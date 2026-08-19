// Lowering — AST to TACKY. The fourth stage, sitting between resolve and
// codegen.
//
// THE CENTRAL CONTRACT, and the thing that makes this pass different in shape
// from every walk before it:
//
//   lowerExpression(exp, out)  APPENDS instructions to `out`, and RETURNS the
//                              Val holding its result.
//   lowerStatement(stmt, out)  APPENDS instructions to `out`, returns nothing.
//
// Compare `emitExpressionIntoW0`, which appends to `lines` and leaves its
// result in a register *by convention* — a fact nothing in the type system
// records, and that every caller has to honour. Here the result is a value you
// receive and pass on, so nesting works with no shared register discipline: to
// lower `a + b`, lower each side, then emit one Binary reading the two Vals you
// got back. That is why arbitrarily deep expressions need no stack here, and
// why the push/pop expression stack disappears from the back end.
//
// Everything emitted is flat. No instruction refers to another by position —
// only by name (Vals) or by label (jumps). That is what lets codegen become a
// loop over a list instead of a recursive walk over a tree.
//
// WHAT THIS PASS OWNS: minting temporaries and labels. The back end mints
// neither any more — by the time it runs, every label it needs already exists
// in the instruction list. All the "which labels does this construct need, and
// where do they go" knowledge lives here, where it is a question about control
// flow rather than about instruction selection.

import type {
  Program,
  FunctionDef,
  BlockItem,
  Statement,
  Declaration,
  Expression,
} from "./ast.js";
import type {
  TackyProgram,
  TackyFunction,
  Instruction,
  Val,
  TackyVar,
} from "./tacky.js";

// Two counters, because temporaries and labels are different namespaces and
// nothing good comes of them sharing numbers when you are reading `--tacky`
// output. Both reset per compilation so the output is deterministic.
//
// The `.` in the generated names is what keeps them from colliding with
// anything the user wrote — C identifiers cannot contain one. The resolver
// relies on the same trick for `a.0`.
let tempCounter = 0;
let labelCounter = 0;

function makeTemporary(): TackyVar {
  return { kind: "Var", name: `tmp.${tempCounter++}` };
}

// `hint` shows up in the label name (`end.3`, `sc.7`) purely so the `--tacky`
// dump is readable. It carries no meaning.
function makeLabel(hint: string): string {
  return `${hint}.${labelCounter++}`;
}

export function lower(program: Program): TackyProgram {
  tempCounter = 0;
  labelCounter = 0;
  return { kind: "Program", function: lowerFunction(program.function) };
}

function lowerFunction(fn: FunctionDef): TackyFunction {
  const instructions: Instruction[] = [];

  for (const item of fn.body) {
    lowerBlockItem(item, instructions);
  }

  // The implicit `return 0` for falling off the end of main, moved here from
  // codegen. Emitted unconditionally for the same reason as before: deciding
  // whether a function always returns is a reachability analysis, not a look at
  // the last block item. It is now one IR instruction rather than four assembly
  // ones, and the eventual dead-code pass that would remove it as unreachable
  // belongs at this level too.
  instructions.push({ kind: "Return", val: { kind: "Constant", value: 0 } });

  return { kind: "Function", name: fn.name, instructions };
}

// A declaration or a statement — the same two-way split as everywhere else.
function lowerBlockItem(item: BlockItem, out: Instruction[]): void {
  if (item.kind === "Declaration") lowerDeclaration(item, out);
  else lowerStatement(item, out);
}

// `int a = <exp>;` is whatever computes <exp>, then a Copy into `a`.
// `int a;` is NOTHING at all.
//
// Note this mints no temporary: the declared variable already has a name (the
// resolver made it unique), and that name is the destination. Temporaries exist
// only for results that have nowhere else to go.
//
// Emitting nothing for an uninitialised declaration is safe because storage is
// discovered from USES, not declarations — whoever assigns slots walks the
// instruction list collecting Var names. A variable never mentioned needs no
// slot; one that is read before being written picks up a slot from the read and
// holds whatever was there, which is exactly C's indeterminate value.
function lowerDeclaration(decl: Declaration, out: Instruction[]): void {
  if (decl.init !== undefined) {
    const src = lowerExpression(decl.init, out);
    out.push({ kind: "Copy", src, dst: { kind: "Var", name: decl.name } });
  }
}

// Appends the instructions for `stmt`. Returns nothing — a statement has no
// value.
function lowerStatement(stmt: Statement, out: Instruction[]): void {
  switch (stmt.kind) {
    case "Return": {
      const val = lowerExpression(stmt.exp, out);
      out.push({ kind: "Return", val });
      break;
    }
    // The Val is discarded, but the instructions are not: `a = 5;` is executed
    // for its effect and only its result is unused.
    case "ExpressionStatement": {
      lowerExpression(stmt.exp, out);
      break;
    }
    case "Null": {
      break;
    }
    // Same skeleton as ch6's codegen, one level up. The false path lands on the
    // alternative's label when there is one and on the join point when there is
    // not — chosen up front so no jump can target a label that is never
    // emitted. The Jump exists solely to skip the alternative, so with no
    // alternative neither it nor the extra label is emitted.
    case "If": {
      const endLabel = makeLabel("end");
      const falseLabel = stmt.alternative ? makeLabel("alternative") : endLabel;

      const condition = lowerExpression(stmt.predicate, out);
      out.push({ kind: "JumpIfZero", condition, target: falseLabel });
      lowerStatement(stmt.consequent, out);

      if (stmt.alternative !== undefined) {
        out.push({ kind: "Jump", target: endLabel });
        out.push({ kind: "Label", name: falseLabel });
        lowerStatement(stmt.alternative, out);
      }

      out.push({ kind: "Label", name: endLabel });
      break;
    }
    // A block is its items in order and nothing else. Scope is already fully
    // discharged: the resolver turned shadowed names into distinct ones, so
    // there is nothing here that knows what a block is — and consequently
    // nothing downstream will either.
    case "Compound": {
      for (const item of stmt.block) {
        lowerBlockItem(item, out);
      }
      break;
    }
    default: {
      const _never: never = stmt;
      throw new Error(`Unhandled statement: ${JSON.stringify(_never)}`);
    }
  }
}

// Appends the instructions that compute `exp`, and returns the Val holding the
// result — either a Constant (nothing was emitted) or a Var naming where the
// result ended up.
function lowerExpression(exp: Expression, out: Instruction[]): Val {
  switch (exp.kind) {
    // The two leaves: they append nothing and are already Vals. This is what
    // keeps `2 + 3` from needing temporaries for its operands.
    case "Constant": {
      return { kind: "Constant", value: exp.value };
    }
    case "Var": {
      return { kind: "Var", name: exp.name };
    }
    case "Unary": {
      const src = lowerExpression(exp.operand, out);
      const dst = makeTemporary();
      out.push({ kind: "Unary", operator: exp.operator, src, dst });
      return dst;
    }
    case "Binary": {
      // `&&` and `||` are NOT a Binary instruction, and cannot be. An
      // instruction's operands are values already computed, which means the
      // instructions producing them sit earlier in the list and have already
      // run — while short-circuiting is precisely the statement that the right
      // operand must NOT be evaluated. Three-address form can say "compute this
      // from values you have"; it has no operand slot for "maybe". So these
      // lower to jumps and a temporary both paths write.
      //
      // The two are mirror images, exactly as ch4's emitShortCircuit found:
      // `&&` short-circuits on zero to 0, `||` on nonzero to 1, and the
      // fall-through value is the complement of whichever it is. Deriving it as
      // `1 - shortVal` is what stops the two drifting apart.
      if (exp.operator === "And" || exp.operator === "Or") {
        const scLabel = makeLabel("sc");
        const endLabel = makeLabel("end");
        const kind = exp.operator === "And" ? "JumpIfZero" : "JumpIfNotZero";
        const shortVal = exp.operator === "And" ? 0 : 1;

        const src1 = lowerExpression(exp.left, out);
        out.push({ kind, condition: src1, target: scLabel });
        const src2 = lowerExpression(exp.right, out);
        out.push({ kind, condition: src2, target: scLabel });

        // Minted here rather than at the top so the `--tacky` dump numbers
        // temporaries in the order they appear.
        const dst = makeTemporary();
        out.push({
          kind: "Copy",
          src: { kind: "Constant", value: 1 - shortVal },
          dst,
        });
        out.push({ kind: "Jump", target: endLabel });

        out.push({ kind: "Label", name: scLabel });
        out.push({
          kind: "Copy",
          src: { kind: "Constant", value: shortVal },
          dst,
        });

        out.push({ kind: "Label", name: endLabel });
        return dst;
      }

      // Everything else: both operands are lowered BEFORE the instruction that
      // reads them, which is the entire reason no operand stack is needed.
      const src1 = lowerExpression(exp.left, out);
      const src2 = lowerExpression(exp.right, out);
      const dst = makeTemporary();
      out.push({ kind: "Binary", operator: exp.operator, src1, src2, dst });
      return dst;
    }
    // The lvalue is a LOCATION, not a value — so its name is read directly
    // rather than lowered. Lowering it would be wrong in kind, and wrong in
    // fact at M5, where `*p = 5` has an lvalue whose address must be computed
    // but whose value must not be loaded.
    //
    // Returning `dst` rather than `src` matters later too: once types exist,
    // assignment converts, and the value of `c = i` is what actually landed in
    // `c` (possibly truncated), not what `i` held.
    case "Assign": {
      if (exp.lvalue.kind !== "Var") {
        throw new Error(
          `Assign lvalue is ${exp.lvalue.kind}; the resolver should have rejected it`,
        );
      }
      const dst: TackyVar = { kind: "Var", name: exp.lvalue.name };
      const src = lowerExpression(exp.rvalue, out);
      out.push({ kind: "Copy", src, dst });
      return dst;
    }
    // The If skeleton again, with the one difference that makes it an
    // expression: both arms Copy into the SAME temporary, so the whole thing
    // has a single value regardless of which path ran. And unlike If, the
    // alternative is mandatory — so the Jump over it is always needed.
    case "Conditional": {
      const altLabel = makeLabel("alternative");
      const endLabel = makeLabel("end");

      const condition = lowerExpression(exp.predicate, out);
      out.push({ kind: "JumpIfZero", condition, target: altLabel });

      const src1 = lowerExpression(exp.consequent, out);
      const dst = makeTemporary();
      out.push({ kind: "Copy", src: src1, dst });
      out.push({ kind: "Jump", target: endLabel });

      out.push({ kind: "Label", name: altLabel });
      const src2 = lowerExpression(exp.alternative, out);
      out.push({ kind: "Copy", src: src2, dst });

      out.push({ kind: "Label", name: endLabel });
      return dst;
    }
    default: {
      const _never: never = exp;
      throw new Error(`Unhandled expression: ${JSON.stringify(_never)}`);
    }
  }
}
