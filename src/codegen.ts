import type {
  Program,
  FunctionDef,
  Statement,
  Declaration,
  Expression,
  BlockItem,
} from "./ast.js";

// Codegen walks the AST and produces ARM64 (AArch64) assembly text for the
// Apple/macOS toolchain. The driver writes this out as a `.s` file and hands it
// to clang, which assembles and links it.
//
// Assembly layout convention (matches what clang emits):
//   - labels go at column 0        -> `_main:`
//   - directives AND instructions are tab-indented, at the same level
//       -> `\t.globl\t_main`, `\tmov\tw0, #42`
// A label is a *name for a position*; everything else is a command. That's the
// only structural distinction, which is why assembly reads as flat.
//
// In later chapters this splits into two stages (AST -> intermediate "TACKY" ->
// assembly); for now a direct AST -> asm walk suffices, even for deeply nested
// expressions and the short-circuit branching of `&&` / `||`.
//
// Locals live in a stack frame anchored to the FRAME POINTER (`fp`/x29), not to
// `sp`. That matters because the expression stack machine below moves `sp`
// mid-expression (see pushRegValOntoStack), so `[sp, #off]` would name a
// different address depending on how deeply nested the expression was. `fp` is
// set once in the prologue and never moves, so `[fp, #-off]` is stable
// everywhere — and `mov sp, fp` in the epilogue restores `sp` without having to
// know how much was pushed.

// macOS mangles C symbol names by prefixing an underscore: `main` -> `_main`.
// (Linux/ELF would use the bare name; this is the one platform detail here.)
function symbol(name: string): string {
  return `_${name}`;
}

// A monotonic counter for minting unique local-label names (`&&`/`||` need
// their own labels per occurrence). `generate()` resets it so label numbering
// is deterministic per compilation rather than cumulative across calls.
let labelCounter = 0;
function freshLabel(prefix: string): string {
  return `L${prefix}_${labelCounter++}`;
}

export function generate(program: Program): string {
  labelCounter = 0;
  const lines: string[] = [];

  emitFunction(program.function, lines);
  // Assemblers like a trailing newline.
  return lines.join("\n") + "\n";
}

// Where each local lives, and how much stack the function needs.
//
// `offsets` maps a variable's RESOLVED (unique) name to its byte offset from
// `fp` — always negative, since locals sit below the frame record. Keying on the
// resolved name is what makes ch7's shadowing work for free: two `a`s in nested
// scopes arrive as distinct names and so get distinct slots.
interface FrameLayout {
  offsets: Map<string, number>;
  frameSize: number;
}

// A miss here means layoutFrame and the resolver disagree — a compiler bug, not
// bad input, so it throws rather than producing `[fp, #undefined]` for the
// assembler to choke on.
function slotOf(offsets: Map<string, number>, name: string): number {
  const offset = offsets.get(name);
  if (offset === undefined) {
    throw new Error(`No stack slot for '${name}' — layoutFrame missed it`);
  }
  return offset;
}

// Ch7 turned this from a flat loop over `fn.body` into a recursive walk,
// because a block is a statement that CAN declare — the one thing an `if` arm
// could not. Two recursion points, everything else a leaf.
//
// SLOT ALLOCATION IS MONOTONIC, and that's a decision rather than an oversight.
// Sibling blocks have disjoint lifetimes, so `{ int b; } { int c; }` could
// safely share one slot; we give them two. Reusing them means saving `offset`
// on entering a block, restoring it on exit, and sizing the frame from the
// maximum rather than the final value — about three lines today, but it is
// lifetime analysis wearing a small disguise, and it stops being three lines
// the moment ch8's loops and M4's IR arrive. "Correct-but-unoptimized" is the
// stated target, so: wasted stack, no bookkeeping.
function layoutFrame(fn: FunctionDef): FrameLayout {
  const offsets = new Map<string, number>();
  let offset = 0;

  function walk(item: BlockItem) {
    switch (item.kind) {
      case "Declaration": {
        offsets.set(item.name, -4 - offset);
        offset += 4;
        break;
      }
      // The two recursion points. `Compound` is the obvious one; `If` is the
      // trap, because an arm can BE a `{ ... }` — `if (x) { int y = 1; }`
      // hides a declaration behind a node that contributed nothing through
      // ch6. Miss it and slotOf throws "No stack slot for 'y.N'", which is
      // exactly the error that guard exists to produce.
      case "Compound": {
        for (const it of item.block) {
          walk(it);
        }
        break;
      }
      case "If": {
        walk(item.consequent);
        if (item.alternative !== undefined) walk(item.alternative);
        break;
      }
      // Genuine leaves: none of these can contain a declaration, directly or
      // otherwise.
      case "ExpressionStatement":
      case "Null":
      case "Return": {
        break;
      }
      default: {
        const _never: never = item;
        throw new Error(`Unhandled blockItem: ${JSON.stringify(_never)}`);
      }
    }
  }

  for (const item of fn.body) {
    walk(item);
  }

  const frameSize = Math.ceil(offset / 16) * 16;

  return { offsets, frameSize };
}

function emitFunction(fn: FunctionDef, lines: string[]): void {
  const { offsets, frameSize } = layoutFrame(fn);

  const label = symbol(fn.name);
  // `.globl` DECLARES the symbol as globally visible; the `label:` line DEFINES
  // it (binds the name to this address). Both are required: without the label
  // the linker reports `Undefined symbols: _main`.
  //
  // We omit clang's explicit `.section __TEXT,__text,...` — the assembler
  // defaults to the text section anyway.
  lines.push(`\t.globl\t${label}`);
  lines.push(`\t.p2align\t2`); // 2^2 = 4-byte alignment (one instruction wide)
  lines.push(`${label}:`);

  emitPrologue(frameSize, lines);
  emitBlock(fn.body, offsets, lines);

  // Falling off the end of `main` returns 0 (C guarantees this for main
  // specifically). Emitted unconditionally: deciding whether a function ALWAYS
  // returns is a reachability analysis, not a look at the last block item —
  // `if (x) return 1; else return 2;` never ends in a Return node but always
  // returns. When the function did return, this path is unreachable, which
  // costs four dead instructions and nothing at runtime.
  lines.push(`\tmovz\tw0, #0`);
  emitEpilogue(lines);
}

// Claim the frame and anchor `fp` to it.
//
// `stp` pushes the caller's fp and lr as one 16-byte unit — the ABI's "frame
// record", fp at the lower address so the saved fps form a linked list that
// debuggers walk for backtraces. `lr` isn't strictly at risk yet (we emit no
// `bl` until M4, so nothing overwrites it), but the pair costs the same single
// instruction as saving fp alone, and keeps `sp` 16-byte aligned.
function emitPrologue(frameSize: number, lines: string[]): void {
  lines.push(`\tstp\tfp, lr, [sp, #-16]!`);
  lines.push(`\tmov\tfp, sp`);
  if (frameSize > 0) lines.push(`\tsub\tsp, sp, #${frameSize}`);
}

// Tear it down, in exact mirror image, and return.
//
// `mov sp, fp` rather than `add sp, sp, #frameSize`: restoring from the anchor
// doesn't depend on the two sizes matching, and it repairs `sp` regardless of
// what the expression stack machine pushed. `ret` must come last — it branches
// to `lr`, so anything after it is unreachable.
function emitEpilogue(lines: string[]): void {
  lines.push(`\tmov\tsp, fp`);
  lines.push(`\tldp\tfp, lr, [sp], #16`);
  lines.push(`\tret`);
}

// Emit a run of block items in source order — used for both the function body
// and a nested block, which at this level are the same thing (`parseBlock` and
// the resolver make the same identification).
//
// The dispatch here is the only place emit-side that cares whether an item is a
// declaration or a statement, which is why it's worth having once.
function emitBlock(
  block: BlockItem[],
  offsets: Map<string, number>,
  lines: string[],
): void {
  for (const item of block) {
    if (item.kind === "Declaration") emitDeclaration(item, offsets, lines);
    else emitStatement(item, offsets, lines);
  }
}

// A declaration's only runtime effect is its initializer's store — the slot
// itself was reserved by the prologue's single `sub sp`. So `int a;` emits
// nothing at all, and the slot holds whatever the previous frame left there,
// which is exactly C's "indeterminate value".
function emitDeclaration(
  decl: Declaration,
  offsets: Map<string, number>,
  lines: string[],
): void {
  if (decl.init === undefined) return;

  emitExpressionIntoW0(decl.init, offsets, lines);
  lines.push(`\tstr\tw0, [fp, #${slotOf(offsets, decl.name)}]`);
}

function emitStatement(
  stmt: Statement,
  offsets: Map<string, number>,
  lines: string[],
): void {
  switch (stmt.kind) {
    case "ExpressionStatement": {
      emitExpressionIntoW0(stmt.exp, offsets, lines);
      return;
    }
    case "Null": {
      return;
    }
    case "Return": {
      // A `return <exp>;` evaluates the expression into w0 (where AAPCS64 says
      // an int return value lives), then `ret` branches back to the caller via
      // the link register.
      emitExpressionIntoW0(stmt.exp, offsets, lines);
      // `return` is no longer a single instruction: the frame has to be torn
      // down before we branch back. The epilogue is inlined at each return
      // site; with more returns (ch6/ch8) or a longer epilogue (M4's
      // callee-saved restores) it's worth switching to one labelled epilogue
      // that each `return` branches to, which is what clang does at -O0.
      emitEpilogue(lines);
      return;
    }
    case "If": {
      // Where the false path lands. With an `else` that's the alternative's
      // own label; without one it IS the join point, since "skip the
      // consequent" and "we're done" are the same address. Deciding it up
      // front is what keeps every branch target defined: the name always
      // refers to a label this function goes on to emit.
      const endLabel = freshLabel("end");
      const falseLabel = stmt.alternative
        ? freshLabel("alternative")
        : endLabel;

      // Truthiness is NONZERO (the ch4 lesson), so the false path is the
      // equal-to-zero one.
      emitExpressionIntoW0(stmt.predicate, offsets, lines);
      lines.push(`\tcmp\tw0, #0`);
      lines.push(`\tbeq\t${falseLabel}`);
      emitStatement(stmt.consequent, offsets, lines);

      // Both of these exist SOLELY to jump over the alternative and to name
      // where it starts — so with no alternative, neither is emitted. That's
      // what stops a bare `if` from ending in a branch to the very next
      // instruction.
      if (stmt.alternative !== undefined) {
        lines.push(`\tb\t${endLabel}`);
        lines.push(`${falseLabel}:`);
        emitStatement(stmt.alternative, offsets, lines);
      }
      lines.push(`${endLabel}:`);
      return;
    }
    // A block emits its items and nothing else — no prologue, no adjustment,
    // not a single instruction of its own. Scope was entirely consumed by
    // earlier stages: the resolver turned shadowed names into distinct ones and
    // layoutFrame already handed each a slot, so by here "which `b`?" is not a
    // question that exists. Braces leave no trace in the machine code.
    case "Compound": {
      emitBlock(stmt.block, offsets, lines);
      return;
    }
    default: {
      // Exhaustiveness guard: if a new Statement variant is added and not
      // handled, TS flags this line at compile time.
      const _never: never = stmt;
      throw new Error(`Unhandled statement: ${_never}`);
    }
  }
}

// Evaluate an expression, leaving its value in w0 (the 32-bit view of x0).
// A Unary op recurses to compute its operand into w0, then transforms w0 in
// place — so arbitrarily nested unaries (e.g. -~2) need no extra registers.
function emitExpressionIntoW0(
  exp: Expression,
  offsets: Map<string, number>,
  lines: string[],
): void {
  switch (exp.kind) {
    case "Constant": {
      // Every ARM64 instruction is 32 bits wide, so none can carry a full
      // 32-bit constant — they're built from 16-bit chunks instead. `movz`
      // writes one chunk and ZEROES the rest; `movk` writes one chunk and KEEPS
      // the rest. An `int` needs at most two.
      //
      // We emit `movz` rather than `mov` deliberately. `mov Wd, #imm` is an
      // alias the assembler satisfies with movz OR movn OR an `orr` bitmask
      // immediate, and if none fits it errors rather than expanding to two
      // instructions — so which constants work is near-unpredictable (#2147483646
      // assembles, #1431655762 does not). `movz` is one specific instruction with
      // one rule: 16 bits, or add a `movk`.
      //
      // STILL UNHANDLED: negative constants, which want the inverted `movn`
      // form. Unreachable today (the lexer only produces digit runs, so `-5` is
      // unary negation applied to 5), but minilisp's `ROOT_END` is `(void *)-1`
      // — see minilisp-inventory.md §6.4.
      const lo = exp.value & 0xffff;
      const hi = (exp.value >>> 16) & 0xffff;
      lines.push(`\tmovz\tw0, #${lo}`);
      if (hi !== 0) lines.push(`\tmovk\tw0, #${hi}, lsl #16`);
      return;
    }
    case "Unary": {
      // Compute the operand into w0, then apply the operator to w0 in place.
      emitExpressionIntoW0(exp.operand, offsets, lines);
      switch (exp.operator) {
        case "Negate":
          lines.push(`\tneg\tw0, w0`);
          break;
        case "Complement":
          lines.push(`\tmvn\tw0, w0`);
          break;
        case "Not":
          lines.push(`\tcmp\tw0, #0`);
          lines.push(`\tcset\tw0, eq`);
          break;
        default: {
          // Exhaustiveness: a new UnaryOp added to the AST but not handled here
          // is caught at compile time rather than silently emitting nothing.
          // Assign `exp`, NOT `exp.operator`: this switch exhausts the ENTIRE
          // UnaryOp union, so TS narrows the whole `exp` down to `never` here —
          // and `exp.operator` would then be a type error (you can't read a
          // property off `never`). The Binary guard below needs the OPPOSITE
          // choice; see the note there for why.
          const _never: never = exp;
          throw new Error(
            `Unhandled unary operator: ${JSON.stringify(_never)}`,
          );
        }
      }
      return;
    }
    case "Conditional": {
      // The same branch skeleton as the `If` statement, with two differences:
      // the alternative is MANDATORY (an expression must produce a value on
      // every path, so there's no one-label shortcut), and each arm leaves its
      // value in w0 — the two arms converge on the register, which is what
      // makes the whole thing an expression.
      //
      // Note what ISN'T here: no push/pop. Binary parks its left operand
      // because both operands must exist SIMULTANEOUSLY to be combined, but
      // here the predicate is consumed by `cmp` before either arm runs, and
      // exactly one arm ever executes. Nothing is live across anything else,
      // so w0 alone suffices no matter how deeply conditionals nest.
      const altLabel = freshLabel("alternative");
      const endLabel = freshLabel("end");

      emitExpressionIntoW0(exp.predicate, offsets, lines);
      lines.push(`\tcmp\tw0, #0`);
      lines.push(`\tbeq\t${altLabel}`);
      emitExpressionIntoW0(exp.consequent, offsets, lines);
      lines.push(`\tb\t${endLabel}`);
      lines.push(`${altLabel}:`);
      emitExpressionIntoW0(exp.alternative, offsets, lines);
      lines.push(`${endLabel}:`);
      return;
    }
    case "Binary": {
      if (exp.operator === "And")
        return emitShortCircuit(exp.left, exp.right, "beq", 0, offsets, lines);
      if (exp.operator === "Or")
        return emitShortCircuit(exp.left, exp.right, "bne", 1, offsets, lines);

      // Binary operators are the first values that can't funnel through w0
      // alone: computing the right operand would clobber the left. So we park
      // the left on the stack while the right is computed, then reunite them.
      // We evaluate RIGHT first and LEFT last, so that after the pop the operands
      // sit as (left = w0, right = w1) — which lets the order-sensitive combines
      // (`sub`, `sdiv`, and every `cmp`-based comparison) read in natural
      // left-to-right order.
      emitExpressionIntoW0(exp.right, offsets, lines);
      pushRegValOntoStack("x0", lines);
      emitExpressionIntoW0(exp.left, offsets, lines);
      popValFromStackIntoReg("x1", lines);

      switch (exp.operator) {
        case "Add":
          lines.push(`\tadd\tw0, w0, w1`);
          break;
        case "Subtract":
          lines.push(`\tsub\tw0, w0, w1`);
          break;
        case "Multiply":
          lines.push(`\tmul\tw0, w0, w1`);
          break;
        case "Divide":
          lines.push(`\tsdiv\tw0, w0, w1`);
          break;
        case "Remainder":
          // No remainder instruction: r = a - (a / b) * b, via multiply-subtract.
          // `msub w0, w2, w1, w0` == w0 - w2 * w1 == left - (left / right) * right.
          lines.push(`\tsdiv\tw2, w0, w1`);
          lines.push(`\tmsub\tw0, w2, w1, w0`);
          break;
        case "LessThan":
          lines.push(`\tcmp\tw0, w1`);
          lines.push(`\tcset\tw0, lt`);
          break;
        case "GreaterThan":
          lines.push(`\tcmp\tw0, w1`);
          lines.push(`\tcset\tw0, gt`);
          break;
        case "LessOrEqual":
          lines.push(`\tcmp\tw0, w1`);
          lines.push(`\tcset\tw0, le`);
          break;
        case "GreaterOrEqual":
          lines.push(`\tcmp\tw0, w1`);
          lines.push(`\tcset\tw0, ge`);
          break;
        case "Equal":
          lines.push(`\tcmp\tw0, w1`);
          lines.push(`\tcset\tw0, eq`);
          break;
        case "NotEqual":
          lines.push(`\tcmp\tw0, w1`);
          lines.push(`\tcset\tw0, ne`);
          break;
        default: {
          // Exhaustiveness: a new BinaryOp added to the AST but not handled here
          // is caught at compile time. Assign `exp.operator`, NOT `exp` — the
          // OPPOSITE of the Unary guard above. Because `And`/`Or` are peeled off
          // by the early `return`s, this switch narrows only the *property* to
          // `never`; `exp` itself stays `Binary`, so `const _never: never = exp`
          // would fail to typecheck.
          const _never: never = exp.operator;
          throw new Error(
            `Unhandled binary operator: ${JSON.stringify(_never)}`,
          );
        }
      }
      return;
    }
    case "Var": {
      lines.push(`\tldr\tw0, [fp, #${slotOf(offsets, exp.name)}]`);
      return;
    }
    case "Assign": {
      // The resolver guarantees the lvalue is a Var (it rejects `2 = 3` and
      // `a + 3 = 4`), so this check should be unreachable — but it narrows the
      // type without a cast and documents the invariant.
      if (exp.lvalue.kind !== "Var") {
        throw new Error(
          `Assign lvalue is ${exp.lvalue.kind}; the resolver should have rejected it`,
        );
      }
      const offset = slotOf(offsets, exp.lvalue.name);
      // Evaluate into w0, store, and LEAVE it in w0 — assignment is an
      // expression, so `b = (a = 5)` needs the value to flow outward.
      emitExpressionIntoW0(exp.rvalue, offsets, lines);
      lines.push(`\tstr\tw0, [fp, #${offset}]`);
      return;
    }
    default: {
      // Exhaustiveness guard: assign the narrowed value (never) itself, not a
      // property of it — `exp.kind` on a `never` value is a type error.
      const _never: never = exp;
      throw new Error(`Unhandled expression: ${JSON.stringify(_never)}`);
    }
  }
}

function pushRegValOntoStack(register: string, lines: string[]): void {
  lines.push(`\tstr\t${register}, [sp, #-16]!`);
}

function popValFromStackIntoReg(register: string, lines: string[]): void {
  lines.push(`\tldr\t${register}, [sp], #16`);
}

// Emit a short-circuiting `&&` / `||`. `branch` is the condition that triggers
// the short-circuit ("beq" for &&, "bne" for ||); `shortVal` is the result when
// we take it (0 for &&, 1 for ||). The fall-through result — reached only when
// NEITHER operand branched — is always the complement, `1 - shortVal`.
function emitShortCircuit(
  left: Expression,
  right: Expression,
  branch: "beq" | "bne",
  shortVal: 0 | 1,
  offsets: Map<string, number>,
  lines: string[],
): void {
  const scLabel = freshLabel("sc");
  const endLabel = freshLabel("end");

  emitExpressionIntoW0(left, offsets, lines);
  lines.push(`\tcmp\tw0, #0`);
  lines.push(`\t${branch}\t${scLabel}`);
  emitExpressionIntoW0(right, offsets, lines);
  lines.push(`\tcmp\tw0, #0`);
  lines.push(`\t${branch}\t${scLabel}`);
  lines.push(`\tmov\tw0, #${1 - shortVal}`);
  lines.push(`\tb\t${endLabel}`);
  lines.push(`${scLabel}:`);
  lines.push(`\tmov\tw0, #${shortVal}`);
  lines.push(`${endLabel}:`);
}
