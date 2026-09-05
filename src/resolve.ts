// Semantic analysis — the stage between parsing and codegen.
//
// The parser knows the SHAPE of a program, not its MEANING. `2 = 3` is a
// perfectly well-formed assignment as far as the grammar is concerned; so is
// `return a;` in a function with no `a`. Neither can be rejected by a
// context-free grammar, because both depend on context the grammar can't see —
// what has been declared so far, and whether an expression denotes a storage
// location. So they're rejected here instead.
//
// This pass does two jobs in ONE walk of the tree:
//
//   1. CHECK   — undeclared variable, duplicate declaration, invalid lvalue.
//   2. RESOLVE — rewrite every variable name to a unique one, so that two
//                declarations of `a` in different scopes stay distinguishable.
//
// Job 2 is why this returns an AST rather than just throwing or returning void:
// it's a transformation, not an inspection. Everything downstream can then
// assume every Var refers to exactly one declaration, and every Assign has a
// real lvalue on the left — codegen never re-asks those questions.
//
// Chapter 7 made scopes nest. A `Scope` is now a map of names declared here
// plus a link to its enclosing scope, and the pass asks two different questions
// of it — see the type below. The unique renaming from ch5 is what turns all of
// that into something codegen never has to know about: by the time the AST
// leaves here, shadowed variables are simply different names.

import type {
  Program,
  FunDecl,
  BlockItem,
  Statement,
  VarDecl,
  Expression,
} from "./ast.js";

// Thrown for any program that parses but doesn't make sense. The driver catches
// it and exits non-zero, which is what the invalid_semantics tests check for.
export class ResolveError extends Error {}

// A scope: names declared HERE, plus a link to the scope enclosing it.
//
// `names` maps a name AS WRITTEN IN SOURCE to a `Binding` — what that name
// currently means. It is one map, not two, because C puts variables and
// functions in ONE namespace (§6.2.3 "ordinary identifiers"), so `int f; f();`
// must be an error rather than two unrelated entities. Two maps could not see
// each other's conflicts.
// The `parent` link is what ch7 added, and it exists because two questions this
// pass asks — answered by one flat Map through ch6 — finally come apart:
//
//   "declared in THIS scope?"          duplicate-declaration check → this map only
//   "declared in ANY enclosing scope?" undeclared-variable check   → walk parents
//
// Both are needed at once, and a program shows why: `int b = 1; { int b = 2; }`
// must SHADOW (so the duplicate check may not see the outer `b`), while
// `int b = 1; { b = 2; }` must RESOLVE (so the lookup must). One map answering
// both would have to pick.
//
// A parent link rather than an array of scopes because it's still a single
// value — every resolve* signature stayed as it was — and the linked shape is
// literally the block nesting. See `lookup` / `declaredHere` below.
// Variables carry a REWRITE, functions carry a CONSTRAINT — and that asymmetry
// is linkage showing up in a data structure. A local's name is invisible
// outside the function, so it is ours to rename; a function's name is what the
// LINKER matches against libc and other objects, so it must survive untouched.
//
// `defined` accumulates over the traversal rather than describing one
// declaration: C allows many declarations of a function but at most one body.
type Binding =
  | { kind: "Var"; uniqueName: string }
  | { kind: "Fun"; arity: number; defined: boolean };

type Scope = {
  names: Map<string, Binding>;
  parent?: Scope;
};

// The two questions, named. `lookup` walks outward and answers "what does this
// name refer to here, if anything"; `declaredHere` refuses to walk, because a
// name declared in an ENCLOSING scope is not a duplicate — it's something to
// shadow.
function lookup(scope: Scope, name: string): Binding | undefined {
  for (let s: Scope | undefined = scope; s !== undefined; s = s.parent) {
    const binding = s.names.get(name);
    if (binding) return binding;
  }
  return undefined;
}

function declaredHere(scope: Scope, name: string): Binding | undefined {
  return scope.names.get(name);
}

// Makes each declaration's name unique. `a` declared twice in different scopes
// becomes `a.0` and `a.1`. The counter is module-level and never resets, which
// is what guarantees uniqueness across the whole program.
let counter = 0;
function makeUnique(name: string): string {
  return `${name}.${counter++}`;
}

export function resolve(program: Program): Program {
  counter = 0;
  const globalScope = { names: new Map() };
  const functions = program.functions.map((fn) =>
    resolveFunDecl(fn, globalScope),
  );
  return { ...program, functions };
}

function resolveFunDecl(fn: FunDecl, scope: Scope): FunDecl {
  const existing = declaredHere(scope, fn.name);
  if (existing !== undefined) {
    if (existing.kind !== "Fun" || existing.arity !== fn.params.length) {
      throw new ResolveError(`Conflicting declaration of '${fn.name}'`);
    }
    if (existing.defined && fn.body) {
      throw new ResolveError(`Redefinition of '${fn.name}'`);
    }
  }

  scope.names.set(fn.name, {
    kind: "Fun",
    arity: fn.params.length,
    defined: existing?.defined || fn.body !== undefined,
  });
  // Duplicate parameter names are illegal in a PROTOTYPE too, so this runs
  // before the early return. It's a local Set rather than the scope because
  // checking and binding turn out to be different jobs: a prototype's parameter
  // names are pure documentation — C ignores them, `int f(int, int);` is
  // equally valid — so there is nothing for them to be bound INTO. The
  // constraint outlives the thing it constrains.
  const seen = new Set<string>();
  for (const param of fn.params) {
    if (seen.has(param)) {
      throw new ResolveError(`Duplicate parameter '${param}' in '${fn.name}'`);
    }
    seen.add(param);
  }

  // Everything below needs a body. A declaration without one contributes only
  // the binding set above — its whole effect is letting a CALL be checked.
  if (!fn.body) return fn;

  const newScope: Scope = { names: new Map(), parent: scope };

  // Parameters are bound into the BODY's scope, not the enclosing one — and
  // into the same scope the body's outermost block uses, which is why
  // `FunDecl.body` is a bare BlockItem[] rather than a Compound. A Compound
  // would open a second scope and make `int f(int a) { int a; }` shadowing
  // instead of the duplicate C says it is. Uniqueness here is already
  // guaranteed by the check above.
  const resolvedParams: string[] = [];
  for (const param of fn.params) {
    const uniqueName = makeUnique(param);
    newScope.names.set(param, { kind: "Var", uniqueName });
    resolvedParams.push(uniqueName);
  }

  fn.params = resolvedParams;
  fn.body = fn.body.map((item) => resolveBlockItem(item, newScope));
  return fn;
}

// Block items are walked in SOURCE order, and that order is what makes
// `a = 1; int a;` an error while `int a; a = 1;` is fine — a name is only
// visible from its declaration onward.
function resolveBlockItem(
  item: BlockItem,
  scope: Scope,
  currentLoop?: string,
): BlockItem {
  switch (item.kind) {
    case "VarDecl": {
      return resolveVarDecl(item, scope);
    }
    case "FunDecl": {
      return resolveFunDecl(item, scope);
    }
    case "Compound":
    case "ExpressionStatement":
    case "Null":
    case "If":
    case "While":
    case "DoWhile":
    case "For":
    case "Break":
    case "Continue":
    case "Return": {
      return resolveStatement(item, scope, currentLoop);
    }
    default: {
      const _never: never = item;
      throw new Error(`Unhandled block item: ${JSON.stringify(_never)}`);
    }
  }
}

// Declaring a name: check it's not already declared HERE, bind it to a fresh
// unique name, then resolve the initializer.
//
// The ordering is load-bearing and easy to get backwards. `int a = 0 && a;` is
// VALID C (the value read is garbage, but that's the programmer's problem), so
// the name must already be in scope when its own initializer is resolved.
// Bind first, then walk `init`.
function resolveVarDecl(decl: VarDecl, scope: Scope): VarDecl {
  // `declaredHere`, NOT `lookup` — deliberately refusing to look outward. A
  // name declared in an enclosing scope isn't a conflict, it's the thing this
  // declaration shadows.
  if (declaredHere(scope, decl.name)) {
    throw new ResolveError(`Duplicate declaration of '${decl.name}'`);
  }
  const uniqueName = makeUnique(decl.name);
  scope.names.set(decl.name, { kind: "Var", uniqueName });
  decl.name = uniqueName;
  if (decl.init !== undefined) {
    decl.init = resolveExpression(decl.init, scope);
  }
  return decl;
}

function resolveStatement(
  stmt: Statement,
  scope: Scope,
  currentLoop?: string,
): Statement {
  switch (stmt.kind) {
    // Both hold a single `exp` and neither introduces a name, so they resolve
    // identically — Return's value and ExpressionStatement's discarded value are the same
    // job from here.
    case "Return":
    case "ExpressionStatement": {
      stmt.exp = resolveExpression(stmt.exp, scope);
      return stmt;
    }
    // Both arms resolve in the SAME scope — still correct after ch7, and worth
    // re-checking rather than assuming. An arm is a single statement; a
    // statement can't declare anything; so there's no name a fresh scope could
    // hold. And when an arm *does* need one it's written `{ ... }`, which is a
    // Compound, which opens its own below. The ch6 decision survives untouched.
    case "If": {
      stmt.predicate = resolveExpression(stmt.predicate, scope);
      stmt.consequent = resolveStatement(stmt.consequent, scope, currentLoop);
      if (stmt.alternative !== undefined) {
        stmt.alternative = resolveStatement(
          stmt.alternative,
          scope,
          currentLoop,
        );
      }
      return stmt;
    }
    case "While": {
      stmt.loopId = makeUnique("while");
      stmt.condition = resolveExpression(stmt.condition, scope);
      stmt.body = resolveStatement(stmt.body, scope, stmt.loopId);
      return stmt;
    }
    case "DoWhile": {
      stmt.loopId = makeUnique("do");
      stmt.condition = resolveExpression(stmt.condition, scope);
      stmt.body = resolveStatement(stmt.body, scope, stmt.loopId);
      return stmt;
    }
    case "For": {
      const newScope: Scope = { names: new Map(), parent: scope };

      stmt.loopId = makeUnique("for");

      switch (stmt.init.kind) {
        case "InitDecl": {
          stmt.init.declaration = resolveVarDecl(
            stmt.init.declaration,
            newScope,
          );
          break;
        }
        case "InitExp": {
          if (stmt.init.exp !== undefined) {
            stmt.init.exp = resolveExpression(stmt.init.exp, newScope);
          }
          break;
        }
        default: {
          const _never: never = stmt.init;
          throw new Error(`Unhandled for-init: ${JSON.stringify(_never)}`);
        }
      }

      if (stmt.condition) {
        stmt.condition = resolveExpression(stmt.condition, newScope);
      }

      if (stmt.post) {
        stmt.post = resolveExpression(stmt.post, newScope);
      }

      stmt.body = resolveStatement(stmt.body, newScope, stmt.loopId);

      return stmt;
    }
    case "Continue":
    case "Break": {
      if (currentLoop === undefined) {
        throw new ResolveError(
          `Cannot ${stmt.kind.toLowerCase()} outside of a loop.`,
        );
      }

      stmt.loopId = currentLoop;
      return stmt;
    }
    // The one place a scope is born. Note it's a NEW value handed downward,
    // never a push onto shared state — so "the inner scope dies at `}`" needs
    // no teardown at all: `newScope` is a local, the caller still holds the
    // scope it always had, and a forgotten pop is not a bug that can exist.
    //
    // resolveBlockItem, not resolveStatement: a block holds block items, so
    // declarations are legal here. That's the difference from an `if` arm.
    case "Compound": {
      const newScope: Scope = { names: new Map(), parent: scope };
      const resolved: BlockItem[] = [];
      for (const it of stmt.block) {
        resolved.push(resolveBlockItem(it, newScope, currentLoop));
      }
      stmt.block = resolved;
      return stmt;
    }
    case "Null": {
      return stmt;
    }
    default: {
      const _never: never = stmt;
      throw new Error(`Unhandled statement: ${JSON.stringify(_never)}`);
    }
  }
}

// Two cases carry the checks; the rest is structural recursion.
//
// Note that resolving is NOT idempotent — a Var's name is rewritten from the
// source spelling to the unique one, and the unique one isn't a key in `scope`.
// So every subexpression must be resolved exactly once.
function resolveExpression(exp: Expression, scope: Scope): Expression {
  switch (exp.kind) {
    case "Var": {
      // `lookup`, NOT `declaredHere` — the mirror image of the declaration
      // check. A block sees everything enclosing it, so `{ b = 2; }` inside a
      // function with an outer `b` resolves to that outer `b` and writes its
      // slot. Braces scope NAMES, not storage.
      const binding = lookup(scope, exp.name);
      if (binding === undefined) {
        throw new ResolveError(`Undeclared variable '${exp.name}'`);
      }
      if (binding.kind === "Fun") {
        throw new ResolveError(
          `Variable '${exp.name}' is a function not a var`,
        );
      }
      exp.name = binding.uniqueName;
      return exp;
    }
    case "FunCall": {
      const binding = lookup(scope, exp.name);

      if (!binding) {
        throw new ResolveError("undeclared function");
      }

      if (binding.kind === "Var") {
        throw new ResolveError("called object is not a function");
      }

      if (binding.arity !== exp.args.length) {
        throw new ResolveError("wrong number of args");
      }

      exp.args = exp.args.map((exp) => resolveExpression(exp, scope));
      return exp;
    }
    case "Assign": {
      // The lvalue check runs at EVERY Assign, not just the outermost one:
      // `a = 3 * b = a` parses as `a = ((3 * b) = a)` because `=` binds looser
      // than `*`, so the offending lvalue is the nested one.
      if (exp.lvalue.kind !== "Var") {
        throw new ResolveError(
          `Invalid lvalue: cannot assign to ${exp.lvalue.kind}`,
        );
      }
      exp.lvalue = resolveExpression(exp.lvalue, scope);
      exp.rvalue = resolveExpression(exp.rvalue, scope);
      return exp;
    }
    case "Constant": {
      return exp;
    }
    case "Unary": {
      exp.operand = resolveExpression(exp.operand, scope);
      return exp;
    }
    case "Binary": {
      exp.left = resolveExpression(exp.left, scope);
      exp.right = resolveExpression(exp.right, scope);
      return exp;
    }
    // Pure structural recursion — nothing to check. Note that `a ? b : c = 1`
    // never reaches here as a Conditional in the lvalue position by accident:
    // the parser's floors make it `Assign(Conditional, 1)`, so the lvalue
    // check in the Assign case above is what rejects it.
    case "Conditional": {
      exp.predicate = resolveExpression(exp.predicate, scope);
      exp.consequent = resolveExpression(exp.consequent, scope);
      exp.alternative = resolveExpression(exp.alternative, scope);
      return exp;
    }
    default: {
      const _never: never = exp;
      throw new Error(`Unhandled expression: ${JSON.stringify(_never)}`);
    }
  }
}
