import type { Token, TokenKind } from "./lexer.js";
import type {
  Program,
  FunDecl,
  BlockItem,
  Statement,
  VarDecl,
  Expression,
  BinaryOp,
  ForInit,
} from "./ast.js";

export class ParseError extends Error {}

// A tiny cursor over the token list. `peek` looks without consuming; `expect`
// consumes a token of a required kind or throws. Almost all recursive-descent
// parsers are built on exactly these two primitives.
class TokenStream {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  peek(lookahead?: 0 | 1 | 2): Token {
    if (lookahead) {
      const idx = this.i + lookahead;
      if (idx >= this.tokens.length) {
        throw Error("help me here");
      }
      return this.tokens[this.i + lookahead]!;
    }
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
// Left-associativity is the silent default; `=` and `?:` opt out.
//
// `?` earns a row here even though folding it is nothing like folding a binary
// operator, because the table answers the ONE question that is the same for
// every infix token: does this bind tightly enough for the current call to fold
// it, or does it belong to an enclosing one? Without a bp, `2 * 0 ? 5 : 6`
// would fold the conditional in the call parsing `*`'s right operand — where
// `left` is only `0` — and produce `2 * (0 ? 5 : 6)` instead of `(2 * 0) ? 5 :
// 6`. "We've finished the predicate" is true only in the call whose floor `?`
// clears; the bp is what locates that call.
//
// `:` deliberately gets NO row: it's a delimiter, consumed by `expect`, never
// folded. That absence is load-bearing — the middle operand terminates
// precisely because the loop looks `:` up, finds nothing, and returns.
type OpEntry = { bp: number; rightAssoc?: boolean } & (
  | { node: "Binary"; op: BinaryOp }
  | { node: "Assign" }
  | { node: "Conditional" }
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
  "?": { bp: 3, node: "Conditional", rightAssoc: true },
  "=": { bp: 1, node: "Assign", rightAssoc: true },
  // Bitwise, slotting into the gaps ch3 left for exactly this. C puts these
  // BETWEEN `&&` and `==`, which is the single most surprising fact about C's
  // precedence: `&` binds tighter than `==`, so `x & 1 == 0` groups as
  // `x & (1 == 0)` and is the language's most famous precedence bug.
  "|": { bp: 15, node: "Binary", op: "BitwiseOr" },
  "^": { bp: 20, node: "Binary", op: "BitwiseXor" },
  "&": { bp: 25, node: "Binary", op: "BitwiseAnd" },
  // Shifts bind tighter than relational, looser than additive — so
  // `a << 2 + 1` is `a << (2 + 1)`, another one worth knowing.
  "<<": { bp: 40, node: "Binary", op: "ShiftLeft" },
  ">>": { bp: 40, node: "Binary", op: "ShiftRight" },
};

// <program> ::= { <function-declaration> }
//
// A translation unit is a list of function DECLARATIONS, not definitions: a
// bodyless `int f(int);` is a perfectly good top-level item. It emits no code,
// but it is what lets a call be checked before — or without — ever seeing the
// body. At M5 this list also holds file-scope variables.
export function parse(tokens: Token[]): Program {
  const ts = new TokenStream(tokens);

  const functions: FunDecl[] = [];
  while (ts.peek().kind !== "eof") {
    functions.push(parseFunDecl(ts, true));
  }

  // The loop above stops at `eof`; this re-assertion is what makes trailing
  // junk a parse error rather than a silent truncation.
  ts.expect("eof");
  return { kind: "Program", functions };
}

// <function-declaration> ::= "int" <identifier> "(" <params> ")" ( <block> | ";" )
//
// One production for both forms, because C's own terminology nests them: a
// definition IS a declaration that additionally supplies a body. So `body?`
// marks the single thing that distinguishes them.
//
// `allowBody` is REQUIRED, not optional, and that is the ch8 lesson applied —
// an optional parameter is a default you can fall into, and here falling into
// it silently accepts a nested function definition. It is the caller, not this
// function, that knows whether a body is legal: file scope yes, block scope no,
// because a nested function could reference its enclosing frame and C declines
// to have closures.
function parseFunDecl(ts: TokenStream, allowBody: boolean): FunDecl {
  ts.expect("int");
  const name = ts.expect("identifier").value;
  ts.expect("(");

  let params: string[] = [];
  if (ts.peek().kind === "void") {
    ts.expect("void");
    ts.expect(")");
  } else {
    ts.expect("int");
    params.push(ts.expect("identifier").value);
    while (ts.peek().kind !== ")") {
      ts.expect(",");
      ts.expect("int");
      params.push(ts.expect("identifier").value);
    }
    ts.expect(")");
  }

  // The `;` is consumed on EVERY path — a prototype is only a complete
  // statement once it has one, and leaving it behind let a following `{ ... }`
  // parse as an ordinary Compound statement, which then ran. Same shape as
  // ch8's `do`-while bug: an unconsumed terminator gets absorbed downstream and
  // turns a rejection into silently different behaviour.
  let body: BlockItem[] | undefined = undefined;
  if (ts.peek().kind === ";") {
    ts.expect(";");
  } else if (allowBody) {
    body = parseBlock(ts);
  } else {
    throw new ParseError(
      `Function definition of '${name}' is not allowed here (C has no nested functions)`,
    );
  }

  return { kind: "FunDecl", name, params, body };
}

// <block> ::= "{" { <block-item> } "}"
//
// Shared by the function body and by a block in statement position — the two
// are the same syntax, and this is the one place that knows it. Note it
// consumes BOTH braces: an earlier version left the `{` to its caller, and the
// two call sites promptly disagreed about whose job it was, which spun
// parseStatement and parseBlock into infinite mutual recursion. A function that
// owns half a bracket pair will always find a caller that mismatches it.
function parseBlock(ts: TokenStream): BlockItem[] {
  ts.expect("{");
  const block: BlockItem[] = [];
  while (ts.peek().kind !== "}") {
    if (ts.peek().kind === "int") {
      if (ts.peek(2).kind === "(") {
        block.push(parseFunDecl(ts, false));
      } else {
        block.push(parseVarDecl(ts));
      }
    } else {
      block.push(parseStatement(ts));
    }
  }
  ts.expect("}");
  return block;
}

// <declaration> ::= "int" <identifier> [ "=" <exp> ] ";"
//
// The `=` here is initializer syntax, NOT the assignment operator — it produces
// no value. Testing for its presence (rather than for a `;`) keeps the optional
// part reading like the grammar and leaves one exit that always eats the
// terminator. `parseExpression(ts, 0)` is right while `,` doesn't exist; once it
// does, an initializer must bind tighter than it (C calls this position an
// assignment-expression), so the floor becomes comma's bp + 1.
function parseVarDecl(ts: TokenStream): VarDecl {
  ts.expect("int");
  const name = ts.expect("identifier").value;
  const decl: VarDecl = { kind: "VarDecl", name };
  if (ts.peek().kind === "=") {
    ts.advance();
    decl.init = parseExpression(ts, 0);
  }
  ts.expect(";");
  return decl;
}

// <statement> ::= "return" <exp> ";"
//               | "if" "(" <exp> ")" <statement> [ "else" <statement> ]
//               | "while" "(" <exp> ")" <statement>
//               | "do" <statement> "while" "(" <exp> ")" ";"
//               | "for" "(" <for-init> [ <exp> ] ";" [ <exp> ] ")" <statement>
//               | "break" ";"
//               | "continue" ";"
//               | <block>
//               | <exp> ";"
//               | ";"
//
// A block holds BLOCK ITEMS, not statements — which is the whole reason
// `{ int x = 1; }` is legal while `if (p) int x = 1;` is not. Same distinction
// as ch5's function body, now reachable anywhere a statement can go.
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
    case "if": {
      ts.advance();
      ts.expect("(");
      // Floor 0: the predicate is closed on the right by `)`, so no operator
      // can compete for it — same as any parenthesized expression.
      const predicate = parseExpression(ts, 0);
      ts.expect(")");
      // parseStatement, NOT parseBlockItem: the arms are statements, so
      // `if (p) int x = 1;` is rejected here with no check of its own.
      const consequent = parseStatement(ts);

      // Grab an `else` greedily. That single line is the whole answer to the
      // dangling-else problem — in `if (a) if (b) x; else y;` the INNER
      // parseStatement call is the one still running when `else` is peeked, so
      // it claims it, binding the else to the nearest if. Which is C's rule.
      if (ts.peek().kind === "else") {
        ts.advance();
        const alternative = parseStatement(ts);
        return { kind: "If", predicate, consequent, alternative };
      }

      return { kind: "If", predicate, consequent };
    }
    case "while": {
      ts.expect("while");
      ts.expect("(");
      const condition = parseExpression(ts, 0);
      ts.expect(")");
      const body = parseStatement(ts);
      return { kind: "While", condition, body };
    }
    case "do": {
      ts.expect("do");
      const body = parseStatement(ts);
      ts.expect("while");
      ts.expect("(");
      const condition = parseExpression(ts, 0);
      ts.expect(")");
      ts.expect(";");
      return { kind: "DoWhile", condition, body };
    }
    case "for": {
      ts.expect("for");
      ts.expect("(");

      // Every arm consumes the init slot's `;` — parseDeclaration eats its
      // own, the other two eat it here — so the condition slot below always
      // starts clean.
      let init: ForInit;
      if (ts.peek().kind === ";") {
        ts.expect(";");
        init = { kind: "InitExp" };
      } else if (ts.peek().kind === "int") {
        init = { kind: "InitDecl", declaration: parseVarDecl(ts) };
      } else {
        const exp = parseExpression(ts, 0);
        ts.expect(";");
        init = { kind: "InitExp", exp };
      }

      let condition: Expression | undefined;
      if (ts.peek().kind === ";") {
        ts.expect(";");
      } else {
        condition = parseExpression(ts, 0);
        ts.expect(";");
      }

      let post: Expression | undefined;
      if (ts.peek().kind !== ")") {
        post = parseExpression(ts, 0);
      }

      ts.expect(")");
      const body = parseStatement(ts);
      return { kind: "For", init, condition, post, body };
    }
    case "break": {
      ts.expect("break");
      ts.expect(";");
      return { kind: "Break" };
    }
    case "continue": {
      ts.expect("continue");
      ts.expect(";");
      return { kind: "Continue" };
    }
    // A block in statement position. The parser builds the node and stops
    // there — it has no notion of scope; opening one is resolve.ts's job.
    case "{": {
      const block = parseBlock(ts);
      return { kind: "Compound", block };
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

      if (ts.peek().kind === "(") {
        ts.expect("(");
        const args: Expression[] = [];
        if (ts.peek().kind !== ")") {
          args.push(parseExpression(ts, 1));
          while (ts.peek().kind !== ")") {
            ts.expect(",");
            args.push(parseExpression(ts, 1));
          }
        }
        ts.expect(")");

        return { kind: "FunCall", name: tok.value, args };
      }
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

// <exp> ::= <atom> { <infix-op> <exp> | "?" <exp> ":" <exp> }
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
//
// The `+ 1` is only ever consulted at EQUAL precedence — with `bp < minBP` as
// the test, `bp + 1` is how you demand "strictly tighter" instead of "at least
// as tight". For operators that differ in precedence the increment changes
// nothing, which is exactly right: associativity is the one bit of information
// precedence doesn't carry.
function parseExpression(ts: TokenStream, minBP: number): Expression {
  let left = parseAtom(ts);

  while (true) {
    const entry = INFIX_OPS[ts.peek().kind];
    if (entry === undefined || entry.bp < minBP) return left;
    ts.advance();

    // `?:` can't ride the generic one-operand path below: it has a different
    // arity AND its two operands take different floors.
    //
    //   consequent  -> 0, because it sits INSIDE the `? ... :` bracket. Nothing
    //     outside can claim part of it, and `:` (not being an operator) is what
    //     stops it. A floor above 0 here could only ever destroy input: a
    //     refused operator between `?` and `:` has no enclosing call to fall
    //     back to, since the enclosing call is parked at this fold. Hence
    //     `a ? b = 1 : c` is legal C.
    //   alternative -> `entry.bp`, because it's open on the right and must
    //     negotiate with whatever follows. Right-associative, so an equal `?`
    //     is folded by the inner call: `a ? b : (c ? d : e)`. And `=` (bp 1)
    //     fails the floor, making `a ? b : c = 1` parse as `(a ? b : c) = 1` —
    //     which is C's grammar (the third operand is a conditional-expression,
    //     not an assignment-expression) and what sends it to the resolver as an
    //     invalid lvalue rather than being accepted here.
    if (entry.node === "Conditional") {
      const consequent = parseExpression(ts, 0);
      ts.expect(":");
      const alternative = parseExpression(ts, entry.bp);
      left = { kind: "Conditional", predicate: left, consequent, alternative };
    } else {
      const nextMinBP = entry.rightAssoc ? entry.bp : entry.bp + 1;
      const right = parseExpression(ts, nextMinBP);

      if (entry.node === "Assign") {
        left = { kind: "Assign", lvalue: left, rvalue: right };
      } else {
        left = { kind: "Binary", operator: entry.op, left, right };
      }
    }
  }
}
