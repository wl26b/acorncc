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
// Chapter 5 has exactly one scope (no nested blocks until ch7), so nothing can
// shadow anything yet. The map is still what does the work; ch7 adds nesting.

import type {
  Program,
  FunctionDef,
  BlockItem,
  Statement,
  Declaration,
  Expression,
} from "./ast.js";

// Thrown for any program that parses but doesn't make sense. The driver catches
// it and exits non-zero, which is what the invalid_semantics tests check for.
export class ResolveError extends Error {}

// Maps a name AS WRITTEN IN SOURCE to the unique name it resolves to.
//
// A plain Map is enough for one flat scope. Chapter 7 introduces nested blocks
// and will need something that can answer "is this declared in the CURRENT
// scope?" (for the duplicate check) separately from "is this declared in ANY
// enclosing scope?" (for the undeclared check) — worth noticing that those are
// already two different questions here, even though one map answers both today.
type Scope = Map<string, string>;

// Makes each declaration's name unique. `a` declared twice in different scopes
// becomes `a.0` and `a.1`. The counter is module-level and never resets, which
// is what guarantees uniqueness across the whole program.
let counter = 0;
function makeUnique(name: string): string {
  return `${name}.${counter++}`;
}

export function resolve(program: Program): Program {
  counter = 0;
  return { ...program, function: resolveFunction(program.function) };
}

function resolveFunction(fn: FunctionDef): FunctionDef {
  const scope: Scope = new Map();
  return { ...fn, body: fn.body.map((item) => resolveBlockItem(item, scope)) };
}

// Block items are walked in SOURCE order, and that order is what makes
// `a = 1; int a;` an error while `int a; a = 1;` is fine — a name is only
// visible from its declaration onward.
function resolveBlockItem(item: BlockItem, scope: Scope): BlockItem {
  switch (item.kind) {
    case "Declaration": {
      return resolveDeclaration(item, scope);
    }
    case "ExpressionStatement":
    case "Null":
    case "Return": {
      return resolveStatement(item, scope);
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
function resolveDeclaration(decl: Declaration, scope: Scope): Declaration {
  if (scope.has(decl.name)) {
    throw new ResolveError(`Duplicate declaration of '${decl.name}'`);
  }
  const uniqueName = makeUnique(decl.name);
  scope.set(decl.name, uniqueName);
  decl.name = uniqueName;
  if (decl.init !== undefined) {
    decl.init = resolveExpression(decl.init, scope);
  }
  return decl;
}

function resolveStatement(stmt: Statement, scope: Scope): Statement {
  switch (stmt.kind) {
    // Both hold a single `exp` and neither introduces a name, so they resolve
    // identically — Return's value and ExpressionStatement's discarded value are the same
    // job from here.
    case "Return":
    case "ExpressionStatement": {
      stmt.exp = resolveExpression(stmt.exp, scope);
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
      const uniqueName = scope.get(exp.name);
      if (uniqueName === undefined) {
        throw new ResolveError(`Undeclared variable '${exp.name}'`);
      }
      exp.name = uniqueName;
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
    default: {
      const _never: never = exp;
      throw new Error(`Unhandled expression: ${JSON.stringify(_never)}`);
    }
  }
}
