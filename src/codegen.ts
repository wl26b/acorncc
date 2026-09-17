// Codegen — TACKY to ARM64 (AArch64) assembly for the Apple/macOS toolchain.
// The driver writes this out as a `.s` file and hands it to clang.
//
// This walks a FLAT LIST. Each instruction expands to a fixed template that
// depends on nothing around it — so there is no recursion here, no label
// minting (lowering already placed them), no expression stack, and no case for
// `if`, `&&`, blocks or scope. All of that was discharged upstream.
//
// Layout convention: labels at column 0, everything else tab-indented.
//
// Cost model: every value lives in a stack slot, and ARM64 cannot compute on
// memory, so a template is typically load, load, operate, store. That is the
// same traffic the old push/pop stack machine had. It is also the thing a
// register allocator later replaces — `layoutFrame` is the seam it plugs into.

import type {
  TackyProgram,
  TackyFun,
  Instruction,
  Val,
  TackyVar,
} from "./tacky.js";

// macOS mangles C symbol names by prefixing an underscore: `main` -> `_main`.
// (Linux/ELF would use the bare name; this is the one platform detail here.)
function symbol(name: string): string {
  return `_${name}`;
}

// Where each value lives, and how much stack the function needs.
//
// `offsets` maps a TACKY `Var` name to its byte offset from `fp` — always
// negative, since values sit below the frame record. User variables and
// temporaries are treated identically, because by this point they ARE
// identical: both are just names.
// `frameSize` covers TWO regions, and only the first has names in `offsets`:
// the named slots, growing downward from `fp`, and below them an unnamed
// outgoing-argument area at the bottom, ending at `sp`. Sizing both here is
// what lets `sp` stay fixed for the whole function.
interface FrameLayout {
  offsets: Map<string, number>;
  frameSize: number;
}

// A miss here means layoutFrame and the lowering disagree — a compiler bug, not
// bad input, so it throws rather than emitting `[fp, #undefined]` for the
// assembler to choke on.
function slotOf(offsets: Map<string, number>, name: string): number {
  const offset = offsets.get(name);
  if (offset === undefined) {
    throw new Error(`No stack slot for '${name}' — layoutFrame missed it`);
  }
  return offset;
}

// Assign every distinct Var a stack slot.
//
// Storage is discovered from USES, not declarations: the first time a name
// appears in any operand position, it gets the next slot. Constants and jump
// targets get none — a target is a position in the code, not a value, which is
// why Vals are extracted field by field rather than by grabbing every string.
//
// Allocation stays monotonic (no reuse for disjoint live ranges) because that
// is the register allocator's job, and a worse version here would be in the
// way.
// AAPCS64: the first eight integer arguments travel in w0-w7; the rest go on
// the CALLER's stack, at the very bottom of its frame. The caller writes them
// at [sp, #0] upward and the callee reads them at [fp, #16] upward — the same
// bytes, named from either side of the boundary between the two frames.
//
// The scratch register for that copy is w9, and it matters that it is outside
// w0-w7: it is what makes the two loops in each direction order-independent.
const MAX_REG_ARGS = 8;

// Bytes per stack-passed argument. Apple's arm64 ABI packs them at their
// natural size rather than padding each to 8, which is a documented divergence
// from generic AArch64 — everything is `int` here, so 4.
const STACK_ARG_SIZE = 4;

// Where the caller's outgoing arguments sit, seen from the callee: just above
// its own frame record (saved fp + lr, 8 bytes each). Constant for every
// function, because `fp` never moves — clang, addressing from `sp`, has to fold
// the frame size into this offset instead.
const FRAME_RECORD_SIZE = 16;

function layoutFrame(fn: TackyFun): FrameLayout {
  const offsets = new Map<string, number>();
  let offset = 0;
  let stagingBytes = 0;

  function assignSlot(name: string) {
    if (!offsets.has(name)) {
      offsets.set(name, -4 - offset);
      offset += 4;
    }
  }

  // Parameters FIRST, and this is the one place the "slots come from uses, not
  // declarations" rule breaks. Every other value originates inside the
  // instruction list, so mentioning it is what proves it exists. A parameter's
  // value arrives from OUTSIDE the list — in a register — so an unused
  // parameter appears nowhere and would get no slot for the prologue to spill
  // into. The declaration has to be a second source of truth.
  for (const param of fn.params) {
    assignSlot(param);
  }

  for (const instr of fn.instructions) {
    switch (instr.kind) {
      case "Return": {
        if (instr.val.kind === "Var") assignSlot(instr.val.name);
        break;
      }
      case "Unary": {
        if (instr.src.kind === "Var") assignSlot(instr.src.name);
        assignSlot(instr.dst.name);
        break;
      }
      case "Binary": {
        if (instr.src1.kind === "Var") assignSlot(instr.src1.name);
        if (instr.src2.kind === "Var") assignSlot(instr.src2.name);
        assignSlot(instr.dst.name);
        break;
      }
      case "Copy": {
        if (instr.src.kind === "Var") assignSlot(instr.src.name);
        assignSlot(instr.dst.name);
        break;
      }
      case "JumpIfNotZero":
      case "JumpIfZero": {
        if (instr.condition.kind === "Var") assignSlot(instr.condition.name);
        break;
      }
      case "Jump":
      case "Label": {
        break;
      }
      case "FunCall": {
        for (const arg of instr.args) {
          if (arg.kind === "Var") assignSlot(arg.name);
        }

        // Outgoing arguments are NOT slots: nothing here is named, and the
        // area is scratch shared by every call this function makes, so it is
        // sized by the widest one rather than by their sum. Reserving it in
        // layoutFrame instead of pushing at the call is what keeps `sp` fixed.
        stagingBytes = Math.max(
          stagingBytes,
          STACK_ARG_SIZE * Math.max(0, instr.args.length - MAX_REG_ARGS),
        );

        assignSlot(instr.dst.name);
        break;
      }
      default: {
        const _never: never = instr;
        throw new Error(`Unhandled instruction: ${JSON.stringify(_never)}`);
      }
    }
  }

  // Named slots AND the outgoing-argument area, rounded together. Rounding the
  // total is what guarantees the staging area at [sp, #0] can never reach the
  // lowest named slot — a silent corruption if it did, since the call would
  // still work and some unrelated local would change.
  const frameSize = Math.ceil((offset + stagingBytes) / 16) * 16;
  return { offsets, frameSize };
}

export function generate(program: TackyProgram): string {
  const lines: string[] = [];
  for (const fn of program.functions) {
    emitFun(fn, lines);
  }
  // Assemblers like a trailing newline.
  return lines.join("\n") + "\n";
}

function emitFun(fn: TackyFun, lines: string[]): void {
  const { offsets, frameSize } = layoutFrame(fn);

  const label = symbol(fn.name);
  // `.globl` DECLARES the symbol as globally visible; the `label:` line DEFINES
  // it (binds the name to this address). Both are required: without the label
  // the linker reports `Undefined symbols: _main`.
  lines.push(`\t.globl\t${label}`);
  lines.push(`\t.p2align\t2`); // 2^2 = 4-byte alignment (one instruction wide)
  lines.push(`${label}:`);

  emitPrologue(frameSize, fn.params, offsets, lines);

  // Note what ISN'T here any more: the unconditional `mov w0, #0` + epilogue
  // that used to be appended for falling off the end. Lowering emits a
  // `Return $0` for that, so it arrives as an ordinary instruction like any
  // other, and the epilogue is emitted by the Return template.
  for (const instr of fn.instructions) {
    emitInstruction(instr, offsets, lines);
  }
}

// Claim the frame and anchor `fp` to it.
//
// `stp` pushes the caller's fp and lr as one 16-byte unit — the ABI's "frame
// record", fp at the lower address so the saved fps form a linked list that
// debuggers walk for backtraces. The pair costs the same single instruction as
// saving fp alone, and keeps `sp` 16-byte aligned.
function emitPrologue(
  frameSize: number,
  params: string[],
  offsets: Map<string, number>,
  lines: string[],
): void {
  lines.push(`\tstp\tfp, lr, [sp, #-16]!`);
  lines.push(`\tmov\tfp, sp`);

  if (frameSize > 0) lines.push(`\tsub\tsp, sp, #${frameSize}`);

  // Spill every parameter into its own slot, so that from here on the body
  // cannot tell where a value arrived from. Both loops end in the same place —
  // only the source differs.

  // Registers: one instruction each.
  for (let i = 0; i < Math.min(params.length, MAX_REG_ARGS); i++) {
    lines.push(`\tstr\tw${i}, [fp, #${slotOf(offsets, params[i]!)}]`);
  }

  // The caller's stack: two, because memory-to-memory needs a register in
  // between. POSITIVE fp offsets — these bytes belong to the caller's frame,
  // and the sign is what says which side of the boundary an address is on.
  for (let i = MAX_REG_ARGS; i < params.length; i++) {
    const incoming = FRAME_RECORD_SIZE + (i - MAX_REG_ARGS) * STACK_ARG_SIZE;
    lines.push(`\tldr\tw9, [fp, #${incoming}]`);
    lines.push(`\tstr\tw9, [fp, #${slotOf(offsets, params[i]!)}]`);
  }
}

// Tear it down, in exact mirror image, and return. `ret` must come last — it
// branches to `lr`, so anything after it is unreachable.
function emitEpilogue(lines: string[]): void {
  lines.push(`\tmov\tsp, fp`);
  lines.push(`\tldp\tfp, lr, [sp], #16`);
  lines.push(`\tret`);
}

// --- The two primitives every template is built from ----------------------

// Get `val` into `reg`: a load from its slot, or a materialised constant.
//
// `movz`/`movk` rather than `mov`, because `mov Wd, #imm` is an alias the
// assembler satisfies with movz OR movn OR a bitmask immediate, erroring if
// none fits — so which constants work is unpredictable (#2147483646 assembles,
// #1431655762 does not). movz writes one 16-bit chunk and zeroes the rest;
// movk writes one and keeps the rest.
//
// Negative constants still want `movn` and aren't handled; unreachable until
// M5's `(void *)-1`.
function loadVal(
  val: Val,
  reg: string,
  offsets: Map<string, number>,
  lines: string[],
): void {
  if (val.kind === "Var") {
    lines.push(`\tldr\t${reg}, [fp, #${slotOf(offsets, val.name)}]`);
  } else {
    const lo = val.value & 0xffff;
    const hi = (val.value >>> 16) & 0xffff;
    lines.push(`\tmovz\t${reg}, #${lo}`);
    if (hi !== 0) lines.push(`\tmovk\t${reg}, #${hi}, lsl #16`);
  }
}

// Emit the store putting `reg` into `dst`'s slot.
function storeVal(
  reg: string,
  dst: TackyVar,
  offsets: Map<string, number>,
  lines: string[],
): void {
  lines.push(`\tstr\t${reg}, [fp, #${slotOf(offsets, dst.name)}]`);
}

// --- One template per instruction kind ------------------------------------
//
// Eight cases, each depending on nothing but its own operands. Note that a
// fixed expansion is the rule, not a single instruction: Remainder is
// `sdiv`+`msub` and the comparisons are `cmp`+`cset`, always.
//
// One hard register constraint: Return's value must end in `w0`. Everything
// else is scratch, since w0-w15 are all caller-saved — that stays true until
// ch9's `bl` makes w0-w7 volatile across calls.
function emitInstruction(
  instr: Instruction,
  offsets: Map<string, number>,
  lines: string[],
): void {
  switch (instr.kind) {
    // Done as a model: a Label is a name for a position, so it emits no
    // instruction at all — just the definition, at column 0.
    case "Label": {
      lines.push(`${instr.name}:`);
      return;
    }
    case "Return": {
      loadVal(instr.val, "w0", offsets, lines);
      emitEpilogue(lines);
      return;
    }
    case "Unary": {
      loadVal(instr.src, "w0", offsets, lines);

      switch (instr.operator) {
        case "Negate": {
          lines.push(`\tneg\tw0, w0`);
          break;
        }
        case "Complement": {
          lines.push(`\tmvn\tw0, w0`);
          break;
        }
        case "Not": {
          lines.push(`\tcmp\tw0, #0`);
          lines.push(`\tcset\tw0, eq`);
          break;
        }
        default: {
          const _never: never = instr;
          throw new Error(`Unhandled: ${JSON.stringify(_never)}`);
        }
      }

      storeVal("w0", instr.dst, offsets, lines);
      return;
    }
    case "Binary": {
      loadVal(instr.src1, "w0", offsets, lines);
      loadVal(instr.src2, "w1", offsets, lines);

      switch (instr.operator) {
        case "Add": {
          lines.push(`\tadd\tw0, w0, w1`);
          break;
        }
        case "Subtract": {
          lines.push(`\tsub\tw0, w0, w1`);
          break;
        }
        case "Multiply": {
          lines.push(`\tmul\tw0, w0, w1`);
          break;
        }
        case "Divide": {
          lines.push(`\tsdiv\tw0, w0, w1`);
          break;
        }
        case "Remainder": {
          lines.push(`\tsdiv\tw2, w0, w1`);
          lines.push(`\tmsub\tw0, w2, w1, w0`);
          break;
        }
        case "LessThan": {
          lines.push(`\tcmp\tw0, w1`);
          lines.push(`\tcset\tw0, lt`);
          break;
        }
        case "GreaterThan": {
          lines.push(`\tcmp\tw0, w1`);
          lines.push(`\tcset\tw0, gt`);
          break;
        }
        case "LessOrEqual": {
          lines.push(`\tcmp\tw0, w1`);
          lines.push(`\tcset\tw0, le`);
          break;
        }
        case "GreaterOrEqual": {
          lines.push(`\tcmp\tw0, w1`);
          lines.push(`\tcset\tw0, ge`);
          break;
        }
        case "Equal": {
          lines.push(`\tcmp\tw0, w1`);
          lines.push(`\tcset\tw0, eq`);
          break;
        }
        case "NotEqual": {
          lines.push(`\tcmp\tw0, w1`);
          lines.push(`\tcset\tw0, ne`);
          break;
        }
        case "BitwiseAnd": {
          lines.push(`\tand\tw0, w0, w1`);
          break;
        }
        case "BitwiseOr": {
          lines.push(`\torr\tw0, w0, w1`);
          break;
        }
        case "BitwiseXor": {
          lines.push(`\teor\tw0, w0, w1`);
          break;
        }
        case "ShiftLeft": {
          lines.push(`\tlsl\tw0, w0, w1`);
          break;
        }
        // `asr`, not `lsr`: C's `>>` on a SIGNED operand is an arithmetic
        // shift, sign-extending rather than zero-filling, and every value in
        // the language is a signed int today. The machine has both and can't
        // know which you meant — the operand's TYPE decides, which makes this
        // the first template that will have to consult one at M5, when
        // `unsigned` arrives and `lsr` becomes correct for it.
        case "ShiftRight": {
          lines.push(`\tasr\tw0, w0, w1`);
          break;
        }
        default: {
          const _never: never = instr;
          throw new Error(`Unhandled: ${JSON.stringify(_never)}`);
        }
      }

      storeVal("w0", instr.dst, offsets, lines);
      return;
    }
    case "Copy": {
      loadVal(instr.src, "w0", offsets, lines);
      storeVal("w0", instr.dst, offsets, lines);
      return;
    }
    case "Jump": {
      lines.push(`\tb\t${instr.target}`);
      return;
    }
    case "JumpIfZero": {
      loadVal(instr.condition, "w0", offsets, lines);
      lines.push(`\tcbz\tw0, ${instr.target}`);
      return;
    }
    case "JumpIfNotZero": {
      loadVal(instr.condition, "w0", offsets, lines);
      lines.push(`\tcbnz\tw0, ${instr.target}`);
      return;
    }
    case "FunCall": {
      // The mirror of emitPrologue: put every argument where the callee will
      // look for it. Note what ISN'T here — no push, no `sp` adjustment around
      // the call. layoutFrame already reserved room for the widest call this
      // function makes, so `sp` is untouched and its 16-byte alignment holds by
      // construction rather than by fixing it up here.
      for (let i = 0; i < Math.min(instr.args.length, MAX_REG_ARGS); i++) {
        loadVal(instr.args[i]!, `w${i}`, offsets, lines);
      }

      // Straight to [sp, #0] upward — the bottom of our own frame is what the
      // callee will see as the bytes just above its frame record.
      for (let i = MAX_REG_ARGS; i < instr.args.length; i++) {
        loadVal(instr.args[i]!, "w9", offsets, lines);
        lines.push(`\tstr\tw9, [sp, #${(i - MAX_REG_ARGS) * STACK_ARG_SIZE}]`);
      }

      lines.push(`\tbl\t${symbol(instr.name)}`);
      storeVal("w0", instr.dst, offsets, lines);
      return;
    }
    default: {
      const _never: never = instr;
      throw new Error(`Unhandled: ${JSON.stringify(_never)}`);
    }
  }
}
