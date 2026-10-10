/**
 * MX's configuration: one loader for the whole project, through cosmiconfig
 * with the module name `mx`.
 *
 * Every MX setting (`target`, `host`, `strict`, `tags`, `contracts`,
 * `syntax`, a target's own key such as `html: { defaultTag }`, a dialect's
 * section under its id) is read through {@link findMxConfig}. One file
 * serves the whole project: MX looks only in the project directory, the
 * directory of the nearest `package.json` (where `package.json#mx` was always
 * read), never below it and never above it, so every file of a project and
 * every tool sees the same config. The places, in cosmiconfig's order:
 * `package.json#mx`, `.mxrc` (YAML or JSON),
 * `.mxrc.{json,yaml,yml,js,ts,cjs,mjs}`, the same names under `.config/`
 * (`.config/mxrc*`), then `mx.config.{js,ts,cjs,mjs}`, plus
 * `mx.config.{mts,cts,json,yaml,yml}`. The first place that holds a config
 * wins, and the others are reported as `shadowed`; there is no merging.
 * Without a `package.json` there is no project and no config. A config file
 * is optional: with none, `findMxConfig` answers `undefined` and MX's
 * defaults apply. cosmiconfig loads the file; its meta config
 * (`.config/config.*`) has no effect on where MX looks, and a file pulled in
 * through `$import` is not watched.
 *
 * **Sync.** Every reader in MX is synchronous (the TypeScript plugin, the
 * language server, the scan, the syntax table), so this uses
 * `cosmiconfigSync`. JSON, YAML and `package.json` are parsed here. A JS or
 * TS config is loaded with `require`, which loads ES modules and strips
 * TypeScript types on the runtimes MX supports (Node 22.18+, Bun). A module
 * that cannot be loaded that way (top-level `await`, a `.ts` file on an older
 * Node) is a positioned error at the config file, never a silently ignored
 * config.
 *
 * **Long-lived readers.** Each file's parse is kept while its text is
 * unchanged, so an edit is picked up on the next call without a restart. A
 * revision that does not parse keeps the previous good config in force and
 * carries the failure, positioned in the file, on `error`. Node cannot
 * re-evaluate an ES module loaded through `require` in the same process (Bun
 * can): an edit to such a config keeps the previous config and reports that
 * the process must restart to apply it.
 *
 * **Passed in.** A tool or a dialect that builds MX's config itself hands it
 * over with {@link provideMxConfig}; files under that root then never search
 * the disk.
 *
 * `package.json` reads go through `package-json.ts`, so a broken
 * `package.json` is one parse shared with the scan and the target policy.
 */

import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type { LoaderSync } from "cosmiconfig";
import {
  positionOfOffset,
  positionOfParseError,
  readPackageJsonCached,
} from "./package-json.ts";
import { RESERVED_CONFIG_KEYS } from "./target-descriptor.ts";

/** cosmiconfig's module name for MX: `mx.config.ts`, `.mxrc`, `package.json#mx`. */
export const MX_CONFIG_MODULE = "mx";

/**
 * Where MX looks for its config in one directory, first wins: cosmiconfig's
 * own places for the module name `mx` (including `.mjs`), then the
 * `mx.config.*` spellings cosmiconfig leaves out.
 */
export const MX_CONFIG_SEARCH_PLACES: readonly string[] = [
  // cosmiconfig 10.0.1's `getDefaultSearchPlaces("mx")`, spelled out so the
  // module list needs no cosmiconfig at import time (`mx-config.test.ts`
  // pins the equality); the five `mx.config.*` spellings cosmiconfig leaves
  // out follow.
  "package.json",
  ".mxrc",
  ".mxrc.json",
  ".mxrc.yaml",
  ".mxrc.yml",
  ".mxrc.js",
  ".mxrc.ts",
  ".mxrc.cjs",
  ".mxrc.mjs",
  ".config/mxrc",
  ".config/mxrc.json",
  ".config/mxrc.yaml",
  ".config/mxrc.yml",
  ".config/mxrc.js",
  ".config/mxrc.ts",
  ".config/mxrc.cjs",
  ".config/mxrc.mjs",
  "mx.config.js",
  "mx.config.ts",
  "mx.config.cjs",
  "mx.config.mjs",
  "mx.config.mts",
  "mx.config.cts",
  "mx.config.json",
  "mx.config.yaml",
  "mx.config.yml",
];

/**
 * The top-level keys MX itself reads. Any other top-level key is a dialect's
 * section (its id) or a target's own key (`html: { defaultTag }`), handed to
 * callers uninterpreted.
 */
export const MX_CONFIG_KEYS: readonly string[] = [
  "target",
  "host",
  "strict",
  "tags",
  "contracts",
  "syntax",
  "data",
  "extensions",
];

/**
 * `config` without the reserved keys ({@link RESERVED_CONFIG_KEYS}): today
 * `mx.dialect`, a dialect package's identity block (id, name, extensions,
 * module), which dialect discovery reads from the dialect's own
 * `package.json`. It is never project config, so it is neither a setting, a
 * dialect section nor an unknown key, in any format.
 */
function withoutReservedKeys(
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (!RESERVED_CONFIG_KEYS.some((key) => Object.hasOwn(config, key)))
    return config;
  return Object.fromEntries(
    Object.entries(config).filter(
      ([key]) => !RESERVED_CONFIG_KEYS.includes(key),
    ),
  );
}

/**
 * A manifest as the search sees it: `mx` without its reserved keys, and no
 * `mx` at all when they were all it held, so a dialect package's own
 * `mx.dialect` does not hide an `mx.config.*` beside it.
 */
function manifestForSearch(manifest: unknown): unknown {
  if (!isObject(manifest) || !isObject(manifest.mx)) return manifest;
  const mx = withoutReservedKeys(manifest.mx);
  if (mx === manifest.mx) return manifest;
  const { mx: _mx, ...rest } = manifest;
  return Object.keys(mx).length > 0 ? { ...rest, mx } : rest;
}

/** Why a config revision could not be loaded, positioned in its file. */
export interface MxConfigError {
  message: string;
  /** 1-based. */
  line: number;
  /** 0-based. */
  column: number;
}

/** A value's place in the config file (1-based line, 0-based column, UTF-16 length). */
export interface MxConfigLocation {
  line: number;
  column: number;
  length: number;
}

/** How the config was written, which decides how positions are found. */
export type MxConfigFormat =
  | "package.json"
  | "json"
  | "yaml"
  | "module"
  | "provided";

/** The config that applies to a directory, and where it came from. */
export interface MxConfigSource {
  /** The file the config came from (or the label it was provided under). */
  file: string;
  /**
   * The directory relative paths in the config resolve from: the directory
   * whose search place held the config (the config file's own directory, or
   * the parent of a `.config/` directory), or the root a config was provided
   * for.
   */
  dir: string;
  format: MxConfigFormat;
  /**
   * The config object (`package.json#mx`, or the file's value). When `error`
   * is set: the last good revision's config, or `undefined` if the file never
   * loaded.
   */
  config: Record<string, unknown> | undefined;
  /** This revision's text (`""` for a module or a provided config). Positions index into it. */
  text: string;
  /** This revision could not be loaded; `config` is the previous good one, if any. */
  error?: MxConfigError;
  /**
   * The dialect fact a user may set for MX (`extensions: { ".mesh": "mesh" }`),
   * when it is an object. Not interpreted here.
   */
  extensions?: Record<string, unknown>;
  /**
   * Every top-level key MX does not read itself (see {@link MX_CONFIG_KEYS}):
   * a dialect's section under its id, or a target's own key. Not interpreted
   * here.
   */
  sections: Record<string, unknown>;
  /**
   * Config files in the project directory that the one in force hides: one
   * file serves the project, and the first place wins. Tools warn at each.
   */
  shadowed: readonly string[];
  /**
   * Every file whose creation, removal or edit could change this answer: the
   * file the config came from and every search place ahead of it. A cache
   * keyed on these stamps notices a new `mx.config.ts` the moment it appears.
   */
  watch: readonly string[];
  /**
   * Where the value at `path` (or, with `key: true`, its key) is written:
   * exact for JSON and `package.json`, best-effort for YAML, `1:0` for a
   * module or a provided config, and `1:0` when the path is not found.
   */
  locate(
    path: readonly string[],
    options?: { key?: boolean },
  ): MxConfigLocation;
}

const START: MxConfigLocation = { line: 1, column: 0, length: 1 };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Positions

const JSON_TOKENS =
  /"(?:\\.|[^"\\])*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g;

/**
 * Where the value at `path` (or its key) sits in a JSON text, or `undefined`.
 * Tokenizes rather than parses, so it still answers for the parts of a
 * revision that came before a syntax error. A duplicated key answers with its
 * last occurrence, the one `JSON.parse` keeps.
 */
export function locateJsonPath(
  text: string,
  path: readonly string[],
  options: { key?: boolean } = {},
): MxConfigLocation | undefined {
  const tokens = [...text.matchAll(JSON_TOKENS)];
  let cursor = 0;
  let found: MxConfigLocation | undefined;
  const matches = (at: string[]): boolean =>
    at.length === path.length && path.every((k, i) => at[i] === k);
  const value = (at: string[]): void => {
    const start = tokens[cursor];
    if (!start) return;
    cursor++;
    if (start[0] === "{") {
      while (tokens[cursor] && tokens[cursor]?.[0] !== "}") {
        const keyToken = tokens[cursor++];
        let name: string;
        try {
          name = JSON.parse(keyToken?.[0] ?? '""') as string;
        } catch {
          // Positioning is best-effort if the token stream is incomplete.
          return;
        }
        if (options.key && keyToken && matches([...at, name])) {
          found = {
            ...positionOfOffset(text, keyToken.index),
            length: keyToken[0].length,
          };
        }
        cursor++; // colon
        value([...at, name]);
        if (tokens[cursor]?.[0] === ",") cursor++;
      }
      cursor++;
    } else if (start[0] === "[") {
      while (tokens[cursor] && tokens[cursor]?.[0] !== "]") {
        value([...at, "[]"]);
        if (tokens[cursor]?.[0] === ",") cursor++;
      }
      cursor++;
    }
    if (!options.key && matches(at)) {
      const end = tokens[cursor - 1];
      found = {
        ...positionOfOffset(text, start.index),
        length:
          (end?.index ?? start.index) + (end?.[0].length ?? 0) - start.index,
      };
    }
  };
  value([]);
  return found;
}

/**
 * Best-effort position of `path` in a block-style YAML text: each segment is
 * a `key:` line indented deeper than its parent's. Flow mappings and anchors
 * are not followed; an unfound path answers `undefined`.
 */
export function locateYamlPath(
  text: string,
  path: readonly string[],
  options: { key?: boolean } = {},
): MxConfigLocation | undefined {
  const lines = text.split("\n");
  let indent = -1;
  let from = 0;
  let hit:
    | { line: number; column: number; key: string; rest: string }
    | undefined;
  for (const segment of path) {
    hit = undefined;
    for (let i = from; i < lines.length; i++) {
      const line = lines[i] as string;
      const match = /^(\s*)(["']?)([^"':#][^:#]*?)\2\s*:(\s*)(.*)$/.exec(line);
      if (!match) continue;
      const lineIndent = (match[1] as string).length;
      if (lineIndent <= indent && line.trim() !== "") {
        if (lineIndent < indent || i > from) break;
      }
      if (lineIndent <= indent) continue;
      if (match[3] !== segment) continue;
      hit = {
        line: i,
        column: lineIndent,
        key: `${match[2]}${match[3]}${match[2]}`,
        rest: (match[5] as string).replace(/\s+#.*$/, ""),
      };
      indent = lineIndent;
      from = i + 1;
      break;
    }
    if (!hit) return undefined;
  }
  if (!hit) return undefined;
  if (options.key || hit.rest === "") {
    return { line: hit.line + 1, column: hit.column, length: hit.key.length };
  }
  const lineText = lines[hit.line] as string;
  const column = lineText.indexOf(hit.rest, hit.column + hit.key.length);
  return { line: hit.line + 1, column, length: hit.rest.length };
}

// ---------------------------------------------------------------------------
// Loading

interface Loaded {
  text: string;
  /** This revision's value, or the last good one when `error` is set. */
  value: unknown;
  /** The last revision that loaded. */
  good: unknown;
  /** That revision's text. */
  goodText?: string;
  hasGood: boolean;
  error?: MxConfigError;
  /** For a module: the object `require` returned, to tell a reload from a cache hit. */
  module?: unknown;
}

/** Each config file's last load, by path. */
const loads = new Map<string, Loaded>();

/** What a loader returns for a file that never loaded: a config with no keys. */
const NEVER_LOADED = Object.freeze({});

function record(
  filepath: string,
  text: string,
  outcome: { value: unknown; module?: unknown } | { error: MxConfigError },
): unknown {
  const previous = loads.get(filepath);
  if ("error" in outcome) {
    loads.set(filepath, {
      text,
      value: previous?.hasGood ? previous.good : NEVER_LOADED,
      good: previous?.good,
      ...(previous?.goodText !== undefined
        ? { goodText: previous.goodText }
        : {}),
      hasGood: previous?.hasGood ?? false,
      error: outcome.error,
      module: previous?.module,
    });
    return previous?.hasGood ? previous.good : NEVER_LOADED;
  }
  loads.set(filepath, {
    text,
    value: outcome.value,
    good: outcome.value,
    goodText: text,
    hasGood: true,
    module: outcome.module,
  });
  return outcome.value;
}

/** What a config value is, for the message that refuses a non-object. */
function kindOf(value: unknown): string {
  if (typeof value === "function") {
    return value.constructor?.name === "AsyncFunction"
      ? "an async function"
      : "a function";
  }
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  ) {
    return "a Promise";
  }
  if (Array.isArray(value)) return "an array";
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return `a ${typeof value}`;
}

/**
 * Why `value` cannot be a config, or `undefined` when it is an object. A
 * function or a Promise is refused, not called or awaited: MX reads its config
 * synchronously, so the export must be the object itself.
 */
function shapeProblem(value: unknown): string | undefined {
  const kind = kindOf(value);
  if (isObject(value) && kind !== "a Promise") return undefined;
  const reason = `the config must be an object, and it is ${kind}`;
  return kind === "a function" ||
    kind === "an async function" ||
    kind === "a Promise"
    ? `${reason}; MX reads its config synchronously, so export the object itself`
    : reason;
}

/** Where a JSON or YAML document's value starts (its first non-blank character). */
function documentStart(text: string): { line: number; column: number } {
  const offset = text.search(/\S/);
  return positionOfOffset(text, offset < 0 ? 0 : offset);
}

/** A loader that reuses the last load while the text is unchanged. */
function cached(
  load: (filepath: string, content: string) => unknown,
): LoaderSync {
  return (filepath, content) => {
    const previous = loads.get(filepath);
    if (previous && previous.text === content) return previous.value;
    return load(filepath, content);
  };
}

const loadJson = cached((filepath, content) => {
  try {
    const value: unknown = JSON.parse(content);
    const problem = shapeProblem(value);
    if (problem) {
      return record(filepath, content, {
        error: { message: problem, ...documentStart(content) },
      });
    }
    return record(filepath, content, { value });
  } catch (cause) {
    const message = (cause as Error).message;
    return record(filepath, content, {
      error: { message, ...positionOfParseError(message, content) },
    });
  }
});

const loadYaml = cached((filepath, content) => {
  try {
    const value: unknown = (
      cosmiconfigModule().defaultLoadersSync[".yaml"] as LoaderSync
    )(filepath, content);
    const problem = shapeProblem(value);
    if (problem) {
      return record(filepath, content, {
        error: { message: problem, ...documentStart(content) },
      });
    }
    return record(filepath, content, { value });
  } catch (cause) {
    const error = cause as Error & { mark?: { line: number; column: number } };
    // js-yaml's first line is the reason; the rest is a code frame, and the
    // position is carried apart.
    const message = (
      error.message.replace(/^YAML Error in [^\n]*\n/, "").split("\n")[0] ?? ""
    ).replace(/ \(\d+:\d+\)$/, "");
    return record(filepath, content, {
      error: {
        message,
        line: (error.mark?.line ?? 0) + 1,
        column: error.mark?.column ?? 0,
      },
    });
  }
});

/**
 * `package.json`: the shared, stat-stamped read in `package-json.ts`, so the
 * scan and the target policy see the same revision and the same error. A
 * broken one that never parsed holds no `mx` key, so the search goes on to
 * the other places in its directory.
 */
const loadPackageJson: LoaderSync = (filepath) => {
  const read = readPackageJsonCached(filepath);
  if (!read) return NEVER_LOADED;
  const previous = loads.get(filepath);
  if (previous && previous.text === read.text) return previous.value;
  const manifest = manifestForSearch(read.manifest);
  loads.set(filepath, {
    text: read.text,
    value: manifest ?? NEVER_LOADED,
    good: read.error ? undefined : manifest,
    hasGood: manifest !== undefined,
    ...(read.error ? { error: read.error } : {}),
  });
  return manifest ?? NEVER_LOADED;
};

/** The default export of a module, or the module itself for CommonJS. */
function defaultExport(module: unknown): unknown {
  if (
    isObject(module) &&
    "default" in module &&
    (module.__esModule === true ||
      Object.prototype.toString.call(module) === "[object Module]")
  ) {
    return module.default;
  }
  return module;
}

const MODULE_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"];

/**
 * The reason a module config could not be `require`d, restated for the
 * author: what to change, not the runtime's raw error. Exported for tests,
 * which cannot run every Node version.
 */
export function moduleLoadMessage(error: Error, filepath: string): string {
  const code = (error as Error & { code?: string }).code;
  const raw = error.message.split("\n")[0] as string;
  if (code === "ERR_REQUIRE_ASYNC_MODULE") {
    return "it uses top-level `await`, and MX reads its config synchronously; remove the top-level `await`, or write the config as JSON or YAML";
  }
  const typescript = /\.[mc]?ts$/.test(filepath);
  const esmSyntax =
    error instanceof SyntaxError &&
    /Unexpected token '(export|import)'|Cannot use import statement/.test(raw);
  if (code === "ERR_REQUIRE_ESM" || esmSyntax) {
    return `this runtime cannot load an ES module config synchronously (${raw}); MX needs Node 22.12 or later for an ES module config (22.18 or later for TypeScript), or Bun; otherwise write the config as JSON, YAML or CommonJS`;
  }
  if (
    typescript &&
    (code === "ERR_UNKNOWN_FILE_EXTENSION" || error instanceof SyntaxError)
  ) {
    return `this runtime cannot load a TypeScript config (${raw}); MX needs Node 22.18 or later, or Bun, for one; otherwise write the config as JSON, YAML or CommonJS`;
  }
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
    const missing = /Cannot find module '([^']+)'/.exec(raw)?.[1];
    if (missing && extname(missing) === "" && isAbsolute(missing)) {
      const withExtension = MODULE_EXTENSIONS.map((ext) => missing + ext).find(
        (candidate) => {
          try {
            return statSync(candidate).isFile();
          } catch {
            return false;
          }
        },
      );
      if (withExtension) {
        let shown = relative(dirname(filepath), withExtension);
        if (!shown.startsWith(".")) shown = `./${shown}`;
        return `${raw}; Node's ES module loader needs the file extension: ${shown}`;
      }
    }
  }
  return raw;
}

const loadModule = cached((filepath, content) => {
  const previous = loads.get(filepath);
  const require = createRequire(filepath);
  let module: unknown;
  try {
    const resolved = require.resolve(filepath);
    delete require.cache[resolved];
    module = require(resolved);
  } catch (cause) {
    const message = moduleLoadMessage(cause as Error, filepath);
    return record(filepath, content, {
      error: {
        message,
        line: 1,
        column: 0,
      },
    });
  }
  const value = defaultExport(module);
  const problem = shapeProblem(value);
  if (problem) {
    return record(filepath, content, {
      error: { message: problem, line: 1, column: 0 },
    });
  }
  if (
    previous?.module !== undefined &&
    typeof value === "object" &&
    value !== null &&
    value === defaultExport(previous.module)
  ) {
    // Back to the text that last loaded: that evaluation is the right one.
    if (previous.hasGood && previous.goodText === content) {
      return record(filepath, content, { value, module });
    }
    // Node keeps an ES module `require` loaded for the life of the process:
    // a fresh namespace object, but the same evaluated exports.
    return record(filepath, content, {
      error: {
        message:
          "this process cannot reload an ES module config after an edit; restart the tool to apply it (a JSON, YAML or CommonJS config reloads in place)",
        line: 1,
        column: 0,
      },
    });
  }
  return record(filepath, content, { value, module });
});

const LOADERS: Record<string, LoaderSync> = {
  ".json": loadJson,
  ".yaml": loadYaml,
  ".yml": loadYaml,
  noExt: loadYaml,
  ".js": loadModule,
  ".mjs": loadModule,
  ".cjs": loadModule,
  ".ts": loadModule,
  ".mts": loadModule,
  ".cts": loadModule,
};

/** The slice of cosmiconfig's entry core uses (CJS named exports). */
interface Cosmiconfig {
  cosmiconfigSync: (
    module: string,
    options: Record<string, unknown>,
  ) => {
    load: (filepath: string) => unknown;
  };
  defaultLoadersSync: Record<string, LoaderSync>;
}

let cosmiconfig: Cosmiconfig | undefined;

/**
 * cosmiconfig, loaded on first config read: importing core must not load it
 * (the cold-start work), and a process that never reads an MX config (every
 * `tagRules: "none"` consumer, a provided config) never pays for it.
 */
function cosmiconfigModule(): Cosmiconfig {
  cosmiconfig ??= createRequire(import.meta.url)("cosmiconfig") as Cosmiconfig;
  return cosmiconfig;
}

let explorer: ReturnType<Cosmiconfig["cosmiconfigSync"]> | undefined;

function getExplorer(): ReturnType<Cosmiconfig["cosmiconfigSync"]> {
  explorer ??= cosmiconfigModule().cosmiconfigSync(MX_CONFIG_MODULE, {
    searchPlaces: [...MX_CONFIG_SEARCH_PLACES],
    loaders: {
      ...LOADERS,
      // `package.json` takes `.json`'s loader in cosmiconfig; route it to the
      // shared read by name.
      ".json": (filepath: string, content: string) =>
        basename(filepath) === "package.json"
          ? loadPackageJson(filepath, content)
          : loadJson(filepath, content),
    },
    // MX picks the file itself (the project directory only) and asks
    // cosmiconfig to load it.
    searchStrategy: "none",
    // Freshness is this module's job: every call re-checks the places, and
    // each file's parse is reused while its text is unchanged.
    cache: false,
  });
  return explorer;
}

// ---------------------------------------------------------------------------
// Provided configs

interface Provided {
  config: Record<string, unknown>;
  file: string;
}

const provided = new Map<string, Provided>();

/** Bumped by every {@link provideMxConfig}, so caches keyed on files notice it. */
let providedGeneration = 0;

/**
 * A counter that changes whenever a config is provided or removed. A cache of
 * anything derived from MX's config stamps it next to the config files.
 */
export function mxConfigGeneration(): number {
  return providedGeneration;
}

/**
 * Hands MX an already-built config for every file under `root`, in place of
 * the file search. A dialect that keeps its own config file, or a tool that
 * builds MX's settings itself, calls this before compiling; MX then never
 * reads `mx.config.*` or `package.json#mx` for that root. `file` names where
 * the settings came from in diagnostics (default: `root`). Passing
 * `undefined` removes the config, and the search applies again. The nearest
 * provided root above a file wins.
 */
export function provideMxConfig(
  root: string,
  config: Record<string, unknown> | undefined,
  options: { file?: string } = {},
): void {
  const key = resolve(root);
  providedGeneration++;
  if (config === undefined) provided.delete(key);
  else provided.set(key, { config, file: options.file ?? key });
}

function providedFor(
  fromDir: string,
): { root: string; entry: Provided } | undefined {
  if (provided.size === 0) return undefined;
  for (let dir = resolve(fromDir); ; dir = dirname(dir)) {
    const entry = provided.get(dir);
    if (entry) return { root: dir, entry };
    if (dirname(dir) === dir) return undefined;
  }
}

// ---------------------------------------------------------------------------
// Search

/** The directory a search place belongs to: `.config/mxrc.json` belongs to the parent of `.config`. */
function baseDirOf(file: string): string {
  const dir = dirname(file);
  return basename(dir) === ".config" ? dirname(dir) : dir;
}

function formatOf(file: string): MxConfigFormat {
  if (basename(file) === "package.json") return "package.json";
  const ext = extname(file);
  if (ext === ".json") return "json";
  if (ext === ".yaml" || ext === ".yml" || ext === "") return "yaml";
  return "module";
}

/**
 * The project `fromDir` belongs to: the directory of the nearest
 * `package.json` at or above it (`undefined` when there is none), and every
 * `package.json` path checked on the way, since creating one of those moves
 * the project.
 */
function projectOf(fromDir: string): {
  dir: string | undefined;
  manifests: string[];
} {
  const manifests: string[] = [];
  for (let dir = resolve(fromDir); ; dir = dirname(dir)) {
    const file = join(dir, "package.json");
    manifests.push(file);
    if (readPackageJsonCached(file)) return { dir, manifests };
    if (dirname(dir) === dir) return { dir: undefined, manifests };
  }
}

/**
 * Every file whose creation, removal or edit could change the answer for
 * `fromDir`: the `package.json` paths up to the project, then the project's
 * search places in order, up to `stopAt` (the config in force).
 */
function watchFor(
  project: { dir: string | undefined; manifests: string[] },
  stopAt?: string,
): string[] {
  const watch = [...project.manifests];
  if (!project.dir) return watch;
  for (const place of MX_CONFIG_SEARCH_PLACES) {
    const file = join(project.dir, place);
    if (!watch.includes(file)) watch.push(file);
    if (file === stopAt) break;
  }
  return watch;
}

/** The file's text when it exists and holds something, else `undefined`. */
function nonEmptyText(file: string): string | undefined {
  try {
    if (!statSync(file).isFile()) return undefined;
    const text = readFileSync(file, "utf8");
    return text.trim() === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

function sourceOf(
  file: string,
  dir: string,
  format: MxConfigFormat,
  config: unknown,
  text: string,
  watch: readonly string[],
  error?: MxConfigError,
  shadowed: readonly string[] = [],
): MxConfigSource {
  const object = isObject(config) ? withoutReservedKeys(config) : undefined;
  const sections: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object ?? {})) {
    // A section is a dialect's (its id) or a target's (its config key). The
    // loader cannot tell which, since it knows neither the dialects nor the
    // targets: target policy resolution rejects a key that is neither
    // (`unknown-config-key`), routing rejects the dialect-owned keys, and
    // `extensions` reaches routing through `extensions` below.
    if (!MX_CONFIG_KEYS.includes(key)) sections[key] = value;
  }
  const locate = (
    path: readonly string[],
    options: { key?: boolean } = {},
  ): MxConfigLocation => {
    if (format === "package.json")
      return locateJsonPath(text, ["mx", ...path], options) ?? START;
    if (format === "json") return locateJsonPath(text, path, options) ?? START;
    if (format === "yaml") {
      return (
        (text.trimStart().startsWith("{")
          ? locateJsonPath(text, path, options)
          : locateYamlPath(text, path, options)) ?? START
      );
    }
    return START;
  };
  return {
    file,
    dir,
    format,
    config: object,
    text,
    ...(error ? { error } : {}),
    ...(isObject(object?.extensions) ? { extensions: object.extensions } : {}),
    sections,
    watch,
    shadowed,
    locate,
  };
}

/**
 * The MX config that applies to files in `fromDir`: a provided config for a
 * root above it, else the first search place that holds one (see the module
 * doc for the order). `undefined` when there is none, so MX's defaults apply.
 *
 * A config file that cannot be loaded comes back with `error` set and its
 * last good `config` (or `undefined`); it still ends the search, since it is
 * the file the author meant. Callers report `error` themselves, deduped by
 * `file` + `message`.
 */
export function findMxConfig(fromDir: string): MxConfigSource | undefined {
  const given = providedFor(fromDir);
  if (given) {
    return sourceOf(
      given.entry.file,
      given.root,
      "provided",
      given.entry.config,
      "",
      [],
    );
  }
  const project = projectOf(fromDir);
  if (!project.dir) return undefined;
  const places = MX_CONFIG_SEARCH_PLACES.map((place) =>
    join(project.dir as string, place),
  );
  for (const [index, filepath] of places.entries()) {
    if (nonEmptyText(filepath) === undefined) continue;
    const format = formatOf(filepath);
    let loaded: { config: unknown } | null;
    try {
      loaded = getExplorer().load(filepath) as { config: unknown } | null;
    } catch (cause) {
      // cosmiconfig throws for what it validates itself: a bad `$import`.
      const previous = loads.get(filepath);
      return sourceOf(
        filepath,
        project.dir,
        format,
        previous?.hasGood ? previous.good : undefined,
        previous?.text ?? "",
        watchFor(project, filepath),
        { message: (cause as Error).message, line: 1, column: 0 },
      );
    }
    const load = loads.get(filepath);
    // For `package.json`, a broken revision is reported by its own readers
    // (the policy walk, the scan) as it always was, and one without `mx`
    // holds no config.
    const error = format === "package.json" ? undefined : load?.error;
    if (format === "package.json" && loaded?.config === undefined) continue;
    const config =
      format === "package.json"
        ? loaded?.config
        : load?.hasGood
          ? load.good
          : undefined;
    const shadowed = places
      .slice(index + 1)
      .filter(
        (other) =>
          basename(other) !== "package.json" &&
          nonEmptyText(other) !== undefined,
      );
    return sourceOf(
      filepath,
      project.dir,
      format,
      config,
      format === "module" ? "" : (load?.text ?? ""),
      watchFor(project, filepath),
      error,
      shadowed,
    );
  }
  return undefined;
}

/**
 * Every file whose creation could give `fromDir` a config: each search place
 * from `fromDir` up to the directory where the search ends. A watcher of a
 * directory with no config yet watches these. With a config in force, its
 * `watch` is the same list cut at that config's file.
 */
export function mxConfigSearchPaths(fromDir: string): string[] {
  return watchFor(projectOf(fromDir));
}

/**
 * Where the key at `path` is written in the config file last loaded from
 * `file` (not a `package.json`, whose readers locate `mx.<key>` themselves);
 * `1:0` when that is unknown.
 */
export function mxConfigKeyPosition(
  file: string,
  path: readonly string[],
): MxConfigLocation {
  return sourceOf(
    file,
    baseDirOf(file),
    formatOf(file),
    undefined,
    loads.get(file)?.text ?? "",
    [],
  ).locate(path, { key: true });
}

/** For tests: forgets every load and every provided config. */
export function clearMxConfigCache(): void {
  loads.clear();
  provided.clear();
}

/** Whether `file` is one of MX's config search places (for watchers). */
export function isMxConfigFile(file: string): boolean {
  const name = basename(file);
  const parent = basename(dirname(file));
  return MX_CONFIG_SEARCH_PLACES.some((place) =>
    place.startsWith(".config/")
      ? parent === ".config" && place === `.config/${name}`
      : place === name,
  );
}
