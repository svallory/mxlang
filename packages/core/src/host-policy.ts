/**
 * Policy resolution (brief §2, `host-diagnostics.md` §3): which host policy
 * applies to a given file.
 *
 * Rule, in order:
 *
 * 1. Walk upward from the file's directory looking for the nearest
 *    `package.json`. If it has an `"mx"` field, that field *is* the
 *    answer: `{ host: "html" | "astro" | "solid" | "preact" | "react" | "hono", strict?: boolean }`
 *    (with "translator" accepted as a deprecated alias for "html").
 * 2. Otherwise, if that same `package.json` depends (in `dependencies` or
 *    `devDependencies`) on exactly one `@mxlang/*` host package
 *    (`@mxlang/html`, `@mxlang/astro`, `@mxlang/solid`, `@mxlang/preact`,
 *    `@mxlang/react`, `@mxlang/hono`;
 *    `@mxlang/core` itself does not count, since every host depends on it
 *    too), use that host.
 * 3. Otherwise, fall back to the translator's default (non-strict) policy.
 *
 * This mirrors `Project.loadMeta`'s own `createRequire` + upward
 * `package.json` walk in Marko's language server (`host-diagnostics.md` §1),
 * so the technique is not novel to this package.
 *
 * It lives in `@mxlang/core` rather than in either consumer because two
 * entry points ask this same question: `@mxlang/language-server` (to pick the
 * policy a document is diagnosed under) and `@mxlang/typescript-plugin` (to
 * pick the host a `.mx` file's virtual TypeScript is compiled through). An
 * editor and a `tsc` run disagreeing about which host owns a file is exactly
 * the drift a second copy invites, so there is one implementation and one
 * set of branch tests. Unlike the rest of this package it touches `node:fs`,
 * which is why it is its own module rather than part of `core.ts`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The host a file compiles through, plus that host's strictness. */
export interface HostPolicy {
  host: "html" | "astro" | "solid" | "preact" | "react" | "hono" | "angular";
  strict?: boolean;
}

const HOST_PACKAGES: Record<string, HostPolicy["host"]> = {
  "@mxlang/html": "html",
  "@mxlang/astro": "astro",
  "@mxlang/solid": "solid",
  "@mxlang/preact": "preact",
  "@mxlang/react": "react",
  "@mxlang/hono": "hono",
  "@mxlang/angular": "angular",
};

const DEFAULT_POLICY: HostPolicy = { host: "html" };

interface PackageJsonShape {
  mx?: { host?: string; strict?: boolean };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function isKnownHost(
  value: unknown,
): value is HostPolicy["host"] | "translator" {
  return (
    value === "html" ||
    value === "translator" ||
    value === "astro" ||
    value === "solid" ||
    value === "preact" ||
    value === "react" ||
    value === "hono" ||
    value === "angular"
  );
}

function readPackageJson(path: string): PackageJsonShape | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Finds the nearest `package.json` at or above `fileDir`, returning its
 * parsed contents plus the directory it was found in. `undefined` if none is
 * found before the filesystem root.
 */
function findNearestPackageJson(
  fileDir: string,
): { pkg: PackageJsonShape; dir: string } | undefined {
  let dir = fileDir;
  for (;;) {
    const candidate = join(dir, "package.json");
    const pkg = readPackageJson(candidate);
    if (pkg) return { pkg, dir };

    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Resolves the `HostPolicy` for `filePath` by walking upward from its
 * containing directory. See module doc for the three-branch rule.
 */
export function resolveHostPolicy(filePath: string): HostPolicy {
  const found = findNearestPackageJson(dirname(filePath));
  if (!found) return DEFAULT_POLICY;

  const { mx, dependencies, devDependencies } = found.pkg;

  if (mx && isKnownHost(mx.host)) {
    if (mx.host === "translator") {
      console.warn(
        "Warning: The 'translator' mx.host alias is deprecated and will be removed in a future release. Use 'html' instead.",
      );
      return { host: "html", strict: mx.strict };
    }
    return { host: mx.host as HostPolicy["host"], strict: mx.strict };
  }

  const deps = { ...dependencies, ...devDependencies };
  const hostDeps = Object.keys(HOST_PACKAGES).filter((name) => name in deps);
  if (hostDeps.length === 1) {
    const host = HOST_PACKAGES[hostDeps[0] as string];
    if (host) return { host };
  }

  return DEFAULT_POLICY;
}
