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
 * Edge cases of the walk (each pinned in `host-policy.test.ts`):
 *
 * - The nearest `package.json` is the one that *exists*, parseable or not. A
 *   malformed one (or one that is not a JSON object) ends the walk with the
 *   default `html` policy plus a warning; it does not fall through to an
 *   unrelated ancestor. Node, TypeScript and `scan.ts` all stop there too.
 * - A directory with no `package.json` of its own belongs to the nearest
 *   ancestor's project, a monorepo root included. That is how `src/` inside a
 *   package works, and it cannot be told apart from a workspace member that
 *   forgot its manifest; give the member its own `package.json` (or `mx.host`)
 *   to opt out.
 * - The walk stops at a `node_modules` directory (Node's package-scope rule):
 *   a file in an installed package that ships no `package.json` gets the
 *   default policy, not the consumer's host.
 * - An `mx.host` that names no host is ignored with a warning (with a
 *   nearest-match hint), and resolution continues with the dependency rule.
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

import { basename, dirname, join } from "node:path";
import {
  type PackageJsonRead,
  positionOfOffset,
  readPackageJsonCached,
} from "./package-json.ts";

/** The host a file compiles through, plus that host's strictness. */
export interface HostPolicy {
  host: "html" | "astro" | "solid" | "preact" | "react" | "hono" | "angular";
  strict?: boolean;
}

/**
 * Every real host name `HostPolicy["host"]` admits — exported so a second
 * caller (`scan.ts`'s `hosts` validation) checks a string against the same
 * runtime list this module already checks `mx.host` against, rather than
 * hand-maintaining a second copy of these seven names. Deliberately excludes
 * `"translator"`: that string is only a deprecated alias for `"html"` on
 * `mx.host`, not a real host `mx.tags[].hosts` could ever filter to.
 */
export const HOST_NAMES: readonly HostPolicy["host"][] = [
  "html",
  "astro",
  "solid",
  "preact",
  "react",
  "hono",
  "angular",
];

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

/** Why a {@link HostPolicyDiagnostic} was raised. */
export type HostPolicyDiagnosticCode =
  | "unknown-host"
  | "malformed-package-json";

/**
 * One problem found while resolving a host, positioned in the `package.json`
 * that caused it. Same shape as `ScanDiagnostic` so a caller can merge the
 * two into the stream it already reports.
 *
 * Every one is a *warning*: resolution always produces a policy, and nothing
 * here may fail a build that compiled before.
 */
export interface HostPolicyDiagnostic {
  /**
   * What went wrong, so a caller can word or route it without matching the
   * message text.
   */
  code: HostPolicyDiagnosticCode;
  /** The `package.json` to point an author at. */
  file: string;
  message: string;
  /** 1-based. */
  line: number;
  /** 0-based. */
  column: number;
}

/** A resolved policy plus whatever the resolution had to say about it. */
export interface HostPolicyResolution {
  policy: HostPolicy;
  diagnostics: HostPolicyDiagnostic[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Found {
  file: string;
  dir: string;
  read: PackageJsonRead;
}

/**
 * Finds the nearest `package.json` at or above `fileDir` — the nearest one
 * that exists, whether or not it parses. `undefined` if none is found before
 * the filesystem root or a `node_modules` directory.
 */
function findNearestPackageJson(fileDir: string): Found | undefined {
  let dir = fileDir;
  for (;;) {
    const file = join(dir, "package.json");
    const read = readPackageJsonCached(file);
    if (read) return { file, dir, read };

    // Node's package scope ends at `node_modules`: a package there without a
    // manifest is not part of the consumer's project.
    if (basename(dir) === "node_modules") return undefined;

    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * What the walk used to answer for a broken `package.json`: the host of the
 * first ancestor that does parse. Only used to tell the author what changed.
 */
function formerAncestorPolicy(
  startDir: string,
): { file: string; host: HostPolicy["host"] } | undefined {
  let dir = startDir;
  for (;;) {
    const file = join(dir, "package.json");
    const read = readPackageJsonCached(file);
    if (read && !read.error && isObject(read.manifest)) {
      return { file, host: policyOf(read.manifest).policy.host };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Levenshtein distance, for the "did you mean" hint. Inputs are tiny. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (current[j - 1] as number) + 1,
        (previous[j] as number) + 1,
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] as number;
}

/** The nearest real host name within two edits of `value`, if any. */
function nearestHost(value: string): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const name of HOST_NAMES) {
    const d = distance(value.toLowerCase(), name);
    if (d < bestDistance) {
      best = name;
      bestDistance = d;
    }
  }
  return best;
}

/** Where `"mx": { "host": <value> }` sits in `text`, else `1:0`. */
function locateMxHost(
  text: string,
  value: unknown,
): { line: number; column: number } {
  const key = /"mx"\s*:/.exec(text);
  if (key) {
    const wanted = JSON.stringify(value);
    const hostKey = /"host"\s*:\s*/g;
    hostKey.lastIndex = key.index + key[0].length;
    for (let m = hostKey.exec(text); m; m = hostKey.exec(text)) {
      const at = m.index + m[0].length;
      if (wanted === undefined || text.startsWith(wanted, at)) {
        return positionOfOffset(text, at);
      }
    }
  }
  return { line: 1, column: 0 };
}

/**
 * The policy one parsed `package.json` answers with, plus the `mx.host` it
 * had to ignore, if any. Pure: no I/O, no warnings printed.
 */
function policyOf(pkg: Record<string, unknown>): {
  policy: HostPolicy;
  ignoredHost?: unknown;
  translator?: boolean;
} {
  const mx = isObject(pkg.mx) ? (pkg.mx as PackageJsonShape["mx"]) : undefined;
  let ignoredHost: unknown;

  if (mx) {
    if (isKnownHost(mx.host)) {
      if (mx.host === "translator") {
        return {
          policy: { host: "html", strict: mx.strict },
          translator: true,
        };
      }
      return {
        policy: { host: mx.host as HostPolicy["host"], strict: mx.strict },
      };
    }
    if (mx.host !== undefined) ignoredHost = mx.host;
  }

  const deps = {
    ...(isObject(pkg.dependencies) ? pkg.dependencies : undefined),
    ...(isObject(pkg.devDependencies) ? pkg.devDependencies : undefined),
  };
  const hostDeps = Object.keys(HOST_PACKAGES).filter((name) => name in deps);
  if (hostDeps.length === 1) {
    const host = HOST_PACKAGES[hostDeps[0] as string];
    if (host) return { policy: { host }, ignoredHost };
  }

  return { policy: DEFAULT_POLICY, ignoredHost };
}

/**
 * Resolves the `HostPolicy` for `filePath` by walking upward from its
 * containing directory, together with the warnings the walk produced. See
 * the module doc for the rule and its edge cases.
 *
 * `resolveHostPolicy` is this function's `policy`; call this one to also
 * learn that a `package.json` was malformed or named an unknown `mx.host`.
 * Nothing is cached beyond the mtime-keyed `package.json` reads, so calling
 * it per file is cheap, but the diagnostics come back on every call: dedupe
 * by `file` + `message` where they are reported.
 */
export function resolveHostPolicyDetailed(
  filePath: string,
): HostPolicyResolution {
  const diagnostics: HostPolicyDiagnostic[] = [];
  const finish = (policy: HostPolicy): HostPolicyResolution => ({
    policy,
    diagnostics,
  });

  const found = findNearestPackageJson(dirname(filePath));
  if (!found) return finish(DEFAULT_POLICY);

  const { file, dir, read } = found;

  if (read.error || !isObject(read.manifest)) {
    const reason = read.error
      ? `could not be parsed as JSON: ${read.error.message}`
      : "must contain a JSON object";
    const former = formerAncestorPolicy(dirname(dir));
    const before = former
      ? `; before, its host was taken from ${former.file} ("${former.host}")`
      : "";
    diagnostics.push({
      code: "malformed-package-json",
      file,
      message: `${file} ${reason}; using the default "${DEFAULT_POLICY.host}" host for the files under ${dir}${before}`,
      line: read.error?.line ?? 1,
      column: read.error?.column ?? 0,
    });
    return finish(DEFAULT_POLICY);
  }

  const resolved = policyOf(read.manifest);
  if (resolved.translator) {
    console.warn(
      "Warning: The 'translator' mx.host alias is deprecated and will be removed in a future release. Use 'html' instead.",
    );
  }
  if (resolved.ignoredHost !== undefined) {
    const shown = JSON.stringify(resolved.ignoredHost);
    const hint =
      typeof resolved.ignoredHost === "string"
        ? nearestHost(resolved.ignoredHost)
        : undefined;
    diagnostics.push({
      code: "unknown-host",
      file,
      message: `unknown mx.host ${shown}; valid hosts: ${HOST_NAMES.join(", ")} ('translator' is a deprecated alias for html).${hint ? ` Did you mean "${hint}"?` : ""} Ignoring it; the host is taken from the @mxlang dependencies instead.`,
      ...locateMxHost(read.text, resolved.ignoredHost),
    });
  }
  return finish(resolved.policy);
}

/**
 * Resolves the `HostPolicy` for `filePath` by walking upward from its
 * containing directory. See module doc for the three-branch rule. Use
 * `resolveHostPolicyDetailed` to also receive the walk's warnings.
 */
export function resolveHostPolicy(filePath: string): HostPolicy {
  return resolveHostPolicyDetailed(filePath).policy;
}
