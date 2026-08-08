# Milestones — the plan to reach minilisp

The living roadmap for acorncc. **This file is the source of truth for milestones
and current progress;** CLAUDE.md carries only a one-line-per-milestone summary
and points here. Each milestone ends with something that RUNS — test at every
increment.

Scope is derived from the real minilisp feature inventory
(`docs/minilisp-inventory.md`). The finish line is: minilisp compiles with
acorncc and passes its own test suite (M7).

## Status at a glance

| M | Milestone | Status |
|---|-----------|--------|
| M1 | Skeleton | ✅ done |
| M2 | Expressions | ✅ done (ch4 green) |
| M3 | Variables, scope, statements | ⬜ next |
| M4 | Control flow + functions (AAPCS64) | ⬜ — conceptual peak |
| M5 | Types + storage | ⬜ |
| M6 | Aggregates | ⬜ |
| M7 | minilisp bring-up + harden | ⬜ — **done = minilisp passes** |

## Chapters vs. milestones

Sandler / test-suite **chapter** numbers are a different axis from acorncc
**milestone** numbers: chapters are her curriculum's increments, milestones are
ours. They coincide early, then diverge.

| Sandler chapter | acorncc milestone |
|-----------------|-------------------|
| ch1 skeleton | M1 |
| ch2 unary | M2 |
| ch3 binary ops | M2 |
| ch4 logical & relational (`! && \|\| == < …`) | M2 |
| ch5 local variables | M3 |
| ch6 if / `?:` | M3 |
| ch7 compound statements (blocks) | M3 |
| ch8 loops | M4 |
| ch9 functions | M4 |
| ch10+ storage / types | M5 |

## The milestones

### M1 — Skeleton ✅
`int main(void){return 42;}` runs end to end (lex → parse → codegen → clang →
native exe). Also: read minilisp and derive the feature inventory that defines
scope (`docs/minilisp-inventory.md`).

### M2 — Expressions ✅
Unary + binary operators, precedence via a Pratt parser; intermediate results
shuttled between stack and registers (the first real register/stack juggling).
- ✅ ch2 unary (`neg`/`mvn`), ch3 binary (`+ - * / %`, stack-machine codegen).
- ✅ **ch4 — logical & relational** (`! && || == != < > <= >=`). Comparisons via
  `cmp`/`cset`; `&&`/`||` via short-circuit branches — the first codegen needing
  labels and conditional jumps, even before real control flow. The driver also
  gained a `clang -E -P` preprocess step (M7 strategy pulled forward) to strip
  the tests' `#ifdef SUPPRESS_WARNINGS` guards.

### M3 — Variables, scope, statements ⬜ (next)
Locals, assignment, `if`/`else` and `?:`, blocks; a symbol table + real ARM64
stack frames. Sandler ch5–7.

### M4 — Control flow + functions ⬜ (conceptual peak)
Loops (`for`/`while`), `switch`/`case`, then function definitions/calls →
**AAPCS64** (arg passing in x0–x7, frame setup/teardown, returns). Plus the
operators left over from M2–M3: `++`/`--`, compound assignment, comma, and
bitwise `&`/`|`. Sandler ch8–9. Likely forces the AST→IR ("TACKY") split that
`codegen.ts` currently only foreshadows.

### M5 — Types + storage ⬜
int/long/unsigned/char; pointers (incl. pointer arithmetic, subtraction, casts,
`void *`); `enum`; `typedef`; `sizeof` / `offsetof`; string literals; and static
storage — file-scope globals **and function-local `static`** — with
`.rodata`/`.data`/`.bss` emission + global initializers. Type checking +
conversions. **No floating point** (minilisp is int-only — a real simplification).

### M6 — Aggregates ⬜
Arrays, structs, **unions, anonymous struct/union members, function pointers
(+ function-type `typedef`), compound literals** (e.g. `&(Obj){ TTRUE }`). This
is minilisp's core datatype; basic struct support is not enough — see
`docs/minilisp-inventory.md` §3.

### M7 — minilisp bring-up + harden ⬜
The "STOP adding features" phase, its own milestone because two real pieces
remain:
- **Variadic functions** (AAPCS64 varargs — `error(fmt, ...)` → `vfprintf`).
- **Preprocessor strategy**: don't build a CPP; shell out to
  `clang -E -nostdinc -I <ourheaders>` so the program's own macros expand and
  `#include`s resolve to `mylibc.h`.

Then: write `mylibc.h` (inventory §4), fix deferred bugs (large immediates), throw
minilisp at acorncc, and iterate until it passes minilisp's own test suite.
**Done = this passes.**

## Warm-up ladder
Warm up on small hand-written C programs that are strict subsets of minilisp's
features — one new feature per rung (struct → union → function pointer → varargs
→ …), so every rung is also direct progress toward the finish line.
