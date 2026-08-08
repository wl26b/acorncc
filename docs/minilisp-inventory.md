# minilisp C-feature inventory — the language spec

Source: `rui314/minilisp` (`minilisp.c`, 996 lines, public domain). This is the
**finish-line program**: acorncc is "done" when this compiles and passes its own
tests. Per CLAUDE.md, *the feature set below IS acorncc's language spec* —
anything minilisp doesn't use, we don't build; anything it DOES use, we must.
The milestones in `docs/milestones.md` are derived from this list.

Each feature is tagged with the milestone that owns it. **Bold** marks the ones
that are easy to underestimate — they get called out again in §3.

---

## 1. What minilisp is (so the feature list has context)

A tree-walking Lisp interpreter with: a hand-written recursive-descent **reader**
(S-expressions), an **evaluator** (`eval`/`apply`), **macros** (`defmacro` +
`macroexpand`), and a **Cheney copying garbage collector** over an `mmap`'d
semi-space heap. No floats anywhere — all Lisp numbers are C `int`. The GC is the
source of most of the "hard C": the two-level-pointer root protocol
(`DEFINE1..4`, `ADD_ROOT`) is implemented with **function-like macros**.

## 2. Feature inventory (by category)

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
- **Function pointers** + a **typedef of a function type**
  (`typedef struct Obj *Primitive(void*, Obj**, Obj**)`, then `Primitive *fn`,
  called as `(*fn)(...)`). → M6

### Operators (the "full operator set" — itemized)
- Arithmetic `+ - *`, unary `-`, and `/ %`. → M2 ✅
- Bitwise `& | ~` (`roundup`, mmap flags). `~` → M2 ✅; `& |` → M4. No `<<`/`>>`
  seen.
- Comparison `< <= > >= == !=`. → M2 ✅
- Logical `&& || !`. → M2 ✅
- Ternary `?:`. → M3 (with `if`, ch6 — distinct codegen, short-circuit branches)
- Assignment `=` → M3; **compound `+= -=`** and **`++` / `--`** (pre/post) → M4
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
- **`switch` / `case` / `default` / fallthrough / `break`** — its own codegen
  (jump logic), not free with the rest of control flow. → M4
- `return`, `break`. → M3/M4. No `goto`, no `do/while`, no `continue` seen.

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
- `#include` (11 system headers — see §4).
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

**What's genuinely absent, and stays out of scope:** floating point, `long long`
beyond pointer-width, `goto`, `do/while`, bitfields, `##`/`#`, VLAs, threads. The
int-only numeric model is a real simplification for M5.

## 4. libc surface to hand-declare (`mylibc.h`)

Per the "no system headers" decision, these must be declared by hand (linker
wires them to real libc). From the 11 includes:
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
