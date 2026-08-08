// The Abstract Syntax Tree. This is the compiler's central data structure: the
// parser builds it, semantic analysis (later) annotates/checks it, and codegen
// walks it. It mirrors the grammar we've implemented so far:
//
//   program     = Program(function_definition)
//   function    = Function(identifier name, block_item* body)
//   block_item  = statement | declaration
//   declaration = Declaration(identifier name, exp? init)
//   statement   = Return(exp)
//               | ExpressionStatement(exp)
//               | Null
//   exp         = Constant(int)
//               | Var(identifier)
//               | Unary(unary_op, exp)
//               | Binary(binary_op, exp, exp)
//               | Assign(exp lvalue, exp rvalue)
//   unary_op    = Negate | Complement | Not
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
  body: BlockItem[];
}

// A function body is a sequence of block items, NOT of statements: a
// declaration is not a statement in C, it's a sibling of one. Naming the union
// keeps the parser, the resolver and codegen all saying the same word.
export type BlockItem = Statement | Declaration;

export interface Declaration {
  kind: "Declaration";
  name: string;
  // Absent for `int a;`. The initializer is a full expression, not just a
  // literal — `int a = b * 2 + 1;` is legal.
  init?: Expression;
}

export type Statement = Return | ExpressionStatement | Null;

export interface Return {
  kind: "Return";
  exp: Expression;
}

// An expression evaluated for its side effects, its value discarded: `a = 5;`.
export interface ExpressionStatement {
  kind: "ExpressionStatement";
  exp: Expression;
}

// The null statement, `;` — does nothing. Having a node for it (rather than
// letting the parser drop it) keeps `Statement` total, so the substatement of
// an `if`/loop in later chapters is never an optional field.
export interface Null {
  kind: "Null";
}

// An expression is a leaf (constant, variable) or an operation applied to other
// expressions (the recursive operands are what make the AST a tree).
export type Expression = Constant | Var | Unary | Binary | Assign;

export interface Constant {
  kind: "Constant";
  value: number;
}

// A reference to a variable. Holds the name as written; the resolver rewrites
// it in place to a unique name so that shadowed declarations in nested scopes
// stay distinguishable.
export interface Var {
  kind: "Var";
  name: string;
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

// Assignment is NOT a BinaryOp: every operator in that union evaluates both
// operands to values and combines them, whereas assignment needs its left
// operand as a *location* to store into. That lvalue/rvalue split is why it
// gets its own node — and why codegen can share nothing with the Binary case.
// Whether `lvalue` really is one is checked by the resolver, not the parser.
export interface Assign {
  kind: "Assign";
  lvalue: Expression;
  rvalue: Expression;
}
