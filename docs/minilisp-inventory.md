# minilisp C-feature inventory — the language spec

Source: `rui314/minilisp` (`minilisp.c`, 996 lines, public domain). This is the
**finish-line program**: acorncc is "done" when this compiles and passes its own
tests. Per CLAUDE.md, *the feature set below IS acorncc's language spec* —
anything minilisp doesn't use, we don't build; anything it DOES use, we must.
The milestones in `docs/milestones.md` are derived from this list.

Each feature is tagged with the milestone that owns it. **Bold** marks the ones
that are easy to underestimate — they get called out again in §3.

**Verified against the real source on 2026-08-08** (996 lines, matching). Every
"absent" claim below was checked by grep rather than assumed, and the audit found
three errors and six omissions in the original hand-reading — all now folded in
and marked ⚠︎ where they changed a milestone's scope. §6 records the one platform
hazard the reading missed entirely.

---

## 1. What minilisp is (so the feature list has context)

A tree-walking Lisp interpreter with: a hand-written recursive-descent **reader**
(S-expressions), an **evaluator** (`eval`/`apply`), **macros** (`defmacro` +
`macroexpand`), and a **Cheney copying garbage collector** over an `mmap`'d
semi-space heap. No floats anywhere — all Lisp numbers are C `int`. The GC is the
source of most of the "hard C": the two-level-pointer root protocol
(`DEFINE1..4`, `ADD_ROOT`) is implemented with **function-like macros**.

## 2. Feature inventory (by category)

### Literals (lexer surface)
- Decimal integer constants only — **no hex, octal, or `u`/`l` suffixes**. The
  ch1 lexer already covers this. ✅
- ⚠︎ **Character literals with escape sequences** — `'\n'`, `'\r'`, `'\t'`,
  `'\0'`, and `'\''` (escaped quote, the awkward one), plus plain `'('`, `')'`,
  `'.'`, `';'`, `'-'`, `' '`, `'0'`. Missed by the first reading; the lexer has no
  rule for these yet. → M5 (with `char`), or earlier — it's cheap and independent.
- ⚠︎ **String literals containing escapes** — `fprintf(stderr, "\n")`. Same gap,
  same fix. → M5

### Types
- `int` — Lisp value, type tag, sizes, counters. → M2/M3 ✅
- `char`, `char *`, `char[]` — symbol names, buffers, string literals. → M5/M6
- `void`, `void *` — generic `root`/heap pointers; **pointer arithmetic on
  `void *`** (`memory + mem_nused`, a GNU extension). → M5 (+ that edge case)
- `bool` / `true` / `false` (`<stdbool.h>`). → M5 (trivially: `_Bool`, or alias
  int)
- `size_t`, `ptrdiff_t` (`<stddef.h>`), `uint8_t` (`<stdint.h>`) — 64-bit
  unsigned/signed + byte type, reached via typedefs. → M5
- `enum` (anonymous, the `TINT..TCPAREN` tags). → M5
- `struct` — self-referential `struct Obj`. → M6
- **`union`** — the object payload is a union. → M6
- **Anonymous struct/union members** — `obj->car`, `obj->value`, `obj->params`
  reach through unnamed nested aggregates (member-name flattening). → M6
- **Flexible-array trick** `char name[1]` sized past its end via `alloc`. → M6
- ⚠︎ **Array-to-pointer decay** — `root = root_ADD_ROOT_` assigns a `void *[3]`
  to a `void *`. → M6
- ⚠︎ **Constant-expression folding in an array declarator** — `ADD_ROOT` declares
  `void *root_ADD_ROOT_[size + 2]`, and `size` is always a literal from
  `DEFINE1`–`DEFINE4`, so `[1 + 2]` must fold to `[3]` at compile time. **Not a
  VLA** (that's why VLAs stay out of scope), but not a bare literal either. → M6
- No multi-dimensional arrays. No designated initializers.
- **Function pointers** + a **typedef of a function type**
  (`typedef struct Obj *Primitive(void*, Obj**, Obj**)`, then `Primitive *fn`,
  called as `(*fn)(...)`). → M6

### Operators (the "full operator set" — itemized)
- Arithmetic `+ - *`, unary `-`, and `/ %`. → M2 ✅
- Bitwise `& | ~` — `~` and `&` in `roundup` (`(var + size - 1) & ~(size - 1)`),
  `|` in the mmap flags. `~` → M2 ✅; `& |` → M4. No `<<`/`>>`, and **no `^`**
  (the `^` in `symbol_chars[]` is inside a string literal, not an operator).
- Comparison `< <= > >= == !=`. → M2 ✅
- Logical `&& || !`. → M2 ✅
- ⚠︎ **Pointer truthiness** — `!` and plain conditions applied to pointers
  (`if (!bind)`, `if (frame[i])`). Needs pointer→bool conversion. → M5
- Ternary `?:`. → M3 (with `if`, ch6 — distinct codegen, short-circuit branches)
- Assignment `=` → M3; **compound `+= -=`** → M4. ⚠︎ Correction: only **postfix
  `++`** is used (5 sites: `i++`, `len++`, `count++`). No `--` anywhere, no prefix
  form. The original "`++`/`--` (pre/post)" over-claimed three of the four — this
  shrinks M4 slightly rather than leaving a hole.
- `sizeof` (of types *and* expressions). → M5 (needs type machinery; used
  constantly)
- `offsetof(Obj, value)` (`<stddef.h>` → `__builtin_offsetof`). → M5
- **Casts**, incl. pointer casts `(uint8_t *)`, `(void ***)`, `(size_t)`. → M5
- Pointer: `*` deref, `&` address-of, `->`, `.`, `[]`; **pointer subtraction**
  (`(uint8_t*)a - (uint8_t*)b`). → M5/M6
- Comma operator, in `for` update clauses. → M4

### Control flow
- `if` / `else` / else-if chains. → M3
- `for` (incl. `for(;;)`, multi-clause, comma update), `while`. → M4
- ⚠︎ **Declarations in the `for`-init clause** — 9 sites (`for (int i = 1; ...)`,
  `for (Obj *p = *env; ...)`). Its own scoping rule: the variable is scoped to the
  loop, not the enclosing block. Missed by the first reading. → M4
- **`switch` / `case` / `default` / fallthrough / `break`** — its own codegen
  (jump logic), not free with the rest of control flow. → M4. 3 switches, 3
  `default:`s. The fallthrough is the easy kind — grouped empty case labels
  sharing one body (`case TINT: case TPRIMITIVE: ... return *obj;`), never a
  case that falls into another case's *statements*.
- `return`. → M3. `break` → M4, and note all 6 uses are **switch**-breaks; no
  loop ever breaks.
- ⚠︎ **`continue`** — correction: the first reading said "no `continue` seen". It
  IS used, twice, in `read_expr`'s `for(;;)` (whitespace and comment skipping),
  and is not removable. Distinct codegen from `break` — it jumps to the update
  clause, not the exit. → M4
- Genuinely absent: no `goto`, no `do/while`.

### Functions
- Definitions, prototypes/forward decls, calls, **recursion**. → M4 (AAPCS64)
- `static` functions (internal linkage). → M5
- `static inline`. → M5 (treat as a normal static function)
- **Variadic function**: `error(char *fmt, ...)` using `va_list`, `va_start`,
  `va_end`, forwarded to `vfprintf`. → M7 (**AAPCS64 varargs** — a hard, distinct
  piece of the calling convention; the *only* user-defined variadic, but it's
  called all over for error handling)
- **Function-local `static`** variable (`gensym`'s `count`, persists across
  calls → lives in `.data`/`.bss`, initialized once). → M5
- `main(int argc, char **argv)`. → M4 (argv unused beyond the signature)

### Storage, linkage, initialization
- File-scope `static` globals with initializers (`Symbols`, `memory`, flags).
  → M5
- `const`-qualified global array (`symbol_chars[]`). → M5 (parse; the qualifier
  can be ignored semantically)
- **String literals** (format strings, `symbol_chars`, `"quote"` …) → `.rodata`.
  → M5
- **Compound literals** used as static initializers: `&(Obj){ TTRUE }` for
  `True`/`Nil`/`Dot`/`Cparen` (partial/positional aggregate init, address taken).
  → M6 (statically-allocated compound literal — notable)
- `__attribute((noreturn))` (GNU attribute on `error`). → M5 (parse-and-ignore)

### Preprocessor  ← the single biggest surprise
acorncc has **no preprocessor of its own**, and won't get one — see §5.1. What
minilisp needs preprocessed (all → M7):
- `#include` (**10** system headers, not 11 as first counted — see §4).
- Object-like `#define` (`MEMORY_SIZE`, `ROOT_END`, `SYMBOL_MAX_LEN`).
- **Function-like macros** with parameters and `\` line-continuations
  (`ADD_ROOT`, `DEFINE1`–`DEFINE4`) — these are **load-bearing**: they declare
  arrays and pointer variables that the GC root protocol depends on.
- **Variadic macros** with `__VA_ARGS__` (`CASE(type, ...)`).
- `#undef`. No `##` token-paste or `#` stringize seen.

## 3. The features that need explicit budget

Each of these hides inside a broad-sounding phrase and needs separately-planned
work. They are the reason scope is derived from this inventory rather than from a
one-line summary of "what a C compiler needs":

1. **Preprocessor** (function-like + variadic macros, includes). The biggest
   single item → §5.1 for the cheap way out.
2. **`union`** and **anonymous struct/union members** — minilisp's central
   datatype is a union with anonymous members. Basic struct support doesn't
   reach it.
3. **Function pointers** + **typedef of function type** — the primitive-dispatch
   mechanism.
4. **Variadic functions** (AAPCS64 varargs) — a distinct, hard sub-feature of the
   calling convention. Only `error`, but used everywhere.
5. **`enum`** — minor, but it disappears if not listed.
6. **`switch`/`case`** — sounds like ordinary control flow; it's its own codegen
   (jump logic).
7. **Function-local `static`** storage.
8. **Compound literals** (`&(Obj){...}`) as static initializers.
9. **`sizeof` / `offsetof`** as first-class operators over types.
10. **Comma operator**, **`++`/`--`**, **compound assignment** — each is real
    codegen work, and each is easily lost inside a blanket "operators" item.
11. **String literals + `.rodata`/`.data`/`.bss`** emission and global
    initializers.

**What's genuinely absent, and stays out of scope** (all grep-verified at zero
occurrences): floating point, `long long` beyond pointer-width, `goto`,
`do/while`, bitfields, `##`/`#`, VLAs, threads, `<<`/`>>`, `^`, hex/octal/suffixed
integer constants, designated initializers, multi-dimensional arrays,
`volatile`/`register`/`restrict`, and the GNU statement-expression / `typeof` /
`alloca` extensions. The int-only numeric model is a real simplification for M5.

**Two absences worth naming as savings, because they remove work you'd otherwise
budget for:**

- **No struct-by-value, anywhere.** Every use is `Obj *` — no struct is ever
  passed to or returned from a function by value. This deletes the single hardest
  part of AAPCS64 (aggregates ≤16 bytes in register pairs, larger ones passed via
  memory with the caller allocating). M4 only ever passes scalars and pointers.
- **No `va_arg`.** `error` uses `va_list`, `va_start`, `va_end` and forwards
  straight to `vfprintf` — acorncc never has to *extract* a variadic argument.
  That's roughly half of what "implement varargs" usually means, gone. What
  remains is the ABI half, and it is not the easy half — see §6.

## 4. libc surface to hand-declare (`mylibc.h`)

Per the "no system headers" decision, these must be declared by hand (linker
wires them to real libc). From the 10 includes — the list below is complete and
grep-verified against every call site:
- **stdio:** `printf`, `fprintf`, `snprintf`, `vfprintf`, `getchar`, `ungetc`;
  globals `stdin`, `stderr`; macro `EOF`.
- **stdlib:** `exit`, `getenv`; macro `NULL`.
- **string:** `strlen`, `strcpy`, `strcmp`, `strchr`, `memcpy`.
- **ctype:** `isdigit`, `isalnum`, `isalpha`.
- **sys/mman:** `mmap`, `munmap`; macros `PROT_READ`, `PROT_WRITE`,
  `MAP_PRIVATE`, `MAP_ANON`.
- **stdarg:** `va_list`, `va_start`, `va_end` (compiler builtins, not plain libc).
- **assert:** `assert` (macro → `__assert_fail`/`abort`).
- **stddef:** `size_t`, `ptrdiff_t`, `offsetof`, `NULL`.
- **stdint:** `uint8_t`. **stdbool:** `bool`, `true`, `false`.

## 5. Strategy that falls out of this

1. **Preprocessor: don't build one — shell out.** Preprocessing is explicitly a
   *compatibility* goal, not an *understanding* goal (same rationale as stdio).
   Run `clang -E -nostdinc -I <ourheaders> minilisp.c` so `#include`s resolve to
   our `mylibc.h` stubs and only the program's own macros expand; acorncc then
   parses the expanded translation unit. This shrinks item #1 from "write a CPP"
   to "provide headers + one `-E` invocation." (Caveat: the expanded code still
   *uses* unions, function pointers, varargs, compound literals — those remain
   real front/back-end work.) The `-E` call already exists in the driver as of
   ch4; M7 just adds the flags.
2. **Warm up on a hand-rolled ladder.** Tiny C programs that are strict *subsets*
   of minilisp's features, one new feature each (struct → union → function
   pointer → varargs → …), culminating in minilisp itself. If a real smaller
   program is ever wanted as an intermediate rung, the bar is: int-only, no
   floats, ideally reusing minilisp's feature subset — anything needing floating
   point drags in a whole axis the finish line never uses.

## 6. Platform hazards (things that fail SILENTLY)

The audit's most important finding, because none of it was in the plan and none of
it announces itself as a compiler bug.

### 6.1 Apple arm64 passes ALL variadic arguments on the stack

Generic AAPCS64 fills `x0`–`x7` first and spills the rest. **Apple's arm64 ABI
does not**: for a variadic call, every argument in the `...` goes on the stack,
and only the *named* parameters use registers. Sandler's book is x86-64, so this
divergence is ours to get right, and it cuts both ways:

- **Caller side** — the 7 `printf` call sites, plus `fprintf`, `snprintf`.
- **Callee side** — `error(char *fmt, ...)`'s own prologue.

Get it wrong and output is garbage rather than a crash, which will read as a bug
in whatever feature you were actually testing. Verify against
`clang -S -O1` on a two-line `printf` program *before* trusting any output.

### 6.2 `va_list` must match the platform ABI exactly

`vfprintf(stderr, fmt, ap)` hands our `va_list` to **real libc**. This is the only
place acorncc's ABI has to agree with code it did not compile. On Apple arm64
`va_list` is a plain `char *` (not the 5-field struct of generic AAPCS64), so
`va_start` must produce exactly what Apple's `vfprintf` expects to read.

### 6.3 Corollary: confront varargs EARLY, not at M7

All of stdio currently sits in M7, which means M5 and M6 — pointers, unions,
anonymous members, `Obj` layout — get debugged with nothing but process exit
codes. Pulling `printf` forward would pay for itself many times over, but it
requires variadic *calls*, hence §6.1. Better to meet that ABI on a two-line test
program during M4/M5 than inside a 996-line interpreter at M7.

### 6.4 The large-immediate bug needs the inverted case

`ROOT_END` is `((void *)-1)`, so the deferred `mov` fix (see CLAUDE.md) must
handle `movn`, not just `movz`/`movk`. Note the *only* literal above 65535 is
`MEMORY_SIZE 65536`, which happens to encode as `movz #1, lsl #16` — so plain
constants won't bite, but `-1` will.
