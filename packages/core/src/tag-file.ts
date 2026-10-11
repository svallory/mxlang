/**
 * Dialect tag files (dialect tag discovery, slice 2): a file in a dialect's
 * `tagDirs` names a tag by its file name, and the dialect's `tagFile` hook
 * turns its text into that tag's contract.
 *
 * - **Lazy.** The scan registers the name and never runs the hook. The first
 *   call of the tag reads its contract (slice 1's deferred registration),
 *   and that read derives it here.
 * - **Cached per tag file**, keyed by its path, its stamp (the scan's rule:
 *   stat, plus a hash while racy), the dialect module's revision, the
 *   parser-facing signature of the tag file's own scan (`ctx.lower` lowers
 *   against that map) and the stamp of every dependency. A failure is cached
 *   too, except on a cycle.
 * - **Dependencies.** `ctx.dependsOn(path)` records one by hand. A read of
 *   another tag file's contract during a derivation (a call `ctx.lower`
 *   resolves) records that file, and everything it depends on, by itself.
 * - **Cycles.** Derivations in progress form a stack of paths. A call that
 *   re-enters one is `MX_TAG_FILE_CYCLE` at that call, and nothing on the
 *   cycle is cached, so fixing one file clears it.
 * - **Diagnostics.** The hook's diagnostics are in the tag file's
 *   coordinates and core sets their `file`. A hook that throws is an error
 *   diagnostic, never a crash. A contract with errors, or none, fails each
 *   call with "`<x>`'s definition has errors (where)", `MX_TAG_FILE_ERROR`,
 *   and the tag file's diagnostics travel with it.
 *
 * This module registers itself with the scan (`registerTagFileReader`) as
 * it loads: the scan must not import `lowerSource`.
 */

import { dirname, relative, resolve } from "node:path";
import { claimedFields } from "./contract-fields.ts";
import {
  attachRelatedErrors,
  isTranslateError,
  type MxWarning,
  TranslateError,
} from "./core.ts";
import type { CustomTag, DeferredRead, DeferredReader } from "./custom-tags.ts";
import {
  type LowerSourceOptions,
  type LowerSourceResult,
  lowerSource,
} from "./ir-entry/index.ts";
import {
  type DiscoveredTag,
  registerTagFileReader,
  type ScanResult,
  tagFileError,
} from "./scan.ts";
import {
  type FileStamp,
  fileStamp,
  fileStampIsFresh,
  parserSignatureOf,
  readStamped,
  scanCached,
} from "./scan-cache.ts";
import { type Dialect, resolveSyntaxOf } from "./syntax-table.ts";
import { createTargetLookup, type TargetLookup } from "./target-descriptor.ts";

/** @unstable What `Dialect.tagFile` is given: one tag file. */
export interface TagFileInput {
  /** The tag file's absolute path. */
  readonly path: string;
  /** The file's text, as core read it. */
  readonly source: string;
  /** The tag's name: the file name less its longest claimed extension. */
  readonly name: string;
}

/** @unstable What `Dialect.tagFile` may call while it derives a contract. */
export interface TagFileContext {
  /**
   * Lowers this tag file with `lowerSource`, under the file's own dialect
   * and its own scanned tag map (nearest wins from the tag file's
   * directory). Memoized per options. Contracts in that map are lazy, so
   * lowering derives only those of the tags the file calls, and each one it
   * reads becomes a dependency of this tag file. `customTags`, when given,
   * are merged over the scanned map (they win on a shared name).
   */
  lower(
    options?: Pick<
      LowerSourceOptions,
      "structural" | "imports" | "unknownTags" | "defaultTag" | "customTags"
    >,
  ): LowerSourceResult;
  /**
   * Records a file the contract depends on, for invalidation: an edit to it
   * derives the contract again. A relative path is from the tag file's
   * directory. A read of another tag file through a call needs no record.
   */
  dependsOn(path: string): void;
}

/** @unstable What `Dialect.tagFile` returns. */
export interface TagFileResult {
  /**
   * The tag's contract: `attributes`, `attributeTags`, `children`,
   * `parents`, `defaultTag`, and keys the dialect claims
   * (`contractFields.tag`). `parseOptions` and `template` are refused: a
   * call's parse needs its options before any contract is read (a `.tag.ts`
   * sidecar declares them), and a data file never calls a template tag.
   * Hooks come from a paired `.tag.ts` sidecar.
   */
  readonly contract?: Omit<CustomTag, "parseOptions" | "template">;
  readonly diagnostics?: readonly TagFileDiagnostic[];
}

/** @unstable One diagnostic of a tag file, in the tag file's coordinates. */
export interface TagFileDiagnostic {
  readonly severity: "error" | "warning";
  readonly message: string;
  /** 1-based. */
  readonly line: number;
  /** 0-based. */
  readonly column: number;
  readonly endLine?: number;
  readonly endColumn?: number;
  /** `MX_`-style upper snake case, when the diagnostic has one. */
  readonly code?: string;
  /**
   * The file `line`/`column` are in, when it is not the tag file: a
   * diagnostic forwarded from `ctx.lower` that names another file keeps it.
   * Core sets the tag file's path on every other one.
   */
  readonly file?: string;
}

/** The keys core reads of a tag file's contract (besides claimed ones). */
const CONTRACT_KEYS = [
  "attributes",
  "attributeTags",
  "children",
  "parents",
  "defaultTag",
] as const;

/** A contract's hooks: a paired sidecar's to supply. */
const HOOK_KEYS = ["analyze", "transform", "finalize"] as const;

/** One derived contract, as cached per tag file. */
interface Derivation {
  readonly path: string;
  /** The dialect module revision: a reload is a new object. */
  readonly dialect: Dialect;
  /** `undefined` for a dialect with no hook: only its revision matters. */
  readonly stamp?: FileStamp;
  /** The tag file's own scan, parser-facing (`parserSignatureOf`). */
  readonly signature?: string;
  /** Every file the contract depends on, each as it was read, transitively. */
  readonly dependencies: ReadonlyMap<string, FileStamp>;
  readonly read: DeferredRead;
}

/** The cached derivation of each tag file, by path. */
const derivations = new Map<string, Derivation>();

/** A derivation in progress: its file, and the dependencies it has read. */
interface Frame {
  readonly path: string;
  readonly dependencies: Map<string, FileStamp>;
  /** A call re-entered this frame or one above it: nothing here is cached. */
  onCycle: boolean;
}

/** Derivations in progress, outermost first (module-global, as the cache). */
const stack: Frame[] = [];

/** The answer to a check reading a tag file whose derivation is in progress. */
const INCOMPLETE: DeferredRead = Object.freeze({ incomplete: true as const });

/** For tests: drops every derived contract. */
export function clearTagFileCache(): void {
  derivations.clear();
}

/** For tests: how many times each tag file's hook ran, by path. */
export const tagFileDerivations = { count: new Map<string, number>() };

/** The parser signature of a scan, computed once per scan result. */
const signatures = new WeakMap<ScanResult, string>();

/**
 * The lookup a tag file's own scan runs under. A tag file has no host: it
 * declares one tag, and the scan's tag set does not depend on the lookup
 * (`ScanOptions.targets`), so this one hostless entry gives the map the
 * caller's own scan would.
 */
let ownLookup: TargetLookup | undefined;

function ownScan(path: string): { scan: ScanResult; signature: string } {
  ownLookup ??= createTargetLookup([
    {
      descriptorVersion: 0,
      name: "tag-file",
      packageName: "@mxlang/core",
      defaultTag: "object",
    },
  ]);
  const scan = scanCached(path, { host: null, targets: ownLookup });
  let signature = signatures.get(scan);
  if (signature === undefined) {
    signature = parserSignatureOf(scan);
    signatures.set(scan, signature);
  }
  return { scan, signature };
}

/** `path` as a message shows it: from the tag directory's parent. */
function shownPath(tag: DiscoveredTag, path: string): string {
  const base = dirname(tag.sourceDir ?? dirname(tag.tagFile as string));
  return relative(base, path).split("\\").join("/");
}

/** Whether a cached derivation still describes the filesystem and the dialect. */
function isCurrent(derivation: Derivation): boolean {
  let dialect: Dialect | undefined;
  try {
    dialect = resolveSyntaxOf(derivation.path).dialect;
  } catch {
    return false;
  }
  if (dialect !== derivation.dialect) return false;
  if (derivation.stamp === undefined) return true;
  if (!fileStampIsFresh(derivation.path, derivation.stamp)) return false;
  try {
    if (ownScan(derivation.path).signature !== derivation.signature) {
      return false;
    }
  } catch {
    return false;
  }
  for (const [path, stamp] of derivation.dependencies) {
    if (!fileStampIsFresh(path, stamp)) return false;
  }
  return true;
}

/** Records `derivation` (its file and its dependencies) in the frame reading it. */
function recordDependency(derivation: Derivation): void {
  const frame = stack.at(-1);
  if (!frame || derivation.stamp === undefined) return;
  frame.dependencies.set(derivation.path, derivation.stamp);
  for (const [path, stamp] of derivation.dependencies) {
    frame.dependencies.set(path, stamp);
  }
}

/**
 * The reader of one discovered tag file's contract (one per scanned entry).
 * It keeps the derivation it answered with, so a read is a lookup; `stale`
 * checks that derivation against the filesystem, once per registration.
 */
function tagFileReader(tag: DiscoveredTag): DeferredReader {
  const path = tag.tagFile as string;
  let answered: Derivation | undefined;
  let cached = false;
  return {
    definedIn: path,
    read(call) {
      const at = stack.findIndex((frame) => frame.path === path);
      if (at >= 0) {
        // A check reading a contract being derived answers "not yet"; a
        // call of it is a cycle.
        if (!call) return INCOMPLETE;
        for (const frame of stack.slice(at)) frame.onCycle = true;
        return { error: cycleError(tag, at), uncached: true };
      }
      if (!answered || (cached && derivations.get(path) !== answered)) {
        const derived = derive(tag);
        answered = derived.derivation;
        cached = derived.cached;
      }
      recordDependency(answered);
      return answered.read;
    },
    stale() {
      if (!answered) return false;
      if (cached && derivations.get(path) === answered && isCurrent(answered)) {
        return false;
      }
      answered = undefined;
      return true;
    },
  };
}

function cycleError(tag: DiscoveredTag, at: number): TranslateError {
  const path = tag.tagFile as string;
  const chain = [...stack.slice(at).map((frame) => frame.path), path]
    .map((each) => shownPath(tag, each))
    .join(" → ");
  const error = new TranslateError(
    `tag files call each other in a cycle: ${chain}`,
    0,
    0,
  );
  error.diagnosticCode = "MX_TAG_FILE_CYCLE";
  return error;
}

/**
 * The derivation of `tag`'s contract: the cached one when it is current,
 * else the hook's answer, cached unless a cycle ran through it.
 */
function derive(tag: DiscoveredTag): {
  derivation: Derivation;
  cached: boolean;
} {
  const path = tag.tagFile as string;
  const uncached = (
    error: unknown,
  ): { derivation: Derivation; cached: false } => ({
    derivation: {
      path,
      dialect: undefined as unknown as Dialect,
      dependencies: new Map(),
      read: { error, uncached: true },
    },
    cached: false,
  });
  let dialect: Dialect | undefined;
  try {
    dialect = resolveSyntaxOf(path).dialect;
  } catch (error) {
    return uncached(error);
  }
  if (!dialect) return uncached(tagFileError(tag));
  const known = derivations.get(path);
  if (known && isCurrent(known)) return { derivation: known, cached: true };
  if (!dialect.tagFile) {
    const derivation: Derivation = {
      path,
      dialect,
      dependencies: new Map(),
      read: { error: tagFileError(tag) },
    };
    derivations.set(path, derivation);
    return { derivation, cached: true };
  }
  let own: ReturnType<typeof ownScan>;
  let read: ReturnType<typeof readStamped>;
  try {
    own = ownScan(path);
    read = readStamped(path);
  } catch (error) {
    return uncached(error);
  }
  const stamp = read.stamp;
  const frame: Frame = { path, dependencies: new Map(), onCycle: false };
  const answer = runHook(tag, dialect, read.text, own.scan, frame);
  const derivation: Derivation = {
    path,
    dialect,
    stamp,
    signature: own.signature,
    dependencies: frame.dependencies,
    read: frame.onCycle ? { ...answer, uncached: true } : answer,
  };
  if (frame.onCycle) {
    derivations.delete(path);
    return { derivation, cached: false };
  }
  derivations.set(path, derivation);
  return { derivation, cached: true };
}

/** Runs the dialect's hook on the tag file, in its frame, and reads its answer. */
function runHook(
  tag: DiscoveredTag,
  dialect: Dialect,
  source: string,
  scan: ScanResult,
  frame: Frame,
): DeferredRead {
  const path = tag.tagFile as string;
  const lowered = new Map<string, LowerSourceResult>();
  const mergedIds = new WeakMap<object, number>();
  let nextId = 0;
  const ctx: TagFileContext = {
    lower(options = {}) {
      const custom = options.customTags;
      let id = 0;
      if (custom) {
        id = mergedIds.get(custom) ?? ++nextId;
        mergedIds.set(custom, id);
      }
      const key = JSON.stringify([
        options.structural,
        options.imports,
        options.unknownTags,
        options.defaultTag,
        id,
      ]);
      const known = lowered.get(key);
      if (known) return known;
      const result = lowerSource(source, path, {
        customTags: custom
          ? { ...scan.customTags, ...custom }
          : scan.customTags,
        ...(options.structural !== undefined
          ? { structural: options.structural }
          : {}),
        ...(options.imports !== undefined ? { imports: options.imports } : {}),
        ...(options.unknownTags !== undefined
          ? { unknownTags: options.unknownTags }
          : {}),
        ...(options.defaultTag !== undefined
          ? { defaultTag: options.defaultTag }
          : {}),
      });
      lowered.set(key, result);
      return result;
    },
    dependsOn(file) {
      const absolute = resolve(dirname(path), file);
      frame.dependencies.set(absolute, fileStamp(absolute));
    },
  };
  tagFileDerivations.count.set(
    path,
    (tagFileDerivations.count.get(path) ?? 0) + 1,
  );
  let result: unknown;
  let thrown: { error: unknown } | undefined;
  stack.push(frame);
  try {
    // biome-ignore lint/style/noNonNullAssertion: `derive` checked the hook
    result = dialect.tagFile!({ path, source, name: tag.name }, ctx);
  } catch (error) {
    thrown = { error };
  } finally {
    stack.pop();
  }
  return answerOf(tag, dialect, result, thrown);
}

/** The hook's answer, as a read: its contract, or the error a call raises. */
function answerOf(
  tag: DiscoveredTag,
  dialect: Dialect,
  result: unknown,
  thrown: { error: unknown } | undefined,
): DeferredRead {
  const path = tag.tagFile as string;
  const errors: TranslateError[] = [];
  const warnings: MxWarning[] = [];
  const at = (message: string, code = "MX_TAG_FILE_ERROR") => {
    const error = new TranslateError(message, 1, 0, path);
    error.diagnosticCode = code;
    errors.push(error);
  };
  let contract: Record<string, unknown> | undefined;
  if (thrown) {
    errors.push(thrownError(thrown.error, path));
  } else if (!result || typeof result !== "object" || Array.isArray(result)) {
    at(
      `the dialect's \`tagFile\` hook returned ${describe(result)}, not \`{ contract, diagnostics }\``,
    );
  } else {
    const answer = result as TagFileResult;
    for (const diagnostic of answer.diagnostics ?? []) {
      const read = diagnosticOf(diagnostic, path);
      if (read.severity === "warning") warnings.push(read.warning);
      else errors.push(read.error);
    }
    const value: unknown = answer.contract;
    if (value !== undefined) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        at(
          `the dialect's \`tagFile\` hook returned a contract that is ${describe(value)}, not an object`,
        );
      } else {
        contract = { ...(value as Record<string, unknown>) };
        refuseKeys(contract, dialect, at);
      }
    } else if (!errors.length) {
      at("the dialect's `tagFile` hook returned no contract");
    }
  }
  const warned = warnings.length > 0 ? { warnings } : {};
  if (errors.length > 0 || !contract) {
    return { error: definitionError(tag, errors), ...warned };
  }
  return { contract: contract as CustomTag, ...warned };
}

/** Refuses a key a tag file's contract cannot carry, each as its own error. */
function refuseKeys(
  contract: Record<string, unknown>,
  dialect: Dialect,
  at: (message: string) => void,
): void {
  const claimed = claimedFields(dialect).tag;
  for (const key of Object.keys(contract)) {
    if (
      (CONTRACT_KEYS as readonly string[]).includes(key) ||
      claimed.has(key)
    ) {
      continue;
    }
    if (key === "parseOptions") {
      at(
        "a tag file's contract cannot set `parseOptions`: a call is parsed before any contract is read, so they come from a `.tag.ts` sidecar beside the tag file",
      );
    } else if (key === "template") {
      at(
        "a tag file's contract cannot set `template`: a tag file defines a contract, and a data file never calls a template tag",
      );
    } else if ((HOOK_KEYS as readonly string[]).includes(key)) {
      at(
        `a tag file's contract cannot set \`${key}\`: hooks come from a \`.tag.ts\` sidecar beside the tag file`,
      );
    } else {
      at(
        `\`${key}\` is not a contract key: a tag file's contract holds ${CONTRACT_KEYS.join(", ")}, or a key the dialect claims (\`contractFields.tag\`)`,
      );
    }
    delete contract[key];
  }
}

/** A hook's throw as an error: its own position when it has one, else 1:0. */
function thrownError(error: unknown, path: string): TranslateError {
  if (isTranslateError(error) && error.line >= 1) {
    const placed = new TranslateError(
      error.message,
      error.line,
      error.column,
      error.file ?? path,
    );
    placed.diagnosticCode = error.diagnosticCode ?? "MX_TAG_FILE_ERROR";
    return placed;
  }
  const placed = new TranslateError(
    `the dialect's \`tagFile\` hook threw: ${error instanceof Error ? error.message : String(error)}`,
    1,
    0,
    path,
  );
  placed.diagnosticCode =
    (isTranslateError(error) ? error.diagnosticCode : undefined) ??
    "MX_TAG_FILE_ERROR";
  return placed;
}

/** One of the hook's diagnostics, with its file set and a 1-based line. */
function diagnosticOf(
  diagnostic: TagFileDiagnostic,
  path: string,
):
  | { severity: "warning"; warning: MxWarning }
  | { severity: "error"; error: TranslateError } {
  const valid =
    diagnostic &&
    typeof diagnostic === "object" &&
    typeof diagnostic.message === "string";
  const message = valid
    ? diagnostic.message
    : `the dialect's \`tagFile\` hook returned a diagnostic that is ${describe(diagnostic)}`;
  const line =
    valid && Number.isInteger(diagnostic.line) && diagnostic.line >= 1
      ? diagnostic.line
      : 1;
  const column =
    valid && Number.isInteger(diagnostic.column) && diagnostic.column >= 0
      ? diagnostic.column
      : 0;
  const file =
    valid && typeof diagnostic.file === "string" ? diagnostic.file : path;
  const code =
    valid && typeof diagnostic.code === "string" ? diagnostic.code : undefined;
  if (valid && diagnostic.severity === "warning") {
    return {
      severity: "warning",
      warning: { message, line, column, file, ...(code ? { code } : {}) },
    };
  }
  const error = new TranslateError(message, line, column, file);
  if (code) error.diagnosticCode = code;
  return { severity: "error", error };
}

/**
 * The error every call of a tag whose definition failed raises: unpositioned
 * (the call places it), naming where the first error is, with the tag
 * file's own errors attached.
 */
function definitionError(
  tag: DiscoveredTag,
  errors: readonly TranslateError[],
): TranslateError {
  const path = tag.tagFile as string;
  const first = errors.find((error) => error.file === path) ?? errors[0];
  const where = first
    ? `${shownPath(tag, first.file ?? path)}:${first.line}:${first.column + 1}`
    : shownPath(tag, path);
  const error = new TranslateError(
    `\`<${tag.name}>\`'s definition has errors (${where})`,
    0,
    0,
  );
  error.diagnosticCode = "MX_TAG_FILE_ERROR";
  attachRelatedErrors(error, errors);
  return error;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

registerTagFileReader(tagFileReader);
