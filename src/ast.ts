// The Abstract Syntax Tree. This is the compiler's central data structure: the
// parser builds it, semantic analysis (later) annotates/checks it, and codegen
// walks it. It mirrors the grammar we've implemented so far:
//
//   program   = Program(function_definition)
//   function  = Function(identifier name, statement body)
//   statement = Return(exp)
//   exp       = Constant(int)
//             | Unary(unary_op, exp)
//   unary_op  = Negate | Complement
//
// As the language grows, each of these gets more variants (more statement
// kinds, more expression kinds). Discriminated unions on `kind` keep TS able to
// narrow exhaustively in switch statements.

export interface Program {
  kind: "Program";
  function: FunctionDef;
}

export interface FunctionDef {
  kind: "Function";
  name: string;
  body: Statement;
}

// Only one statement form so far.
export type Statement = Return;

export interface Return {
  kind: "Return";
  exp: Expression;
}

// An expression is a constant or a unary operation applied to another
// expression (the recursive `operand` is what makes the AST a tree).
export type Expression = Constant | Unary | Binary;

export interface Constant {
  kind: "Constant";
  value: number;
}

export interface Unary {
  kind: "Unary";
  operator: UnaryOp;
  operand: Expression;
}

export type UnaryOp = "Negate" | "Complement" | "Not";

export interface Binary {
  kind: "Binary";
  operator: BinaryOp;
  left: Expression;
  right: Expression;
}

export type BinaryOp =
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
  | "NotEqual"
  // logical (short-circuit)
  | "And"
  | "Or";
