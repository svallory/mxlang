/**
 * What building a file calls. A tool that builds a file (a bundler plugin, a
 * loader) routes it to its dialect and asks that dialect for its emit; the
 * emit is what the tool runs. Core is dialect zero: its emit builds MX's own
 * files (`.mx` and `.<host>.mx`) under the target the tool resolved for the
 * file. A dialect with no emit answers `undefined`, and the tool refuses the
 * file; no tool picks a target for a dialect's files.
 *
 * The emits are a table in this module and nothing outside it can add to it.
 */
import { isTranslateError } from "./core.ts";
import {
  type DialectManifest,
  type RouteDialectOptions,
  routeDialect,
} from "./dialect-discovery.ts";
import { CORE_DIALECT, MX_DIALECT } from "./dialect-registry.ts";
import type {
  TargetCompileOptions,
  TargetCompileResult,
  TargetLookup,
} from "./target-descriptor.ts";

/**
 * What the tool hands core's emit besides the source: the target the file's
 * project resolved for it, the lookup that target belongs to, and the
 * whole-file compile options. @unstable
 */
export interface EmitRequest extends Omit<TargetCompileOptions, "targets"> {
  /** The target to build under, as named in `targets`. */
  readonly target: string;
  /** The target set `target` is looked up in. */
  readonly targets: TargetLookup;
  /**
   * The tool's `@mxlang/core` (`import * as core from "@mxlang/core"`), which
   * the target's `load` gets: a target that uses core shares the tool's
   * registry, caches and `TranslateError` class.
   */
  readonly core: typeof import("./index.ts");
  /**
   * The tool's sentence for a target that cannot build whole files. `identity`
   * names it (`<host name> host`, `<target name> target`) and `pending` is the target's
   * own reason, when it states one. The emit throws an `Error` with this
   * text.
   */
  unwired(identity: string, pending: string | undefined): string;
}

/**
 * A dialect's emit: builds one file's source to a module. Throws a
 * positioned `TranslateError` on a source error. @unstable
 */
export type DialectEmit = (
  source: string,
  filename: string,
  request: EmitRequest,
) => TargetCompileResult;

/** The answer of {@link emitFor}. @unstable */
export interface FileEmit {
  /** The dialect that handles the file: `mx` (MX's own) or a routed dialect's. */
  readonly dialect: { readonly id: string; readonly name: string };
  /** The dialect's emit, or `undefined` when it registers none. */
  readonly emit: DialectEmit | undefined;
}

/** MX's emit: the target-driven whole-file compile. */
const coreEmit: DialectEmit = (source, filename, request) => {
  const { target, targets, core, unwired, ...options } = request;
  const descriptor = targets.target(target);
  const load = descriptor?.load;
  if (!load) {
    const identity = descriptor?.host
      ? `${descriptor.host.name} host`
      : `${target} target`;
    throw new Error(unwired(identity, descriptor?.pending));
  }
  return load(core).compileModule(source, filename, { ...options, targets });
};

/** The emits, by dialect id. No dialect can take `mx`'s id, so only core is here. */
const EMITS: ReadonlyMap<string, DialectEmit> = new Map([
  [CORE_DIALECT, coreEmit],
]);

/**
 * Asks the dialect of `filename` for its emit: `routeDialect` names the
 * dialect (MX's own for a file no dialect claims), and the answer carries
 * its emit, `undefined` when it registers none.
 *
 * A routing error (two dialects claim the extension, a manifest claims one
 * MX owns) is thrown for a file that does not end in `.mx`, since no dialect
 * can be named. For a file that ends in `.mx` the answer is MX's emit, whose
 * compile reports the same routing error where the file is built.
 * @unstable
 */
export function emitFor(
  filename: string,
  options: RouteDialectOptions = {},
): FileEmit {
  let dialect: DialectManifest | undefined;
  try {
    dialect = routeDialect(filename, options);
  } catch (error) {
    if (!filename.endsWith(".mx") || !isTranslateError(error)) throw error;
  }
  const identity = dialect ?? MX_DIALECT;
  return { dialect: identity, emit: EMITS.get(identity.id) };
}
