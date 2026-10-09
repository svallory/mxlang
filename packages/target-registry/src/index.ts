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

import { dirname } from "node:path";
import angular from "@mxlang/angular/descriptor";
import astro from "@mxlang/astro/descriptor";
import {
  type CustomTag,
  contractDefaultTagDiagnostics,
  hostModuleSegment as coreHostModuleSegment,
  resolveTargetPolicyDetailed as coreResolveTargetPolicyDetailed,
  scanCached as coreScanCached,
  createTargetLookup,
  defaultTagDiagnostic,
  defaultTagScopeFor,
  type HostFileKind,
  type HostRegionInput,
  type HostRegionResult,
  hostRestrictionDiagnostics,
  type MxWarning,
  readTargetDefaultTag,
  registerCalleeInputReader,
  type ScanDiagnostic,
  type ScanOptions,
  type ScanResult,
  type TargetDescriptor,
  type TargetLookup,
  type TargetPolicy,
  type TargetPolicyDiagnostic,
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

/** Names no descriptor may take: outputs a built-in host may add later (07 Q5), and `data`, reserved for the future evaluated tree target (decision 187). */
const RESERVED_NAMES: readonly string[] = ["astro-template", "data"];

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
    // A loaded host's callee readers are not registered: core reads them from
    // this lookup's file kinds (`ResolveContext.targets`), so they stay scoped
    // to the project that loaded the host.
    projectLookups.set(descriptor, lookup);
  }
  return lookup;
}

/**
 * The base target of `policy`'s target: the end of its `builtOn` chain (the
 * lookup resolves and validates it), else the target itself. A check that is
 * specific to a target (`mx-tsc`'s data check) asks this, never the project's
 * `mx.target` string, so a third-party host that declares it is built on the
 * target gets the check without the caller knowing the host.
 */
export function baseTargetOfPolicy(policy: TargetPolicy): string {
  const lookup = lookupFor(policy);
  return lookup.baseTargetOf?.(policy.target) ?? policy.target;
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

/**
 * The template pipelines, by segment. A region file kind needs no entry: a
 * kind with a `compileRegion` is a region file whatever its segment, so a new
 * region host is served by the region pipeline without an edit here.
 */
const PIPELINES: Readonly<Record<string, BuiltinFileKind["pipeline"]>> = {
  ng: "ng-template",
  astro: "astro-template",
};

/** Every built-in host file kind with its pipeline key. */
export const builtinFileKinds: readonly BuiltinFileKind[] = builtinTargets
  .flatMap((target) => target.host?.fileKinds ?? [])
  .map((kind) => {
    const pipeline = kind.compileRegion ? "region" : PIPELINES[kind.segment];
    if (!pipeline) {
      throw new Error(
        `@mxlang/target-registry: built-in file kind "${kind.segment}" has no editor pipeline`,
      );
    }
    return { ...kind, pipeline };
  });

/**
 * A region file kind: TypeScript with MX regions (`.<segment>.mx`), lowered
 * region by region through the parser's bridge. `target` is the descriptor
 * that declares it, the target the regions compile under.
 */
export interface RegionFileKind extends HostFileKind {
  readonly compileRegion: NonNullable<HostFileKind["compileRegion"]>;
  readonly target: string;
}

/**
 * Every region file kind `lookup` registers, in registration order: the
 * built-in set unless a project's lookup (`lookupFor(policy)`) is given. A
 * file kind is a region kind only if it has a `compileRegion`; a kind without
 * one (a template kind, or a third-party kind on a hostless target) is never
 * routed to the region bridge.
 */
export function regionFileKinds(
  lookup: TargetLookup = builtinLookup(),
): readonly RegionFileKind[] {
  const kinds: RegionFileKind[] = [];
  for (const name of lookup.targetNames()) {
    const descriptor = lookup.target(name);
    for (const kind of descriptor?.host?.fileKinds ?? []) {
      const { compileRegion } = kind;
      if (compileRegion) kinds.push({ ...kind, compileRegion, target: name });
    }
  }
  return kinds;
}

/**
 * The region file kind `filePath` belongs to in `lookup`, by its exact
 * `.<segment>.mx` suffix. Undefined for every other file, an unregistered
 * `.<word>.mx` included: that stays a whole-file `.mx`, the rule core's
 * `hostModuleSegment` already applies.
 */
export function regionFileKind(
  filePath: string,
  lookup: TargetLookup = builtinLookup(),
): RegionFileKind | undefined {
  return regionFileKinds(lookup).find((kind) =>
    filePath.endsWith(`.${kind.segment}.mx`),
  );
}

/** What {@link regionCompileFor} binds into every region's compile. */
export interface RegionCompileOptions {
  /** The set the host resolves callees against; default the built-in lookup. */
  targets?: TargetLookup;
  /** Collects the host's positioned warnings. */
  warnings?: MxWarning[];
  /** Called with every file a region's compile read. */
  onDependency?: (file: string) => void;
}

/**
 * The parser's `mxRegionCompile` hook for `filePath`: the compile of the
 * region file kind its suffix names, with `targets` and `warnings` bound.
 * Undefined when `filePath` is not a region file in `targets`.
 *
 * Typed against core's structural mirror of the parser's region contract;
 * a caller hands it to `parse`/`print` with the parser's own type (core
 * keeps hoisted AST nodes opaque to avoid a dependency cycle).
 */
export function regionCompileFor(
  filePath: string,
  options: RegionCompileOptions = {},
): ((input: HostRegionInput) => HostRegionResult) | undefined {
  const targets = options.targets ?? builtinLookup();
  const kind = regionFileKind(filePath, targets);
  return kind && regionKindCompile(kind, { ...options, targets });
}

/**
 * {@link regionCompileFor} for a kind already in hand: the parser hook that
 * lowers every region with `kind`'s `compileRegion`, `targets` (default the
 * built-in lookup) and `warnings` bound. Throws for a kind with no region
 * entry, which no region file kind is.
 */
export function regionKindCompile(
  kind: Pick<HostFileKind, "segment" | "compileRegion">,
  options: RegionCompileOptions = {},
): (input: HostRegionInput) => HostRegionResult {
  const { compileRegion } = kind;
  if (!compileRegion)
    throw new Error(
      `@mxlang/target-registry: file kind ".${kind.segment}.mx" has no compileRegion`,
    );
  const targets = options.targets ?? builtinLookup();
  return (input) => {
    const result = compileRegion(input.source, {
      ...input,
      ...(options.warnings === undefined ? {} : { warnings: options.warnings }),
      targets,
    });
    if (options.onDependency)
      for (const dependency of result.dependencies ?? [])
        options.onDependency(dependency);
    return result;
  };
}

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
function registerCalleeInputReaders(...targets: TargetDescriptor[]): void {
  for (const kind of targets.flatMap(
    (target) => target.host?.fileKinds ?? [],
  )) {
    if (kind.readCalleeInput)
      registerCalleeInputReader(`.${kind.segment}.mx`, kind.readCalleeInput);
  }
}
registerCalleeInputReaders(...builtinTargets);

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
export function resolveTargetPolicy(
  filePath: string,
  options: ResolveTargetPolicyOptions = {},
): TargetPolicy {
  return resolveTargetPolicyDetailed(filePath, options).policy;
}

/** Options of {@link resolveTargetPolicyDetailed}; every default is the staged behavior. */
export interface ResolveTargetPolicyOptions {
  /**
   * The caller compiles `data` itself (`mx-tsc`, through `checkDataPackage`):
   * answer with the real policy, `data` included, instead of the positioned
   * "not wired yet" error and the `html` fallback the editor tools, Vite and
   * the Bun loader still get (TODO `data-target-tooling-dispatch`).
   */
  dataWired?: boolean;
  /**
   * Print nothing for the deprecated `mx.host` alias. For a caller that asks
   * about a file's policy again after another call already reported it.
   */
  quiet?: boolean;
}

/**
 * `resolveTargetPolicyDetailed` over the built-in set: the same policy plus
 * whatever the walk had to say (an unknown `mx.host`, a malformed
 * `package.json`).
 */
export function resolveTargetPolicyDetailed(
  filePath: string,
  options: ResolveTargetPolicyOptions = {},
): TargetPolicyResolution {
  return checkDefaultTags(resolveStaged(filePath, options), filePath);
}

/**
 * The ladder's rungs the registry owns (decision 145): the package's
 * `mx.<target>.defaultTag`, then the host's override on its descriptor, then
 * the target's built-in. A tool hands the result to the target's compile as
 * `defaultTag`; the target's own `resolveDefaultTag` ends with the same
 * built-in, and a parent contract's rung (later) goes in front of all three.
 */
export function effectiveDefaultTag(
  policy: Pick<TargetPolicy, "defaultTag">,
  descriptor: TargetDescriptor,
): string {
  return (
    policy.defaultTag ?? descriptor.host?.defaultTag ?? descriptor.defaultTag
  );
}

/**
 * The target a host module file kind (`.solid.mx`, `.ng.mx`, `.astro.mx`, a
 * loaded host's own) compiles under, which is not the page policy's target.
 */
function fileKindTarget(
  filePath: string,
  lookup: TargetLookup,
): TargetDescriptor | undefined {
  return lookup
    .targetNames()
    .map((name) => lookup.target(name))
    .find((target) =>
      target?.host?.fileKinds?.some((kind) =>
        filePath.endsWith(`.${kind.segment}.mx`),
      ),
    );
}

/** The target `filePath` compiles under and its `mx.<target>.defaultTag`, validated or not. */
function configFor(
  filePath: string,
  policy: TargetPolicy,
): {
  target: string;
  value?: string;
  at?: NonNullable<TargetPolicy["defaultTagAt"]>;
  diagnostic?: TargetPolicyDiagnostic;
} {
  const kind = fileKindTarget(filePath, lookupFor(policy));
  if (!kind || kind.name === policy.target) {
    return {
      target: policy.target,
      ...(policy.defaultTag === undefined
        ? {}
        : { value: policy.defaultTag, at: policy.defaultTagAt }),
    };
  }
  return {
    target: kind.name,
    ...readTargetDefaultTag(filePath, kind.name, kind.configKey),
  };
}

/**
 * `mx.<base>.defaultTag` for the base target of `target` (the end of its
 * `builtOn` chain), when that is another target: the rung a target built on
 * another reads when its own key is absent (`mx.data.defaultTag` on a host
 * built on data). Not validated.
 */
function baseConfigFor(
  filePath: string,
  lookup: TargetLookup,
  target: string,
): ({ target: string } & ReturnType<typeof readTargetDefaultTag>) | undefined {
  const base = lookup.baseTargetOf?.(target) ?? target;
  if (base === target) return undefined;
  return {
    target: base,
    ...readTargetDefaultTag(filePath, base, lookup.target(base)?.configKey),
  };
}

/** `mx.<config key>.defaultTag`, spelled as a JSON path an author can find. */
function keyPath(target: string, configKey?: string): string {
  const key = configKey ?? target;
  return /^[A-Za-z_$][\w$]*$/.test(key)
    ? `mx.${key}.defaultTag`
    : `mx[${JSON.stringify(key)}].defaultTag`;
}

/** The scope a package's `defaultTag` is checked in: its scan, and the lookup the target compiles with. */
function scopeFor(
  descriptor: TargetDescriptor,
  lookup: TargetLookup,
  filePath: string,
  builtins: readonly string[],
) {
  return () => {
    const hostKey = lookup.hostFilterKey(descriptor.name);
    return defaultTagScopeFor({
      dir: dirname(filePath),
      translator: (descriptor.parseTranslator ??
        descriptor.translator ??
        html.translator) as unknown,
      // The scan alone may fail (a malformed mx.contracts): the custom tags
      // are then unknown, the parse-shape check still runs, and the tool's
      // own scan reports the real error. A taglib or translator failure is
      // not tolerated and throws.
      customTags: () =>
        coreScanCached(filePath, {
          targets: lookup,
          ...(hostKey === undefined ? {} : { host: hostKey }),
        }).customTags,
      declarations: descriptor.declarations?.default,
      builtins,
    });
  };
}

const TARGET_ERROR_CODES: ReadonlySet<string> = new Set([
  "unknown-target",
  "target-host-mismatch",
  "target-not-found",
  "target-load-failed",
  "target-invalid-descriptor",
  "host-invalid-descriptor",
]);

/**
 * The registration check of the package's contracts' `defaultTag`s (the
 * parent-contract rung): each at its declaration, and refused by a host that
 * does not permit it. A failed scan skips it; the tool's own scan reports that.
 */
function contractDiagnostics(
  descriptor: TargetDescriptor,
  lookup: TargetLookup,
  filePath: string,
): TargetPolicyDiagnostic[] {
  let scan: ReturnType<typeof coreScanCached>;
  const hostKey = lookup.hostFilterKey(descriptor.name);
  try {
    scan = coreScanCached(filePath, {
      targets: lookup,
      ...(hostKey === undefined ? {} : { host: hostKey }),
    });
  } catch {
    return [];
  }
  return contractDefaultTagDiagnostics({
    tags: scan.tags,
    customTags: scan.customTags,
    scope: defaultTagScopeFor({
      dir: dirname(filePath),
      translator: (descriptor.parseTranslator ??
        descriptor.translator ??
        html.translator) as unknown,
      customTags: scan.customTags,
      declarations: descriptor.declarations?.default,
      builtins: builtinsOf(descriptor),
    }),
    // One source for the permit flag: the target's declarations, host or not.
    host: {
      name: descriptor.host?.name ?? descriptor.name,
      kind: descriptor.host ? "host" : "target",
      allowContractDefaultTag:
        descriptor.declarations?.default.allowContractDefaultTag !== false,
    },
  });
}

/**
 * The built-in names a target lists: its own, its host's override and those
 * its declarations provide (`builtinTags`).
 */
function builtinsOf(descriptor: TargetDescriptor): readonly string[] {
  return [
    descriptor.defaultTag,
    descriptor.host?.defaultTag,
    ...(declaredBuiltins(descriptor) ?? []),
  ].filter((value): value is string => value !== undefined);
}

/** `HostDeclarations.builtinTags` of a descriptor: the vocabulary it is built on. */
function declaredBuiltins(
  descriptor: TargetDescriptor,
): readonly string[] | undefined {
  return descriptor.declarations?.default.builtinTags;
}

/**
 * Checks every `defaultTag` the file's compile rests on, once per package and
 * positioned where it is written: the package's `mx.<target>.defaultTag` for
 * the target the file compiles under, and, for a descriptor loaded from a
 * package specifier, the descriptor's host override and built-in, each
 * against the target's lookup (never against a set that holds the value
 * itself). A built-in descriptor's own values are this repo's to get right,
 * and its tests pin them. A user value that fails is dropped from the policy,
 * so the compile that follows uses the next rung and the one error is the only
 * noise.
 */
function checkDefaultTags(
  resolution: TargetPolicyResolution,
  filePath: string,
): TargetPolicyResolution {
  const { policy } = resolution;
  const lookup = lookupFor(policy);
  const config = configFor(filePath, policy);
  const descriptor = lookup.target(config.target);
  if (!descriptor) return resolution;
  const diagnostics = [...resolution.diagnostics];
  // Only the type error of a config read for a file-kind target: the policy's
  // own target already reported its own.
  if (config.diagnostic) diagnostics.push(config.diagnostic);
  let next = policy;
  const scope = scopeFor(descriptor, lookup, filePath, builtinsOf(descriptor));
  let own: string | undefined;
  if (config.value !== undefined && config.at) {
    const diagnostic = defaultTagDiagnostic(config.value, config.at, scope);
    if (diagnostic) {
      diagnostics.push(diagnostic);
      if (config.target === policy.target) {
        const { defaultTag: _value, defaultTagAt: _at, ...rest } = next;
        next = rest;
      }
    } else own = config.value;
  }
  // The base target's own key (a host built on data reads `mx.data.defaultTag`):
  // the rung below the target's key, checked in the same scope. When both are
  // set and differ the target's wins, and saying nothing would ignore the other.
  const base = baseConfigFor(filePath, lookup, config.target);
  if (base) {
    if (base.diagnostic) diagnostics.push(base.diagnostic);
    if (base.value !== undefined && base.at) {
      const diagnostic = defaultTagDiagnostic(base.value, base.at, scope);
      if (diagnostic) diagnostics.push(diagnostic);
      else if (own === undefined) {
        if (config.target === policy.target)
          next = { ...next, defaultTag: base.value, defaultTagAt: base.at };
      } else if (own !== base.value) {
        diagnostics.push({
          code: "default-tag-overridden",
          severity: "warning",
          file: base.at.file,
          line: base.at.line,
          column: base.at.column,
          ...(base.at.length !== undefined ? { length: base.at.length } : {}),
          message: `${keyPath(base.target, lookup.target(base.target)?.configKey)} ${JSON.stringify(base.value)} is ignored: ${keyPath(config.target, lookup.target(config.target)?.configKey)} ${JSON.stringify(own)} takes precedence`,
        });
      }
    }
  }
  // A package whose target could not be selected or loaded compiles under a
  // fallback its author did not ask for: its contracts are not this target's
  // to judge, and reading them would re-scan a package already in error.
  if (!resolution.diagnostics.some((d) => TARGET_ERROR_CODES.has(d.code)))
    diagnostics.push(...contractDiagnostics(descriptor, lookup, filePath));
  if (
    policy.descriptor &&
    policy.descriptorAt &&
    descriptor === policy.descriptor
  ) {
    const own: Array<[string, string]> = [
      [descriptor.defaultTag, `defaultTag of "${descriptor.name}"`],
    ];
    if (descriptor.host?.defaultTag !== undefined) {
      own.unshift([
        descriptor.host.defaultTag,
        `host.defaultTag of "${descriptor.name}"`,
      ]);
    }
    for (const [name, owner] of own) {
      // Only what the declarations provide as built-in (`builtinTags`), never
      // the value itself: listing it would make the reachability question a
      // tautology.
      const diagnostic = defaultTagDiagnostic(
        name,
        policy.descriptorAt,
        scopeFor(
          descriptor,
          lookup,
          filePath,
          declaredBuiltins(descriptor) ?? [],
        ),
        owner,
      );
      if (diagnostic) diagnostics.push(diagnostic);
    }
  }
  return diagnostics.length === resolution.diagnostics.length && next === policy
    ? resolution
    : { ...resolution, policy: next, diagnostics };
}

/**
 * The name the unnamed tag takes in `filePath`, for a tool to hand to the
 * compile as `defaultTag`: the ladder's registry rungs (config, then the base
 * target's config for a target `builtOn` another, host override, target
 * built-in) for the target the file compiles under. `policy` is the
 * file's resolved policy (the tool has it: this never resolves again), and a
 * rejected user value is already out of it. A host module file kind reads its
 * own target's key, which the registry checks here.
 */
export function defaultTagFor(filePath: string, policy: TargetPolicy): string {
  const lookup = lookupFor(policy);
  const config = configFor(filePath, policy);
  const descriptor = lookup.target(config.target) ?? descriptorFor(policy);
  // The policy's own target: `checkDefaultTags` already validated its key and
  // folded the base target's in, so the policy is the answer.
  if (config.target === policy.target)
    return effectiveDefaultTag(policy, descriptor);
  // A host module file kind's target: its own key, else its base's, each
  // checked here.
  const scope = scopeFor(descriptor, lookup, filePath, builtinsOf(descriptor));
  const usable = (value?: string, at?: TargetPolicy["defaultTagAt"]) =>
    value !== undefined &&
    at !== undefined &&
    defaultTagDiagnostic(value, at, scope) === undefined;
  const base = baseConfigFor(filePath, lookup, config.target);
  const value = usable(config.value, config.at)
    ? config.value
    : base && usable(base.value, base.at)
      ? base.value
      : undefined;
  return effectiveDefaultTag(
    value === undefined ? {} : { defaultTag: value },
    descriptor,
  );
}

function resolveStaged(
  filePath: string,
  options: ResolveTargetPolicyOptions,
): TargetPolicyResolution {
  const lookup = builtinLookup();
  // A tool that checks data files itself asks for the unmasked answer: the
  // registry's staged error and fallback stay the default for every other tool.
  if (options.dataWired)
    return coreResolveTargetPolicyDetailed(filePath, lookup, options);
  // Decision 131 addendum: explicit tree is not yet wired into tooling.
  // Mask selection and suggestions, not registration or package inference,
  // so core's generic unknown-target path positions it and hands on the
  // same fallback without advertising a target that tools cannot use.
  const resolution = coreResolveTargetPolicyDetailed(
    filePath,
    {
      ...lookup,
      hasTarget: (name) => name !== "tree" && lookup.hasTarget(name),
      targetNames: () => lookup.targetNames().filter((name) => name !== "tree"),
      // Still registered: a loaded host may be `builtOn` it.
      allTargetNames: () => lookup.targetNames(),
    },
    options,
  );
  for (const diagnostic of resolution.diagnostics) {
    if (diagnostic.code === "unknown-target" && diagnostic.value === "tree") {
      diagnostic.message =
        'mx.target "tree" is not wired into the editor and build tools yet (TODO data-target-tooling-dispatch); call parseData from @mxlang/data instead';
    }
  }
  // Preserve the pre-3b staging of rule-2 data inference as well.
  if (resolution.policy.target !== "tree") return resolution;
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
