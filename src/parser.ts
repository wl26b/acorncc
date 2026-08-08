import type { Token, TokenKind } from "./lexer.js";
import type {
  Program,
  FunctionDef,
  Statement,
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

// The Pratt binding-power / operator table. One lookup answers both questions
// the parse loop asks: "is this token a binary operator (present in the map),
// and if so, how tightly does it bind and which AST operator is it?".
//
// Only the RELATIVE order of `bp` matters: `* / %` (50) bind tighter than
// `+ -` (45), which is what makes `2 + 3 * 4` group as `2 + (3 * 4)`. The
// absolute numbers are Sandler's, spaced to leave room for operators that slot
// between these tiers in later chapters (shifts, comparisons, &&, =, ...).
const BINARY_OPS: Partial<Record<TokenKind, { bp: number; op: BinaryOp }>> = {
  "+": { bp: 45, op: "Add" },
  "-": { bp: 45, op: "Subtract" },
  "*": { bp: 50, op: "Multiply" },
  "/": { bp: 50, op: "Divide" },
  "%": { bp: 50, op: "Remainder" },
  "<": { bp: 35, op: "LessThan" },
  "<=": { bp: 35, op: "LessOrEqual" },
  ">": { bp: 35, op: "GreaterThan" },
  ">=": { bp: 35, op: "GreaterOrEqual" },
  "==": { bp: 30, op: "Equal" },
  "!=": { bp: 30, op: "NotEqual" },
  "&&": { bp: 10, op: "And" },
  "||": { bp: 5, op: "Or" },
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

// <function> ::= "int" <identifier> "(" "void" ")" "{" <statement> "}"
function parseFunction(ts: TokenStream): FunctionDef {
  ts.expect("int");
  const name = ts.expect("identifier").value;
  ts.expect("(");
  ts.expect("void");
  ts.expect(")");
  ts.expect("{");
  const body = parseStatement(ts);
  ts.expect("}");
  return { kind: "Function", name, body };
}

// <statement> ::= "return" <exp> ";"
function parseStatement(ts: TokenStream): Statement {
  ts.expect("return");
  const exp = parseExpression(ts, 0);
  ts.expect(";");
  return { kind: "Return", exp };
}

// <atom> ::= <int> | <unop> <atom> | "(" <exp> ")"
// <unop> ::= "-" | "~" | "!"
//
// Parses a single "atom": a literal, a parenthesized expression, or a prefix
// unary applied to another atom. Prefix operators have no precedence problem
// (they bind tighter than any binary), so plain recursive descent is enough.
// Binary operators and their precedence live in the Pratt loop, parseExpression.
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

// <exp> ::= <atom> { <binop> <exp> }
//
// The Pratt loop. `minBP` is the tightest binding power this call is allowed to
// stop below: a caller passing 0 accepts any operator; a recursive call passing
// `bp + 1` (see below) refuses to fold anything that binds as loosely as the
// operator it's already handling.
//
//   - `left = parseAtom(ts)` grabs the first operand (constant / unary / paren).
//   - Each iteration peeks the next token. Not in BINARY_OPS -> not an operator,
//     so we're done. Binds looser than `minBP` -> it belongs to an enclosing
//     call, so we hand `left` back and let that call fold it. The LOOP (rather
//     than pure recursion) is what makes `1 + 2 + 3` chain iteratively.
//   - `bp + 1` on the recursive call is the associativity knob. For a
//     left-associative operator we recurse at *higher* min power, so an operator
//     of equal precedence to the right (`... - 3` in `1 - 2 - 3`) is refused by
//     the inner call and folded by this one instead -> `(1 - 2) - 3`. Using `bp`
//     (not `bp + 1`) would make it right-associative.
function parseExpression(ts: TokenStream, minBP: number): Expression {
  let left = parseAtom(ts);

  while (true) {
    const entry = BINARY_OPS[ts.peek().kind];
    if (entry === undefined || entry.bp < minBP) return left;

    ts.advance();
    const right = parseExpression(ts, entry.bp + 1);
    left = { kind: "Binary", operator: entry.op, left, right };
  }
}
