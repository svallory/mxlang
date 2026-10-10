/**
 * The `angular` section of MX's config (`mx.config.*`, `.mxrc*` or
 * `package.json#mx`; design note A3).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findMxConfig, TranslateError } from "@mxlang/core";

export type OnError = "keep-last" | "error-template" | "delete";

/**
 * When Angular template diagnostics run for `.ng.mx` files.
 *
 * `"off"` disables them everywhere (`mx-tsc` and editors). `"idle"` and
 * `"save"` are editor scheduling modes (after 1 s idle / on save); `mx-tsc`
 * has no editing session and treats both as on.
 */
export type AngularDiagnosticsMode = "idle" | "save" | "off";

export interface AngularConfig {
  include: string[];
  pageExtension: string;
  tagExtension: string;
  /**
   * The extension a `.ng.mx` component compiles to, beside its source.
   *
   * Its own key rather than a reuse of `tagExtension`: the two outputs have
   * different overwrite risks. A tag module is wholly MX-generated, while a
   * `.ng.mx` emits a module whose TypeScript the author wrote, so a project
   * may well want them routed differently — and sharing one key would make
   * that impossible without changing both.
   */
  ngExtension: string;
  tagSelectorPrefix: string;
  onError: OnError;
  /** See {@link AngularDiagnosticsMode}. Default `"idle"`. */
  diagnostics: AngularDiagnosticsMode;
}

interface AngularConfigShape {
  include?: unknown;
  pageExtension?: unknown;
  tagExtension?: unknown;
  ngExtension?: unknown;
  tagSelectorPrefix?: unknown;
  onError?: unknown;
  diagnostics?: unknown;
}

const DEFAULTS: AngularConfig = {
  include: [],
  pageExtension: ".html",
  tagExtension: ".ts",
  ngExtension: ".ts",
  tagSelectorPrefix: "mx-",
  onError: "keep-last",
  diagnostics: "idle",
};

/** A config error, positioned against the config file itself (no finer position exists for a value read this way). */
function fail(packageFile: string, message: string): never {
  throw new TranslateError(message, 1, 0, packageFile);
}

function readStringArray(
  packageFile: string,
  value: unknown,
  what: string,
): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    fail(packageFile, `\`${what}\` must be an array of strings`);
  }
  return value as string[];
}

function readString(packageFile: string, value: unknown, what: string): string {
  if (typeof value !== "string") {
    fail(packageFile, `\`${what}\` must be a string`);
  }
  return value;
}

function readOnError(packageFile: string, value: unknown): OnError {
  if (
    value !== "keep-last" &&
    value !== "error-template" &&
    value !== "delete"
  ) {
    fail(
      packageFile,
      '`mx.angular.onError` must be one of "keep-last", "error-template" or "delete"',
    );
  }
  return value;
}

function readDiagnostics(
  packageFile: string,
  value: unknown,
): AngularDiagnosticsMode {
  if (value !== "idle" && value !== "save" && value !== "off") {
    fail(
      packageFile,
      '`mx.angular.diagnostics` must be one of "idle", "save" or "off"',
    );
  }
  return value;
}

/**
 * Reads and validates the `angular` section of the MX config that applies to
 * `projectDir` (`package.json#mx.angular`, or `angular` in `mx.config.*`),
 * applying A3's defaults.
 *
 * Tooling-facing API: the build, the watcher and editor tooling (the
 * TypeScript plugin) read the same config through it, so they cannot disagree
 * about a project. Not part of `@mxlang/host-angular/runtime`, which stays
 * zero-import.
 *
 * Throws a positioned `TranslateError` (line 1 of the config file) when the
 * config file cannot be read, when a value has the wrong type, and for
 * an unknown key: `` `mx.angular.<key>` is not a recognized key; expected one
 * of ... ``, and for a `diagnostics` value other than `"idle"`, `"save"` or
 * `"off"` (`"off"` turns Angular template diagnostics off everywhere; the
 * other two are editor scheduling modes that `mx-tsc` treats as on). It
 * never falls back to defaults on invalid input, so a caller must catch and
 * report the error rather than ignore it.
 */
export function readAngularConfig(projectDir: string): AngularConfig {
  const source = findMxConfig(projectDir);
  const packageFile = source?.file ?? join(projectDir, "package.json");
  if (!source || source.format === "package.json") {
    // The project's own manifest must parse, as it always had to: the
    // config loader keeps a broken revision's previous settings in force,
    // which the build must not do silently.
    try {
      JSON.parse(readFileSync(packageFile, "utf8"));
    } catch (err) {
      fail(
        packageFile,
        `could not read ${packageFile}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (source.error) {
    throw new TranslateError(
      `could not read ${packageFile}: ${source.error.message}`,
      source.error.line,
      source.error.column,
      packageFile,
    );
  }

  const raw = (source?.config?.angular ?? {}) as AngularConfigShape;
  const allowed = new Set([
    "include",
    "pageExtension",
    "tagExtension",
    "ngExtension",
    "tagSelectorPrefix",
    "onError",
    "diagnostics",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      fail(
        packageFile,
        `\`mx.angular.${key}\` is not a recognized key; expected one of ${[...allowed].join(", ")}`,
      );
    }
  }

  const config: AngularConfig = { ...DEFAULTS };

  if (raw.include !== undefined) {
    config.include = readStringArray(
      packageFile,
      raw.include,
      "mx.angular.include",
    );
  }
  if (raw.pageExtension !== undefined) {
    config.pageExtension = readString(
      packageFile,
      raw.pageExtension,
      "mx.angular.pageExtension",
    );
  }
  if (raw.ngExtension !== undefined) {
    config.ngExtension = readString(
      packageFile,
      raw.ngExtension,
      "mx.angular.ngExtension",
    );
  }
  if (raw.tagExtension !== undefined) {
    config.tagExtension = readString(
      packageFile,
      raw.tagExtension,
      "mx.angular.tagExtension",
    );
  }
  if (raw.tagSelectorPrefix !== undefined) {
    config.tagSelectorPrefix = readString(
      packageFile,
      raw.tagSelectorPrefix,
      "mx.angular.tagSelectorPrefix",
    );
  }
  if (raw.onError !== undefined) {
    config.onError = readOnError(packageFile, raw.onError);
  }

  if (raw.diagnostics !== undefined) {
    config.diagnostics = readDiagnostics(packageFile, raw.diagnostics);
  }

  return config;
}
