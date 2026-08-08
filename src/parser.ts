import type { Token, TokenKind } from "./lexer.js";
import type {
  Program,
  FunctionDef,
  BlockItem,
  Statement,
  Declaration,
  Expression,
  BinaryOp,
} from "./ast.js";

export class ParseError extends Error {}

// A tiny cursor over the token list. `peek` looks without consuming; `expect`
// consumes a token of a required kind or throws. Almost all recursive-descent
// parsers are built on exactly these two primitives.
class TokenStream {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  peek(): Token {
    return this.tokens[this.i]!; // there's always an eof sentinel at the end
  }

  advance(): Token {
    return this.tokens[this.i++]!;
  }

  expect(kind: TokenKind): Token {
    const t = this.peek();
    if (t.kind !== kind) {
      throw new ParseError(
        `Expected '${kind}' but found '${t.kind}' ('${t.value}') at ${t.pos}`,
      );
    }
    return this.advance();
  }
}

// The Pratt binding-power / operator table. One lookup answers every question
// the parse loop asks about an infix token: is it an operator at all (present
// in the map), how tightly does it bind, does it associate left or right, and
// which AST node does folding it produce?
//
// Only the RELATIVE order of `bp` matters: `* / %` (50) bind tighter than
// `+ -` (45), which is what makes `2 + 3 * 4` group as `2 + (3 * 4)`. The
// absolute numbers are Sandler's, spaced to leave room for operators that slot
// between these tiers in later chapters (shifts, `?:`, `,`, ...). Assignment
// sits at 1 rather than 0 so the comma operator can later go below it.
//
// Left-associativity is the silent default; only `=` opts out. The two axes
// happen to coincide today (the one right-associative operator is also the one
// non-Binary node), but they come apart in ch6: `?:` is right-associative AND
// builds a third node kind.
type OpEntry = { bp: number; rightAssoc?: boolean } & (
  { node: "Binary"; op: BinaryOp } | { node: "Assign" }
);

const INFIX_OPS: Partial<Record<TokenKind, OpEntry>> = {
  "+": { bp: 45, node: "Binary", op: "Add" },
  "-": { bp: 45, node: "Binary", op: "Subtract" },
  "*": { bp: 50, node: "Binary", op: "Multiply" },
  "/": { bp: 50, node: "Binary", op: "Divide" },
  "%": { bp: 50, node: "Binary", op: "Remainder" },
  "<": { bp: 35, node: "Binary", op: "LessThan" },
  "<=": { bp: 35, node: "Binary", op: "LessOrEqual" },
  ">": { bp: 35, node: "Binary", op: "GreaterThan" },
  ">=": { bp: 35, node: "Binary", op: "GreaterOrEqual" },
  "==": { bp: 30, node: "Binary", op: "Equal" },
  "!=": { bp: 30, node: "Binary", op: "NotEqual" },
  "&&": { bp: 10, node: "Binary", op: "And" },
  "||": { bp: 5, node: "Binary", op: "Or" },
  "=": { bp: 1, node: "Assign", rightAssoc: true },
};

// <program> ::= <function>
export function parse(tokens: Token[]): Program {
  const ts = new TokenStream(tokens);
  const fn = parseFunction(ts);
  // After the single function, nothing but EOF may remain. Catching trailing
  // junk here is what makes "int main(void){return 0;} foo" a parse error.
  ts.expect("eof");
  return { kind: "Program", function: fn };
}

// <function> ::= "int" <identifier> "(" "void" ")" "{" { <block-item> } "}"
//
// The body is a sequence of BLOCK ITEMS, not statements: a declaration is not a
// statement in C. One token of lookahead separates them — only a declaration
// can start with a type keyword.
function parseFunction(ts: TokenStream): FunctionDef {
  ts.expect("int");
  const name = ts.expect("identifier").value;
  ts.expect("(");
  ts.expect("void");
  ts.expect(")");
  ts.expect("{");

  const body: BlockItem[] = [];
  while (ts.peek().kind !== "}") {
    if (ts.peek().kind === "int") {
      body.push(parseDeclaration(ts));
    } else {
      body.push(parseStatement(ts));
    }
  }

  ts.expect("}");
  return { kind: "Function", name, body };
}

// <declaration> ::= "int" <identifier> [ "=" <exp> ] ";"
//
// The `=` here is initializer syntax, NOT the assignment operator — it produces
// no value. Testing for its presence (rather than for a `;`) keeps the optional
// part reading like the grammar and leaves one exit that always eats the
// terminator. `parseExpression(ts, 0)` is right while `,` doesn't exist; once it
// does, an initializer must bind tighter than it (C calls this position an
// assignment-expression), so the floor becomes comma's bp + 1.
function parseDeclaration(ts: TokenStream): Declaration {
  ts.expect("int");
  const name = ts.expect("identifier").value;
  const decl: Declaration = { kind: "Declaration", name };
  if (ts.peek().kind === "=") {
    ts.advance();
    decl.init = parseExpression(ts, 0);
  }
  ts.expect(";");
  return decl;
}

// <statement> ::= "return" <exp> ";" | <exp> ";" | ";"
//
// The bare `;` must be checked BEFORE falling through to the expression case,
// or it reaches parseAtom, which has no way to start an expression from it.
function parseStatement(ts: TokenStream): Statement {
  switch (ts.peek().kind) {
    case "return": {
      ts.expect("return");
      const exp = parseExpression(ts, 0);
      ts.expect(";");
      return { kind: "Return", exp };
    }
    case ";": {
      ts.advance();
      return { kind: "Null" };
    }
    default: {
      const expr = parseExpression(ts, 0);
      ts.expect(";");
      return { kind: "ExpressionStatement", exp: expr };
    }
  }
}

// <atom> ::= <int> | <identifier> | <unop> <atom> | "(" <exp> ")"
// <unop> ::= "-" | "~" | "!"
//
// Parses a single "atom": a literal, a variable reference, a parenthesized
// expression, or a prefix unary applied to another atom. Prefix operators have
// no precedence problem (they bind tighter than any infix operator), so plain
// recursive descent is enough. Infix operators and their precedence live in the
// Pratt loop, parseExpression.
function parseAtom(ts: TokenStream): Expression {
  const tok = ts.peek();

  switch (tok.kind) {
    case "constant": {
      ts.advance();
      return { kind: "Constant", value: Number(tok.value) };
    }
    case "(": {
      ts.advance();
      const exp = parseExpression(ts, 0);
      ts.expect(")");
      return exp;
    }
    case "-": {
      ts.advance();
      return { kind: "Unary", operator: "Negate", operand: parseAtom(ts) };
    }
    case "~": {
      ts.advance();
      return { kind: "Unary", operator: "Complement", operand: parseAtom(ts) };
    }
    case "!": {
      ts.advance();
      return { kind: "Unary", operator: "Not", operand: parseAtom(ts) };
    }
    case "identifier": {
      ts.advance();
      return { kind: "Var", name: tok.value };
    }
    default: {
      // Unlike the exhaustive `never` guards over AST node kinds, this is a
      // real runtime error path: most TokenKinds simply can't START an
      // expression (`;`, `+`, `)`, ...). Reaching one means malformed input.
      throw new ParseError(
        `Expected an expression but found '${tok.kind}' ('${tok.value}') at ${tok.pos}`,
      );
    }
  }
}

// <exp> ::= <atom> { <infix-op> <exp> }
//
// The Pratt loop. `minBP` is a FLOOR: the loosest operator this call is willing
// to fold. Callers starting a fresh expression — `return exp ;`, `( exp )`,
// `= exp ;` — pass 0, because a terminator or closing bracket ends them, not an
// operator, so they accept everything.
//
//   - `left = parseAtom(ts)` grabs the first operand (constant / var / unary /
//     paren).
//   - Each iteration peeks the next token. Not in INFIX_OPS -> not an operator,
//     so we're done. Binds looser than `minBP` -> it belongs to an enclosing
//     call, so we hand `left` back and let that call fold it. The LOOP (rather
//     than pure recursion) is what makes `1 + 2 + 3` chain iteratively.
//   - The floor we recurse at is the associativity knob, and the table decides
//     it per operator. LEFT-associative: recurse at `bp + 1`, so an operator of
//     equal precedence to the right (`... - 3` in `1 - 2 - 3`) is refused by the
//     inner call and folded by this one -> `(1 - 2) - 3`. RIGHT-associative:
//     recurse at `bp`, so the inner call accepts it and folds it itself ->
//     `a = (b = 5)`. Same numbers, one `+ 1`, opposite lean.
function parseExpression(ts: TokenStream, minBP: number): Expression {
  let left = parseAtom(ts);

  while (true) {
    const entry = INFIX_OPS[ts.peek().kind];
    if (entry === undefined || entry.bp < minBP) return left;

    ts.advance();
    const nextMinBP = entry.rightAssoc ? entry.bp : entry.bp + 1;
    const right = parseExpression(ts, nextMinBP);

    if (entry.node === "Assign") {
      left = { kind: "Assign", lvalue: left, rvalue: right };
    } else {
      left = { kind: "Binary", operator: entry.op, left, right };
    }
  }
}
