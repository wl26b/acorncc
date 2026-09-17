// The Abstract Syntax Tree. This is the compiler's central data structure: the
// parser builds it, `resolve.ts` renames and checks it, `lower.ts` flattens it
// into TACKY, and codegen never sees it at all. It mirrors the grammar we've
// implemented so far:
//
//   program     = Program(fun_decl*)
//   block_item  = statement | declaration
//   declaration = VarDecl(identifier name, exp? init)
//               | FunDecl(identifier name, identifier* params, block_item*? body)
//   statement   = Return(exp)
//               | ExpressionStatement(exp)
//               | If(exp predicate, statement consequent, statement? alternative)
//               | Compound(block_item* block)
//               | While(exp condition, statement body)
//               | DoWhile(statement body, exp condition)
//               | For(for_init init, exp? condition, exp? post, statement body)
//               | Break
//               | Continue
//               | Null
//   for_init    = InitDecl(var_decl) | InitExp(exp?)
//   exp         = Constant(int)
//               | Var(identifier)
//               | Unary(unary_op, exp)
//               | Binary(binary_op, exp, exp)
//               | Assign(exp lvalue, exp rvalue)
//               | Conditional(exp predicate, exp consequent, exp alternative)
//               | FunCall(identifier name, exp* args)
//   unary_op    = Negate | Complement | Not
//
// As the language grows, each of these gets more variants (more statement
// kinds, more expression kinds). Discriminated unions on `kind` keep TS able to
// narrow exhaustively in switch statements.

export interface Program {
  kind: "Program";
  functions: FunDecl[];
}

export interface FunDecl {
  kind: "FunDecl";
  name: string;
  params: string[];
  body?: BlockItem[];
}

export interface FunCall {
  kind: "FunCall";
  name: string;
  args: Expression[];
}

// A function body is a sequence of block items, NOT of statements: a
// declaration is not a statement in C, it's a sibling of one. Naming the union
// keeps the parser, the resolver and codegen all saying the same word.
export type BlockItem = Statement | Declaration;

export type Declaration = VarDecl | FunDecl;

export interface VarDecl {
  kind: "VarDecl";
  name: string;
  // Absent for `int a;`. The initializer is a full expression, not just a
  // literal — `int a = b * 2 + 1;` is legal.
  init?: Expression;
}

export type Statement =
  | Return
  | ExpressionStatement
  | Null
  | If
  | Compound
  | While
  | DoWhile
  | For
  | Continue
  | Break;

export interface While {
  kind: "While";
  condition: Expression;
  body: Statement;
  loopId?: string;
}

export interface DoWhile {
  kind: "DoWhile";
  condition: Expression;
  body: Statement;
  loopId?: string;
}

export interface For {
  kind: "For";
  // Not optional: an absent init is `InitExp` with no expression. Keeping the
  // slot total means every consumer switches instead of null-checking first,
  // and it mirrors C's grammar, where the `_opt` is on the expression rather
  // than on the slot.
  init: ForInit;
  condition?: Expression;
  post?: Expression;
  body: Statement;
  loopId?: string;
}

// The `for` header's first slot. A wrapper, not a bare `Declaration |
// Expression`, because TS unions FLATTEN: that bare form has seven `kind`s
// (Declaration plus every Expression variant), so "is this a declaration?"
// becomes a test against one of seven and no `never` guard is possible. The
// wrapper keeps the expression kinds one level down, so the discriminant
// answers the question this slot actually poses.
export type ForInit = InitDecl | InitExp;

export interface InitDecl {
  kind: "InitDecl";
  declaration: VarDecl;
}

// `exp` is absent for `for (; ...)`. InitDecl has no such option — a
// declaration can't be empty — which is why the two arms differ in more than
// their payload type.
export interface InitExp {
  kind: "InitExp";
  exp?: Expression;
}

export interface Break {
  kind: "Break";
  loopId?: string;
}

export interface Continue {
  kind: "Continue";
  loopId?: string;
}

// A brace-delimited block appearing in statement position: `{ ... }`.
//
// Note what this is NOT: `FunDecl.body` is a bare `BlockItem[]`, not a
// Compound. Both are "a run of block items", but only this one is a *statement*
// — and being a statement is exactly what makes it nestable and what makes it
// open a scope. Keeping the function body out of the Statement union is what
// stops it acquiring the second of those: at ch9, a function's parameters and
// its body's outermost block are ONE scope, so `int f(int a) { int a; }` must
// be a duplicate rather than shadowing. Route the body through a Compound and
// it would get a scope of its own and wrongly accept that.
//
// C draws the statement/expression line hard here: a block never has a value,
// so `return { a = 2; };` is a syntax error (parseAtom can't start an
// expression from `{`). GCC's `({ ... })` statement-expression extension is a
// different, non-ISO construct we don't support.
export interface Compound {
  kind: "Compound";
  block: BlockItem[];
}

// `if (p) c;` / `if (p) c; else a;`. Field names are Scheme's — predicate /
// consequent / alternative — and `Conditional` below reuses all three, which is
// the point: the two nodes are the same idea at two levels of the grammar.
//
// Both arms are STATEMENTS, not BlockItem[]. That single choice is what makes
// `if (p) int x = 1;` illegal for free: a declaration isn't a statement in C,
// so there's no production that would accept one here. It's also why `Null`
// exists — `if (p) ;` needs something to point at, so the arms are never
// optional the way `alternative` is.
export interface If {
  kind: "If";
  predicate: Expression;
  consequent: Statement;
  // Optional, because a bare `if` is a complete statement. Contrast
  // `Conditional`, where it's mandatory.
  alternative?: Statement;
}

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
export type Expression =
  Constant | Var | Unary | Binary | Assign | Conditional | FunCall;

// The `? :` operator — C calls it the *conditional operator* (§6.5.15), and the
// grammar production is `conditional-expression`. Not named `Ternary`: `Unary`
// and `Binary` are arity names because each is a FAMILY carrying an operator
// tag, and this is a lone operator with nothing to discriminate.
//
// `alternative` is mandatory here, unlike `If`'s, because an expression has to
// produce a value on every path. Same three field names as `If` on purpose.
export interface Conditional {
  kind: "Conditional";
  predicate: Expression;
  consequent: Expression;
  alternative: Expression;
}

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
  | "Or"
  | "BitwiseAnd"
  | "BitwiseOr"
  | "BitwiseXor"
  | "ShiftLeft"
  | "ShiftRight";

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
