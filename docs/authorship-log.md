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
| M3 / ch5 | `81f6ffe` | Lexer: `=` token | Claude | boilerplate (maximal-munch ordering after `==`) |
| M3 / ch5 | `81f6ffe` | AST: `Declaration`, `Var`, `Assign`, `ExpressionStatement`, `Null`, `BlockItem` | **User** | reviewed shape — argued `init` must be a full `Expression` and optional, argued against a `typ` field until real types exist, suggested naming the `BlockItem` union and the `ExpressionStatement` rename |
| M3 / ch5 | `81f6ffe` | Parser: `parseDeclaration`, three statement forms, `Var` atom | **User** | reviewed; caught the un-consumed `;`, suggested testing for `=` rather than for `;` |
| M3 / ch5 | `81f6ffe` | Pratt table generalised to carry associativity + node kind (`=` right-assoc, non-`Binary`) | **User** | reviewed; caught `=` parsing left-associative, and that putting `"Assign"` in `BinaryOp` forces an unreachable arm in codegen's `never` guard |
| M3 / ch5 | `81f6ffe` | Driver: `--validate` stage | Claude | boilerplate |
| M3 / ch5 | `81f6ffe` | `resolve.ts` — the new semantic-analysis stage | **User → Claude-reviewed** | Claude scaffolded the file (structure + `TODO(you)` holes + contracts); user wrote all the logic; Claude caught the `exp.left`/`exp.right` typo that silently skipped right subtrees, then did error messages and comment cleanup |
| M3 / ch5 | `47d0ce1` | Codegen: `layoutFrame`, fp-anchored slots, prologue/epilogue, `Var`/`Assign`/`Declaration` arms, `movz`/`movk` constants | **User → Claude-reviewed** | specced the ARM64 (frame layout, 16-byte alignment, `stp`/`ldp`, `fp` vs `sp` anchoring) and predicted the `sp`-moves-mid-expression trap before it was written; caught the `#--4` double-negation, `ret` firing before the epilogue, and the missing implicit `return 0`; extracted `slotOf`/`emitPrologue`/`emitEpilogue` and reworked comments |

## Running tally of user-authored work

- **Front end:** unary + binary expression parsing, the entire Pratt loop (incl.
  ch4's relational/equality/logical precedence tiers and ch5's generalisation to
  carry associativity and node kind), all AST node designs (`Unary`, `Binary`
  and their operator tags; `Declaration`, `Var`, `Assign`,
  `ExpressionStatement`, `Null`, `BlockItem`), and the declaration/statement
  parsing.
- **Middle end:** all of `resolve.ts`'s logic — scope map, undeclared-variable
  and duplicate-declaration checks, lvalue validation, and the unique-renaming
  that makes ch7's shadowing tractable. (Claude scaffolded the file's structure;
  the user filled every hole.)
- **Back end:** all codegen written so far — constant returns, unary ops (incl.
  `!`), the binary-operator stack machine, the comparison ops (`cmp`/`cset`), the
  short-circuit `&&`/`||` branch logic, and ch5's **stack frames**: slot layout,
  16-byte alignment, fp-anchored addressing, prologue/epilogue, and chunked
  constants via `movz`/`movk`.
- **Not yet touched by user (still ahead):** control flow (`if`/`?:`, loops,
  `switch`), functions/AAPCS64, types, aggregates.

## Next up (so the log stays honest about what's user work vs. not)

- **ch6 — `if` / `?:`** (continues M3): the `If` statement and `Conditional`
  expression. `?:` goes in the Pratt table for its binding power but needs its
  own branch in the loop — it must consume a middle expression and expect `:`,
  so it can't share the generic two-operand fold. Codegen reuses the label and
  branch machinery from `&&`/`||`; the new part is that `?:` must produce a
  *value*, so both arms converge on the same register. USER-writes codegen;
  Claude specs/reviews. Oracle: `clang -S -O0` for anything about frames,
  `-O1` for instruction selection.
