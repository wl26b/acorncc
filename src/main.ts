// The compiler driver. Implements the command-line contract that Sandler's test
// suite expects:
//
//   acorncc foo.c             -> produce executable ./foo (assemble + link), exit 0
//   acorncc --lex foo.c       -> run the lexer only; write NO files
//   acorncc --parse foo.c     -> run through the parser; write NO files
//   acorncc --validate foo.c  -> run through semantic analysis; write NO files
//   acorncc --codegen foo.c   -> run through codegen; write NO files
//   acorncc -S foo.c          -> emit foo.s assembly; do not assemble/link
//
// On ANY compile error: exit non-zero and leave no output files behind. Because
// we only write files at the very end (after all in-memory stages succeed),
// that property falls out naturally.

import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import { lex } from "./lexer.js";
import { parse } from "./parser.js";
import { resolve } from "./resolve.js";
import { generate } from "./codegen.js";

type Stage =
  "lex" | "parse" | "validate" | "codegen" | "assembly" | "executable";

interface Options {
  stage: Stage;
  sourcePath: string;
}

function parseArgs(argv: string[]): Options {
  let stage: Stage = "executable";
  let sourcePath: string | undefined;

  for (const arg of argv) {
    switch (arg) {
      case "--lex":
        stage = "lex";
        break;
      case "--parse":
        stage = "parse";
        break;
      case "--validate":
        stage = "validate";
        break;
      case "--codegen":
        stage = "codegen";
        break;
      case "-S":
      case "-s":
        stage = "assembly";
        break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        sourcePath = arg;
    }
  }

  if (sourcePath === undefined) {
    throw new Error("No source file provided");
  }
  return { stage, sourcePath };
}

function main(): void {
  const { stage, sourcePath } = parseArgs(process.argv.slice(2));

  // Preprocess by shelling out to clang: -E expands directives, -P drops the
  // `# 12 "file"` line markers. acorncc already depends on clang to
  // assemble+link, so this adds no new dependency — it's the M7 preprocessor
  // strategy ("don't build a CPP; shell out to clang -E") pulled forward,
  // because the ch4 tests wrap warning pragmas in `#ifdef SUPPRESS_WARNINGS`
  // blocks that must be stripped (the macro is never defined). Full M7 will
  // extend this with `-nostdinc -I <ourheaders>` so #includes resolve to
  // mylibc.h.
  const source = execFileSync("clang", ["-E", "-P", sourcePath], {
    encoding: "utf8",
  });

  // --- Front end: text -> tokens -> AST. Pure, in-memory, no file output. ---
  const tokens = lex(source);
  if (stage === "lex") return;

  const ast = parse(tokens);
  if (stage === "parse") return;

  // --- Middle: semantic analysis. Rejects programs that PARSE but don't mean
  // anything (undeclared names, duplicate declarations, assigning to a
  // non-lvalue), and resolves every name to the declaration it refers to. Takes
  // an AST and returns an AST, so codegen never has to ask those questions. ---
  const resolved = resolve(ast);
  if (stage === "validate") return;

  // --- Back end: AST -> assembly text. ---
  const asm = generate(resolved);
  if (stage === "codegen") return;

  // From here on we produce files. Compute sibling paths next to the source:
  //   /path/foo.c -> asm /path/foo.s, exe /path/foo
  const dir = dirname(sourcePath);
  const stem = basename(sourcePath, extname(sourcePath));
  const asmPath = join(dir, `${stem}.s`);
  const exePath = join(dir, stem);

  writeFileSync(asmPath, asm);
  if (stage === "assembly") return; // -S: leave the .s, stop here.

  // Default: hand the assembly to clang, which assembles and links it (pulling
  // in the C runtime that calls _main) into a native executable.
  try {
    execFileSync("clang", [asmPath, "-o", exePath], { stdio: "inherit" });
  } finally {
    // The .s is just an intermediate for a full build; don't leave it lying
    // around. (For -S we returned above and kept it.)
    rmSync(asmPath, { force: true });
  }
}

try {
  main();
  process.exit(0);
} catch (err) {
  // Any lexer/parser/driver error: report and exit non-zero. This is what the
  // invalid_* test cases rely on to distinguish "rejected correctly" from
  // "compiled something broken".
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
}
