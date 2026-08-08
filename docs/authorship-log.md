# Authorship log — who wrote what

A running ledger of who implemented each piece of acorncc. The point of this file
is **so the user can see, at a glance, what they personally wrote** (the learning
is the point — see CLAUDE.md "How we work"). Updated whenever a chunk of work
lands (by convention, at least each time a test-suite chapter turns green).

Scope is the compiler itself — `src/` and the entry point. Docs aren't tracked.

**Author** column:

- **User** — written by the user from scratch (the conceptual core: codegen,
  ARM64, Pratt parser, AAPCS64, AST node design).
- **User → Claude-reviewed** — user wrote it; Claude reviewed like a senior eng
  and/or applied cleanups. The `Claude's role` note says what the cleanup was.
- **Claude** — Claude generated it (boilerplate: driver, cursors, lexer, config;
  or analysis/docs).

## Before the initial commit

Everything through chapter 4 landed before the repo's first commit, so there are
no commits to point at and no useful dates to record — **these rows are the
record.** Ordered by chapter, which is the real sequence.

Confidence varies, and the distinction is worth keeping: **ch1–ch2 are
reconstructed** from project notes after the fact; **ch3–ch4 were recorded as the
work happened.**

| M / ch | Component | Author | Claude's role |
|--------|-----------|--------|---------------|
| M1 / ch1 | Driver (`main.ts`), lexer (`lexer.ts`), `TokenStream` cursor, AST scaffolding | Claude | boilerplate, per work-split policy |
| M1 / ch1 | Codegen: `return <constant>` → ARM64 (`_main`, `mov w0`, `ret`) | **User** | — |
| M2 / ch2 | `Unary` AST node + `UnaryOp` union | **User** | — |
| M2 / ch2 | Parser: unary/paren/constant dispatch (`parseAtom`) | **User** | — |
| M2 / ch2 | Codegen: unary `neg` / `mvn` | **User** | — |
| M2 / ch3 | `Binary` AST node + `BinaryOp` union | **User** | reviewed shape |
| M2 / ch3 | Pratt parser: `parseExpression(minBP)` + binding-power table | **User** | reviewed; suggested single lookup table |
| M2 / ch3 | Codegen: binary ops (stack-machine park/eval/combine; `sdiv`+`msub` modulo) | **User → Claude-reviewed** | consolidated `BINARY_OPS`, de-duped the 5 cases, fixed the `never` exhaustiveness guards (incl. the same latent bug in the ch2 Unary guard) |
| M2 / ch4 | Lexer tokens (`! && \|\| == != < > <= >=`) | Claude | boilerplate (maximal-munch ordering) |
| M2 / ch4 | AST tags (`Not` + relational/equality/logical `BinaryOp`s) + Pratt precedence tiers | **User** | reviewed shape; formatted the union |
| M2 / ch4 | Parser: `!` prefix in `parseAtom` | Claude | copy of the `~` case, swapping the operator tag |
| M2 / ch4 | Codegen: `!` + comparisons (`cmp`/`cset`), short-circuit `&&`/`\|\|` + `emitShortCircuit` helper | **User → Claude-reviewed** | specced the ARM64; caught the `\|\|` bug (`#1`/`beq`→`#0`/`bne`) and the fall-through complement; comment/nit cleanup |
| M2 / ch4 | Driver: preprocess via `clang -E -P` (M7 strategy pulled forward for `#ifdef` test guards) | Claude | boilerplate / plan-aligned |

## Since the initial commit

Commit-linked, because there's now a history to point at. No dates — the commit
carries its own.

| M / ch | Commit | Component | Author | Claude's role |
|--------|--------|-----------|--------|---------------|
| — | — | *nothing yet — ch5 will be the first row* | — | — |

## Running tally of user-authored work

- **Front end:** unary + binary expression parsing, the entire Pratt loop
  (incl. ch4's relational/equality/logical precedence tiers), all AST node
  designs (`Unary`, `Binary`, and their operator tags).
- **Back end:** all codegen written so far — constant returns, unary ops (incl.
  `!`), the binary-operator stack machine, the comparison ops (`cmp`/`cset`), and
  the short-circuit `&&`/`||` branch logic (the first codegen needing labels).
- **Not yet touched by user (still ahead):** variables & stack frames, control
  flow, functions/AAPCS64, types, aggregates.

## Next up (so the log stays honest about what's user work vs. not)

- **ch5 — local variables** (begins M3): declarations, assignment, a symbol
  table + real ARM64 stack frames. USER-writes codegen; Claude specs/reviews.
