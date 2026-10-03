/**
 * The target descriptor contract (decisions 129 and 132).
 *
 * **Unstable.** Nothing here is published under a stable version yet, and
 * `descriptorVersion` is `0` until it is: any of these types may change in a
 * minor release. Nothing in the repo consumes the contract in this revision;
 * it is the shape a later change moves the closed host lists onto.
 *
 * A **target** is an output format a file compiles to (Solid JSX, an Angular
 * template, an HTML string, a data tree). A **host** is a framework MX lives
 * inside; only some targets have one. A `TargetDescriptor` is plain data plus
 * a lazy, synchronous `load()`: importing one is cheap, and the heavy imports
 * (`@marko/compiler`) happen only when a tool calls `load()`.
 *
 * Core names no target and no host (decision 126). Open-set questions (is
 * this a known target? which values does `mx.host` accept? which file-kind
 * segments exist?) are asked of a `TargetLookup` that the caller builds with
 * `createTargetLookup` and passes in.
 */

import type { CalleeInputReader } from "./callee-input.ts";
import type { RawSourceMap } from "./compile.ts";
import type { MxWarning } from "./core.ts";
import type { CustomTag } from "./custom-tags.ts";
import type { HostDeclarations } from "./declarations.ts";
import type { GeneratedMapping } from "./mapping.ts";

/**
 * The whole-file compile options every target's `compileModule` accepts: the
 * option bag the host compile entries already share.
 *
 * @unstable
 */
export interface TargetCompileOptions {
  /** Custom tags already loaded by the calling integration, by call name. */
  customTags?: Readonly<Record<string, CustomTag>>;
  /** Collects positioned warnings; unset, they print to `console.warn`. */
  warnings?: MxWarning[];
  /** The `mx.strict` setting the caller resolved. A target may force it on (`strict: "always"`). */
  strict?: boolean;
  /** A synchronous import resolver (decision 107), tried before the built-in resolution. */
  resolveImport?: (specifier: string, importer: string) => string | undefined;
  /** Caller-owned target set for cross-file resolution; unset uses the descriptor's own lookup. */
  targets?: TargetLookup;
}

/**
 * What a whole-file compile returns.
 *
 * @unstable
 */
export interface TargetCompileResult {
  code: string;
  map?: RawSourceMap;
  /** Every file read while resolving callees; an integration invalidates this module when one changes. */
  dependencies: string[];
  /** Generated-to-source mappings, for a target that records them (`mappings: "merge-recorded"`). */
  mappings?: readonly GeneratedMapping[];
}

/**
 * The compile entry a target's `load()` returns.
 *
 * @unstable
 */
export interface TargetCompiler {
  /** Whole-file `.mx` to a module. Throws a positioned `TranslateError` on a source error. */
  compileModule(
    source: string,
    filename: string,
    options: TargetCompileOptions,
  ): TargetCompileResult;
}

/**
 * One MX region of a host module file, as the parser's bridge hands it over.
 * Mirrors the parser's `MxRegionCompileInput`; core cannot import the parser
 * (a cycle), so the shape is restated structurally.
 *
 * @unstable
 */
export interface HostRegionInput {
  /** The region's own source text. */
  source: string;
  /** The file being parsed. */
  filename: string;
  /** True for a `<>…</>` fragment region: `source` is the children only. */
  fragment?: boolean;
  /** The region's absolute start offset in the file. */
  baseOffset: number;
  /** The region's 0-based start line in the file. */
  baseLine: number;
  /** The region's 0-based start column on that line. */
  baseColumn: number;
  /** Custom tag definitions the caller registered. */
  customTags?: Record<string, CustomTag>;
  /** Caller-owned target set for cross-file resolution; unset uses the descriptor's own lookup. */
  targets?: TargetLookup;
  /** Where the region appeared; opaque here. */
  context?: unknown;
  /** Imports declared by the surrounding module, local binding to specifier. */
  importSpecifiers: ReadonlyMap<string, string>;
  /** Every value the surrounding module binds at its top level. */
  moduleBindings: ReadonlySet<string>;
  /** Bindings that are a default import from a `.marko`/`.mx` source. */
  importDefaultFromMarkoOrMx: ReadonlySet<string>;
  /** Non-import names whose value is not statically a function, arrow or class. */
  unknownModuleBindings: ReadonlySet<string>;
}

/**
 * What the bridge needs back from a host for one region. Mirrors the parser's
 * `MxRegionCompileResult`.
 *
 * @unstable
 */
export interface HostRegionResult {
  /** The lowered region, as source text the surrounding grammar can parse. */
  code: string;
  /** Imports the compiler minted for discovered tags called inside the region. */
  hoistedImports?: readonly unknown[];
  /** `<define>`s the region hoisted to module scope. */
  hoistedDefines?: readonly unknown[];
  /** `/var` names this region's call sites bind. */
  returnVars?: string[];
  /** Files read while resolving callees used by this region. */
  dependencies?: string[];
}

/**
 * A host module file kind: `<segment>.mx` (`.solid.mx`, `.ng.mx`).
 *
 * @unstable
 */
export interface HostFileKind {
  /** The segment before `.mx`: `solid`, `ng`. A bare word with no dot, and never `mx`. */
  readonly segment: string;
  /** Editor language ids that select this file kind. */
  readonly languageIds?: readonly string[];
  /** The label on diagnostics produced for this file kind. */
  readonly diagnosticSource: string;
  /**
   * Region file: TypeScript with MX regions; the parser's bridge calls this
   * once per region. Must emit what the host's default target emits for the
   * same source.
   */
  compileRegion?(source: string, input: HostRegionInput): HostRegionResult;
  /**
   * Reads a callee `.<segment>.mx` file's `Input`. A tool registers it into
   * *its own* core; a host must never self-register (two copies of core would
   * split the registry).
   */
  readonly readCalleeInput?: CalleeInputReader;
}

/**
 * Host-level facts of a target that belongs to a framework. Core's types name
 * no host.
 *
 * @unstable
 */
export interface TargetHost {
  /** The `mx.host` value and the `mx.tags[].hosts` filter value. */
  readonly name: string;
  /**
   * This target is the host's default (what `mx.host: "<name>"` selects).
   * Implied when the host has one target; with several, exactly one sets it
   * (`createTargetLookup` throws otherwise).
   */
  readonly default?: true;
  /** Host module file kinds. */
  readonly fileKinds?: readonly HostFileKind[];
}

/**
 * The registered thing: one output format, with an optional `host` part.
 *
 * @unstable
 */
export interface TargetDescriptor {
  /** Contract revision. Loading rejects any other value. Starts at 0. */
  readonly descriptorVersion: 0;
  /** The `mx.target` value. Distinct from every host name and every other target name. */
  readonly name: string;
  /**
   * npm name of the package exporting this descriptor. Feeds the single
   * dependency rule and the `AttrTag` source set. Unique for a hostless
   * target; targets share one only when they have the same `host.name`.
   */
  readonly packageName: string;
  /**
   * Values accepted under `mx.host` that select this target. Never accepted
   * under `mx.target`. At most one may be non-deprecated: it is the hostless
   * target's `mx.tags[].hosts` filter key. A target with a `host` part does
   * not need any: its host name is already a value.
   */
  readonly legacyHostValues?: readonly {
    readonly value: string;
    readonly deprecated?: true;
  }[];

  /** `mx.strict` handling for page `.mx`. Default `"policy"`. */
  readonly strict?: "policy" | "always";
  /** Lowering policy for this output. Also used by the mapping pass. */
  readonly declarations?: {
    readonly default: HostDeclarations;
    readonly strict?: HostDeclarations;
  };
  /** Marko translator whose taglib the mapping pass looks tags up in. */
  readonly translator?: unknown;

  /**
   * Whole-file `.mx` to module. Absent means page compilation is not wired
   * for this target. `core` is the **tool's** `@mxlang/core`: a third-party
   * target uses it (one registry, one cache set, one `TranslateError` class);
   * built-ins ignore it.
   */
  load?(core: typeof import("./index.ts")): TargetCompiler;

  /** Rewrites the emitted module's types for the TypeScript plugin. */
  readonly typeSurface?: (code: string) => string;
  /** `"merge-recorded"`: decode the map and recorded mappings. Default `"second-lowering"`. */
  readonly mappings?: "second-lowering" | "merge-recorded";
  /** Why page compilation is absent; part of the diagnostic text. */
  readonly pending?: string;

  /** Present iff the target belongs to a host. */
  readonly host?: TargetHost;
}

/**
 * What a tool asks of the set of registered targets. Required wherever core
 * needs an open-set answer, so forgetting it is a type error, never a silent
 * loss of validation.
 *
 * @unstable
 */
export interface TargetLookup {
  // ---- targets: output, compile, packages ----
  /** Is `name` a registered target (an `mx.target` value)? */
  hasTarget(name: string): boolean;
  /** Registered target names, in registration order. */
  targetNames(): readonly string[];
  target(name: string): TargetDescriptor | undefined;
  /** The target used when nothing selects one. */
  defaultTarget(): string;
  /** The target a project dependency on `pkg` selects: the host's default target, or the hostless target itself. */
  fromPackage(pkg: string): string | undefined;
  /** Every distinct `packageName`: the specifiers `AttrTag` may be imported from, besides core. */
  attrTagSources(): readonly string[];

  // ---- hosts: framework facts ----
  /** Values accepted under `mx.host`: host names and legacy values, in registration order. */
  hostValues(): readonly string[];
  /** The target an `mx.host` value selects, and whether the value is deprecated. */
  hostTarget(value: string): { target: string; deprecated?: true } | undefined;
  /** The target's `host.name`, if it has a host. */
  hostOf(target: string): string | undefined;
  /** The value `mx.tags[].hosts` is matched against for `target`; undefined means no restricted entry matches. */
  hostFilterKey(target: string): string | undefined;
  /** Every host file-kind segment. */
  moduleSegments(): readonly string[];
}

/**
 * A descriptor that fails validation. `field` names the first failing field
 * (a dotted path, `host.fileKinds[0].segment`); `message` is the detail that
 * follows it, with no prefix, so a caller can say where the descriptor came
 * from.
 *
 * @unstable
 */
export class TargetDescriptorError extends Error {
  override readonly name = "TargetDescriptorError";
  /** `"version"` for a `descriptorVersion` other than 0 (`found` holds it), `"invalid"` otherwise. */
  readonly kind: "invalid" | "version";
  readonly field: string;
  readonly found?: number;

  constructor(
    field: string,
    message: string,
    kind: "invalid" | "version" = "invalid",
    found?: number,
  ) {
    super(message);
    this.field = field;
    this.kind = kind;
    if (found !== undefined) this.found = found;
  }
}

/**
 * The rule a set of descriptors broke when `createTargetLookup` rejected it.
 *
 * @unstable
 */
export type TargetLookupRule =
  | "empty"
  | "unknown-default"
  | "duplicate-target"
  | "target-is-host-name"
  | "package-conflict"
  | "host-default"
  | "host-value-conflict"
  | "segment-conflict"
  | "reserved-name";

/**
 * A set of descriptors that cannot be one lookup.
 *
 * @unstable
 */
export class TargetLookupError extends Error {
  override readonly name = "TargetLookupError";
  readonly rule: TargetLookupRule;

  constructor(rule: TargetLookupRule, message: string) {
    super(message);
    this.rule = rule;
  }
}

/** A bare word: how a target or host name is spelled, never a package specifier. */
const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
/** A file-kind segment: one lowercase word, no dot. */
const SEGMENT_RE = /^[a-z][a-z0-9-]*$/;

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  switch (typeof value) {
    case "string":
      return "a string";
    case "number":
      return "a number";
    case "boolean":
      return "a boolean";
    case "function":
      return "a function";
    case "object":
      return "an object";
    default:
      return typeof value;
  }
}

function bad(
  field: string,
  value: unknown,
  expected: string,
): TargetDescriptorError {
  const found = value === undefined ? "is missing" : `is ${describe(value)}`;
  return new TargetDescriptorError(
    field,
    `"${field}" ${found}, expected ${expected}`,
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  owner: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = owner[key];
  if (value === "")
    throw new TargetDescriptorError(
      path,
      `"${path}" is an empty string, expected a non-empty string`,
    );
  if (typeof value !== "string") throw bad(path, value, "a string");
  return value;
}

function optionalFunction(
  owner: Record<string, unknown>,
  key: string,
  path: string,
): void {
  const value = owner[key];
  if (value !== undefined && typeof value !== "function")
    throw bad(path, value, "a function");
}

function requireName(
  owner: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = requireString(owner, key, path);
  if (!NAME_RE.test(value)) {
    throw new TargetDescriptorError(
      path,
      `"${path}" is ${JSON.stringify(value)}, expected a bare word (letters, digits, "-" and "_", starting with a letter), not a package specifier`,
    );
  }
  return value;
}

function validateFileKind(value: unknown, path: string): void {
  if (!isObject(value)) throw bad(path, value, "an object");
  const segment = requireString(value, "segment", `${path}.segment`);
  if (!SEGMENT_RE.test(segment) || segment === "mx") {
    throw new TargetDescriptorError(
      `${path}.segment`,
      `"${path}.segment" is ${JSON.stringify(segment)}, expected one lowercase word with no dot, and not "mx"`,
    );
  }
  requireString(value, "diagnosticSource", `${path}.diagnosticSource`);
  const ids = value.languageIds;
  if (ids !== undefined) {
    if (!Array.isArray(ids))
      throw bad(`${path}.languageIds`, ids, "an array of strings");
    ids.forEach((id, i) => {
      if (typeof id !== "string" || id === "")
        throw bad(`${path}.languageIds[${i}]`, id, "a non-empty string");
    });
  }
  optionalFunction(value, "compileRegion", `${path}.compileRegion`);
  optionalFunction(value, "readCalleeInput", `${path}.readCalleeInput`);
}

function validateHost(value: unknown): void {
  if (!isObject(value)) throw bad("host", value, "an object");
  requireName(value, "name", "host.name");
  if (value.default !== undefined && value.default !== true) {
    throw new TargetDescriptorError(
      "host.default",
      '"host.default" must be true when present',
    );
  }
  const kinds = value.fileKinds;
  if (kinds !== undefined) {
    if (!Array.isArray(kinds)) throw bad("host.fileKinds", kinds, "an array");
    for (const [i, kind] of kinds.entries())
      validateFileKind(kind, `host.fileKinds[${i}]`);
  }
}

function validateLegacyHostValues(value: unknown): void {
  if (!Array.isArray(value)) throw bad("legacyHostValues", value, "an array");
  const current: string[] = [];
  value.forEach((entry, i) => {
    const path = `legacyHostValues[${i}]`;
    if (!isObject(entry))
      throw bad(path, entry, "an object with a string value");
    const v = requireName(entry, "value", `${path}.value`);
    if (entry.deprecated !== undefined && entry.deprecated !== true) {
      throw new TargetDescriptorError(
        `${path}.deprecated`,
        `"${path}.deprecated" must be true when present`,
      );
    }
    if (entry.deprecated !== true) current.push(v);
  });
  if (current.length > 1) {
    throw new TargetDescriptorError(
      "legacyHostValues",
      `"legacyHostValues" has more than one non-deprecated value (${current.join(", ")}); at most one may be, because it is the filter key`,
    );
  }
}

/**
 * Checks `value` against the descriptor contract and returns it, typed.
 * Throws a `TargetDescriptorError` naming the **first** failing field, in
 * declaration order. Unknown extra fields are ignored, so a newer descriptor
 * of the same `descriptorVersion` still loads.
 *
 * Only shape is checked: a `declarations` object is not probed for its hooks,
 * and a `load()` is not called.
 *
 * @unstable
 */
export function validateDescriptor(value: unknown): TargetDescriptor {
  if (!isObject(value)) {
    const found =
      value === undefined || value === null
        ? "is missing"
        : `is ${describe(value)}`;
    throw new TargetDescriptorError(
      "descriptor",
      `the export ${found}, expected an object`,
    );
  }

  const version = value.descriptorVersion;
  if (typeof version === "number") {
    if (version !== 0) {
      throw new TargetDescriptorError(
        "descriptorVersion",
        `descriptor version ${version}; this mx supports 0`,
        "version",
        version,
      );
    }
  } else {
    const found =
      version === undefined ? "is missing" : `is ${describe(version)}`;
    throw new TargetDescriptorError(
      "descriptorVersion",
      `"descriptorVersion" ${found}, expected the number 0`,
    );
  }

  requireName(value, "name", "name");
  requireString(value, "packageName", "packageName");

  if (value.legacyHostValues !== undefined)
    validateLegacyHostValues(value.legacyHostValues);

  if (
    value.strict !== undefined &&
    value.strict !== "policy" &&
    value.strict !== "always"
  ) {
    throw new TargetDescriptorError(
      "strict",
      '"strict" must be "policy" or "always"',
    );
  }

  const declarations = value.declarations;
  if (declarations !== undefined) {
    if (!isObject(declarations))
      throw bad("declarations", declarations, "an object");
    if (!isObject(declarations.default))
      throw bad("declarations.default", declarations.default, "an object");
    if (declarations.strict !== undefined && !isObject(declarations.strict)) {
      throw bad("declarations.strict", declarations.strict, "an object");
    }
  }

  optionalFunction(value, "load", "load");
  optionalFunction(value, "typeSurface", "typeSurface");

  if (
    value.mappings !== undefined &&
    value.mappings !== "second-lowering" &&
    value.mappings !== "merge-recorded"
  ) {
    throw new TargetDescriptorError(
      "mappings",
      '"mappings" must be "second-lowering" or "merge-recorded"',
    );
  }
  if (value.pending !== undefined && typeof value.pending !== "string")
    throw bad("pending", value.pending, "a string");

  if (value.host !== undefined) validateHost(value.host);

  // SAFETY: the checks above validate the descriptor's version-zero boundary
  // schema; declarations retain their target-owned typed implementation.
  return value as unknown as TargetDescriptor;
}

/**
 * Builds the lookup over `descriptors`, validating each and enforcing the
 * rules that only a *set* can break. Throws `TargetDescriptorError` for an
 * invalid descriptor and `TargetLookupError` (with a `rule`) for a bad set:
 *
 * - a target name may equal no host name and no other target's name;
 * - a `packageName` is unique for a hostless target, and shared only between
 *   targets of the same `host.name`;
 * - a host with several targets has exactly one `host.default` (implied for one);
 * - `mx.host` values (host names and legacy values) each select one target;
 * - a file-kind segment belongs to one host.
 *
 * `options.reservedNames` lists names no descriptor may take (`reserved-name`);
 * core names none, the caller (a registry) supplies them so an output a host
 * may add later cannot be taken first by a third party (07 Q5).
 * `options.defaultTarget` names the target used when nothing selects one; it
 * defaults to the first descriptor, so a lookup over one descriptor defaults
 * to it.
 *
 * @unstable
 */
export function createTargetLookup(
  descriptors: readonly TargetDescriptor[],
  options: {
    defaultTarget?: string;
    reservedNames?: readonly string[];
  } = {},
): TargetLookup {
  if (descriptors.length === 0) {
    throw new TargetLookupError(
      "empty",
      "a target lookup needs at least one target descriptor",
    );
  }
  for (const descriptor of descriptors) validateDescriptor(descriptor);

  const reserved = new Set(options.reservedNames ?? []);
  for (const descriptor of descriptors) {
    if (reserved.has(descriptor.name)) {
      throw new TargetLookupError(
        "reserved-name",
        `target "${descriptor.name}" uses a reserved name`,
      );
    }
  }

  const targets = new Map<string, TargetDescriptor>();
  const hostNames = new Set<string>();
  for (const descriptor of descriptors) {
    if (targets.has(descriptor.name)) {
      throw new TargetLookupError(
        "duplicate-target",
        `target "${descriptor.name}" is registered twice`,
      );
    }
    targets.set(descriptor.name, descriptor);
    if (descriptor.host) hostNames.add(descriptor.host.name);
  }
  for (const descriptor of descriptors) {
    if (hostNames.has(descriptor.name)) {
      throw new TargetLookupError(
        "target-is-host-name",
        `target "${descriptor.name}" has the same name as a host; a target name must be distinct from every host name`,
      );
    }
  }

  // Package ownership: hostless targets own a package alone; hosted ones share it within one host.
  const packageOwner = new Map<string, TargetDescriptor>();
  for (const descriptor of descriptors) {
    const owner = packageOwner.get(descriptor.packageName);
    if (
      owner &&
      (!owner.host ||
        !descriptor.host ||
        owner.host.name !== descriptor.host.name)
    ) {
      throw new TargetLookupError(
        "package-conflict",
        `targets "${owner.name}" and "${descriptor.name}" both declare package "${descriptor.packageName}"; a package may be shared only by targets of the same host`,
      );
    }
    if (!owner) packageOwner.set(descriptor.packageName, descriptor);
  }

  // Each host's default target.
  const hostDefaults = new Map<string, string>();
  const byHost = new Map<string, TargetDescriptor[]>();
  for (const descriptor of descriptors) {
    if (!descriptor.host) continue;
    const list = byHost.get(descriptor.host.name) ?? [];
    list.push(descriptor);
    byHost.set(descriptor.host.name, list);
  }
  for (const [host, list] of byHost) {
    if (list.length === 1) {
      hostDefaults.set(host, (list[0] as TargetDescriptor).name);
      continue;
    }
    const flagged = list.filter((d) => d.host?.default === true);
    if (flagged.length !== 1) {
      throw new TargetLookupError(
        "host-default",
        `host "${host}" has ${list.length} targets (${list.map((d) => d.name).join(", ")}) and ${flagged.length} marked as its default; exactly one must set host.default`,
      );
    }
    hostDefaults.set(host, (flagged[0] as TargetDescriptor).name);
  }

  // Values accepted under `mx.host`.
  const hostValues = new Map<string, { target: string; deprecated?: true }>();
  const claim = (value: string, target: string, deprecated: boolean) => {
    const existing = hostValues.get(value);
    if (existing && existing.target !== target) {
      throw new TargetLookupError(
        "host-value-conflict",
        `mx.host value "${value}" would select both "${existing.target}" and "${target}"`,
      );
    }
    if (!existing)
      hostValues.set(
        value,
        deprecated ? { target, deprecated: true } : { target },
      );
  };
  for (const descriptor of descriptors) {
    if (descriptor.host)
      claim(
        descriptor.host.name,
        hostDefaults.get(descriptor.host.name) as string,
        false,
      );
    for (const legacy of descriptor.legacyHostValues ?? []) {
      claim(legacy.value, descriptor.name, legacy.deprecated === true);
    }
  }

  // File-kind segments belong to one host.
  const segments = new Map<string, string>();
  for (const descriptor of descriptors) {
    if (!descriptor.host) continue;
    const own = new Set<string>();
    for (const kind of descriptor.host.fileKinds ?? []) {
      const owner = segments.get(kind.segment);
      if (
        own.has(kind.segment) ||
        (owner !== undefined && owner !== descriptor.host.name)
      ) {
        throw new TargetLookupError(
          "segment-conflict",
          `file-kind segment "${kind.segment}" is declared more than once (host "${descriptor.host.name}"${owner && owner !== descriptor.host.name ? ` and host "${owner}"` : ""})`,
        );
      }
      own.add(kind.segment);
      segments.set(kind.segment, descriptor.host.name);
    }
  }

  const fromPackage = new Map<string, string>();
  for (const descriptor of descriptors) {
    if (fromPackage.has(descriptor.packageName)) continue;
    fromPackage.set(
      descriptor.packageName,
      descriptor.host
        ? (hostDefaults.get(descriptor.host.name) as string)
        : descriptor.name,
    );
  }

  const defaultTarget =
    options.defaultTarget ?? (descriptors[0] as TargetDescriptor).name;
  if (!targets.has(defaultTarget)) {
    throw new TargetLookupError(
      "unknown-default",
      `default target "${defaultTarget}" is not among the registered targets`,
    );
  }

  const filterKey = (descriptor: TargetDescriptor): string | undefined => {
    if (descriptor.host) return descriptor.host.name;
    return descriptor.legacyHostValues?.find(
      (legacy) => legacy.deprecated !== true,
    )?.value;
  };

  return {
    hasTarget: (name) => targets.has(name),
    targetNames: () => [...targets.keys()],
    target: (name) => targets.get(name),
    defaultTarget: () => defaultTarget,
    fromPackage: (pkg) => fromPackage.get(pkg),
    attrTagSources: () => [...packageOwner.keys()],
    hostValues: () => [...hostValues.keys()],
    hostTarget: (value) => {
      const entry = hostValues.get(value);
      return entry && { ...entry };
    },
    hostOf: (target) => targets.get(target)?.host?.name,
    hostFilterKey: (target) => {
      const descriptor = targets.get(target);
      return descriptor && filterKey(descriptor);
    },
    moduleSegments: () => [...segments.keys()],
  };
}
