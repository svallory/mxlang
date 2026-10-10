import { readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
  checkDataPackage,
  HOST_POLICY_DIAGNOSTIC_CODE,
  isDataProject,
  lineAndColumn,
} from "@mxlang/typescript-plugin";

/**
 * The directory `mx-tsc` should check as a data package, or `undefined` when
 * this run is an ordinary `tsc` run.
 *
 * Only the arguments a data check understands qualify: `-p`/`--project <dir
 * or tsconfig>`, `--pretty [bool]` and `--noEmit`. Anything else (`-b`,
 * `-w`, `--version`, `--init`, a file list) is a request the data check does
 * not answer, so it stays with `tsc` and the registry wrapper's removed-target error.
 * No tsconfig is needed or read: the files are the package's `.mx` files.
 *
 * And only when that directory's own `package.json` says `mx.target: "tree"`:
 * a monorepo root, or a directory with no manifest of its own, keeps its
 * `tsc` run, so a TypeScript error is never swallowed by a data inference.
 * Decision 204 removed the tree target, so no directory qualifies until the
 * dialect check replaces this one (TODO dialect-check (PR 1c)).
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
 *
 * The line is printed here, not by `typescript.formatDiagnostics`: that wants
 * a parsed `SourceFile`, and parsing a manifest or a data file to find a line
 * start recurses with its nesting depth, so a deep but valid file would
 * overflow the stack inside the very diagnostic that reports on it. The
 * line-break rules are TypeScript's own (`lineAndColumn`, pinned against
 * `ts.createSourceFile` in `data-check.test.ts`).
 */
export function runDataCheck(dir: string): number {
  const { diagnostics } = checkDataPackage(dir);
  if (diagnostics.length === 0) return 0;
  const cwd = process.cwd();
  const printed = diagnostics.map((diagnostic) => {
    // The path is relative to the cwd, as `tsc` prints it; the cwd itself is `.`.
    const path = relative(cwd, diagnostic.file) || ".";
    const code =
      diagnostic.origin === "manifest"
        ? HOST_POLICY_DIAGNOSTIC_CODE
        : diagnostic.severity === "error"
          ? 80001
          : 80002;
    const head = `${diagnostic.severity} TS${diagnostic.origin === "io" ? 80001 : code}: ${diagnostic.message}\n`;
    // The file system refused: there is no text to position in.
    if (diagnostic.origin === "io") return `${path}: ${head}`;
    let text: string | undefined;
    try {
      text = readFileSync(diagnostic.file, "utf8");
    } catch {
      // Unreadable now: print the message without a line/column.
    }
    // `undefined` is "could not read"; an empty file that read fine is "" and
    // is still a file to name and position in.
    if (text === undefined) return `${path}: ${head}`;
    const offset =
      diagnostic.offset ??
      (diagnostic.lfCoordinates
        ? offsetOfLfPosition(text, diagnostic)
        : undefined);
    const at =
      offset !== undefined
        ? lineAndColumn(text, offset)
        : {
            // Any other producer's coordinates are printed as given, clamped.
            line: Math.min(
              Math.max(diagnostic.line, 1),
              lineAndColumn(text, text.length).line,
            ),
            column: diagnostic.column,
          };
    // `line` is 1-based and `column` 0-based; tsc prints both 1-based.
    return `${path}(${at.line},${at.column + 1}): ${head}`;
  });
  process.stderr.write(printed.join(""));
  return diagnostics.some((d) => d.severity === "error") ? 1 : 0;
}

/**
 * The offset a diagnostic without one points at, when it is tagged
 * `lfCoordinates`. Its `line`/`column` come from a producer that counts lines
 * by LF only (core's policy and scan diagnostics), so they
 * are turned into an offset by that rule and clamped to the text (a line past
 * the end is the end); the printer then applies TypeScript's rule to the
 * offset. Reading them with TypeScript's rule instead would move a position in
 * a file with a lone CR or a U+2028 above it.
 */
function offsetOfLfPosition(
  text: string,
  { line, column }: { line: number; column: number },
): number {
  let start = 0;
  for (let seen = 1; seen < line; seen++) {
    const next = text.indexOf("\n", start);
    if (next === -1) return text.length;
    start = next + 1;
  }
  return Math.min(start + Math.max(column, 0), text.length);
}
