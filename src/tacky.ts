// TACKY — the intermediate representation between AST and assembly.
//
// The name is Sandler's, from "three-address code": every instruction names at
// most three things (two sources and a destination). It sits between the front
// end and the back end and does two flattenings:
//
//   EXPRESSIONS become named temporaries.
//     return (a + b) * c;   ->   t.0 = a + b
//                                t.1 = t.0 * c
//                                Return(t.1)
//
//   CONTROL FLOW becomes labels and jumps.
//     if (a) b = 1;         ->   JumpIfZero(a, "end_if.0")
//                                Copy(1, b)
//                                Label("end_if.0")
//
// After both, nothing is nested. A function is a flat list of instructions,
// which is what a machine actually is — so the assembly emitter becomes a loop
// over that list with a fixed template per instruction, instead of a recursive
// walk that has to know what an `if` is.
//
// WHY THIS EXISTS, in order of how much it matters:
//
//   1. It makes register allocation EXPRESSIBLE. The AST-direct back end parks
//      intermediates on the stack with push/pop — anonymous and positional, so
//      there's no handle to ask "does this value really need to be in memory?".
//      A TACKY temporary is a NAME, which is exactly what you compute a live
//      range for. Naive TACKY codegen costs about the same as the stack machine
//      it replaces; the win is that only one of the two can be improved.
//   2. It caps the back end's complexity. Ten control-flow constructs in C
//      (`&&`, `||`, `if`, `?:`, `while`, `for`, `do`, `break`, `continue`,
//      `switch`) collapse into three instructions here, so the emitter stops
//      growing a new shape per chapter.
//   3. It separates "what does this program compute" (lowering) from "how do I
//      say that in ARM64" (emission).
//
// THE TWO RULES THAT GENERATE THE INSTRUCTION SET:
//
//   a. Each instruction must be emittable knowing ONLY ITSELF — so operands are
//      values already computed, and jump targets are names rather than "the end
//      of my enclosing loop". This is why `&&` can't be a `Binary`: an
//      instruction's operands are values, and short-circuiting is precisely the
//      claim that one of them must NOT be computed.
//   b. Each must expand the SAME WAY EVERY TIME — meaning the expansion is a
//      deterministic function of the instruction, NOT that it is a constant
//      number of machine instructions. `Binary(Divide)` has always emitted two
//      (`sdiv` + `msub`), and ch9's `FunCall` emits one per argument plus the
//      `bl`. Variable LENGTH is fine; variable *depending on context* is not.
//
// `FunCall` is the first instruction with an operand LIST rather than fixed
// slots, so its template is a loop instead of a string with holes. It is also
// the first whose expansion is dictated by the ABI (which register each
// argument goes in) rather than by the ISA — the same IR, retargeted, would
// expand it completely differently.

// A value an instruction reads. Either a literal or a name.
//
// DELIBERATELY, there is no distinction between a user's variable and a
// compiler-generated temporary — `a.0` and `tmp.3` are both just `Var`. That
// uniformity is the point: the pass that assigns storage (a stack slot now, a
// register later) treats every name identically, and never has to ask where it
// came from. Neither can collide with a name the user wrote, because both carry
// a `.` and C identifiers can't.
export type Val = TackyConstant | TackyVar;

export interface TackyConstant {
  kind: "Constant";
  value: number;
}

export interface TackyVar {
  kind: "Var";
  name: string;
}

export interface TackyProgram {
  kind: "Program";
  functions: TackyFun[];
}

// The flat list is the whole idea. Compare `FunDecl.body`, which is a tree
// of block items containing statements containing expressions.
//
// Always a DEFINITION — `instructions` is required. The AST's `FunDecl`
// covers prototypes too, because C has them; there is no IR for "a name I
// promised to define elsewhere", so lowering drops them. That is why
// TackyProgram can hold fewer functions than Program, and it is not lost work.
export interface TackyFun {
  kind: "Fun";
  name: string;
  params: string[];
  instructions: Instruction[];
}

export type Instruction =
  | TackyReturn
  | TackyUnary
  | TackyBinary
  | TackyCopy
  | TackyJump
  | TackyJumpIfZero
  | TackyJumpIfNotZero
  | TackyLabel
  | TackyFunCall;

export interface TackyFunCall {
  kind: "FunCall";
  name: string;
  args: Val[];
  dst: TackyVar;
}

export interface TackyReturn {
  kind: "Return";
  val: Val;
}

// `dst` is always a Var — you can't store into a constant. Typing it as `Val`
// would make every consumer re-check something the lowering guarantees.
export interface TackyUnary {
  kind: "Unary";
  operator: TackyUnaryOp;
  src: Val;
  dst: TackyVar;
}

export interface TackyBinary {
  kind: "Binary";
  operator: TackyBinaryOp;
  src1: Val;
  src2: Val;
  dst: TackyVar;
}

// `dst = src`. What an assignment lowers to once the lvalue has been resolved
// to a name, and what each arm of a `?:` writes so both converge on one value.
export interface TackyCopy {
  kind: "Copy";
  src: Val;
  dst: TackyVar;
}

export interface TackyJump {
  kind: "Jump";
  target: string;
}

// Truthiness is NONZERO, not `== 1` (the ch4 lesson, now stated once here
// rather than at every branch site in the back end).
export interface TackyJumpIfZero {
  kind: "JumpIfZero";
  condition: Val;
  target: string;
}

export interface TackyJumpIfNotZero {
  kind: "JumpIfNotZero";
  condition: Val;
  target: string;
}

export interface TackyLabel {
  kind: "Label";
  name: string;
}

export type TackyUnaryOp = "Negate" | "Complement" | "Not";

// The AST's BinaryOp MINUS `And` and `Or`, and the omission is load-bearing.
// Those two short-circuit: they evaluate their right operand conditionally, so
// they lower to jumps, never to a single instruction that reads both operands.
// Reusing `ast.ts`'s union here would leave the back end's exhaustiveness guard
// demanding arms that can never be reached — the same trap as putting "Assign"
// in `BinaryOp` back in ch5.
export type TackyBinaryOp =
  // arithmetic
  | "Add"
  | "Subtract"
  | "Multiply"
  | "Divide"
  | "Remainder"
  // relational
  | "LessThan"
  | "GreaterThan"
  | "LessOrEqual"
  | "GreaterOrEqual"
  // equality
  | "Equal"
  | "NotEqual";

// --- Debug printing -------------------------------------------------------
//
// Not part of the pipeline; it backs the driver's `--tacky` stage. Reading the
// IR is most of how you debug a lowering bug, because a wrong instruction list
// is far easier to spot than the assembly it produces.

function formatVal(val: Val): string {
  return val.kind === "Constant" ? `$${val.value}` : val.name;
}

function formatInstruction(instr: Instruction): string {
  switch (instr.kind) {
    case "Return":
      return `\treturn ${formatVal(instr.val)}`;
    case "Unary":
      return `\t${instr.dst.name} = ${instr.operator} ${formatVal(instr.src)}`;
    case "Binary":
      return `\t${instr.dst.name} = ${formatVal(instr.src1)} ${instr.operator} ${formatVal(instr.src2)}`;
    case "Copy":
      return `\t${instr.dst.name} = ${formatVal(instr.src)}`;
    case "Jump":
      return `\tjump ${instr.target}`;
    case "JumpIfZero":
      return `\tjump ${instr.target} if ${formatVal(instr.condition)} == 0`;
    case "JumpIfNotZero":
      return `\tjump ${instr.target} if ${formatVal(instr.condition)} != 0`;
    case "Label":
      return `${instr.name}:`;
    case "FunCall": {
      const args = instr.args.map(formatVal).join(", ");
      return `\t${formatVal(instr.dst)} = ${instr.name}(${args})`;
    }
    default: {
      const _never: never = instr;
      throw new Error(`Unhandled TACKY instruction: ${JSON.stringify(_never)}`);
    }
  }
}

export function formatTacky(program: TackyProgram): string {
  return program.functions
    .map((fn) => {
      const params = fn.params.join(", ");
      const body = fn.instructions.map(formatInstruction).join("\n");
      return `${fn.name}(${params}):\n${body}\n`;
    })
    .join("\n");
}
