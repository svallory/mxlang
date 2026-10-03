/**
 * Policy resolution (brief §2, `host-diagnostics.md` §3): which target a file
 * compiles through, plus that target's strictness.
 *
 * **Unstable contract (decisions 129 and 132).** `mx.target` lands with
 * registration PR 3b; until it does, this module answers the `mx.host` half
 * of §4.1's rule only.
 *
 * Rule, in order:
 *
 * 1. Walk upward from the file's directory looking for the nearest
 *    `package.json`. If it has an `"mx"` field, that field *is* the
 *    answer: `{ host: "<a registered host value>", strict?: boolean }`,
 *    where a host value is a host name or a target's legacy `mx.host`
 *    spelling.
 * 2. Otherwise, if that same `package.json` depends (in `dependencies` or
 *    `devDependencies`) on exactly one package some registered target
 *    declares as its `packageName` (`@mxlang/html`, `@mxlang/astro`,
 *    `@mxlang/solid`, `@mxlang/preact`, `@mxlang/react`, `@mxlang/hono`,
 *    `@mxlang/angular`; `@mxlang/core` itself declares no target and does
 *    not count, since every target package depends on it too), use the
 *    target that package selects.
 * 3. Otherwise, fall back to the lookup's default target, non-strict.
 *
 * Edge cases of the walk (each pinned in `host-policy.test.ts`):
 *
 * - The nearest `package.json` is the one that *exists*, parseable or not. A
 *   malformed one (or one that is not a JSON object) ends the walk with the
 *   default policy plus a warning; it does not fall through to an
 *   unrelated ancestor. Node, TypeScript and `scan.ts` all stop there too.
 * - A directory with no `package.json` of its own belongs to the nearest
 *   ancestor's project, a monorepo root included. That is how `src/` inside a
 *   package works, and it cannot be told apart from a workspace member that
 *   forgot its manifest; give the member its own `package.json` (or `mx.host`)
 *   to opt out.
 * - The walk stops at a `node_modules` directory (Node's package-scope rule):
 *   a file in an installed package that ships no `package.json` gets the
 *   default policy, not the consumer's host.
 * - An `mx.host` that names no known value is ignored with a warning (with a
 *   nearest-match hint), and resolution continues with the dependency rule.
 *
 * This mirrors `Project.loadMeta`'s own `createRequire` + upward
 * `package.json` walk in Marko's language server (`host-diagnostics.md` §1),
 * so the technique is not novel to this package.
 *
 * It lives in `@mxlang/core` rather than in either consumer because two
 * entry points ask this same question: `@mxlang/language-server` (to pick the
 * policy a document is diagnosed under) and `@mxlang/typescript-plugin` (to
 * pick the target a `.mx` file's virtual TypeScript is compiled through). An
 * editor and a `tsc` run disagreeing about which target owns a file is
 * exactly the drift a second copy invites, so there is one implementation and
 * one set of branch tests. Unlike the rest of this package it touches
 * `node:fs`, which is why it is its own module rather than part of `core.ts`.
 *
 * **No target and no host is named here** (decision 126). The lookup is a
 * required parameter on every entry point: a caller that forgot it gets a
 * type error, not a silently closed-over list.
 */

import { basename, dirname, join } from "node:path";
import {
  type PackageJsonRead,
  positionOfOffset,
  readPackageJsonCached,
} from "./package-json.ts";
import type { TargetLookup } from "./target-descriptor.ts";

/**
 * The target a file compiles through, plus that target's host (when it has
 * one) and the `mx.strict` setting of the nearest `package.json`.
 *
 * `host` is what `mx.host: "<name>"` selects and what `mx.tags[].hosts`
 * filters by; a target with no host (the `html` target, which a legacy
 * `mx.host: "html"` names) has none. Read the filter value for a target off
 * the lookup (`hostFilterKey`) rather than off this field: for a hostless
 * target it is the target's legacy value, not the target name.
 */
export interface TargetPolicy {
  target: string;
  host?: string;
  strict?: boolean;
}

/** Why a {@link TargetPolicyDiagnostic} was raised. */
export type TargetPolicyDiagnosticCode =
  | "unknown-host"
  | "malformed-package-json";

/**
 * One problem found while resolving a target, positioned in the
 * `package.json` that caused it. Same shape as `ScanDiagnostic` so a caller
 * can merge the two into the stream it already reports.
 *
 * Every one is a *warning*: resolution always produces a policy, and nothing
 * here may fail a build that compiled before.
 */
export interface TargetPolicyDiagnostic {
  /**
   * What went wrong, so a caller can word or route it without matching the
   * message text.
   */
  code: TargetPolicyDiagnosticCode;
  /** The `package.json` to point an author at. */
  file: string;
  message: string;
  /** 1-based. */
  line: number;
  /** 0-based. */
  column: number;
}

/** A resolved policy plus whatever the resolution had to say about it. */
export interface TargetPolicyResolution {
  policy: TargetPolicy;
  diagnostics: TargetPolicyDiagnostic[];
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

/**
 * The `mx.host` values the lookup offers today, split by whether they are
 * deprecated. A deprecated value is an old spelling of a target (`the
 * 'translator' alias`) and is listed apart: an author who typed one needs to
 * be told so, and a did-you-mean must never suggest one.
 */
function hostValuesByDeprecation(lookup: TargetLookup): {
  current: string[];
  deprecated: string[];
} {
  const current: string[] = [];
  const deprecated: string[] = [];
  for (const value of lookup.hostValues()) {
    if (lookup.hostTarget(value)?.deprecated === true) deprecated.push(value);
    else current.push(value);
  }
  return { current, deprecated };
}

/**
 * The nearest current host value within two edits of `value`, if any.
 */
function nearestHostValue(
  value: string,
  candidates: readonly string[],
): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const name of candidates) {
    const d = distance(value.toLowerCase(), name);
    if (d < bestDistance) {
      best = name;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * `valid hosts: …` for the unknown-`mx.host` warning: every current value
 * the lookup accepts, plus one clause per deprecated value naming the target
 * it spells. For the built-in lookup this reproduces the closed list the
 * resolver used to hold, in the same order, so the message text is unchanged
 * (decision 07 Q9).
 */
function validHostsClause(lookup: TargetLookup): string {
  const { current, deprecated } = hostValuesByDeprecation(lookup);
  const clauses = deprecated.map(
    (value) =>
      `'${value}' is a deprecated alias for ${lookup.hostTarget(value)?.target}`,
  );
  return clauses.length
    ? `${current.join(", ")} (${clauses.join(", ")})`
    : current.join(", ");
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
function policyOf(
  pkg: Record<string, unknown>,
  lookup: TargetLookup,
): {
  policy: TargetPolicy;
  ignoredHost?: unknown;
  /** The deprecated `mx.host` value used, which the caller warns about. */
  deprecatedValue?: string;
} {
  const mx = isObject(pkg.mx)
    ? (pkg.mx as { host?: unknown; strict?: unknown })
    : undefined;
  let ignoredHost: unknown;

  if (mx) {
    const selected =
      typeof mx.host === "string" ? lookup.hostTarget(mx.host) : undefined;
    if (selected) {
      return {
        policy: {
          target: selected.target,
          host: lookup.hostOf(selected.target),
          strict: mx.strict as boolean | undefined,
        },
        ...(selected.deprecated === true
          ? { deprecatedValue: mx.host as string }
          : {}),
      };
    }
    if (mx.host !== undefined) ignoredHost = mx.host;
  }

  const deps = {
    ...(isObject(pkg.dependencies) ? pkg.dependencies : undefined),
    ...(isObject(pkg.devDependencies) ? pkg.devDependencies : undefined),
  };
  const targetDeps = Object.keys(deps).flatMap((name) => {
    const target = lookup.fromPackage(name);
    return target ? [target] : [];
  });
  if (targetDeps.length === 1) {
    const target = targetDeps[0] as string;
    return {
      policy: { target, host: lookup.hostOf(target) },
      ignoredHost,
    };
  }

  return {
    policy: {
      target: lookup.defaultTarget(),
      host: lookup.hostOf(lookup.defaultTarget()),
    },
    ignoredHost,
  };
}

/**
 * Resolves the `TargetPolicy` for `filePath` by walking upward from its
 * containing directory, together with the warnings the walk produced. See
 * the module doc for the rule and its edge cases.
 *
 * `lookup` is required: which values `mx.host` accepts, which package selects
 * which target, and which target is the default are open-set questions the
 * caller answers (`@mxlang/target-registry` binds the built-in lookup, so a
 * tool imports its wrapper instead of passing one).
 *
 * `resolveTargetPolicy` is this function's `policy`; call this one to also
 * learn that a `package.json` was malformed or named an unknown `mx.host`.
 * Nothing is cached beyond the mtime-keyed `package.json` reads, so calling
 * it per file is cheap, but the diagnostics come back on every call: dedupe
 * by `file` + `message` where they are reported.
 */
export function resolveTargetPolicyDetailed(
  filePath: string,
  lookup: TargetLookup,
): TargetPolicyResolution {
  const diagnostics: TargetPolicyDiagnostic[] = [];
  const defaultPolicy = (): TargetPolicy => {
    const target = lookup.defaultTarget();
    return { target, host: lookup.hostOf(target) };
  };
  const finish = (policy: TargetPolicy): TargetPolicyResolution => ({
    policy,
    diagnostics,
  });

  const found = findNearestPackageJson(dirname(filePath));
  if (!found) return finish(defaultPolicy());

  const { file, dir, read } = found;

  if (read.error || !isObject(read.manifest)) {
    const reason = read.error
      ? `could not be parsed as JSON: ${read.error.message}`
      : "must contain a JSON object";
    const former = formerAncestorPolicy(dirname(dir), lookup);
    const before = former
      ? `; before, its host was taken from ${former.file} ("${former.host}")`
      : "";
    diagnostics.push({
      code: "malformed-package-json",
      file,
      message: `${file} ${reason}; using the default "${lookup.defaultTarget()}" host for the files under ${dir}${before}`,
      line: read.error?.line ?? 1,
      column: read.error?.column ?? 0,
    });
    return finish(defaultPolicy());
  }

  const resolved = policyOf(read.manifest, lookup);
  if (resolved.deprecatedValue !== undefined) {
    const target = lookup.hostTarget(resolved.deprecatedValue)?.target;
    console.warn(
      `Warning: The '${resolved.deprecatedValue}' mx.host alias is deprecated and will be removed in a future release. Use '${target}' instead.`,
    );
  }
  if (resolved.ignoredHost !== undefined) {
    const shown = JSON.stringify(resolved.ignoredHost);
    const hint =
      typeof resolved.ignoredHost === "string"
        ? nearestHostValue(
            resolved.ignoredHost,
            hostValuesByDeprecation(lookup).current,
          )
        : undefined;
    diagnostics.push({
      code: "unknown-host",
      file,
      message: `unknown mx.host ${shown}; valid hosts: ${validHostsClause(lookup)}.${hint ? ` Did you mean "${hint}"?` : ""} Ignoring it; the host is taken from the @mxlang dependencies instead.`,
      ...locateMxHost(read.text, resolved.ignoredHost),
    });
  }
  return finish(resolved.policy);
}

/**
 * Resolves the `TargetPolicy` for `filePath` by walking upward from its
 * containing directory. See module doc for the three-branch rule. Use
 * `resolveTargetPolicyDetailed` to also receive the walk's warnings.
 */
export function resolveTargetPolicy(
  filePath: string,
  lookup: TargetLookup,
): TargetPolicy {
  return resolveTargetPolicyDetailed(filePath, lookup).policy;
}

/**
 * What the walk used to answer for a broken `package.json`: the host of the
 * first ancestor that does parse. Only used to tell the author what changed.
 * A hostless target is named by its own filter value, so the clause reads
 * the same as it did when every target had a host.
 */
function formerAncestorPolicy(
  startDir: string,
  lookup: TargetLookup,
): { file: string; host: string } | undefined {
  let dir = startDir;
  for (;;) {
    const file = join(dir, "package.json");
    const read = readPackageJsonCached(file);
    if (read && !read.error && isObject(read.manifest)) {
      const { target, host } = policyOf(read.manifest, lookup).policy;
      return { file, host: host ?? (lookup.hostFilterKey(target) as string) };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
