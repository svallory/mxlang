/**
 * The built-in target table (decisions 129 and 132; unstable).
 *
 * A closed list of the target descriptors the repo's own hosts export, a
 * lookup built over it, and the wrappers every tool imports instead of
 * threading a lookup through its own call sites: a tool that has the built-in
 * set in hand imports `resolveTargetPolicy`, `hostModuleSegment`, `scanCached`
 * and the lookup's own questions from here, and core's closed lists stay
 * deleted (decision 126).
 *
 * Every import below is a light `./descriptor` subpath: loading this module
 * pulls in policy tables and emitters' declaration objects, never
 * `@marko/compiler` or a compile entry (those are reached by each descriptor's
 * `load()`). The imports are static so a bundler inlines them.
 */

import angular from "@mxlang/angular/descriptor";
import astro from "@mxlang/astro/descriptor";
import {
  type CustomTag,
  hostModuleSegment as coreHostModuleSegment,
  resolveTargetPolicyDetailed as coreResolveTargetPolicyDetailed,
  scanCached as coreScanCached,
  createTargetLookup,
  type HostFileKind,
  hostRestrictionDiagnostics,
  registerCalleeInputReader,
  type ScanDiagnostic,
  type ScanOptions,
  type ScanResult,
  type TargetDescriptor,
  type TargetLookup,
  type TargetPolicy,
  type TargetPolicyResolution,
} from "@mxlang/core";
import data from "@mxlang/data/descriptor";
import hono from "@mxlang/hono/descriptor";
import html from "@mxlang/html/descriptor";
import preact from "@mxlang/preact/descriptor";
import react from "@mxlang/react/descriptor";
import solid from "@mxlang/solid/descriptor";

/**
 * A host file kind plus the key of the editor pipeline that serves it. The key
 * is tool glue for the built-ins, so it lives here and never in core
 * (`pipeline: "region"` is TypeScript with MX regions, `"ng-template"` is the
 * Angular template pipeline, `"astro-template"` is the `.astro.mx` pipeline,
 * a file kind of the `astro` host per decision 134).
 */
export interface BuiltinFileKind extends HostFileKind {
  readonly pipeline: "region" | "ng-template" | "astro-template";
}

/**
 * A descriptor a target package could actually supply, or `undefined` where it
 * could not. Published tools may lack private target packages; importing the
 * registry must still work before the first compile.
 */
function resolved(
  descriptor: TargetDescriptor | undefined,
): descriptor is TargetDescriptor {
  return (
    typeof descriptor === "object" &&
    descriptor !== null &&
    typeof descriptor.name === "string"
  );
}

/** Built-ins in registration order; hostless `data` is last. */
export const builtinTargets: readonly TargetDescriptor[] = [
  html,
  astro,
  solid,
  preact,
  react,
  hono,
  angular,
  data,
].filter(resolved);

/** Names no descriptor may take: outputs a built-in host may add later (07 Q5). */
const RESERVED_NAMES: readonly string[] = ["astro-template"];

let cachedLookup: TargetLookup | undefined;

/**
 * The built-in lookup, built on first use.
 *
 * Deferred rather than built at import: a consumer install of a published tool
 * may resolve no host package at all (each private package's `main` is
 * TypeScript source, so none can be installed), and `createTargetLookup`
 * rejects an empty set. Building here means such an install still *loads* —
 * `mx-tsc --version` and a Vite config load, the two paths that must work —
 * and the error surfaces where the missing target is actionable: the first
 * compile. Every caller inside this repository goes through a wrapper below,
 * which builds it once and reuses it.
 */
export function builtinLookup(): TargetLookup {
  cachedLookup ??= createTargetLookup(builtinTargets, {
    reservedNames: RESERVED_NAMES,
  });
  return cachedLookup;
}

const projectLookups = new WeakMap<TargetDescriptor, TargetLookup>();

/**
 * The lookup for the project `policy` was resolved in: the built-in set, plus
 * the descriptor a package specifier under `mx.target` / `mx.host` loaded.
 *
 * Core already checked that descriptor against this lookup (names, reserved
 * names, packages, hosts) before handing the policy on, so this cannot throw
 * for a policy `resolveTargetPolicyDetailed` returned. Cached per descriptor,
 * and a descriptor is itself cached per package, so the identity is stable
 * between calls.
 */
export function lookupFor(policy: TargetPolicy): TargetLookup {
  const { descriptor } = policy;
  if (!descriptor) return builtinLookup();
  let lookup = projectLookups.get(descriptor);
  if (!lookup) {
    lookup = createTargetLookup([...builtinTargets, descriptor], {
      reservedNames: RESERVED_NAMES,
    });
    projectLookups.set(descriptor, lookup);
  }
  return lookup;
}

/**
 * The descriptor `policy` compiles through: the loaded one, else the built-in
 * the policy names.
 */
export function descriptorFor(policy: TargetPolicy): TargetDescriptor {
  const found = lookupFor(policy).target(policy.target);
  if (!found) {
    throw new Error(
      `@mxlang/target-registry: no descriptor for target "${policy.target}"`,
    );
  }
  return found;
}

const PIPELINES: Readonly<Record<string, BuiltinFileKind["pipeline"]>> = {
  solid: "region",
  ng: "ng-template",
  astro: "astro-template",
};

/** Every built-in host file kind with its pipeline key. */
export const builtinFileKinds: readonly BuiltinFileKind[] = builtinTargets
  .flatMap((target) => target.host?.fileKinds ?? [])
  .map((kind) => {
    const pipeline = PIPELINES[kind.segment];
    if (!pipeline) {
      throw new Error(
        `@mxlang/target-registry: built-in file kind "${kind.segment}" has no editor pipeline`,
      );
    }
    return { ...kind, pipeline };
  });

/**
 * Installs every built-in file kind's callee reader into *this* core copy,
 * once, at registry creation (design note §5).
 *
 * A reader used to exist only after its host package was imported for a side
 * effect (`@mxlang/solid` calls `registerCalleeInputReader` at import), so
 * core's extension probes saw `.solid.mx` only once that import had happened
 * — an import-order dependency a second copy of core also cannot see. A tool
 * that has the registry has the whole table, so it registers from the table
 * instead of relying on an import side effect. Each reader is a lazy closure
 * over its own package (`require` inside the function body), so this adds no
 * compile entry to the import graph.
 */
function registerBuiltinCalleeReaders(): void {
  for (const kind of builtinTargets.flatMap(
    (target) => target.host?.fileKinds ?? [],
  )) {
    if (kind.readCalleeInput)
      registerCalleeInputReader(`.${kind.segment}.mx`, kind.readCalleeInput);
  }
}
registerBuiltinCalleeReaders();

// ---- the lookup's own questions, bound to the built-in set ----

/** Is `name` a registered built-in target? */
export const hasTarget = (name: string): boolean =>
  builtinLookup().hasTarget(name);
/** The registered built-in target names, in registration order. */
export const targetNames = (): readonly string[] =>
  builtinLookup().targetNames();
/** One registered built-in target's descriptor, if any. */
export const target = (name: string): TargetDescriptor | undefined =>
  builtinLookup().target(name);
/** The target used when nothing selects one. */
export const defaultTarget = (): string => builtinLookup().defaultTarget();
/** The target a project dependency on `pkg` selects. */
export const fromPackage = (pkg: string): string | undefined =>
  builtinLookup().fromPackage(pkg);
/** Every registered target's `packageName`: the specifiers `AttrTag` may come from. */
export const attrTagSources = (): readonly string[] =>
  builtinLookup().attrTagSources();
/** Values `mx.host` accepts: the host names and the legacy values. */
export const hostValues = (): readonly string[] => builtinLookup().hostValues();
/** The target an `mx.host` value selects, and whether the value is deprecated. */
export const hostTarget = (
  value: string,
): { target: string; deprecated?: true } | undefined =>
  builtinLookup().hostTarget(value);
/** A target's `host.name`, if it has a host. */
export const hostOf = (targetName: string): string | undefined =>
  builtinLookup().hostOf(targetName);
/** The value `mx.tags[].hosts` is matched against for `targetName`. */
export const hostFilterKey = (targetName: string): string | undefined =>
  builtinLookup().hostFilterKey(targetName);
/** Every registered host file-kind segment. */
export const moduleSegments = (): readonly string[] =>
  builtinLookup().moduleSegments();

/**
 * `resolveTargetPolicy` over the built-in set: the policy a file compiles
 * under, resolved from its nearest `package.json`. Core's own takes the
 * lookup as a required argument; this binds the built-in one, so a tool
 * changes its import specifier and not its call sites.
 */
export function resolveTargetPolicy(filePath: string): TargetPolicy {
  return resolveTargetPolicyDetailed(filePath).policy;
}

/**
 * `resolveTargetPolicyDetailed` over the built-in set: the same policy plus
 * whatever the walk had to say (an unknown `mx.host`, a malformed
 * `package.json`).
 */
export function resolveTargetPolicyDetailed(
  filePath: string,
): TargetPolicyResolution {
  const lookup = builtinLookup();
  // Decision 131 addendum: explicit data is not yet wired into tooling.
  // Mask selection and suggestions, not registration or package inference,
  // so core's generic unknown-target path positions it and hands on the
  // same fallback without advertising a target that tools cannot use.
  const resolution = coreResolveTargetPolicyDetailed(filePath, {
    ...lookup,
    hasTarget: (name) => name !== "data" && lookup.hasTarget(name),
    targetNames: () => lookup.targetNames().filter((name) => name !== "data"),
  });
  for (const diagnostic of resolution.diagnostics) {
    if (diagnostic.code === "unknown-target" && diagnostic.value === "data") {
      diagnostic.message =
        'mx.target "data" is not wired into the editor and build tools yet (TODO data-target-tooling-dispatch); call parseData from @mxlang/data instead';
    }
  }
  // Preserve the pre-3b staging of rule-2 data inference as well.
  if (resolution.policy.target !== "data") return resolution;
  const target = lookup.defaultTarget();
  return { ...resolution, policy: { target, host: lookup.hostOf(target) } };
}

/**
 * `hostModuleSegment(entry)` over the built-in set: the host segment a
 * `.mx` file name carries (`ng`, `solid`, `astro`) when a registered file
 * kind declares it, else `undefined`.
 */
export function hostModuleSegment(entry: string): string | undefined {
  return coreHostModuleSegment(entry, builtinLookup());
}

/**
 * The `hosts` restrictions a scan read that the built-in set cannot match:
 * a bare word no registered host accepts, and nothing else (a package
 * specifier is a host package the project may not use, and a registered
 * value matches). The scan records what it read; this is the built-in set's
 * verdict, and the same rule every caller's own lookup applies.
 */
function restrictionWarnings(
  result: ScanResult,
  targets: TargetLookup,
): ScanDiagnostic[] {
  return hostRestrictionDiagnostics(result.hostRestrictions, targets);
}

/**
 * Scan options plus the lookup of the project the file is in. Unset, the
 * built-in set answers; a tool compiling under a loaded third-party target
 * passes `lookupFor(policy)`, so that target's host name is a valid
 * `mx.tags[].hosts` value and no unknown-host warning fires for it.
 */
export type RegistryScanOptions = Omit<ScanOptions, "targets"> & {
  targets?: TargetLookup;
};

/**
 * `scanCached` over the built-in set, with the scan's diagnostics plus the
 * warnings its unreadable `hosts` restrictions deserve. The cache key is
 * core's and does not include the lookup, so the diagnostics are derived from
 * the same cached result each call — a copy, never a mutation of the cached
 * one.
 */
export function scanCached(
  filePath: string,
  options: RegistryScanOptions = {},
): ScanResult {
  const targets = options.targets ?? builtinLookup();
  const result = coreScanCached(filePath, { ...options, targets });
  const extra = restrictionWarnings(result, targets);
  return extra.length === 0
    ? result
    : { ...result, diagnostics: [...result.diagnostics, ...extra] };
}

/** `getCustomTags` over the built-in set; see {@link scanCached}. */
export function getCustomTags(
  filePath: string,
  options: RegistryScanOptions = {},
): Record<string, CustomTag> {
  return scanCached(filePath, options).customTags;
}

export type {
  HostFileKind,
  TargetDescriptor,
  TargetLookup,
} from "@mxlang/core";
