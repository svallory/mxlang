/**
 * Resolving `@angular/compiler-cli` from the *user's project*, at runtime.
 *
 * It is an optional peer dependency and is never bundled: this package ships
 * inside the VS Code extension's TypeScript plugin and inside `mx-tsc`, and
 * neither may carry a copy of Angular's compiler. The version the user's
 * project installs is the one that must check its templates.
 *
 * Resolution never crashes and never goes silent: every outcome that is not
 * `"ok"` carries a message telling the user what to install, or how to turn
 * the diagnostics off.
 */

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/** The compiler-cli versions this checker is tested against. */
export const SUPPORTED_COMPILER_CLI_RANGE = ">=22.0.0 <23.0.0";

/** The `@angular/compiler-cli` module, as this package uses it. */
export type CompilerCliModule = typeof import("@angular/compiler-cli");

export type CompilerCliResolution =
  | {
      status: "ok";
      version: string;
      module: CompilerCliModule;
      /** Real path of the resolved `@angular/compiler-cli/package.json`. */
      packageJson: string;
    }
  | { status: "missing"; message: string }
  | { status: "out-of-range"; version: string; message: string }
  | { status: "load-failed"; version: string; message: string };

const HOW_TO_FIX = `install a supported @angular/compiler-cli (${SUPPORTED_COMPILER_CLI_RANGE}) in your project, or set "mx.angular.diagnostics": "off" in package.json to skip Angular template diagnostics`;

/** `major.minor.patch` of a version string; a prerelease tag is ignored. */
function parseVersion(version: string): [number, number, number] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** Whether `version` is inside {@link SUPPORTED_COMPILER_CLI_RANGE}. */
function inSupportedRange(version: string): boolean {
  const parsed = parseVersion(version);
  return parsed !== undefined && parsed[0] === 22;
}

/**
 * Resolve `@angular/compiler-cli` from `projectDir`, check its version, and
 * load it.
 *
 * The version is checked *before* the module is loaded, so an unsupported
 * release is never executed.
 */
export function resolveCompilerCli(projectDir: string): CompilerCliResolution {
  const require = createRequire(join(projectDir, "package.json"));

  let version: string;
  let packageJson: string;
  try {
    packageJson = realpathSync(
      require.resolve("@angular/compiler-cli/package.json"),
    );
    const pkg = require("@angular/compiler-cli/package.json") as {
      version?: unknown;
    };
    version = typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return {
      status: "missing",
      message: `@angular/compiler-cli was not found from ${projectDir}: ${HOW_TO_FIX}.`,
    };
  }

  if (!inSupportedRange(version)) {
    return {
      status: "out-of-range",
      version,
      message: `@angular/compiler-cli ${version} (found from ${projectDir}) is outside the supported range ${SUPPORTED_COMPILER_CLI_RANGE}: ${HOW_TO_FIX}.`,
    };
  }

  try {
    return {
      status: "ok",
      version,
      module: require("@angular/compiler-cli") as CompilerCliModule,
      packageJson,
    };
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    return {
      status: "load-failed",
      version,
      message: `@angular/compiler-cli ${version} (found from ${projectDir}) could not be loaded: ${cause}. Fix the installation, or set "mx.angular.diagnostics": "off" in package.json to skip Angular template diagnostics.`,
    };
  }
}

/** The `typescript` module, as this package uses it. */
export type TypescriptModule = typeof import("typescript");

export type TypescriptResolution =
  | { status: "ok"; version: string; module: TypescriptModule }
  | { status: "missing"; message: string }
  | { status: "load-failed"; message: string };

/**
 * Resolve `typescript` for the checker.
 *
 * It is never bundled or shipped with this package: the checker runs in a
 * forked worker that tsserver hands no `ts` object. The instance that matters
 * is the one the project's compiler-cli loads (the checker's compiler host and
 * source files are handed to `NgtscProgram`), so when `compilerCliPackageJson`
 * (the real path of the resolved compiler-cli) is given, `typescript` is
 * resolved from there first, which is exactly what compiler-cli itself loads.
 * Only if that fails (or no path is given) does it fall back to `projectDir`.
 */
export function resolveTypescript(
  projectDir: string,
  compilerCliPackageJson?: string,
): TypescriptResolution {
  const candidates = [
    ...(compilerCliPackageJson ? [createRequire(compilerCliPackageJson)] : []),
    createRequire(join(projectDir, "package.json")),
  ];
  let require = candidates[0] as NodeJS.Require;
  let version: string | undefined;
  for (const candidate of candidates) {
    try {
      const pkg = candidate("typescript/package.json") as { version?: unknown };
      version = typeof pkg.version === "string" ? pkg.version : "unknown";
      require = candidate;
      break;
    } catch {}
  }
  if (version === undefined) {
    return {
      status: "missing",
      message: `typescript was not found from ${projectDir}: ${TS_HOW_TO_FIX}.`,
    };
  }
  try {
    return {
      status: "ok",
      version,
      module: require("typescript") as TypescriptModule,
    };
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    return {
      status: "load-failed",
      message: `typescript ${version} (found from ${projectDir}) could not be loaded: ${cause}. Fix the installation, or set "mx.angular.diagnostics": "off" in package.json to skip Angular template diagnostics.`,
    };
  }
}

const TS_HOW_TO_FIX = `install typescript in your project (the one your @angular/compiler-cli uses), or set "mx.angular.diagnostics": "off" in package.json to skip Angular template diagnostics`;

/**
 * Thrown by `createAngularChecker` when no usable compiler-cli, or no
 * `typescript`, resolves from the project. The message names which.
 */
export class CompilerCliUnavailableError extends Error {
  readonly status: "missing" | "out-of-range" | "load-failed";

  constructor(
    resolution: Exclude<
      CompilerCliResolution | TypescriptResolution,
      { status: "ok" }
    >,
  ) {
    super(resolution.message);
    this.name = "CompilerCliUnavailableError";
    this.status = resolution.status;
  }
}
