// The lexer (a.k.a. scanner / tokenizer) turns raw source text into a flat list
// of tokens. It is the ONLY stage that looks at individual characters; every
// later stage works with tokens, never chars. That separation is the whole point.

export type TokenKind =
  // keywords
  | "int"
  | "void"
  | "return"
  // punctuation
  | "("
  | ")"
  | "{"
  | "}"
  | ";"
  // operators
  | "-" // negation (unary) / subtraction (binary)
  | "~" // bitwise complement (unary)
  | "--" // decrement: lexed as ONE token so `--x` is never two negations
  | "+"
  | "*"
  | "/"
  | "%"
  | "!" // logical not (unary)
  | "&&" // logical and (short-circuit, binary)
  | "||" // logical or (short-circuit, binary)
  | "==" // equal
  | "!=" // not equal
  | "<" // less than
  | ">" // greater than
  | "<=" // less than or equal
  | ">=" // greater than or equal
  // multi-char / value-bearing
  | "identifier"
  | "constant"
  | "eof";

export interface Token {
  kind: TokenKind;
  // The exact source text. For a constant this is the digits ("42"); for an
  // identifier the name ("main"). For fixed tokens it equals the kind.
  value: string;
  // Byte offset where this token starts — handy for error messages later.
  pos: number;
}

// A lex error. We throw these; the driver catches them and exits non-zero
// WITHOUT writing any output files (that's what --lex tests check for).
export class LexError extends Error {}

// Reserved words. If an identifier-shaped run of characters is in this map,
// it's a keyword, not an identifier.
const KEYWORDS = new Map<string, TokenKind>([
  ["int", "int"],
  ["void", "void"],
  ["return", "return"],
]);

// Each regex is anchored with \G-like behaviour by matching from `pos` using
// `sticky` (y) flag, so it only matches starting exactly at the current index.
const RE_WHITESPACE = /\s+/y;
const RE_IDENTIFIER = /[a-zA-Z_]\w*/y; // C identifier: letter/_ then word chars
const RE_CONSTANT = /[0-9]+/y; // Chapter 1: unsigned decimal integers only

// Punctuation and operators, matched by plain string comparison.
//
// ORDER MATTERS: this list is scanned top to bottom and the first match wins,
// so longer operators MUST come before any operator that is a prefix of them.
// `--` sits before `-` so that "--x" lexes as [--, x] and never as [-, -, x].
// That's "maximal munch": always consume the longest token that matches.
const OPERATORS: TokenKind[] = [
  "--", // must precede "-"
  "-",
  "~",
  "+",
  "*",
  "/",
  "%",
  "&&",
  "||",
  "==",
  "!=", // must precede "!"
  "!",
  "<=", // must precede "<"
  "<",
  ">=", // must precede ">"
  ">",
  "(",
  ")",
  "{",
  "}",
  ";",
];

export function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;

  while (pos < source.length) {
    // 1. Skip whitespace (including newlines/tabs — the tests exercise all).
    RE_WHITESPACE.lastIndex = pos;
    const ws = RE_WHITESPACE.exec(source);
    if (ws && ws.index === pos) {
      pos = RE_WHITESPACE.lastIndex;
      continue;
    }

    // 2. Skip comments. These MUST be checked before the operator table, or
    //    "//" would lex as two "/" (divide) tokens and "/*" as one.
    if (source.startsWith("//", pos)) {
      const nl = source.indexOf("\n", pos);
      pos = nl === -1 ? source.length : nl;
      continue;
    }
    if (source.startsWith("/*", pos)) {
      const end = source.indexOf("*/", pos + 2);
      if (end === -1)
        throw new LexError(`Unterminated block comment at ${pos}`);
      pos = end + 2;
      continue;
    }

    const ch = source[pos]!;

    // 3. Operators and punctuation (maximal munch — see OPERATORS above).
    const op = OPERATORS.find((o) => source.startsWith(o, pos));
    if (op !== undefined) {
      tokens.push({ kind: op, value: op, pos });
      pos += op.length;
      continue;
    }

    // 4. Identifiers and keywords.
    if (/[a-zA-Z_]/.test(ch)) {
      RE_IDENTIFIER.lastIndex = pos;
      const m = RE_IDENTIFIER.exec(source)!;
      const text = m[0];
      const kw = KEYWORDS.get(text);
      tokens.push({ kind: kw ?? "identifier", value: text, pos });
      pos = RE_IDENTIFIER.lastIndex;
      continue;
    }

    // 5. Integer constants.
    if (/[0-9]/.test(ch)) {
      RE_CONSTANT.lastIndex = pos;
      const m = RE_CONSTANT.exec(source)!;
      const end = RE_CONSTANT.lastIndex;
      // A constant must not be glued to identifier characters: `123abc` is a
      // lex error in C, not the two tokens `123` and `abc`. This is exactly
      // what the chapter-1 invalid_lex tests check.
      const next = source[end];
      if (next !== undefined && /[a-zA-Z_]/.test(next)) {
        throw new LexError(`Invalid token: '${m[0]}${next}...' at ${pos}`);
      }
      tokens.push({ kind: "constant", value: m[0], pos });
      pos = end;
      continue;
    }

    // 6. Anything else (@, `, \, ...) is not a valid token.
    throw new LexError(`Unexpected character '${ch}' at ${pos}`);
  }

  tokens.push({ kind: "eof", value: "", pos });
  return tokens;
}
