# acorncc — a C→ARM64 compiler in TypeScript

A compiler for a useful subset of C, written in TypeScript, targeting ARM64 on
macOS. Input is C source text; output is real ARM64 assembly that Clang
assembles and links into a native executable. A ~6-month side project. The
invoked binary is `acorncc`; the repo lives at `~/Dev/acorncc`.

## Goal

Understand the compilation pipeline end to end — especially the **back end** (IR,
instruction selection, register allocation, calling conventions). Explicitly NOT
goals: speed, an optimizer, broad C compatibility. Correct-but-unoptimized is the
target (expect 2–5× slower than `clang -O2`).

## Finish line

`minilisp` (Rui Ueyama's ~1000-line C Lisp interpreter) compiles with acorncc and
passes its own test suite. It's the yardstick because it's a *real,
self-contained, nontrivial* C program — proof the compiler handles useful C, not
toy snippets.

**The C features minilisp uses ARE the language spec.** They're inventoried in
`docs/minilisp-inventory.md` — the source of truth for scope, from which the
milestones are derived. Anything minilisp doesn't use, we don't build; that's
what stops "useful subset of C" from expanding forever.

Worth keeping in mind for the simplifications they buy, all confirmed absent from
minilisp: no floating point, no `long long` beyond pointer width, no `goto`,
`do/while`, bitfields, VLAs, or token-paste/stringize. **Grep-verified against the
real source on 2026-08-08**, along with two larger savings: **no struct is ever
passed or returned by value** (deleting the hardest part of AAPCS64) and
**`va_arg` is never called** (so varargs needs the ABI but no argument
extraction). The audit also found `continue` *is* used — the inventory had said
otherwise — plus a silent-failure hazard in Apple's varargs ABI:
`docs/minilisp-inventory.md` §6.

## Key decisions (with the cost we accepted)

- **TypeScript.** Effort goes to compiler concepts, not fighting a new language.
  Cost: no self-hosting within 6 months. Write in a plain, C-ish style as cheap
  insurance for a possible later rewrite.
- **ARM64 (AArch64).** Native on Apple Silicon, cleaner ISA to learn on. Cost:
  Sandler's book is x86-64 only, so her code-gen is translated to ARM64 at each
  step — that translation *is* concentrated back-end learning. Use
  `clang -S -O0` (or `-O1`) as the worked-examples oracle, constantly.
- **Pratt parser** for expressions, inside hand-written recursive descent for
  statements/declarations. Kills precedence boilerplate; stays symbol-table-aware
  (needed for C's `typedef` ambiguity).
- **No system headers.** Hand-declare the libc functions we need (`mylibc.h`);
  the linker wires them to the real libc. Supporting `stdio.h` is a compatibility
  goal, not an understanding goal — bad effort-to-learning ratio.
- **Warm up on a hand-written ladder.** Tiny C programs that are strict *subsets*
  of minilisp's features, one new feature per rung (struct → union → function
  pointer → varargs → …), so every warm-up step is also direct progress.

## Milestones

**Full roadmap + live status: `docs/milestones.md`** (the source of truth — read
it before working a milestone; update its status table as work lands). Summary,
each ending in something that RUNS:

1. **Skeleton** ✅
2. **Expressions** (unary + binary + logical/relational, Pratt) ✅
3. **Variables, scope, statements** ⬜ ← next
4. **Control flow + functions** (loops, `switch`, AAPCS64) — *conceptual peak*
5. **Types + storage** (int/long/unsigned/char, pointers, enum, static storage)
6. **Aggregates** (arrays, structs + unions + function pointers + compound literals)
7. **minilisp bring-up + harden** (varargs + preprocessor-via-`clang -E`) — **done = minilisp passes**

Sandler/test-suite *chapter* numbers are a separate axis from *milestone*
numbers — full mapping in `docs/milestones.md`.

Other docs: `docs/minilisp-inventory.md` (scope source of truth),
`docs/authorship-log.md` (who wrote what — update when a chapter turns green).

## How we work (guidance for Claude)

Learning is the point, so allocate work by learning value:

- **Core concepts → the USER writes, Claude reviews.** Codegen, ARM64, the Pratt
  parser, AAPCS64, register allocation. Default mechanism: Claude scaffolds
  structure with `// TODO(you)` holes, or the user writes and Claude reviews like
  a senior eng. Do NOT hand these over whole.
- **AST node design → the USER writes, Claude reviews the shape.** The user opted
  into this (wrote the Unary/Binary nodes). Light design exercise ("what must this
  node hold?"), not boilerplate — don't pre-generate node definitions.
- **Boilerplate → Claude generates.** Driver, cursors, config, the lexer, plain
  recursive descent.
- **Technique: predict-then-verify.** Predict the assembly, then diff against the
  `clang -S` oracle. The test suite is the red/green loop — let the user struggle
  productively; step in when asked.

Claude has a bias toward just doing the task; the user may need to hold Claude to
scaffold/review mode, and Claude should proactively offer it for core work.

## Conventions & commands

- **Commits:** conventional-commit style scoped by pipeline stage —
  `feat(codegen): ...`, `fix(parser): ...`. State the *capability* gained (and
  the chapter it turns green). NOT "Month N" / "Chapter N" as the message.
- **Test:** `npm test -- --chapter N` (add `--stage parse` to test the front end
  without codegen; `--latest-only` to skip earlier chapters).
- **Typecheck:** `npm run typecheck` — a *separate* gate from the tests, which run
  via `tsx` and never typecheck.
- **Assembly oracle:** `clang -S -O1 x.c -o -`.
- **Format:** `npm run format` (Prettier; `*.md` excluded so it doesn't fight the
  hand-wrapped prose).
- Test suite lives at `writing-a-c-compiler-tests/` — a gitignored upstream repo,
  not vendored. Clone it there; a shallow clone is fine.
- **Authorship log:** when a chapter turns green (or a notable chunk lands), add a
  row to `docs/authorship-log.md` recording who wrote it. This is the user's
  record of what they personally built — don't inflate Claude's cleanups into user
  work or vice versa.
- **Remote:** none yet. Solo repo, so force-pushing to tidy history is fine once
  one exists (would not be with collaborators/CI).

## Current status

**M2 complete — chapter 4 green (105/105).** The full expression language works:
constants, unary `-`/`~`/`!`, binary `+ - * / %` with Pratt precedence and
associativity, and `== != < > <= >=` / `&& ||`. The driver preprocesses with
`clang -E -P` before lexing (M7's strategy pulled forward; M7 extends the same
call with `-nostdinc -I <ourheaders>`). Who wrote what:
`docs/authorship-log.md`.

**In progress → chapter 5: local variables**, the start of **M3 (variables,
scope, statements)**. Lex, parse, and **validate** all green (147/147 each):
declarations, assignment, block items, a Pratt table that now carries
associativity and node kind as well as binding power, and `resolve.ts` — a new
third pipeline stage (`--validate`) that rejects undeclared variables, duplicate
declarations and invalid lvalues, and renames each variable uniquely for ch7's
shadowing. **Remaining: codegen** — real ARM64 stack frames, `sp`-relative
slots, prologue/teardown, plus arms for `Var`/`Assign`/`ExprStmt`/`Null` and
`BlockItem[]` bodies. Then ch6 `if`/`?:`, ch7 blocks. Codegen is USER-writes;
Claude specs + reviews; oracle `clang -S -O1`. The AAPCS64 "conceptual peak" and
the likely AST→IR ("TACKY") split land around ch8–9 (M4), not now.

### Lessons banked

- **The `never` exhaustiveness guard is context-dependent.** When a switch
  exhausts an operator union *directly* (the Unary guard), TS collapses the whole
  `exp` to `never` → assign `exp`. When variants are *peeled off first* by early
  `if`/`return` (the Binary guard peels `And`/`Or`), only the *property* narrows →
  assign `exp.operator`. Each guard's comment explains its own case.
- **Truthiness is *nonzero*, not `== 1`.** Short-circuit `||` must test `#0`/`bne`,
  not `#1`/`beq`. `emitShortCircuit` derives the fall-through value as
  `1 - shortVal` so `&&` and `||` can't drift apart.
- **`minBP` is a *floor*, and associativity is which floor you recurse at.**
  Left-assoc recurses at `bp + 1` (an equal-precedence operator to the right is
  refused by the inner call, folded by the outer → `(1-2)-3`); right-assoc
  recurses at `bp` (the inner call accepts and folds it → `a = (b = 5)`). Same
  numbers, one `+ 1`, opposite lean. Fresh-expression contexts (`return exp ;`,
  `( exp )`, `= exp ;`) pass 0 because a terminator ends them, not an operator.
- **Assignment is not a binary operator, even though it parses like one.** Every
  `BinaryOp` evaluates both operands to values; assignment needs its left operand
  as a *location*. Hence a separate `Assign` node sharing the Pratt table but not
  the `BinaryOp` union — putting `"Assign"` in that union makes codegen's `never`
  guard demand an unreachable arm. Corollary: `=` sits at bp 1, not 0, so the
  comma operator can later go below it.
- **The parser knows shape; meaning needs its own stage.** `2 = 3` and `return a;`
  with no `a` are both well-formed and both meaningless — a context-free grammar
  can't reject either. That's what `resolve.ts` is for, and it *transforms* (name
  resolution) rather than just checking, which is why it returns an AST.

## Deferred bugs

- `mov w0, #N` only encodes immediates fitting one movz/movk chunk (≤16 bits,
  16-bit-aligned shift); e.g. `#70000` won't assemble. Fix with movz/movk pairs
  or `ldr w0, =N` when constants get large (M5-ish). The fix must also cover the
  **inverted (`movn`)** case: minilisp's `ROOT_END` is `((void *)-1)`. Its only
  literal above 65535 is `MEMORY_SIZE 65536`, which happens to encode as
  `movz #1, lsl #16` — so plain constants won't bite, but `-1` will.

## Resources

- **Spine:** Nora Sandler, *Writing a C Compiler* (free blog + test suite first;
  buy at the type chapters). x86-64 → translate to ARM64 each step.
- **Depth:** Fraser & Hanson, *A Retargetable C Compiler* (lcc) — per-topic, not
  linear.
