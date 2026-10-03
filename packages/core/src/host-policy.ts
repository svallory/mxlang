/**
 * Policy resolution (brief §2, `host-diagnostics.md` §3): which target a file
 * compiles through, plus that target's strictness.
 *
 * **Unstable contract (decisions 129 and 132).** `mx.target` selects a
 * registered target directly; `mx.host` selects its host's default target.
 * If both resolve, they must agree. A mismatch is an error, with the
 * explicit target handed on so later diagnostics are not drowned.
 *
 * Rule, in order:
 *
 * 1. Walk upward to the nearest `package.json`. `mx.target` names a
 *    registered target; `mx.host` names a host (its default target) or a
 *    target's legacy spelling. If both resolve, they must agree; a mismatch
 *    is an error with the explicit target handed on. Exactly one resolved
 *    key selects that target and carries `mx.strict`. Unknown targets are
 *    errors; unknown hosts retain their existing warning.
 * 2. If neither resolves, exactly one registered target package in that
 *    manifest's `dependencies` or `devDependencies` selects its target.
 *    The lookup answers which packages count; peers do not count.
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
  | "malformed-package-json"
  | "unknown-target"
  | "target-host-mismatch";

/**
 * One problem found while resolving a target, positioned in the
 * `package.json` that caused it. Same shape as `ScanDiagnostic` so a caller
 * can merge the two into the stream it already reports.
 *
 * Existing host diagnostics remain warnings. Invalid `mx.target` values
 * and contradictions are errors; resolution still hands on a policy.
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
  /** Absent means warning, preserving existing diagnostics byte-for-byte. */
  severity?: "error" | "warning";
  /** Rejected string value, when an unknown target was authored as a string. */
  value?: string;
  /** UTF-16 length of the authored JSON value, quotes included. */
  length?: number;
  relatedInformation?: readonly {
    file: string;
    message: string;
    line: number;
    column: number;
    length: number;
  }[];
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

/**
 * The direct `mx[key]` value. `legacyValue` retains the old text-matching
 * positions for existing unknown-host warnings, byte-for-byte; new errors
 * use the actual member's range, including escaped spelling.
 */
function locateMxValue(
  text: string,
  key: "host" | "target",
  legacyValue?: unknown,
): { line: number; column: number; length: number } {
  if (legacyValue !== undefined) {
    const mxKey = /"mx"\s*:/.exec(text);
    if (mxKey) {
      const wanted = JSON.stringify(legacyValue);
      const member = new RegExp(`"${key}"\\s*:\\s*`, "g");
      member.lastIndex = mxKey.index + mxKey[0].length;
      for (let match = member.exec(text); match; match = member.exec(text)) {
        const at = match.index + match[0].length;
        if (wanted === undefined || text.startsWith(wanted, at)) {
          return { ...positionOfOffset(text, at), length: wanted?.length ?? 1 };
        }
      }
    }
    return { line: 1, column: 0, length: 1 };
  }
  const tokens = [
    ...text.matchAll(
      /"(?:\\.|[^"\\])*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g,
    ),
  ];
  let cursor = 0;
  let found: { line: number; column: number; length: number } | undefined;
  const value = (path: string[]): void => {
    const start = tokens[cursor];
    if (!start) return;
    cursor++;
    if (start[0] === "{") {
      while (tokens[cursor] && tokens[cursor]?.[0] !== "}") {
        let name: string;
        try {
          name = JSON.parse(tokens[cursor++]?.[0] ?? '""') as string;
        } catch {
          // Positioning is best-effort if the token stream is incomplete.
          return;
        }
        cursor++; // colon
        value([...path, name]);
        if (tokens[cursor]?.[0] === ",") cursor++;
      }
      cursor++;
    } else if (start[0] === "[") {
      while (tokens[cursor] && tokens[cursor]?.[0] !== "]") {
        value([...path, "[]"]);
        if (tokens[cursor]?.[0] === ",") cursor++;
      }
      cursor++;
    }
    if (path.length === 2 && path[0] === "mx" && path[1] === key) {
      const end = tokens[cursor - 1];
      found = {
        ...positionOfOffset(text, start.index),
        length:
          (end?.index ?? start.index) + (end?.[0].length ?? 0) - start.index,
      };
    }
  };
  value([]);
  return found ?? { line: 1, column: 0, length: 1 };
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
  ignoredTarget?: unknown;
  mismatch?: { host: string; hostTarget: string; target: string };
  /** The deprecated `mx.host` value used, which the caller warns about. */
  deprecatedValue?: string;
} {
  const mx = isObject(pkg.mx)
    ? (pkg.mx as { host?: unknown; target?: unknown; strict?: unknown })
    : undefined;
  let ignoredHost: unknown;
  let ignoredTarget: unknown;

  if (mx) {
    const selectedHost =
      typeof mx.host === "string" ? lookup.hostTarget(mx.host) : undefined;
    const selectedTarget =
      typeof mx.target === "string" && lookup.hasTarget(mx.target)
        ? mx.target
        : undefined;
    if (mx.host !== undefined && !selectedHost) ignoredHost = mx.host;
    if (mx.target !== undefined && !selectedTarget) ignoredTarget = mx.target;
    const target = selectedTarget ?? selectedHost?.target;
    if (target !== undefined) {
      const host = lookup.hostOf(target);
      const agrees =
        selectedHost &&
        (lookup.hostOf(selectedHost.target) === mx.host
          ? host === mx.host
          : selectedHost.target === target);
      return {
        policy: { target, host, strict: mx.strict as boolean | undefined },
        ignoredHost,
        ignoredTarget,
        ...(selectedTarget && selectedHost && !agrees
          ? {
              mismatch: {
                host: mx.host as string,
                hostTarget: selectedHost.target,
                target,
              },
            }
          : {}),
        ...(selectedHost?.deprecated === true
          ? { deprecatedValue: mx.host as string }
          : {}),
      };
    }
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
      ignoredTarget,
    };
  }

  return {
    policy: {
      target: lookup.defaultTarget(),
      host: lookup.hostOf(lookup.defaultTarget()),
    },
    ignoredHost,
    ignoredTarget,
  };
}

/**
 * Resolves the `TargetPolicy` for `filePath` by walking upward from its
 * containing directory, together with the diagnostics the walk produced. See
 * the module doc for the rule and its edge cases.
 *
 * `lookup` is required: which values `mx.host` accepts, which package selects
 * which target, and which target is the default are open-set questions the
 * caller answers (`@mxlang/target-registry` binds the built-in lookup, so a
 * tool imports its wrapper instead of passing one).
 *
 * `resolveTargetPolicy` is this function's `policy`; call this one to also
 * learn about an invalid key, a mismatch, or a malformed `package.json`.
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
      ...(() => {
        const { line, column } = locateMxValue(
          read.text,
          "host",
          resolved.ignoredHost,
        );
        return { line, column };
      })(),
    });
  }
  if (resolved.ignoredTarget !== undefined) {
    const value = resolved.ignoredTarget;
    const shown = JSON.stringify(value);
    const host =
      typeof value === "string" ? lookup.hostTarget(value) : undefined;
    const isHost = host && lookup.hostOf(host.target) === value;
    const hint =
      typeof value === "string"
        ? nearestHostValue(value, lookup.targetNames())
        : undefined;
    const packageSpecifier =
      typeof value === "string" &&
      (value.includes("/") || /^[@./]/.test(value));
    diagnostics.push({
      code: "unknown-target",
      severity: "error",
      ...(typeof value === "string" ? { value } : {}),
      file,
      message: packageSpecifier
        ? `mx.target ${shown}: loading a target package is not supported yet.`
        : `unknown mx.target ${shown}; valid targets: ${lookup.targetNames().join(", ")}.${isHost ? ` ${shown} is a host, not a target: its default target is "${host.target}" (use mx.host ${shown} or mx.target "${host.target}").` : hint ? ` Did you mean "${hint}"?` : ""} Compiling under the target taken from the @mxlang dependencies (or the default) so later diagnostics are not drowned.`,
      ...locateMxValue(read.text, "target"),
    });
  }
  if (resolved.mismatch) {
    const { host, hostTarget, target } = resolved.mismatch;
    const targetHost = lookup.hostOf(target);
    const legacy = lookup.hostOf(hostTarget) !== host;
    diagnostics.push({
      code: "target-host-mismatch",
      severity: "error",
      file,
      message: legacy
        ? `mx.host "${host}" is the legacy spelling of mx.target "${hostTarget}", but mx.target is "${target}"${targetHost ? ` (host "${targetHost}")` : ""}. Remove mx.host: mx.target alone selects the target.`
        : targetHost
          ? `mx.target "${target}" belongs to host "${targetHost}", but mx.host is "${host}". Remove one of them: mx.host "${host}" selects target "${hostTarget}"; mx.target "${target}" selects host "${targetHost}".`
          : `mx.target "${target}" has no host, but mx.host is "${host}". Remove one of them: mx.host "${host}" selects target "${hostTarget}"; mx.target "${target}" needs no mx.host.`,
      ...locateMxValue(read.text, "target"),
      relatedInformation: [
        {
          file,
          message: `mx.host "${host}" selects target "${hostTarget}".`,
          ...locateMxValue(read.text, "host"),
        },
      ],
    });
  }
  return finish(resolved.policy);
}

/**
 * Resolves the `TargetPolicy` for `filePath` by walking upward from its
 * containing directory. See module doc for the resolution rule. Use
 * `resolveTargetPolicyDetailed` to also receive the walk's diagnostics.
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
