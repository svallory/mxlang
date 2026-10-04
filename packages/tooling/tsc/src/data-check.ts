import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import {
  checkDataPackage,
  type DataCheckDiagnostic,
  HOST_POLICY_DIAGNOSTIC_CODE,
  isDataProject,
} from "@mxlang/typescript-plugin";

/**
 * The directory `mx-tsc` should check as a data package, or `undefined` when
 * this run is an ordinary `tsc` run.
 *
 * Only the arguments a data check understands qualify: `-p`/`--project <dir
 * or tsconfig>`, `--pretty [bool]` and `--noEmit`. Anything else (`-b`,
 * `-w`, `--version`, `--init`, a file list) is a request the data check does
 * not answer, so it stays with `tsc` and the staged error for `data` that
 * the registry wrapper still raises (TODO `data-target-tooling-dispatch`).
 * No tsconfig is needed or read: the files are the package's `.mx` files.
 *
 * And only when that directory's own `package.json` says `mx.target: "data"`:
 * a package that is data by rule 5 (an `@mxlang/data` dependency), a monorepo
 * root, or a directory with no manifest of its own keeps its `tsc` run, so a
 * TypeScript error is never swallowed by a data inference.
 */
export function dataProjectDir(
  argv: readonly string[],
  cwd: string,
): string | undefined {
  let project: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-p" || arg === "--project") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("-")) return undefined;
      project = value;
    } else if (arg === "--pretty") {
      if (argv[i + 1] === "true" || argv[i + 1] === "false") i++;
    } else if (arg !== "--noEmit") return undefined;
  }
  const path = resolve(cwd, project ?? ".");
  let dir = path;
  try {
    if (!statSync(path).isDirectory()) dir = dirname(path);
  } catch {
    return undefined;
  }
  return isDataProject(dir) ? dir : undefined;
}

/**
 * Runs the data check on `dir` and prints what it found in the shape `tsc`
 * prints a host file's diagnostics: `file(line,col): error TS80001: message`.
 * A data file's diagnostic is the same compile diagnostic a host `.mx` file
 * gets (TS80001 an error, TS80002 a warning), so one grep finds them all; a
 * problem in the `package.json` that configures the check is TS80003, the
 * code of every other manifest diagnostic. Returns the exit code: 1 on any
 * error, else 0.
 */
export function runDataCheck(dir: string): number {
  const { diagnostics } = checkDataPackage(dir);
  if (diagnostics.length === 0) return 0;
  const require = createRequire(import.meta.url);
  const typescript = require("typescript") as typeof import("typescript");
  const host = {
    getCanonicalFileName: (fileName: string) => fileName,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => "\n",
  };
  const printed = diagnostics.map((diagnostic) =>
    diagnostic.origin === "io"
      ? // The file system refused: there is no text to position in, and
        // `formatDiagnostics` would drop the path with it.
        `${relative(host.getCurrentDirectory(), diagnostic.file)}: ${diagnostic.severity} TS80001: ${diagnostic.message}\n`
      : typescript.formatDiagnostics(
          [toTsDiagnostic(typescript, diagnostic)],
          host,
        ),
  );
  process.stderr.write(printed.join(""));
  return diagnostics.some((d) => d.severity === "error") ? 1 : 0;
}

function toTsDiagnostic(
  typescript: typeof import("typescript"),
  diagnostic: DataCheckDiagnostic,
): import("typescript").Diagnostic {
  // `undefined` is "could not read"; an empty file that read fine is "" and is
  // still a file to name and position in.
  let text: string | undefined;
  try {
    text = readFileSync(diagnostic.file, "utf8");
  } catch {
    // Unreadable now: print the message without a line/column.
  }
  const file =
    text === undefined
      ? undefined
      : typescript.createSourceFile(
          diagnostic.file,
          text,
          typescript.ScriptTarget.Latest,
          false,
          diagnostic.origin === "manifest"
            ? typescript.ScriptKind.JSON
            : typescript.ScriptKind.Unknown,
        );
  const starts = file?.getLineStarts() ?? [0];
  const line = Math.min(Math.max(diagnostic.line - 1, 0), starts.length - 1);
  const isError = diagnostic.severity === "error";
  return {
    file,
    // `line` is 1-based and `column` 0-based; tsc prints both 1-based.
    start: Math.min((starts[line] ?? 0) + diagnostic.column, text?.length ?? 0),
    length: diagnostic.length ?? 0,
    category: isError
      ? typescript.DiagnosticCategory.Error
      : typescript.DiagnosticCategory.Warning,
    code:
      diagnostic.origin === "manifest"
        ? HOST_POLICY_DIAGNOSTIC_CODE
        : isError
          ? 80001
          : 80002,
    source: "mxlang",
    messageText: diagnostic.message,
  };
}
