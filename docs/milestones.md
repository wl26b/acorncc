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
| M3 | Variables, scope, statements | 🔶 in progress (ch5: front end green) |
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

### M3 — Variables, scope, statements 🔶 (in progress)
Locals, assignment, `if`/`else` and `?:`, blocks; a symbol table + real ARM64
stack frames. Sandler ch5–7.

**ch5 — local variables**, where the pipeline grows a third stage:
- ✅ **Front end green** (147/147 lex + parse). `Declaration`/`Var`/`Assign`/
  `ExprStmt`/`Null` AST nodes, block items (a declaration is *not* a statement in
  C, so the function body is a `BlockItem[]`), and the Pratt table generalised
  from `{bp, op}` to also carry associativity and which node to build — `=` is
  the first right-associative operator, and the first infix operator that isn't
  a `Binary`.
- ✅ **Semantic analysis green** (147/147 `--validate`). `resolve.ts`, the new
  third stage, wired into the driver as `--validate`. Two jobs in one walk:
  reject what parses but doesn't mean anything (undeclared variable, duplicate
  declaration, invalid lvalue), and resolve each name to a unique one so ch7's
  shadowing stays distinguishable. Note the pass is *not* idempotent — a `Var`
  is rewritten from source spelling to unique name, and the unique name is not a
  key in the scope map, so each subexpression must be resolved exactly once.
- ⬜ **Codegen** — real ARM64 stack frames (`sp`-relative slots, prologue and
  teardown). Oracle: `clang -S -O1`.

### M4 — Control flow + functions ⬜ (conceptual peak)
Loops (`for`/`while`), `switch`/`case`, then function definitions/calls →
**AAPCS64** (arg passing in x0–x7, frame setup/teardown, returns). Plus the
operators left over from M2–M3: postfix `++`, compound assignment `+= -=`, comma,
and bitwise `&`/`|`. Sandler ch8–9. Likely forces the AST→IR ("TACKY") split that
`codegen.ts` currently only foreshadows.

Added by the 2026-08-08 source audit (see `minilisp-inventory.md`):
- **`continue`** — the inventory previously said minilisp had none; it has two, in
  `read_expr`'s `for(;;)`. Distinct codegen from `break` (jumps to the update
  clause, not the exit).
- **Declarations in the `for`-init clause** — 9 sites, and the variable is scoped
  to the loop rather than the enclosing block.
- Scope *removed*: no `--`, no prefix `++`, and no loop `break` (all 6 `break`s
  are switch-breaks). Struct-by-value is never used either, which deletes the
  hardest part of AAPCS64 — M4 only ever passes scalars and pointers.

### M5 — Types + storage ⬜
int/long/unsigned/char; pointers (incl. pointer arithmetic, subtraction, casts,
`void *`); `enum`; `typedef`; `sizeof` / `offsetof`; string literals; and static
storage — file-scope globals **and function-local `static`** — with
`.rodata`/`.data`/`.bss` emission + global initializers. Type checking +
conversions. **No floating point** (minilisp is int-only — a real simplification).

Also required, and easy to lose because each is one line of C:
- `bool` / `true` / `false` (`_Bool`, or alias int).
- `static` **functions** (internal linkage) — distinct from static *storage*.
- `static inline` — treat as a normal static function.
- `const` qualifier and `__attribute((noreturn))` — parse and ignore.
- **Character literals with escapes** (`'\n'`, `'\0'`, `'\''`) and **string
  literals with escapes** — lexer work, missed by the original inventory reading
  and not yet built. Independent of everything else, so it can land any time.
- **Pointer truthiness** — `if (!bind)`, `if (frame[i])`.

⚠︎ **The success metric changes here.** Through M4, "done" meant *the chapter's
test directory is green*, which works while acorncc is a strict prefix of
Sandler's curriculum. From M5 it stops working: her ch11+ tests exercise
`long long` and integer conversions we deliberately don't build, so chapter-green
becomes unreachable *by construction*. From M5 on, "done" means **the inventory's
items for this milestone are implemented and minilisp is closer to compiling** —
with M7 (minilisp's own test suite) as the real gate. Chapter flags stay useful
for regression-checking M1–M4, not for grading M5+.

### M6 — Aggregates ⬜
Arrays, structs, **unions, anonymous struct/union members, function pointers
(+ function-type `typedef`), compound literals** (e.g. `&(Obj){ TTRUE }`). This
is minilisp's core datatype; basic struct support is not enough — see
`docs/minilisp-inventory.md` §3.

Confirmed by the audit — `struct Obj`'s payload is an **anonymous union
containing anonymous structs**, so `obj->car` flattens through *two* unnamed
levels, exactly as feared. Plus three smaller items the first reading missed:
- **Flexible-array trick** `char name[1]`, over-allocated via `alloc`.
- **Array-to-pointer decay** — `root = root_ADD_ROOT_` assigns `void *[3]` to
  `void *`.
- **Constant-expression folding in an array declarator** — `ADD_ROOT` declares
  `void *root_ADD_ROOT_[size + 2]` where `size` is always a literal, so `[1 + 2]`
  must fold at compile time. Not a VLA, but not a bare literal either.

No multi-dimensional arrays, no designated initializers, no struct-by-value.

### M7 — minilisp bring-up + harden ⬜
The "STOP adding features" phase, its own milestone because two real pieces
remain:
- **Variadic functions** (AAPCS64 varargs — `error(fmt, ...)` → `vfprintf`).
  Half the usual work is absent — minilisp never calls `va_arg`, so no argument
  *extraction* is needed. The remaining half is the ABI, and it's the dangerous
  half: **Apple's arm64 passes all variadic arguments on the stack**, unlike
  generic AAPCS64, and our `va_list` must byte-match what real `vfprintf` reads.
  Both fail silently as garbage output rather than crashing — see
  `minilisp-inventory.md` §6, which also argues for meeting this ABI during
  M4/M5 on a two-line program instead of at M7 inside a 996-line interpreter.
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
