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
import {
  builtOnUnknownMessage,
  createTargetLookup,
  type TargetDescriptor,
  type TargetLookup,
} from "./target-descriptor.ts";
import { loadTargetDescriptor, TargetLoadError } from "./target-loader.ts";

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
  /**
   * The descriptor loaded from a package specifier under `mx.target` or
   * `mx.host`. Absent for a built-in target, which the tool's lookup holds:
   * read a descriptor as `policy.descriptor ?? lookup.target(policy.target)`.
   * The same object on every resolution until the target package changes
   * (`loadTargetDescriptor` caches it), so its identity is stable.
   */
  descriptor?: TargetDescriptor;
  /**
   * The `mx.<target>.defaultTag` the package configures (decision 145), when
   * it is a usable string. A registry that knows the target's base target
   * (`TargetDescriptor.builtOn`) falls back to the base's own key
   * (`mx.<base>.defaultTag`) when the target's is absent or rejected, and
   * `defaultTagAt` then points there. Whether the name is a reachable, plain-parsing tag
   * is checked where tags are known; an invalid value is a diagnostic and is
   * never carried here.
   */
  defaultTag?: string;
  /** Where `defaultTag` is written in the `package.json` (1-based line, 0-based column, UTF-16 length). */
  defaultTagAt?: PolicyLocation;
  /**
   * Where the `mx.target`/`mx.host` specifier that loaded `descriptor` is
   * written, for a problem with the descriptor's own values.
   */
  descriptorAt?: PolicyLocation;
}

/** A value's place in the `package.json` that set it. */
export interface PolicyLocation {
  file: string;
  line: number;
  column: number;
  length: number;
}

/** Why a {@link TargetPolicyDiagnostic} was raised. */
export type TargetPolicyDiagnosticCode =
  | "unknown-host"
  | "malformed-package-json"
  | "unknown-target"
  | "target-host-mismatch"
  | "target-not-found"
  | "target-load-failed"
  | "target-invalid-descriptor"
  | "host-invalid-descriptor"
  | "invalid-default-tag"
  | "default-tag-overridden";

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
export function findNearestPackageJson(fileDir: string): Found | undefined {
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
  key: string | readonly string[],
  legacyValue?: unknown,
): { line: number; column: number; length: number } {
  const keys = typeof key === "string" ? [key] : key;
  if (legacyValue !== undefined) {
    const mxKey = /"mx"\s*:/.exec(text);
    if (mxKey) {
      const wanted = JSON.stringify(legacyValue);
      const member = new RegExp(`"${keys.join(".")}"\\s*:\\s*`, "g");
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
    if (
      path.length === keys.length + 1 &&
      path[0] === "mx" &&
      keys.every((k, i) => path[i + 1] === k)
    ) {
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

/** How a JSON value reads in a diagnostic: "a number", "null", "an array". */
function describeJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
}

/** Whether `value` names a package or a path, not a bare word. */
function isSpecifier(value: unknown): value is string {
  return (
    typeof value === "string" && (value.includes("/") || /^[@./]/.test(value))
  );
}

/** One descriptor loaded from the key it came from. */
interface LoadedSpecifier {
  spec: string;
  descriptor: TargetDescriptor;
}

/** What loading the specifiers in `mx.host` and `mx.target` produced. */
interface LoadedSpecifiers {
  host?: LoadedSpecifier;
  target?: LoadedSpecifier;
  /** The key held a specifier that did not become a usable descriptor. */
  failed: { host?: true; target?: true };
}

const NO_SPECIFIERS: LoadedSpecifiers = { failed: {} };

const LOAD_CODES = {
  "not-found": "target-not-found",
  "load-failed": "target-load-failed",
  "invalid-descriptor": "target-invalid-descriptor",
} as const;

/**
 * The policy one parsed `package.json` answers with, plus the `mx.host` it
 * had to ignore, if any. Pure: no I/O, no warnings printed.
 */
function policyOf(
  pkg: Record<string, unknown>,
  lookup: TargetLookup,
  loaded: LoadedSpecifiers = NO_SPECIFIERS,
): {
  policy: TargetPolicy;
  ignoredHost?: unknown;
  ignoredTarget?: unknown;
  mismatch?: {
    host: string;
    hostTarget: string;
    target: string;
    /** Host of `target` and of `hostTarget`, which may be loaded descriptors. */
    targetHost?: string;
    hostTargetHost?: string;
    /** `mx.host` named a package, so it is no legacy spelling of anything. */
    hostIsPackage: boolean;
  };
  /** The deprecated `mx.host` value used, which the caller warns about. */
  deprecatedValue?: string;
} {
  const mx = isObject(pkg.mx)
    ? (pkg.mx as { host?: unknown; target?: unknown; strict?: unknown })
    : undefined;
  let ignoredHost: unknown;
  let ignoredTarget: unknown;
  const hostOf = (name: string): string | undefined =>
    loaded.target?.descriptor.name === name
      ? loaded.target.descriptor.host?.name
      : loaded.host?.descriptor.name === name
        ? loaded.host.descriptor.host?.name
        : lookup.hostOf(name);
  const descriptorOf = (name: string): TargetDescriptor | undefined =>
    [loaded.target?.descriptor, loaded.host?.descriptor].find(
      (d) => d?.name === name,
    );

  if (mx) {
    const selectedHost: { target: string; deprecated?: true } | undefined =
      loaded.host
        ? { target: loaded.host.descriptor.name }
        : typeof mx.host === "string"
          ? (lookup.hostTarget(mx.host) ??
            // A bare word naming the loaded `mx.target`'s own host selects it.
            (loaded.target?.descriptor.host?.name === mx.host
              ? { target: loaded.target.descriptor.name }
              : undefined))
          : undefined;
    const selectedTarget = loaded.target
      ? loaded.target.descriptor.name
      : typeof mx.target === "string" && lookup.hasTarget(mx.target)
        ? mx.target
        : undefined;
    // A specifier that failed to load already has its own diagnostic.
    if (mx.host !== undefined && !selectedHost && !loaded.failed.host)
      ignoredHost = mx.host;
    if (mx.target !== undefined && !selectedTarget && !loaded.failed.target)
      ignoredTarget = mx.target;
    const target = selectedTarget ?? selectedHost?.target;
    if (target !== undefined) {
      const host = hostOf(target);
      const selectedHostName = selectedHost && hostOf(selectedHost.target);
      // Rule 3 compares host names. A loaded `mx.host` is a specifier, never
      // equal to the name it stands for, so it is compared by that name.
      const agrees =
        selectedHost &&
        (loaded.host
          ? host !== undefined && host === selectedHostName
          : selectedHostName === mx.host
            ? host === mx.host
            : selectedHost.target === target);
      const descriptor = descriptorOf(target);
      return {
        policy: {
          target,
          host,
          strict: mx.strict as boolean | undefined,
          ...(descriptor ? { descriptor } : {}),
        },
        ignoredHost,
        ignoredTarget,
        ...(selectedTarget && selectedHost && !agrees
          ? {
              mismatch: {
                host: mx.host as string,
                hostTarget: selectedHost.target,
                target,
                targetHost: host,
                hostTargetHost: hostOf(selectedHost.target),
                hostIsPackage: loaded.host !== undefined,
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

const verdicts = new WeakMap<TargetDescriptor, Map<string, string | null>>();

/**
 * Why `descriptor` cannot join `lookup`, or `undefined` if it can. A built-in
 * host is refused for now (TODO `third-party-join-builtin-host`): it is not
 * wired for a loaded target, and silently accepting it would be a silent
 * no-op. A file-kind segment must be the host's own name (decisions 136, 148),
 * so a loaded host cannot take another host's `.<name>.mx`. The rest is the set
 * rules of `createTargetLookup`, a file-kind segment another host owns included. The verdict is cached per descriptor and per shape
 * of lookup, as resolution runs per file and per keystroke.
 */
function registrationVerdict(
  lookup: TargetLookup,
  descriptor: TargetDescriptor,
): string | undefined {
  const names = lookup.targetNames();
  const shape = `${names.join(",")}|${lookup.defaultTarget()}|${(lookup.reservedNames?.() ?? []).join(",")}`;
  const byShape = verdicts.get(descriptor) ?? new Map<string, string | null>();
  verdicts.set(descriptor, byShape);
  const known = byShape.get(shape);
  if (known !== undefined) return known ?? undefined;
  let verdict: string | undefined;
  const host = descriptor.host?.name;
  if (host !== undefined && names.some((n) => lookup.hostOf(n) === host)) {
    verdict = `host "${host}" belongs to the built-in targets; a third-party target cannot join it (for now)`;
  } else if (
    host !== undefined &&
    (descriptor.host?.fileKinds ?? []).some((kind) => kind.segment !== host)
  ) {
    const wrong = (descriptor.host?.fileKinds ?? []).find(
      (kind) => kind.segment !== host,
    );
    verdict = `file kind segment "${wrong?.segment}" is not the host's name "${host}"; the segment before \`.mx\` is a host name (decision 136)`;
  } else {
    try {
      // A tool may mask a target from selection (`targetNames`) while the
      // lookup still answers it (the registry's staged `data`): the target a
      // descriptor is built on is part of the set it joins either way, and an
      // unknown name lists every target the lookup answers.
      const members = names.map(
        (name) => lookup.target(name) as TargetDescriptor,
      );
      if (
        descriptor.builtOn !== undefined &&
        descriptor.builtOn !== descriptor.name &&
        !lookup.target(descriptor.builtOn)
      ) {
        throw new Error(
          builtOnUnknownMessage(
            descriptor.name,
            descriptor.builtOn,
            [...(lookup.allTargetNames?.() ?? names), descriptor.name],
            lookup.hostTarget(descriptor.builtOn)?.target,
          ),
        );
      }
      for (
        let base =
          descriptor.builtOn === undefined
            ? undefined
            : lookup.target(descriptor.builtOn);
        base !== undefined && !members.includes(base);
        base =
          base.builtOn === undefined ? undefined : lookup.target(base.builtOn)
      )
        members.push(base);
      createTargetLookup([...members, descriptor], {
        defaultTarget: lookup.defaultTarget(),
        reservedNames: lookup.reservedNames?.() ?? [],
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      verdict = error.message;
    }
  }
  byShape.set(shape, verdict ?? null);
  return verdict;
}

/**
 * Loads the package specifiers under `mx.host` and `mx.target` (§4.2), and
 * pushes one positioned error per failure (§4.3): not found, throws on
 * load, invalid or unsupported descriptor, a descriptor with no `host` part
 * under `mx.host`, or a descriptor that cannot join the lookup (a name or
 * package a built-in already owns). A failure is an error with no fallback to
 * a guessed target: resolution carries on as if the key were absent, so tools
 * still have a target to hand on, but the author is never told it worked.
 */
function loadSpecifiers(
  mx: Record<string, unknown>,
  dir: string,
  lookup: TargetLookup,
  source: { file: string; text: string },
  diagnostics: TargetPolicyDiagnostic[],
): LoadedSpecifiers {
  const loaded: LoadedSpecifiers = { failed: {} };
  for (const key of ["host", "target"] as const) {
    const spec = mx[key];
    if (!isSpecifier(spec)) continue;
    // A built-in or legacy value is never a specifier; a path-shaped one that
    // the lookup somehow holds is still the lookup's.
    if (key === "target" ? lookup.hasTarget(spec) : lookup.hostTarget(spec))
      continue;
    const fail = (
      code: TargetPolicyDiagnosticCode,
      message: string,
    ): LoadedSpecifiers => {
      diagnostics.push({
        code,
        severity: "error",
        value: spec,
        file: source.file,
        message,
        ...locateMxValue(source.text, key),
      });
      loaded.failed[key] = true;
      return loaded;
    };
    let descriptor: TargetDescriptor;
    try {
      descriptor = loadTargetDescriptor(spec, dir);
    } catch (error) {
      if (!(error instanceof TargetLoadError)) throw error;
      const hint =
        error.code === "not-found"
          ? ` ${/^[./]/.test(spec) ? "Check the path" : `Install it (bun add -d ${spec})`} or use a built-in target: ${lookup.targetNames().join(", ")}.`
          : "";
      fail(
        LOAD_CODES[error.code],
        `mx.${key} ${error.message}${error.code === "not-found" ? "." : ""}${hint}`,
      );
      continue;
    }
    if (key === "host" && !descriptor.host) {
      fail(
        "host-invalid-descriptor",
        `mx.host "${spec}" exports a target with no host. Use mx.target "${spec}", or give the descriptor a "host" part.`,
      );
      continue;
    }
    const unregistrable = registrationVerdict(lookup, descriptor);
    if (unregistrable !== undefined) {
      fail(
        "target-invalid-descriptor",
        `mx.${key} "${spec}" cannot be registered next to the built-in targets: ${unregistrable}. See the TargetDescriptor contract (unstable).`,
      );
      continue;
    }
    loaded[key] = { spec, descriptor };
  }
  return loaded;
}

/** What one `package.json` says about `mx.<target>.defaultTag`. */
export interface DefaultTagConfig {
  /** The configured name, when it is a usable string. */
  value?: string;
  at?: PolicyLocation;
  /** The type error, when the value is not a non-empty string. */
  diagnostic?: TargetPolicyDiagnostic;
}

/** Reads `mx[<config key>].defaultTag` from an already-read manifest; see {@link readTargetDefaultTag}. */
function readDefaultTagConfig(
  read: PackageJsonRead,
  file: string,
  target: string,
  configKey?: string,
): DefaultTagConfig {
  const key = configKey ?? target;
  const mx =
    isObject(read.manifest) && isObject(read.manifest.mx)
      ? read.manifest.mx
      : undefined;
  const configured = mx?.[key];
  if (!isObject(configured) || configured.defaultTag === undefined) return {};
  const value = configured.defaultTag;
  const at = {
    file,
    ...locateMxValue(read.text, [key, "defaultTag"]),
  };
  if (typeof value === "string" && value !== "") return { value, at };
  return {
    diagnostic: {
      code: "invalid-default-tag",
      severity: "error",
      file,
      message: `invalid \`defaultTag\` value: mx.${key}.defaultTag is ${value === "" ? "an empty string" : describeJson(value)}, expected a tag name string`,
      line: at.line,
      column: at.column,
      length: at.length,
    },
  };
}

/**
 * The `mx.<config key>.defaultTag` of the package that holds `filePath`, for a
 * target other than the one the package's policy selects (a host module file
 * kind compiles under its own target). The key is the target's descriptor
 * `configKey` when it has one, else its name. `value` is a usable string; a
 * value of any other type comes back as the one `invalid-default-tag`
 * diagnostic. A package that cannot be read says nothing here: the policy walk
 * already reported it.
 */
export function readTargetDefaultTag(
  filePath: string,
  target: string,
  configKey?: string,
): DefaultTagConfig {
  const found = findNearestPackageJson(dirname(filePath));
  if (!found || found.read.error || !isObject(found.read.manifest)) return {};
  return readDefaultTagConfig(found.read, found.file, target, configKey);
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
  options: { quiet?: boolean } = {},
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

  const mx = isObject(read.manifest.mx) ? read.manifest.mx : undefined;
  const loaded = mx
    ? loadSpecifiers(mx, dir, lookup, { file, text: read.text }, diagnostics)
    : NO_SPECIFIERS;
  const resolved = policyOf(read.manifest, lookup, loaded);
  if (resolved.policy.descriptor) {
    const key = loaded.target ? "target" : "host";
    resolved.policy.descriptorAt = { file, ...locateMxValue(read.text, key) };
  }
  const config = readDefaultTagConfig(
    read,
    file,
    resolved.policy.target,
    lookup.target(resolved.policy.target)?.configKey,
  );
  if (config.value !== undefined) {
    resolved.policy.defaultTag = config.value;
    resolved.policy.defaultTagAt = config.at;
  }
  if (config.diagnostic) diagnostics.push(config.diagnostic);
  if (resolved.deprecatedValue !== undefined && !options.quiet) {
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
    const dataReserved =
      value === "data"
        ? ' "data" is reserved for the evaluated tree target (decision 187); the static tree target is "tree".'
        : "";
    diagnostics.push({
      code: "unknown-target",
      severity: "error",
      ...(typeof value === "string" ? { value } : {}),
      file,
      message: `unknown mx.target ${shown}; valid targets: ${lookup.targetNames().join(", ")}.${isHost ? ` ${shown} is a host, not a target: its default target is "${host.target}" (use mx.host ${shown} or mx.target "${host.target}").` : hint ? ` Did you mean "${hint}"?` : ""}${dataReserved} Compiling under the target taken from the @mxlang dependencies (or the default) so later diagnostics are not drowned.`,
      ...locateMxValue(read.text, "target"),
    });
  }
  if (resolved.mismatch) {
    const {
      host,
      hostTarget,
      target,
      targetHost,
      hostTargetHost,
      hostIsPackage,
    } = resolved.mismatch;
    const legacy = !hostIsPackage && hostTargetHost !== host;
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
