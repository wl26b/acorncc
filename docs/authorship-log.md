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
| M3 / ch6 | `7277bdf` | Lexer: `if`/`else` keywords, `?`/`:` tokens | Claude | boilerplate |
| M3 / ch6 | `7277bdf` | AST: `If` statement + `Conditional` expression | **User** | reviewed shape; user chose Scheme's predicate/consequent/alternative naming after weighing ESTree/clang/Sandler conventions; Claude argued `If` over `IfElse` (the else is optional) and `Conditional` over `Ternary` (arity names in this file mean operator *families*, which `?:` isn't), and flagged that `else`/`then` as TS field names bring a destructuring restriction and the thenable trap |
| M3 / ch6 | `7277bdf` | Parser: `if`/`else` statement with greedy dangling-else | **User** | reviewed — correct first time |
| M3 / ch6 | `7277bdf` | Parser: `?:` in the Pratt loop (table row + its own fold path) | **User** | specced why `?` needs a binding power at all (else `2 * 0 ? 5 : 6` mis-parses) and why `:` must NOT have one; caught the generic `right` running before the Conditional branch (double-parsing the middle), then the alternative at floor 0 instead of `bp`, then a duplicated `expect(":")`; user derived the floor asymmetry from the C grammar's conditional-expression rule |
| M3 / ch6 | `7277bdf` | `resolve.ts`: `If` + `Conditional` arms | **User** | reviewed — correct first time; noted only a truthiness-vs-`!== undefined` consistency nit |
| M3 / ch6 | `7277bdf` | Codegen: `If` and `Conditional` branch emission, label/join layout | **User → Claude-reviewed** | specced the skeleton and posed the two design questions (why no operand stack; what the no-`else` shape collapses to); caught the dead `b` to the next instruction, then the half-applied fix that left `beq` pointing at an undefined label; suggested deciding the false target up front; supplied the `clang -S -O1` oracle showing `cbz` (deferred) |
| M3 / ch7 | `abbcca7` | AST: `Compound` statement; function body kept as a bare `BlockItem[]` | **User** | reviewed shape; walked through the three candidate designs and why sharing `parseBlock` but NOT statement-hood is the one that survives ch9's parameter scope |
| M3 / ch7 | `abbcca7` | Parser: `parseBlock` extracted and shared by function body + block statement | **User → Claude-reviewed** | caught that `parseBlock` consumed `}` but not `{`, so the two call sites disagreed and spun into infinite mutual recursion; caught the lowercase `"compound"` tag and the grammar comment saying `<statement>` where it holds block items |
| M3 / ch7 | `abbcca7` | `resolve.ts`: nested `Scope` (`{ vars, parent? }`), `lookup` / `declaredHere`, the `Compound` case | **User** | posed the two-questions framing and the three structure options (chain / parent link / copied map + flag), recommended the parent link because it keeps every signature single-argument; caught the walk using `scope` where it meant `currScope` — twice, giving both a lookup that never walked and an infinite loop; caught `Compound` handled in both `resolveBlockItem` and `resolveStatement`; suggested naming the two lookups after the two questions |
| M3 / ch7 | `abbcca7` | Codegen: recursive `layoutFrame` walk, `emitBlock`, `Compound` emission | **User → Claude-reviewed** | flagged the `If`-arm recursion trap a chapter ahead (an arm can BE a block) and posed the slot-reuse decision explicitly; caught that `emitBlock` was extracted but `emitFunction` still had the inline loop; comment pass recording the monotonic-allocation decision |

| Interlude | `38661fa` | `tacky.ts` — the IR types | Claude | proposed the instruction set and the two criteria that generate it (context-free emittability, fixed expansion); user confirmed the two decisions with consequences — `Var` covering temporaries, `And`/`Or` excluded |
| Interlude | `38661fa` | `lower.ts` — AST → TACKY | **User → Claude-reviewed** | Claude scaffolded the file (contracts + `TODO(you)` holes, two leaf cases as a model); user wrote all the lowering. Claude caught the declaration copying into a fresh temporary instead of the declared name, and the `If` emitting `Label` where `Jump` belonged (both arms ran, label defined twice); user's `&&`/`\|\|` and `?:` were correct first time |
| Interlude | `38661fa` | Codegen rewritten onto TACKY — `layoutFrame`, `loadVal`/`storeVal`, the eight templates | **User → Claude-reviewed** | Claude scaffolded and specced the ladder (chapters map onto instruction kinds); user wrote every template. Claude caught `mov` re-introducing the ch5 large-immediate bug, `bl` where `b` belonged, conditional jumps not loading their condition, and `LessOrEqual` using `LT` |
| Interlude | `38661fa` | `--tacky` driver stage + IR printer; `tools/oracle.sh` | Claude | boilerplate/tooling |
| M4 / ch8 | `4c939ab` | Lexer: `while` / `do` / `for` / `break` / `continue` keywords | Claude | boilerplate (no new operators — `for`'s header reuses `;` `(` `)`) |
| M4 / ch8 | `4c939ab` | AST: `While`, `DoWhile`, `For`, `Break`, `Continue`, `loopId`, and the `ForInit` union | **User** | reviewed shape — caught the loop body typed `BlockItem[]`, which would have accepted `while (c) int x = 1;`; confirmed `loopId?` optional (only a traversal can fill it) and `Break`/`Continue` as two nodes rather than one tagged node; later argued the `ForInit` wrapper, since a bare `Declaration \| Expression` FLATTENS to seven `kind`s and so admits no `never` guard, and applied that refactor |
| M4 / ch8 | `4c939ab` | Parser: `while`, `do`, `for`, `break`, `continue` | **User** | Claude scaffolded the cases, then reset them at the user's request so the user wrote every one; caught the `do` case never consuming its trailing `;` — a *permissive* bug that valid-program tests cannot find, because the orphaned `;` is absorbed by the `Null` statement — and three successive `for`-header bugs: non-empty slots not consuming their terminator, the post slot testing `;` instead of `)`, then the dead empty-post branch |
| M4 / ch8 | `4c939ab` | `resolve.ts`: loop labelling (`currentLoop` threading), the `for`-header scope, `break`/`continue`-outside-a-loop errors | **User** | specced the binding-vs-placement split (which loop does this `break` belong to — resolve's job, caused by nesting; where does the continue label sit — lower's job, caused by loop form) and the by-value threading; caught `DoWhile` missing from `resolveBlockItem`'s case list (the `never` guard found it), the missing `break`/`continue` error check, and `For` not passing `loopId` into its body |
| M4 / ch8 | `4c939ab` | `lower.ts`: `While`, `DoWhile`, `For`, `Break`, `Continue`, `deriveLoopLabel` | **User** | specced labels-by-role (so `Break`/`Continue` lowering is identical for all three forms) and the 2-vs-3 label split; caught `do`'s continue label aimed at the top of the body instead of the test, and `for` missing its body, its backward `Jump` and its start label |
| M4 / ch8 | `4c939ab` | Codegen | — | **untouched** — the chapter added no IR instruction |

## Running tally of user-authored work

- **Front end:** unary + binary expression parsing, the entire Pratt loop (incl.
  ch4's relational/equality/logical precedence tiers, ch5's generalisation to
  carry associativity and node kind, and ch6's `?:` — the first operator with
  its own fold path and per-operand floors), all AST node designs (`Unary`,
  `Binary` and their operator tags; `Declaration`, `Var`, `Assign`,
  `ExpressionStatement`, `Null`, `BlockItem`; `If`, `Conditional`; ch8's
  `While`, `DoWhile`, `For`, `Break`, `Continue` and the `ForInit` union), and
  the declaration/statement parsing including `if`/`else` and all three loop
  forms.
- **Middle end:** all of `resolve.ts`'s logic — the scope structure (flat map
  through ch6, then ch7's parent-linked `Scope` with `lookup`/`declaredHere`),
  undeclared-variable and duplicate-declaration checks, lvalue validation, the
  unique-renaming that makes shadowing tractable, the `If`/`Conditional`/
  `Compound` recursion, and ch8's loop labelling — `currentLoop` threaded by
  value, the `for`-header scope, and the two new errors. (Claude scaffolded the file's structure at ch5; the user
  filled every hole and has written every addition since.)
- **Back end:** all codegen written so far — constant returns, unary ops (incl.
  `!`), the binary-operator stack machine, the comparison ops (`cmp`/`cset`), the
  short-circuit `&&`/`||` branch logic, ch5's **stack frames** (slot layout,
  16-byte alignment, fp-anchored addressing, prologue/epilogue, chunked
  constants via `movz`/`movk`), ch6's **branch emission** for `if`/`else` and
  `?:`, and ch7's **recursive frame layout** over nested blocks. Since the
  TACKY split this is `lower.ts` plus the eight codegen templates; ch8 added
  five lowering cases and nothing in `codegen.ts`.
- **Not yet touched by user (still ahead):** `switch`, functions/AAPCS64,
  types, aggregates.

## Next up (so the log stays honest about what's user work vs. not)

- **ch9 — functions + AAPCS64**: multiple function definitions, calls, and the
  ARM64 calling convention (args in x0–x7, frame setup/teardown, returns). The
  conceptual peak of M4. `resolve.ts` grows a function-name table alongside the
  variable scope, and ch7's decision to keep the function body a bare
  `BlockItem[]` finally pays: parameters and the body's outermost block must be
  ONE scope, so `int f(int a) { int a; }` is a duplicate rather than shadowing.
  Unlike ch8, this one *does* add IR (`FunCall`) and real codegen.
  USER-writes; Claude specs/reviews.
- **Deferred from ch6:** `cbz`/`cbnz` in place of `cmp #0` + `beq`/`bne`, which
  would cover `emitShortCircuit` too. Instruction selection, not correctness.
- **Deferred from ch7:** slot reuse for disjoint block lifetimes — deliberately
  not done; see the note in `layoutFrame`.
