/**
 * Angular template diagnostics for the `.ng.mx` files `mx-tsc` just compiled.
 *
 * `mx-tsc` type-checks a `.ng.mx` as a TypeScript module, which covers the
 * class but treats a template as an opaque string. This runs Angular's own
 * template checker over the same compiles and reports its findings at their
 * `.ng.mx` positions.
 */

import { existsSync, statSync } from "node:fs";
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
 * The tsconfig `tsc` itself uses for `argv`: the value of `-p` / `--project`
 * (a file, or a directory holding `tsconfig.json`), else the nearest
 * `tsconfig.json` at or above `cwd`. `undefined` when there is none (for
 * example `tsc file.ts`, which uses no tsconfig).
 */
export function resolveProjectTsconfig(
  argv: readonly string[],
  cwd: string,
): string | undefined {
  let project: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "-p" || arg === "--project") project = argv[i + 1];
    else if (arg.startsWith("--project=")) project = arg.slice(10);
  }
  if (project !== undefined) {
    const path = resolve(cwd, project);
    if (!existsSync(path)) return undefined;
    return statSync(path).isDirectory() ? join(path, "tsconfig.json") : path;
  }
  let dir = cwd;
  for (;;) {
    const candidate = join(dir, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
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
