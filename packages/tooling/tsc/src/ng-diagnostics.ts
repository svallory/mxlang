/**
 * Angular template diagnostics for the `.ng.mx` files `mx-tsc` just compiled.
 *
 * `mx-tsc` type-checks a `.ng.mx` as a TypeScript module, which covers the
 * class but treats a template as an opaque string. This runs Angular's own
 * template checker over the same compiles and reports its findings at their
 * `.ng.mx` positions.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
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
): NgDiagnosticsResult {
  const resolve = deps.resolveCompilerCli ?? resolveCompilerCli;
  const createChecker = deps.createChecker ?? createAngularChecker;
  const result: NgDiagnosticsResult = { reports: [], errors: [] };

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

    const tsconfigPath = join(projectDir, "tsconfig.json");
    const checker = createChecker({
      projectDir,
      ...(existsSync(tsconfigPath) ? { tsconfigPath } : {}),
    });
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
    } finally {
      checker.dispose();
    }
  }

  return result;
}
