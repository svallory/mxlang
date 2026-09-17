/**
 * `package.json#mx.angular` config (design note A3).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TranslateError } from "@mxlang/core";

export type OnError = "keep-last" | "error-template" | "delete";

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
}

interface AngularConfigShape {
  include?: unknown;
  pageExtension?: unknown;
  tagExtension?: unknown;
  ngExtension?: unknown;
  tagSelectorPrefix?: unknown;
  onError?: unknown;
}

interface PackageJsonShape {
  mx?: { angular?: AngularConfigShape };
}

const DEFAULTS: AngularConfig = {
  include: [],
  pageExtension: ".html",
  tagExtension: ".ts",
  ngExtension: ".ts",
  tagSelectorPrefix: "mx-",
  onError: "keep-last",
};

/** A config error, positioned against `package.json` itself (no finer position exists for a JSON value read this way). */
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

/** Reads and validates `package.json#mx.angular` in `projectDir`, applying A3's defaults. */
export function readAngularConfig(projectDir: string): AngularConfig {
  const packageFile = join(projectDir, "package.json");
  let pkg: PackageJsonShape;
  try {
    pkg = JSON.parse(readFileSync(packageFile, "utf8"));
  } catch (err) {
    fail(
      packageFile,
      `could not read ${packageFile}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const raw = pkg.mx?.angular ?? {};
  const allowed = new Set([
    "include",
    "pageExtension",
    "tagExtension",
    "ngExtension",
    "tagSelectorPrefix",
    "onError",
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

  return config;
}
