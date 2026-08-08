import type { Program, FunctionDef, Statement, Expression } from "./ast.js";

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

function emitFunction(fn: FunctionDef, lines: string[]): void {
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
  emitStatement(fn.body, lines);
}

function emitStatement(stmt: Statement, lines: string[]): void {
  switch (stmt.kind) {
    case "Return": {
      // A `return <exp>;` evaluates the expression into w0 (where AAPCS64 says
      // an int return value lives), then `ret` branches back to the caller via
      // the link register.
      emitExpressionIntoW0(stmt.exp, lines);
      lines.push(`\tret`);
      return;
    }
    default: {
      // Exhaustiveness guard: if a new Statement variant is added and not
      // handled, TS flags this line at compile time.
      const _never: never = stmt.kind;
      throw new Error(`Unhandled statement: ${_never}`);
    }
  }
}

// Evaluate an expression, leaving its value in w0 (the 32-bit view of x0).
// A Unary op recurses to compute its operand into w0, then transforms w0 in
// place — so arbitrarily nested unaries (e.g. -~2) need no extra registers.
function emitExpressionIntoW0(exp: Expression, lines: string[]): void {
  switch (exp.kind) {
    case "Constant": {
      // NOTE: `mov` is an alias that only encodes immediates fitting a single
      // movz/movk chunk (a 16-bit value at a 16-bit-aligned shift). e.g.
      // #65536 assembles, but #70000 does NOT — it needs two chunks, and the
      // assembler will not synthesize them for us. Fine while the test constants
      // stay small; revisit with movz/movk or `ldr w0, =N` when they get large.
      lines.push(`\tmov\tw0, #${exp.value}`);
      return;
    }
    case "Unary": {
      // Compute the operand into w0, then apply the operator to w0 in place.
      emitExpressionIntoW0(exp.operand, lines);
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
    case "Binary": {
      if (exp.operator === "And")
        return emitShortCircuit(exp.left, exp.right, "beq", 0, lines);
      if (exp.operator === "Or")
        return emitShortCircuit(exp.left, exp.right, "bne", 1, lines);

      // Binary operators are the first values that can't funnel through w0
      // alone: computing the right operand would clobber the left. So we park
      // the left on the stack while the right is computed, then reunite them.
      // We evaluate RIGHT first and LEFT last, so that after the pop the operands
      // sit as (left = w0, right = w1) — which lets the order-sensitive combines
      // (`sub`, `sdiv`, and every `cmp`-based comparison) read in natural
      // left-to-right order.
      emitExpressionIntoW0(exp.right, lines);
      pushRegValOntoStack("x0", lines);
      emitExpressionIntoW0(exp.left, lines);
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
  lines: string[],
): void {
  const scLabel = freshLabel("sc");
  const endLabel = freshLabel("end");

  emitExpressionIntoW0(left, lines);
  lines.push(`\tcmp\tw0, #0`);
  lines.push(`\t${branch}\t${scLabel}`);
  emitExpressionIntoW0(right, lines);
  lines.push(`\tcmp\tw0, #0`);
  lines.push(`\t${branch}\t${scLabel}`);
  lines.push(`\tmov\tw0, #${1 - shortVal}`);
  lines.push(`\tb\t${endLabel}`);
  lines.push(`${scLabel}:`);
  lines.push(`\tmov\tw0, #${shortVal}`);
  lines.push(`${endLabel}:`);
}
