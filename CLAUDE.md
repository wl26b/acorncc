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
3. **Variables, scope, statements** ✅
4. **Control flow + functions** (loops, `switch`, AAPCS64) ⬜ ← next — *conceptual peak*
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
- **Assembly oracle:** `tools/oracle.sh` — wraps `clang -S`, strips the noise
  (`.cfi_*`, sections, inline comments), and takes a file *or* an inline
  snippet. `--shape` compares opcode sequences with acorncc's, operands and
  label names dropped; `--diff` is the full text diff. **Predict the assembly
  first, then run it** — the gap is the learning. `-O0` answers "what goes
  where" (frame layout, loop structure); `-O1` answers "which instruction"
  (`cbz`, `cset`, `csel`) but rotates loops, so don't copy its structure.
- **Format:** `npm run format` (Prettier; `*.md` excluded so it doesn't fight the
  hand-wrapped prose).
- Test suite lives at `writing-a-c-compiler-tests/` — a gitignored upstream repo,
  not vendored. Clone it there; a shallow clone is fine.
- **Authorship log:** when a chapter turns green (or a notable chunk lands), add a
  row to `docs/authorship-log.md` recording who wrote it. This is the user's
  record of what they personally built — don't inflate Claude's cleanups into user
  work or vice versa.
- **Remote:** `github.com/wl26b/acorncc` (private), `main` tracking
  `origin/main`. Still solo and no CI, so force-pushing to tidy history is fine
  — that stops being true the moment anyone else clones it.

## Current status

**M2 complete — chapter 4 green (105/105).** The full expression language works:
constants, unary `-`/`~`/`!`, binary `+ - * / %` with Pratt precedence and
associativity, and `== != < > <= >=` / `&& ||`. The driver preprocesses with
`clang -E -P` before lexing (M7's strategy pulled forward; M7 extends the same
call with `-nostdinc -I <ourheaders>`). Who wrote what:
`docs/authorship-log.md`.

**M3 complete — chapters 5, 6 and 7 green (202/202).** Local variables,
control flow and lexical scope all work end to end. The pipeline gained a
**third stage**, `resolve.ts` (`--validate`), which rejects what parses but
doesn't mean anything (undeclared variables, duplicate declarations, invalid
lvalues) and renames each variable uniquely. Codegen gained **real ARM64 stack
frames**: slot layout, 16-byte alignment, and fp-anchored addressing — locals
anchor to `fp` rather than `sp` because the expression stack machine moves `sp`
mid-expression.

Chapter 6 added the first control flow: `If` (statement) and `Conditional`
(expression), sharing the field names predicate / consequent / alternative.
`?:` lives in the Pratt table for its binding power but folds on its own path —
different arity, and its two operands take different floors (consequent 0,
alternative `bp`).

Chapter 7 added blocks, and was almost entirely a semantic-analysis chapter.
`Scope` became `{ vars, parent? }` so `lookup` (walks outward, for the
undeclared check) and `declaredHere` (refuses to, for the duplicate check) can
disagree — which is what lets `{ int b; }` shadow while `{ b = 2; }` resolves.
The function body is deliberately NOT a `Compound`: both are runs of block
items, but only a `Compound` is a *statement*, and being a statement is what
opens a scope — routing the body through one would give ch9's parameters and
the body's outermost block two scopes instead of one. Codegen emits **nothing**
for a block; scope is entirely consumed upstream.

**Next → M4, starting with chapter 8: loops** (`while`, `for`, `do`, plus
`break`/`continue`), then ch9 functions and AAPCS64 — the conceptual peak. This
is also where the AST→IR ("TACKY") split becomes hard to avoid, since loop
codegen wants labels the AST shape doesn't naturally provide. Codegen is
USER-writes; Claude specs + reviews. Oracle: `clang -S -O0` for anything about
stack frames (at `-O1` locals live in registers and there's no frame to diff
against), `-O1` for instruction selection.

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
- **One data structure answering two questions is a bug waiting for a feature.**
  `resolve.ts`'s flat `Map` answered "declared here?" and "declared anywhere
  enclosing?" identically for two chapters — correctly, because nothing could
  nest. Blocks made the answers contradict, and the fix wasn't cleverness, it
  was noticing the questions had always been distinct. The ch5 comment saying so
  is what made ch7 a rename rather than a redesign; the general habit is to name
  the *questions* even while one lookup answers all of them.
- **Scope by value, not by push/pop.** Entering a block builds a new `Scope`
  linked to its parent and hands it down; leaving is just returning. "The inner
  scope dies at `}`" becomes ordinary variable lifetime, so a forgotten pop is
  not a bug that can exist. Prefer the version of a structure where the mistake
  is unrepresentable over the one where it's merely avoided — same reason the
  `If` false-branch target is chosen up front.
- **Sameness of shape is not sameness of kind.** A function body and a `{ ... }`
  block are both runs of block items, so they share `parseBlock`. But only the
  block is a *statement*, and being a statement is what opens a scope — so the
  body is a bare `BlockItem[]`, not a `Compound`. Unifying them would silently
  give ch9's parameters a scope separate from the body's, accepting
  `int f(int a) { int a; }`. Share the syntax, not the semantics.
- **A function that owns half a bracket pair will find a caller that
  mismatches.** `parseBlock` briefly consumed `}` but left `{` to its caller;
  the two call sites disagreed and it spun into infinite mutual recursion. Make
  the unit of consumption a complete construct.
- **A floor is a refusal, and refusal needs a recipient.** `bp < minBP → return`
  only works because an *enclosing* loop is sitting at the same token, ready to
  fold what this call declined. Inside a bracketed operand there is no such
  call — the enclosing one is parked mid-fold, past the closing delimiter — so a
  floor above 0 there doesn't hand the operator up, it drops it. That's why the
  ternary's consequent parses at 0 (closed by `:`) while its alternative parses
  at `bp` (open on the right), and why `return exp ;` / `( exp )` / `= exp ;`
  have always passed 0. Sort every call site by *what closes it*: a terminator
  or bracket → 0; more expression → a real floor.
- **A delimiter is not an operator.** `:` gets no row in the Pratt table, and
  the absence does work: the middle operand terminates precisely because the
  loop looks `:` up and finds nothing. Give it a binding power and the middle
  swallows its own closing token. Same reason `)` has no bp.
- **A label's definition and every branch targeting it must move together.**
  Making the alternative label conditional while leaving `beq` aimed at it
  yields *assembler local symbol not defined*. Choosing the false target up
  front (`alternative ? freshLabel(…) : endLabel`) makes the mismatch
  unrepresentable rather than merely avoided. Silver lining: an undefined local
  label is a hard assembler error, so that class of bug can't reach a running
  binary — a branch to the *wrong* defined label would have.
- **Branches need no operand stack.** `Binary` parks its left operand because
  both operands must exist *simultaneously* to combine. In `If`/`Conditional`
  the predicate is consumed by `cmp` before either arm runs and exactly one arm
  executes, so nothing is live across anything else — `w0` alone survives
  arbitrary nesting.
- **The parser knows shape; meaning needs its own stage.** `2 = 3` and `return a;`
  with no `a` are both well-formed and both meaningless — a context-free grammar
  can't reject either. That's what `resolve.ts` is for, and it *transforms* (name
  resolution) rather than just checking, which is why it returns an AST.

## Deferred bugs

- ~~Large positive immediates~~ — **fixed in ch5.** Constants are now built from
  16-bit chunks (`movz` + optional `movk, lsl #16`). The lesson worth keeping:
  `mov Wd, #imm` is an *alias* the assembler satisfies with movz OR movn OR an
  `orr` bitmask immediate, erroring if none fits rather than expanding to two
  instructions — so which constants work is near-unpredictable (`#2147483646`
  assembles, `#1431655762` does not). Emit `movz` explicitly and the guesswork
  disappears.
- **Still open: negative immediates**, which want the inverted `movn` form.
  Unreachable today (the lexer only produces digit runs, so `-5` is unary
  negation applied to `5`), but minilisp's `ROOT_END` is `((void *)-1)` — due at
  M5. See `docs/minilisp-inventory.md` §6.4.

## Resources

- **Spine:** Nora Sandler, *Writing a C Compiler* (free blog + test suite first;
  buy at the type chapters). x86-64 → translate to ARM64 each step.
- **Depth:** Fraser & Hanson, *A Retargetable C Compiler* (lcc) — per-topic, not
  linear.
