/**
 * Angular template diagnostics for the `.ng.mx` files `mx-tsc` just compiled.
 *
 * `mx-tsc` type-checks a `.ng.mx` as a TypeScript module, which covers the
 * class but treats a template as an opaque string. This runs Angular's own
 * template checker over the same compiles and reports its findings at their
 * `.ng.mx` positions.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { readAngularConfig } from "@mxlang/angular";
import {
  type AngularChecker,
  type AngularCheckerOptions,
  createAngularChecker,
  diagnoseNgMx,
  type NgMxDiagnostic,
  resolveCompilerCli,
} from "@mxlang/angular-checker";
import type { CompiledNgMx } from "@mxlang/typescript-plugin";

/** Seams for tests; production uses the real implementations. */
export interface NgDiagnosticsDeps {
  resolveCompilerCli?: typeof resolveCompilerCli;
  createChecker?: (options: AngularCheckerOptions) => AngularChecker;
}

export interface NgDiagnosticsOptions {
  /**
   * The tsconfig the TypeScript pass ran under (see
   * {@link resolveProjectTsconfig}); templates are checked under the same
   * options as the code.
   */
  tsconfigPath?: string | undefined;
}

export interface NgMxReport {
  fileName: string;
  /** The `.ng.mx` text the diagnostics' offsets index into. */
  source: string;
  diagnostics: NgMxDiagnostic[];
}

export interface NgDiagnosticsResult {
  /** One entry per checked file that has diagnostics. */
  reports: NgMxReport[];
  /**
   * Conditions that stop a project's templates from being checked at all:
   * a missing or unsupported compiler-cli, an invalid config, a crashed
   * check. Each one fails the run; silence would pass CI with the templates
   * unchecked.
   */
  errors: string[];
  /** Compiler option warnings: printed, never failing the run. */
  warnings: string[];
}

function nearestPackageDir(fileName: string): string {
  let dir = dirname(fileName);
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return dirname(fileName);
    dir = parent;
  }
}

/**
 * The tsconfigs `tsc` itself uses for `argv`, decided by TypeScript's own
 * command-line parser (so `-p`/`-P`, response files and every other spelling
 * agree with the TypeScript pass by construction) and by the same rules as
 * `tsc`'s `executeCommandLine`:
 *
 * - `-p` names a file, or a directory holding `tsconfig.json`;
 * - without `-p`, input files on the command line mean no tsconfig at all;
 *   otherwise `ts.findConfigFile` from `cwd` upwards;
 * - `-b` / `--build` names its projects positionally (default `.`, no walk
 *   up), each a file or a directory, in the order given.
 *
 * Empty when `tsc` uses none or cannot find one (it reports that itself and
 * fails the run). Exactly one entry except under `-b` with several projects.
 */
export function resolveProjectTsconfigs(
  argv: readonly string[],
  cwd: string,
): string[] {
  const require = createRequire(import.meta.url);
  const ts = require("typescript") as typeof import("typescript");
  const configIn = (fileOrDirectory: string): string[] => {
    const path = resolve(cwd, fileOrDirectory);
    if (ts.sys.directoryExists(path)) {
      const config = join(path, "tsconfig.json");
      return ts.sys.fileExists(config) ? [config] : [];
    }
    return ts.sys.fileExists(path) ? [path] : [];
  };
  // `tsc` enters build mode only when `-b` / `--build` is the first argument.
  const first = argv[0]?.replace(/^--?/, "").toLowerCase();
  if (argv[0]?.startsWith("-") && (first === "b" || first === "build")) {
    const { projects } = ts.parseBuildCommand([...argv]);
    return (projects.length > 0 ? projects : ["."]).flatMap(configIn);
  }
  const { options, fileNames } = ts.parseCommandLine([...argv], (path) =>
    ts.sys.readFile(resolve(cwd, path)),
  );
  if (options.help || options.all || options.version || options.init) {
    return [];
  }
  if (options.project) return configIn(options.project);
  if (fileNames.length > 0) return [];
  const found = ts.findConfigFile(cwd, ts.sys.fileExists);
  return found === undefined ? [] : [found];
}

/** The first tsconfig {@link resolveProjectTsconfigs} finds, if any. */
export function resolveProjectTsconfig(
  argv: readonly string[],
  cwd: string,
): string | undefined {
  return resolveProjectTsconfigs(argv, cwd)[0];
}

/**
 * {@link checkNgMxFiles} once per tsconfig `argv` makes `tsc` use, results
 * merged in that order. One tsconfig (every case but `tsc -b a b`) checks all
 * entries, as before. With several, a file belongs to the project whose
 * directory holds it most closely; a file under none is not checked (the
 * TypeScript pass has no project for it either), and a project with no
 * `.ng.mx` is skipped.
 */
export function checkNgMxProjects(
  entries: readonly CompiledNgMx[],
  argv: readonly string[],
  cwd: string,
  deps: NgDiagnosticsDeps = {},
): NgDiagnosticsResult {
  const result: NgDiagnosticsResult = { reports: [], errors: [], warnings: [] };
  if (entries.length === 0) return result;
  const configs = resolveProjectTsconfigs(argv, cwd);
  const run = (group: readonly CompiledNgMx[], tsconfigPath?: string) => {
    if (group.length === 0) return;
    const part = checkNgMxFiles(group, deps, { tsconfigPath });
    result.reports.push(...part.reports);
    result.errors.push(...part.errors);
    result.warnings.push(...part.warnings);
  };
  if (configs.length <= 1) {
    run(entries, configs[0]);
    return result;
  }
  const dirs = configs.map((config) => dirname(config));
  const owner = (fileName: string): number => {
    let best = -1;
    dirs.forEach((dir, index) => {
      if (
        fileName.startsWith(`${dir}/`) &&
        (best < 0 || dir.length > (dirs[best] as string).length)
      ) {
        best = index;
      }
    });
    return best;
  };
  configs.forEach((config, index) => {
    run(
      entries.filter((entry) => owner(entry.fileName) === index),
      config,
    );
  });
  return result;
}

/**
 * {@link checkNgMxFiles} once per project, each under its own tsconfig, results
 * merged in order. The `-b` path: the caller has already assigned every file to
 * exactly one project, so nothing here guesses ownership.
 */
export function checkNgMxGroups(
  groups: readonly { tsconfigPath: string; entries: readonly CompiledNgMx[] }[],
  deps: NgDiagnosticsDeps = {},
): NgDiagnosticsResult {
  const result: NgDiagnosticsResult = { reports: [], errors: [], warnings: [] };
  for (const { tsconfigPath, entries } of groups) {
    if (entries.length === 0) continue;
    const part = checkNgMxFiles(entries, deps, { tsconfigPath });
    result.reports.push(...part.reports);
    result.errors.push(...part.errors);
    result.warnings.push(...part.warnings);
  }
  return result;
}

function plural(count: number): string {
  return `${count} .ng.mx file${count === 1 ? "" : "s"}`;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Run Angular template diagnostics over compiled `.ng.mx` files.
 *
 * Files are grouped by project (the nearest `package.json`). A project whose
 * `mx.angular.diagnostics` is `"off"` is skipped before `@angular/compiler-cli`
 * is touched, and so is a run with no `.ng.mx` files at all. Otherwise
 * compiler-cli is resolved from the project; one checker serves every file of
 * the project and is disposed when the project is done.
 */
export function checkNgMxFiles(
  entries: readonly CompiledNgMx[],
  deps: NgDiagnosticsDeps = {},
  options: NgDiagnosticsOptions = {},
): NgDiagnosticsResult {
  const resolve = deps.resolveCompilerCli ?? resolveCompilerCli;
  const createChecker = deps.createChecker ?? createAngularChecker;
  const result: NgDiagnosticsResult = {
    reports: [],
    errors: [],
    warnings: [],
  };

  const byProject = new Map<string, CompiledNgMx[]>();
  for (const entry of [...entries].sort((a, b) =>
    a.fileName.localeCompare(b.fileName),
  )) {
    const dir = nearestPackageDir(entry.fileName);
    const group = byProject.get(dir);
    if (group) group.push(entry);
    else byProject.set(dir, [entry]);
  }

  for (const [projectDir, files] of byProject) {
    let diagnostics: string;
    try {
      diagnostics = readAngularConfig(projectDir).diagnostics;
    } catch (cause) {
      result.errors.push(
        `${join(projectDir, "package.json")}: ${message(cause)}`,
      );
      continue;
    }
    if (diagnostics === "off") continue;

    const resolution = resolve(projectDir);
    if (resolution.status !== "ok") {
      result.errors.push(
        `${resolution.message} (${plural(files.length)} in ${projectDir} not checked)`,
      );
      continue;
    }

    let checker: AngularChecker;
    try {
      checker = createChecker({
        projectDir,
        ...(options.tsconfigPath ? { tsconfigPath: options.tsconfigPath } : {}),
      });
    } catch (cause) {
      // An unusable tsconfig (unreadable, malformed, bad `extends`) or
      // compiler-cli: report it, never fall back to other options.
      result.errors.push(
        `${message(cause)} (${plural(files.length)} in ${projectDir} not checked)`,
      );
      continue;
    }
    try {
      for (const entry of files) {
        try {
          const found = diagnoseNgMx(
            entry.result,
            checker,
            `${entry.fileName}.ts`,
          );
          if (found.length > 0) {
            result.reports.push({
              fileName: entry.fileName,
              source: entry.source,
              diagnostics: found,
            });
          }
        } catch (cause) {
          result.errors.push(
            `${entry.fileName}: Angular template diagnostics failed: ${message(cause)}`,
          );
        }
      }
      // Compiler option errors (e.g. `extendedDiagnostics` with
      // `strictTemplates: false`, which `ng build` rejects) belong to the
      // configuration, not to a file: report them once per project, against
      // the tsconfig.
      for (const d of checker.configDiagnostics()) {
        // TypeScript's own option errors are already printed by the
        // TypeScript pass for this same tsconfig; repeating them would print
        // each twice (the same reason `diagnoseNgMx` drops `ts` records).
        if (d.source === "ts") continue;
        const text = `${options.tsconfigPath ?? join(projectDir, "package.json")}: ${d.message} (code ${d.code})`;
        if (d.category === "error") result.errors.push(text);
        else result.warnings.push(text);
      }
    } finally {
      checker.dispose();
    }
  }

  return result;
}
