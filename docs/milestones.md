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
| M3 | Variables, scope, statements | ✅ done (ch5–7 green) |
| M4 | Control flow + functions (AAPCS64) | 🟡 in progress (ch8 + ch9 green) — conceptual peak |
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

### M3 — Variables, scope, statements ✅
Locals, assignment, `if`/`else` and `?:`, blocks; a symbol table + real ARM64
stack frames. Sandler ch5–7, all green.

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
- ✅ **Codegen green — chapter 5 passes end to end (147/147).** Real ARM64 stack
  frames. Three things worth remembering:
  - **Locals anchor to `fp`, not `sp`.** The expression stack machine moves `sp`
    mid-expression, so `[sp, #off]` names a different address depending on
    nesting depth — `a + b` alone would read garbage. `mov sp, fp` in the
    epilogue also repairs `sp` without knowing what was pushed.
  - **`return` stopped being one instruction.** With a frame, it's tear-down
    then branch. Falling off the end emits `mov w0, #0` first, unconditionally —
    deciding whether a function always returns is a reachability analysis, not a
    look at the last block item.
  - **Constants are built from 16-bit chunks** (`movz` + optional `movk`),
    because no 32-bit instruction can carry a 32-bit immediate.
  - Oracle note: use `clang -S -O0` for frame layout — at `-O1` locals live in
    registers and there's no frame to compare against. `-O1` stays better for
    instruction selection.

**ch6 — `if` / `else` / `?:` — green end to end (183/183).** The first real
control flow. Two nodes, `If` (statement) and `Conditional` (expression),
sharing Scheme's field names (predicate / consequent / alternative) because
they're the same idea at two levels of the grammar; the differences are that
`If`'s alternative is optional and `Conditional`'s arms must produce a value.
What the chapter actually taught:
- **`?:` needs a binding power, not just a production.** It goes in the Pratt
  table like any infix operator, because the table answers the one question
  every infix token asks — *does this bind tightly enough for THIS call to fold
  it?* Fold `?` on sight and `2 * 0 ? 5 : 6` becomes `2 * (0 ? 5 : 6)`, since
  the call parsing `*`'s right operand holds only `0`. "We've finished the
  predicate" is true only in the call whose floor `?` clears.
- **Its two operands take different floors, and that asymmetry is positional.**
  The consequent sits *inside* the `? … :` bracket → floor 0, exactly like
  `( exp )`. The alternative is open on the right → floor `bp`, so it has to
  negotiate with what follows. A floor above 0 inside a bracket can only
  destroy input: a refused operator there has no enclosing call to fall back
  to. This is what makes `a ? b = 1 : c` legal while `a ? b : c = 1` parses as
  `(a ? b : c) = 1` — C's grammar exactly, and the route by which
  `ternary_assign` reaches the resolver as an invalid lvalue.
- **`:` deliberately has no binding power.** It's a delimiter consumed by
  `expect`, and its *absence* from the table is what terminates the middle
  operand — same mechanism as `)`.
- **Codegen needs no stack.** Unlike `Binary`, which parks its left operand
  because both must exist simultaneously, the predicate is consumed by `cmp`
  before either arm runs and exactly one arm executes. Nothing is live across
  anything, so `w0` suffices at any nesting depth.
- **A label's definition and every branch to it must move together.** Making
  the alternative label conditional while leaving `beq` pointing at it gives
  *assembler local symbol not defined*. Deciding the false target up front —
  `alternative ? freshLabel(...) : endLabel` — makes that unrepresentable, and
  drops the dead `b` that a bare `if` otherwise emits to the next instruction.
- Deferred at the time: `cbz`/`cbnz` instead of `cmp #0` + `beq`, because it
  would have meant three edits across ch4 and ch6 code. Landed later with the
  IR, where all branching funnels through two instruction templates.

**ch7 — compound statements — green end to end (202/202), and M3 closes.** Tiny
syntactically (one node, `Compound`, holding `BlockItem[]`), and almost entirely
a semantic-analysis chapter:
- **The two questions finally came apart.** Through ch6 a single flat `Map`
  answered both "is this declared in the CURRENT scope?" (duplicate check) and
  "is it declared in ANY enclosing scope?" (undeclared check). Blocks make those
  contradict: `int b = 1; { int b = 2; }` must shadow, so the duplicate check
  must NOT look outward, while `int b = 1; { b = 2; }` must resolve, so the
  lookup must. `Scope` became `{ vars, parent? }` with `lookup` walking and
  `declaredHere` refusing to — the two functions named after the two questions.
- **A parent link rather than an array of scopes**, because it stays a single
  value: no `resolve*` signature changed. And the child scope is a NEW value
  handed downward, never a push onto shared state — so "the inner scope dies at
  `}`" is ordinary variable lifetime, and a forgotten pop isn't a bug that can
  exist.
- **The function body deliberately is NOT a `Compound`.** Both are "a run of
  block items", but only a `Compound` is a *statement*, and being a statement is
  what makes it open a scope. Route the body through one and at ch9 a function's
  parameters and its body's outermost block would be two scopes instead of one,
  wrongly accepting `int f(int a) { int a; }`. `parseBlock` is shared; the
  scope-opening is not.
- **`layoutFrame`'s `If` arm was the trap**, exactly as predicted in ch6's
  comment: an arm can BE a block, so `if (x) { int y = 1; }` hides a declaration
  behind a node that contributed nothing through ch6. The walk must recurse into
  both `Compound` and the `If` arms.
- **Codegen emits nothing for a block.** No prologue, no adjustment, not one
  instruction. Scope was fully consumed upstream — the resolver made shadowed
  names distinct and `layoutFrame` gave each a slot — so "which `b`?" is not a
  question that survives to the back end. Braces leave no trace in machine code.
- Slot allocation stays **monotonic** by decision, not oversight: sibling blocks
  get distinct slots though their lifetimes are disjoint. Reuse is ~3 lines
  today (save/restore `offset`, size from the max) but it's lifetime analysis in
  disguise and stops being 3 lines at ch8/M4.
- A parser lesson worth keeping: `parseBlock` consumes BOTH braces. An earlier
  version left `{` to its caller, the two call sites disagreed, and
  `parseStatement`/`parseBlock` spun into infinite mutual recursion. A function
  that owns half a bracket pair will find a caller that mismatches it.

### Interlude — the TACKY IR ✅
Landed between M3 and ch8, on the `tacky` branch. The pipeline gained a fifth
stage: `lower.ts` turns the resolved AST into **TACKY** (`tacky.ts`), a
three-address IR. Expressions become named temporaries; control flow becomes
labels and jumps. `--tacky` prints it.

Done early rather than at ch8 because loops would otherwise have been written
twice, and because ch1–7's 202 tests are the ideal safety net for a back-end
refactor.

- **Why:** register allocation is not expressible against an AST. The push/pop
  expression stack parks intermediates anonymously and positionally, so there
  is no handle to ask "does this value need to be in memory?" A TACKY temporary
  is a *name*, which is what a live range attaches to. Liveness needs a CFG;
  a CFG needs something flat. Secondarily, ten C control-flow constructs
  collapse into `Jump`/`JumpIfZero`/`Label`, so the emitter stops growing a
  shape per chapter.
- **Two design decisions.** `Var` covers user variables and temporaries alike,
  which is what lets the storage pass treat every name identically.
  `TackyBinaryOp` is the AST's minus `And`/`Or`, and that omission is forced:
  an instruction's operands are values already computed, while short-circuiting
  is exactly the claim that one must not be evaluated.
- **The lowering contract:** `lowerExpression` appends instructions and
  *returns* the Val holding its result; `lowerStatement` appends and returns
  nothing. That replaces `emitExpressionIntoW0`'s convention of leaving the
  result in a register — a fact no type recorded and every caller had to honour.
- **Codegen no longer imports `ast.ts`.** It walks a flat list with one fixed
  template per instruction. `layoutFrame` lost its recursive walk entirely:
  slots now come from *uses*, not declarations.
- Net cost ~200 lines. No speed change — every value still gets a stack slot,
  the same traffic the stack machine had. The point is that the policy is now
  behind an interface a register allocator can replace.
- Took `cbz`/`cbnz` while here (the deferred ch6 item). It was three edits
  before; through the IR it is one.

### M4 — Control flow + functions 🟡 (conceptual peak)
Loops (`for`/`while`), `switch`/`case`, then function definitions/calls →
**AAPCS64** (arg passing in x0–x7, frame setup/teardown, returns). Plus the
operators left over from M2–M3: postfix `++`, compound assignment `+= -=`, comma,
and bitwise `&`/`|`. Sandler ch8–9.

**ch8 loops ✅ green (240/240 through ch8).** `while`, `do`/`while`, `for`,
`break`, `continue`. The AST→IR split it was expected to force had already
landed between M3 and ch8, and the prediction that followed from it held: ch8
added **no IR instruction and no line of codegen**. All three loop forms are
`Label` / `Jump` / `JumpIfZero`, which `if` and `&&` had already paid for.

The chapter's whole difficulty was one question — *where does `continue` land* —
and it has three answers. `while` needs 2 labels because its restart address and
its continue target are the same; `do` and `for` need 3 because theirs diverge
(`do`'s continue is the test at the bottom, `for`'s is the post-expression). That
divergence is also why `for` cannot be desugared into `while`: the rewrite puts
the post inside the body, where `continue` skips it.

What was actually new lives in `resolve.ts`, and it is one optional parameter.
`currentLoop` is threaded exactly like `scope` — handed down by value, *replaced*
by each loop rather than pushed, never restored — so an inner `break` binding to
an outer loop is unrepresentable rather than merely avoided. `break` outside any
loop is `currentLoop === undefined`, which makes the error check free. `for` is
the one loop that opens a scope, and the only scope in the language not hung on a
`{`.

**ch9 functions + AAPCS64 ✅ green (300/301 through ch9).** Multiple
function definitions, parameters, calls, and prototypes. This chapter is the
counter-test to ch8: where loops needed no new IR at all, `FunCall` is the first
instruction added since the split — and the first with an operand *list* rather
than fixed slots, so its template is a loop. It's also the first whose expansion
is dictated by the **ABI** (which register each argument goes in) rather than by
the ISA; the same IR retargeted would expand it completely differently.

Three things the chapter established:

- **Function names are never renamed.** Variables become `a.3` because nothing
  outside the function observes them; a function name is what the *linker*
  matches. So `resolve`'s scope map stopped mapping name→string and became
  name→`Binding` — variables carrying a rewrite, functions a constraint — one
  map, because C puts both in one namespace.
- **Prototypes produce no code and still do work.** Their entire effect is in
  `resolve`, enabling and checking *calls*. `lower` drops them, which makes the
  AST→TACKY boundary the first stage that removes a node rather than
  transforming it.
- **Parameters break "slots come from uses."** A parameter's value arrives from
  outside the instruction list, so an unused one is mentioned nowhere and gets
  no slot. `layoutFrame` seeds from `fn.params` — a second source of truth, and
  a small preview of what M5 does to the same rule.

**Stack arguments are done**, and the shape is worth recording because the
obvious mental model is wrong. The caller does not *push*: `layoutFrame`
reserves an outgoing-argument area at the bottom of the caller's own frame,
sized by the widest call it makes, so `sp` never moves across a call and the
ABI's 16-byte alignment is satisfied by construction rather than fixed up. The
caller writes args 9+ at `[sp, #0]` upward; the callee reads them at
`[fp, #16]` upward. Same bytes — the two frames are adjacent, and the arguments
sit exactly on the boundary. `#16` is the frame record and is constant, because
`fp` doesn't move; clang addresses from `sp` and must fold the frame size in.

That area is *not* slots: nothing in it is named, and it's scratch reused by
every call, so it is sized by the maximum rather than the sum. It is the first
thing in the frame that `offsets` doesn't answer for.

Verified by **separate compilation** — an acorncc caller passing ten arguments
links against a clang-compiled callee and returns the right answer. A
single-file test only proves the compiler agrees with itself; this is the only
kind that catches an ABI that is self-consistently wrong.

The single non-passing test is **`stack_alignment`**, which cannot pass on this
target: the suite links the object against a hand-written x86-64 helper
(`pushq %rbp`) and ships no ARM64 equivalent. The property it checks holds by
construction anyway, since `sp` never moves at a call.

The last fix was the **duplicate-parameter check**, and it split a loop that had
been doing two jobs. Checking for duplicates applies to every declaration;
binding and renaming only apply where there is a body. A prototype's parameter
names are pure documentation — C ignores them, `int f(int, int);` is equally
valid — so there is nothing to bind them into, and yet the duplicate rule still
applies. The constraint outlives the thing it constrains.

**M4 remaining**, all in `extra_credit/` directories the chapter flag has never
run — use `--extra-credit`, which is 474 tests rather than 301. This is where
"chapter green" stops being a sufficient definition of done, one milestone
earlier than the ⚠︎ note below predicts.

**Bitwise `& | ^ << >>` ✅** — 27 tests, and a clean measurement of what the
front end's design bought: five tag strings, five rows in `INFIX_OPS`, five
codegen templates, and nothing else. Adding an infix operator is *data*, not
code. Precedence was the only decision — C puts `|` `^` `&` between `&&` and
`==`, so `&` binds TIGHTER than equality (`x & 1 == 0` groups as
`x & (1 == 0)`), and shifts sit between relational and additive. ch3's bp
numbers were spaced for exactly this.

The lexer's `OPERATORS` list is now sorted by length at load instead of
hand-ordered. Through ch8 the "longer before shorter" rule was four entries
with `--` before `-`; the new families make prefix chains three deep
(`<` → `<<` → `<<=`, `&` → `&&` → `&=`), which is the point at which a
hand-maintained invariant should become an enforced one.

Still open: **compound assignment** (22 tests, including the `&=`/`|=`/`<<=`
forms), **`++`/`--`** (~7, postfix only per the inventory), and
**`switch`/`case`** (20). Plus ~23 `goto`/label tests that are deliberately out
of scope — the inventory grep-verified minilisp has no `goto`, and this is
exactly the case it exists to license skipping.

Two bugs worth recording because neither was found by a failing test. The
prototype's `;` was consumed only on the body-allowed path, so at block scope a
following `{ ... }` parsed as an ordinary `Compound` **statement** and ran —
`int main(void) { int f(void) { return 1; } return 2; }` returned 1. Identical
shape to ch8's `do`-while bug: an unconsumed terminator gets absorbed
downstream, turning a rejection into silently different behaviour. And
`allowBody` was optional, so the block-scope call site fell into the default —
the ch8 lesson about optional parameters, arriving one chapter later in a form
that silently accepted a nested function definition.

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
