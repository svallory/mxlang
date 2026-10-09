/**
 * `mx(source)`/`loadMx(path)` — one-call compile-and-cache helpers for a
 * bundler-free consumer (Express, Hono, a plain Bun server): the ergonomics
 * Pug's `compile`/`renderFile` give, over `@mxlang/html`'s `compile`/
 * `compileFile`, which hand back source text a caller still has to execute
 * and cache themselves.
 *
 * ## Why not a bundler step
 *
 * `compile()`'s output is plain TypeScript with real ESM `import`s — a
 * discovered custom tag's relative `.mx` import, this host's own
 * `escape` re-export, anything else the template's fence imports. Handing
 * that string to a caller (as `compile`/`compileFile` already do) makes
 * *them* write it to disk and run it through their own bundler/loader,
 * exactly the ceremony this pitch exists to remove. `mx`/`loadMx` instead
 * compile, rewrite every import to a real absolute target, and evaluate the
 * result in memory — synchronously, with zero disk writes, on both Bun and
 * Node.
 *
 * ## Two runtimes, two evaluation mechanisms, no writes on either
 *
 * - **Bun**: a `Bun.plugin` virtual module (`build.module(name, …)`) under
 *   the same private `mx-virtual:` scheme Node uses, evaluated with a
 *   synchronous `require()` and Bun's own real TypeScript stripping. Not a
 *   `data:` URL: Bun 1.3.14 (the CI pin) fails `require("data:…")` with
 *   `NameTooLong while resolving package 'data:text/typescript;base64,…'`
 *   once the URL passes ~1.5 KB, and a nested tag's `data:` URL is embedded
 *   base64-in-base64 in its importer, so any page that calls a tag crosses
 *   that line. A virtual module has no location of its own either, so a
 *   relative import inside it cannot resolve — which is why every import is
 *   rewritten to an absolute `file://` target (or another in-memory
 *   module's own URL) before this ever runs, not left for Bun's own
 *   resolver to puzzle out.
 * - **Node ≥22.15**: `node:module`'s `registerHooks({ resolve, load })`
 *   intercepts a synchronous `require()` for a private `mx-virtual:` scheme
 *   this module owns; `load` runs the source through `node:module`'s
 *   `stripTypeScriptTypes` (also experimental — see the caveat below) before
 *   handing it to Node's own ESM compiler. Registered once per process,
 *   lazily, on first use.
 *
 * Both mechanisms are wired through the exact same rewrite pass
 * (`rewriteImports`): the runtime split is only in *how a rewritten module's
 * text is finally evaluated*, never in how imports are resolved.
 *
 * ## Resolving every import to something real, with no disk write
 *
 * `compile()`'s emitted imports are three shapes, and each is handled before
 * the module ever reaches Bun's or Node's own resolver:
 *
 * - **Bare** (`import { escape } from "@mxlang/html"`) — resolved with
 *   `createRequire(anchor).resolve(specifier)` against the *anchor* (the
 *   real `.mx` file's own path, or `options.filename` for `mx(source)`),
 *   never the process's current working directory. This is what makes the
 *   caller's own `node_modules` resolve regardless of where the process
 *   happened to be started from — Bun's own bare-specifier resolution from
 *   a virtual module is CWD-relative and silently wrong whenever a
 *   caller's CWD differs from their project root.
 * - **Relative, non-`.mx`** (`import { helper } from "./util.ts"`) —
 *   rewritten to an absolute `file://` URL against the anchor's directory.
 * - **Relative `.mx`/`.marko`** (a discovered custom tag's own injected
 *   import) — compiled *recursively* through this same cache, and the
 *   import is pointed at that nested module's own in-memory form (a
 *   versioned `mx-virtual:` URL, on both runtimes) rather than a
 *   file path, since there is no file to point at.
 *
 * `mx(source)` with no `options.filename` and no relative imports in its
 * compiled output needs no anchor and evaluates from source text alone; one
 * with a relative import and no `filename` is a compile-time error naming
 * the missing option, since there is no directory to resolve `./tags/x.mx`
 * (or a bare specifier, for that matter — an anchor is also what lets a
 * bare import resolve against the *caller's* dependencies rather than
 * `@mxlang/html`'s own) against otherwise.
 *
 * ## An import is parsed, never matched against printed text
 *
 * Each compiled import is its own complete line (`compile()`'s own emit
 * convention — see `translate.ts`), so `@mxlang/core`'s `importedNames`
 * (a real, one-line Babel parse, the same function `@mxlang/preact`'s own
 * hook guard uses) gives the specifier's exact text; splicing it out of
 * that one line is then locating a parser-validated exact substring, not a
 * regex scanning arbitrary code for something that looks like an import.
 *
 * ## Caching and invalidation
 *
 * `loadMx(path)` caches by resolved path, keyed on every file in its
 * *transitive* dependency graph's mtime — not just its own, and not just its
 * direct imports': a page that calls a discovered tag which itself imports
 * another `.mx` file must invalidate when the deepest file changes, which
 * needs each nested compile's own dependency set merged into its caller's,
 * recursively. `mx(source, options)` caches by a hash of `source` plus
 * `options.filename` (custom tags/imports resolve relative to it, so two
 * calls with the same source but a different filename are different
 * compiles), bounded LRU-256 — matching `@mxlang/core`'s own
 * template-metadata cache bound, not a new number invented here.
 *
 * **Node's own require cache is keyed by URL**, so a recompiled
 * `mx-virtual:` module needs a *new* URL each time it actually changes
 * (a monotonic `#v<n>` fragment) or the cache would keep serving the first
 * version forever regardless of what `isFresh` decides — confirmed by
 * measurement: a bare `mx-virtual:<path>` scheme with no version, tried
 * first, never picked up a nested dependency's edit at all under Node
 * (Bun gets the same versioned URLs). Each recompile therefore adds one more
 * `mx-virtual:` URL Node's require cache holds — Node has no API to evict a `require`d
 * ESM module, so **a long-lived dev process that edits templates over and
 * over grows this cache without bound**. An unchanged file is a cache hit
 * (`isFresh`) and mints no new URL, so this only grows on a real edit, at
 * the rate templates are actually edited — acceptable for a dev server, a
 * concern only for a process meant to run for a very long time under heavy
 * edit churn.
 *
 * ## `stripTypeScriptTypes`'s experimental warning
 *
 * Node prints exactly one `ExperimentalWarning` for `stripTypeScriptTypes`
 * per process, regardless of how many times it's called (measured: three
 * calls in one process print the warning once, after the run). Left alone
 * deliberately — a library must not intercept `process.emitWarning` to
 * silence its own dependency's warning for the caller. A consumer who wants
 * it gone can pass Node's own `--disable-warning=ExperimentalWarning`.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import * as babelParser from "@babel/parser";
import {
  getCustomTags,
  isMarkoOrMxSpecifier,
  isTranslateError,
  type MxWarning,
  scanCached,
  type TargetLookup,
  TranslateError,
} from "@mxlang/core";
import type { PluginBuilder } from "bun";
import { configuredDefaultTag } from "./default-tag.ts";
import { type CompileOptions, compile, htmlTargets } from "./index.ts";

/**
 * `@babel/parser`, the parser `@mxlang/core` itself parses whole modules with
 * (decision 197: no Marko Babel). Round 2, finding 3: the original rewrite pass scanned the
 * compiled module line by line with `importedNames` (a single-*line* parse),
 * which silently skipped an author-written multi-line import and never even
 * attempted an `export … from` re-export (`importedNames` only recognizes
 * `ImportDeclaration`). A real whole-module parse sees both, plus a
 * side-effect import (`import "./x.ts"`, no specifiers at all).
 */
const babelModule = () =>
  babelParser as unknown as {
    parse: (
      code: string,
      options?: Record<string, unknown>,
    ) => {
      program: { body: BabelModuleNode[] };
    };
  };

interface BabelModuleNode {
  type: string;
  source?: { value: string; start: number; end: number } | null;
}

/** A compiled, callable MX template. */
export interface MxRenderer<I = Record<string, unknown>> {
  (input: I): string;
  /** This compile's warnings — silent-drop reports, not compile errors. */
  readonly warnings: readonly MxWarning[];
}

export interface MxOptions extends CompileOptions {
  /**
   * The real file this source would live at, if it were a file — the
   * anchor every import in the compiled output resolves against. Required
   * whenever the compiled output has any import at all (a bare specifier,
   * this host's own `escape` re-export always among them, or a discovered
   * custom tag's relative import); omit it only for a template with no
   * custom tags and no bare imports of its own.
   */
  filename?: string;
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/**
 * Stable, per-process identity ids for a function passed as an option
 * (`resolveImport`, or a `CustomTag`'s own `analyze`/`transform`/`finalize`
 * hooks) — behavior is decided by *which* function was passed, not by its
 * source text (`toString()` collapses two different closures with identical
 * bodies, or two calls of a factory that always returns textually-identical
 * code, onto the same fingerprint).
 */
const functionIds = new WeakMap<object, number>();
let nextFunctionId = 0;
function functionId(fn: (...args: never[]) => unknown): number {
  let id = functionIds.get(fn);
  if (id === undefined) {
    id = nextFunctionId++;
    functionIds.set(fn, id);
  }
  return id;
}

/**
 * A stable string standing in for everything about `options` that could
 * change what `compile()` actually produces — round 2, finding 1: the cache
 * key used to be source/path (+ filename) only, so a second call with
 * different `strict`/`customTags`/`resolveImport` silently reused the first
 * call's renderer. `warnings` is excluded: it is an output-only array the
 * caller reads after the call, never part of what a compile decides.
 */
function fingerprintOptions(options: CompileOptions): string {
  const parts: string[] = [`strict:${options.strict ? 1 : 0}`];
  if (options.defaultTag !== undefined) {
    parts.push(`defaultTag:${JSON.stringify(options.defaultTag)}`);
  }

  if (options.resolveImport) {
    parts.push(`resolveImport:${functionId(options.resolveImport)}`);
  }

  if (options.customTags) {
    const names = Object.keys(options.customTags).sort();
    for (const name of names) {
      const tag = options.customTags[name] as Record<string, unknown>;
      const tagParts: string[] = [];
      for (const key of ["parseOptions", "attributes", "attributeTags"]) {
        if (tag[key] !== undefined)
          tagParts.push(`${key}:${JSON.stringify(tag[key])}`);
      }
      for (const key of ["analyze", "transform", "finalize"]) {
        const fn = tag[key];
        if (typeof fn === "function")
          tagParts.push(
            `${key}:${functionId(fn as (...args: never[]) => unknown)}`,
          );
      }
      const template = tag.template as
        | { filename?: string; source?: string }
        | undefined;
      if (template?.filename) tagParts.push(`template:${template.filename}`);
      if (template?.source) tagParts.push(`source:${template.source}`);
      parts.push(`tag(${name}):${tagParts.join(",")}`);
    }
  }

  return parts.join("|");
}

/**
 * `fingerprintOptions({})` — what `loadNestedMx` always compiles a
 * discovered custom tag with (only its own `customTags`, never a caller
 * option). `loadMx(path, options)` registers its own compile into the
 * shared nested-tag cache (`pathCache`/`urlForPath`) only when its own
 * fingerprint matches this exactly (round 3, finding: the cache split
 * from round 2 let a `strict`/`resolveImport`/`customTags`-bearing
 * `loadMx` call taint the plain-compile cache another page's nested
 * lookup would otherwise reuse).
 */
const NESTED_DEFAULT_FINGERPRINT = fingerprintOptions({});

interface CacheEntry<I> {
  renderer: MxRenderer<I>;
  /** Every file this compile transitively depends on, mtime at compile time. */
  deps: ReadonlyMap<string, number>;
}

const MAX_CACHE_ENTRIES = 256;
const sourceCache = new Map<string, CacheEntry<never>>();
/** Nested `.mx` imports only — always compiled with just `customTags`, so
 * this is keyed by path alone, never by caller options. */
const pathCache = new Map<string, CacheEntry<never>>();
/** `loadMx`'s own top-level entries — keyed by path AND options, since two
 * `loadMx(path, options)` calls with different options are different
 * compiles (round 2, finding 1). Deliberately a separate map from
 * `pathCache`: the two have different key shapes for the same path. */
const topLevelPathCache = new Map<string, CacheEntry<never>>();

/** In-memory module text, keyed by the URL it was last registered under. */
const virtualSources = new Map<string, string>();
/** Real path -> its current virtual/data URL, so a cache hit reuses it. */
const urlForPath = new Map<string, string>();
let virtualVersion = 0;

/**
 * Bun's half of the `mx-virtual:` scheme: one plugin, registered lazily,
 * whose builder is kept so each new module is added with `build.module`
 * (registering a whole plugin per module would pile up plugins).
 */
let bunBuild: PluginBuilder | undefined;

function registerVirtual(url: string, source: string): void {
  virtualSources.set(url, source);
  if (!isBun) return;
  if (!bunBuild) {
    // SAFETY: the isBun guard above checked the runtime's Bun global.
    (globalThis as unknown as { Bun: typeof import("bun") }).Bun.plugin({
      name: "mxlang-virtual",
      setup(build) {
        bunBuild = build;
      },
    });
  }
  bunBuild?.module(url, () => ({ contents: source, loader: "ts" }));
}

let nodeHooksRegistered = false;

function ensureNodeHooks(): void {
  if (nodeHooksRegistered || isBun) return;
  const localRequire = createRequire(import.meta.url);
  const nodeModule = localRequire(
    "node:module",
  ) as typeof import("node:module");
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith("mx-virtual:")) {
        return { url: specifier, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.startsWith("mx-virtual:")) {
        const source = virtualSources.get(url);
        if (source === undefined) {
          throw new Error(
            `@mxlang/html: no virtual source registered for ${url}`,
          );
        }
        let stripped: string;
        try {
          stripped = nodeModule.stripTypeScriptTypes(source);
        } catch (cause) {
          // Round 2, finding 5: `stripTypeScriptTypes` is *type-erasure*
          // only — it raises a raw, opaque Node `SyntaxError` for real TS
          // syntax that lowers to runtime code (an `enum`, a `namespace`
          // with a value), which `compile()` accepts and emits verbatim
          // since it's ordinary author-written TypeScript on every other
          // host. Wrapped in an MX-branded error naming the real file (the
          // path embedded in `mx-virtual:<path>#v<n>`) and stating the
          // no-bundler-helpers constraint, rather than surfacing Node's own
          // wording with no file context at all.
          const path = url.slice("mx-virtual:".length).replace(/#v\d+$/, "");
          throw new Error(
            `@mxlang/html: ${path}: mx()/loadMx() support only erasable TypeScript (types only, no enum/namespace/parameter-property runtime code) — ${(cause as Error).message}`,
          );
        }
        return {
          format: "module",
          source: stripped,
          shortCircuit: true,
        };
      }
      return nextLoad(url, context);
    },
  });
  nodeHooksRegistered = true;
}

function evictOldest<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

/**
 * Moves `key` to the end of `map`'s own iteration order (a `Map` preserves
 * insertion order, so delete-then-reinsert makes it the *most recently
 * used* entry) — round 2, finding 4: without this, `evictOldest`'s "oldest
 * inserted" was FIFO by first compile, not LRU by last use, so a hot entry
 * compiled early could still be evicted ahead of a cold one compiled more
 * recently but never touched again.
 */
function touch<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
}

function fresh(deps: ReadonlyMap<string, number>): boolean {
  for (const [path, mtimeMs] of deps) {
    if (!existsSync(path)) return false;
    if (statSync(path).mtimeMs !== mtimeMs) return false;
  }
  return true;
}

/**
 * Rewrites every import/re-export specifier in one compiled module's source
 * to a real, resolvable target — recording every file this rewrite touched
 * (this module's own path/anchor, every dependency `compile()` reported, and
 * every nested `.mx` import's own transitive dependencies) into `deps`.
 *
 * A real parse of the whole module (`@marko/compiler`'s own Babel, the same
 * instance `@mxlang/core` uses internally), not a line scan: an
 * `ImportDeclaration` (including a side-effect-only `import "./x.ts"`, whose
 * `specifiers` list is empty but which still has a `source`),
 * `ExportNamedDeclaration`/`ExportAllDeclaration` with a `source` (an
 * `export … from`), each with real node offsets — round 2, finding 3.
 * Every edit is applied right-to-left (highest offset first) so an earlier
 * edit's own offsets stay valid as later ones are spliced in.
 */
function rewriteImports(
  code: string,
  anchor: string | undefined,
  deps: Map<string, number>,
  seen: Set<string>,
  targets: TargetLookup,
): string {
  const { parse } = babelModule();
  // Compiled MX output is TypeScript (an `export interface Input {}`, a
  // typed parameter), so the parse needs the `typescript` plugin — the same
  // combination `@mxlang/core`'s own `scan.ts` uses for a whole-file TS
  // parse, `importedNames` never needed since it parses only one bare import
  // line at a time.
  const file = parse(code, {
    sourceType: "module",
    plugins: ["typescript"],
    configFile: false,
    babelrc: false,
  });

  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const node of file.program.body) {
    if (
      node.type !== "ImportDeclaration" &&
      node.type !== "ExportNamedDeclaration" &&
      node.type !== "ExportAllDeclaration"
    ) {
      continue;
    }
    const source = node.source;
    if (!source) continue; // a plain `export { x }` with no `from` clause
    const specifier = source.value;

    let replacement: string;
    if (isMarkoOrMxSpecifier(specifier)) {
      if (!anchor) {
        throw new Error(
          `@mxlang/html: mx(source) has a relative import (\`${specifier}\`) and no anchor; pass \`filename\` so it can be resolved.`,
        );
      }
      const resolved = specifier.startsWith(".")
        ? resolvePath(dirname(anchor), specifier)
        : specifier;
      replacement = loadNestedMx(resolved, deps, seen, targets);
    } else if (specifier.startsWith(".")) {
      if (!anchor) {
        throw new Error(
          `@mxlang/html: mx(source) has a relative import (\`${specifier}\`) and no anchor; pass \`filename\` so it can be resolved.`,
        );
      }
      replacement = pathToFileURL(resolvePath(dirname(anchor), specifier)).href;
    } else if (specifier === "@mxlang/html") {
      // Every compiled template imports this host's own `escape` re-export
      // — a specifier this package can always resolve against itself, since
      // it names its own package. No caller anchor is needed for it
      // specifically, which is what lets `mx("<p>${input.n}</p>")` (no
      // `filename`) work at all: nearly every real template compiles an
      // `escape` import, so requiring an anchor for this one bare specifier
      // would make the no-filename case useless in practice.
      const req = createRequire(import.meta.url);
      replacement = pathToFileURL(req.resolve("@mxlang/html")).href;
    } else {
      if (!anchor) {
        throw new Error(
          `@mxlang/html: mx(source) imports \`${specifier}\` and has no anchor; pass \`filename\` so it can resolve against your project's own dependencies.`,
        );
      }
      const req = createRequire(anchor);
      replacement = pathToFileURL(req.resolve(specifier)).href;
    }

    // `source.start`/`source.end` span the string literal INCLUDING its
    // quote characters, so the replacement is quoted the same way the
    // author's own specifier was.
    const quote = code[source.start];
    edits.push({
      start: source.start,
      end: source.end,
      text: `${quote}${replacement}${quote}`,
    });
  }

  edits.sort((a, b) => b.start - a.start);
  let out = code;
  for (const edit of edits) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

/**
 * Compiles and registers one nested `.mx` file's in-memory module,
 * recursively, merging its own transitive dependencies into `deps`. Returns
 * the URL to import it by. Detects a cycle through `seen` (the set of paths
 * currently being compiled on this call stack) rather than only relying on
 * the process-wide path cache, since a self- or mutually-recursive pair of
 * `.mx` files would otherwise recurse forever before either finishes
 * compiling once.
 */
/** `loadMx`'s own scan: the package's validated defaultTag, contracts checked too. */
function scanOwn(abs: string, targets: TargetLookup): string | undefined {
  const scanned = scanCached(abs, { host: "html", targets });
  return configuredDefaultTag(abs, scanned.customTags, targets, scanned.tags);
}

function nestedKey(path: string, defaultTag: string | undefined): string {
  return `${path}\u0000${defaultTag ?? ""}`;
}

function loadNestedMx(
  path: string,
  callerDeps: Map<string, number>,
  seen: Set<string>,
  targets: TargetLookup,
): string {
  if (seen.has(path)) {
    throw new TranslateError(
      `@mxlang/html: import cycle detected: ${[...seen, path].join(" -> ")}`,
      1,
      1,
    );
  }

  // The package's defaultTag shapes the compile, so it is part of the key: a
  // changed `mx.html.defaultTag` must not reuse the module the old one made.
  const scanned = scanCached(path, { host: "html", targets });
  const defaultTag = configuredDefaultTag(
    path,
    scanned.customTags,
    targets,
    scanned.tags,
  );
  const cacheKey = nestedKey(path, defaultTag);
  const cached = pathCache.get(cacheKey);
  const cachedUrl = urlForPath.get(cacheKey);
  if (cached && cachedUrl && fresh(cached.deps)) {
    touch(pathCache, cacheKey, cached);
    for (const [depPath, mtimeMs] of cached.deps) {
      callerDeps.set(depPath, mtimeMs);
    }
    return cachedUrl;
  }

  if (!existsSync(path)) {
    throw new Error(`@mxlang/html: cannot find module '${path}'`);
  }

  const nextSeen = new Set(seen);
  nextSeen.add(path);

  const source = readFileSync(path, "utf8");
  const customTags = getCustomTags(path, { host: "html", targets });
  let code: string;
  let dependencies: readonly string[];
  try {
    ({ code, dependencies } = compile(source, path, {
      customTags,
      ...(defaultTag === undefined ? {} : { defaultTag }),
      targets,
    }));
  } catch (error) {
    if (isTranslateError(error) && !error.file) {
      // A nested compile error must carry the nested file's own path and
      // position, not the caller's — this is what makes it reported against
      // `path`, never the top-level `.mx` file that merely imported it.
      throw new TranslateError(error.message, error.line, error.column, path);
    }
    throw error;
  }

  const deps = new Map<string, number>();
  deps.set(path, statSync(path).mtimeMs);
  for (const dep of dependencies) deps.set(dep, statSync(dep).mtimeMs);

  const rewritten = rewriteImports(code, path, deps, nextSeen, targets);
  const url = `mx-virtual:${path}#v${virtualVersion++}`;
  registerVirtual(url, rewritten);
  urlForPath.set(cacheKey, url);
  pathCache.set(cacheKey, { renderer: null as never, deps });
  evictOldest(pathCache, MAX_CACHE_ENTRIES);

  for (const [depPath, mtimeMs] of deps) callerDeps.set(depPath, mtimeMs);
  return url;
}

/**
 * Evaluates `rewritten` and returns both the module and the exact URL it was
 * evaluated under, per runtime — round 2, finding 2: recording a URL
 * reconstructed *after* the fact (a guessed `mx-virtual:` string) went stale
 * the moment
 * `virtualVersion` next incremented, so a file `loadMx`'d standalone and
 * later imported as a nested tag resolved to nothing. The caller records
 * exactly what comes back from here, never reconstructs it.
 */
function evaluate(
  rewritten: string,
  anchor: string | undefined,
): { mod: unknown; url: string } {
  const url = `mx-virtual:${anchor ?? "inline"}#v${virtualVersion++}`;
  registerVirtual(url, rewritten);
  if (isBun) return { mod: require(url), url };
  ensureNodeHooks();
  const req = createRequire(anchor ?? import.meta.url);
  return { mod: req(url), url };
}

/**
 * Compiles `source`, resolves every import to a real target, evaluates the
 * result synchronously, in memory, and returns a callable renderer.
 * `options.filename` anchors any relative or bare import the source's fence
 * writes; omit it only when the source has none.
 */
export function mx<I = Record<string, unknown>>(
  source: string,
  rawOptions: MxOptions = {},
): MxRenderer<I> {
  // A `filename` places the source in a package, whose `mx.html.defaultTag`
  // shapes the compile and so belongs in the key. An explicit option wins.
  const configured =
    rawOptions.defaultTag === undefined && rawOptions.filename
      ? configuredDefaultTag(
          rawOptions.filename,
          rawOptions.customTags,
          rawOptions.targets ?? htmlTargets,
        )
      : undefined;
  const options: MxOptions =
    configured === undefined
      ? rawOptions
      : { ...rawOptions, defaultTag: configured };
  const key = createHash("sha256")
    .update(options.filename ?? "")
    .update("\u0000")
    .update(fingerprintOptions(options))
    .update("\u0000")
    .update(source)
    .digest("hex");
  const cached = sourceCache.get(key);
  if (cached && fresh(cached.deps)) {
    touch(sourceCache, key, cached);
    return cached.renderer as MxRenderer<I>;
  }

  const warnings: MxWarning[] = [];
  const { code } = compile(source, options.filename ?? "<mx>", {
    ...options,
    warnings,
  });

  // Every dependency (this source's own filename, and each discovered
  // custom tag's own transitive deps) is recorded by `rewriteImports`
  // itself as it resolves each import — never pre-read here, since a
  // fictitious `filename` with a real-looking but nonexistent custom-tag
  // path must reach the "pass `filename`" refusal, not an opaque ENOENT
  // from stat-ing a dependency this call was never going to be able to use
  // anyway.
  const deps = new Map<string, number>();
  if (options.filename) deps.set(options.filename, safeMtime(options.filename));

  const seen = new Set<string>(options.filename ? [options.filename] : []);
  const rewritten = rewriteImports(
    code,
    options.filename,
    deps,
    seen,
    options.targets ?? htmlTargets,
  );
  const { mod: rawMod } = evaluate(rewritten, options.filename);
  const mod = rawMod as { default: (input: I) => string };

  const renderer = Object.assign((input: I) => mod.default(input), {
    warnings,
  }) as MxRenderer<I>;

  sourceCache.set(key, { renderer: renderer as never, deps });
  evictOldest(sourceCache, MAX_CACHE_ENTRIES);
  return renderer;
}

function safeMtime(path: string): number {
  return existsSync(path) ? statSync(path).mtimeMs : -1;
}

/**
 * `loadMx(path)` — `mx()` over a file already on disk, cached by the file's
 * own resolved path and mtime (plus every transitive dependency's), not by
 * content hash.
 */
export function loadMx<I = Record<string, unknown>>(
  path: string,
  options: CompileOptions = {},
): MxRenderer<I> {
  const abs = isAbsolute(path) ? path : resolvePath(process.cwd(), path);
  // `customTags` is excluded from the fingerprint here: `compile()` below
  // always passes its own `getCustomTags(abs)` discovery result last, which
  // silently overrides anything `options.customTags` supplied (the object
  // spread order), so two `loadMx(path, { customTags: a })`/
  // `loadMx(path, { customTags: b })` calls compile identically regardless
  // — including a caller-supplied `customTags` in the key would only ever
  // create spurious cache misses for options that were never honored.
  const targets = options.targets ?? htmlTargets;
  // The package's `defaultTag` (decision 145) shapes the compile, so it is in
  // the key: an edited config recompiles. An explicit option wins over it.
  const configured =
    options.defaultTag === undefined && existsSync(abs)
      ? scanOwn(abs, targets)
      : undefined;
  const effective: CompileOptions =
    configured === undefined ? options : { ...options, defaultTag: configured };
  const { customTags: _ignoredForLoadMx, ...fingerprintableOptions } =
    effective;
  const key = `${abs}\u0000${fingerprintOptions(fingerprintableOptions)}`;
  const cached = topLevelPathCache.get(key) as CacheEntry<I> | undefined;
  if (cached?.renderer && fresh(cached.deps)) {
    touch(topLevelPathCache, key, cached);
    return cached.renderer;
  }

  if (!existsSync(abs)) {
    throw new Error(`@mxlang/html: cannot find module '${abs}'`);
  }

  const source = readFileSync(abs, "utf8");
  const customTags = getCustomTags(abs, {
    host: "html",
    targets: options.targets ?? htmlTargets,
  });
  const warnings: MxWarning[] = [];
  const { code } = compile(source, abs, {
    ...effective,
    customTags,
    warnings,
  });

  // Each dependency (a discovered custom tag's own file, and everything
  // *it* transitively imports) is recorded by `rewriteImports`/
  // `loadNestedMx` as it resolves each import, so no separate pre-pass over
  // `compile()`'s own `dependencies` is needed here.
  const deps = new Map<string, number>();
  deps.set(abs, statSync(abs).mtimeMs);

  const seen = new Set<string>([abs]);
  const rewritten = rewriteImports(
    code,
    abs,
    deps,
    seen,
    options.targets ?? htmlTargets,
  );
  const { mod: rawMod, url } = evaluate(rewritten, abs);
  const mod = rawMod as { default: (input: I) => string };

  const renderer = Object.assign((input: I) => mod.default(input), {
    warnings,
  }) as MxRenderer<I>;

  // Also registered under the plain-path nested-tag cache (`pathCache`/
  // `urlForPath`), with the exact URL just evaluated — round 2, finding 2:
  // a file `loadMx`'d standalone here must resolve to the same, already-
  // evaluated module if something else later imports it as a custom tag,
  // rather than that lookup finding no entry (or a stale/wrong one) and
  // recompiling it separately under a second URL.
  //
  // Round 3: only when this call's own options are the nested-tag default
  // (`loadNestedMx` always compiles a discovered tag with nothing but its
  // own `customTags`, never any caller option) — otherwise a `strict`,
  // `resolveImport`, or `customTags`-bearing `loadMx(A, options)` call
  // would taint the *shared* cache, and a later page that discovers A as a
  // plain nested tag would silently reuse this call's differently-compiled
  // module instead of doing its own default-options compile. Confirmed by
  // reproduction: a module-scope `static` counter in A's own source stayed
  // at 1 (never re-evaluated) after a page nested A following a
  // `resolveImport`-bearing standalone `loadMx(A, ...)` call, before this
  // fix.
  //
  // The package's own `defaultTag` is not a caller option: a nested compile
  // reads the same config, so it stays eligible and keys on the value.
  const { customTags: _ownTags, ...callerOptions } = options;
  if (fingerprintOptions(callerOptions) === NESTED_DEFAULT_FINGERPRINT) {
    const nested = nestedKey(abs, configured);
    pathCache.set(nested, { renderer: renderer as never, deps });
    urlForPath.set(nested, url);
    evictOldest(pathCache, MAX_CACHE_ENTRIES);
  }

  topLevelPathCache.set(key, { renderer: renderer as never, deps });
  evictOldest(topLevelPathCache, MAX_CACHE_ENTRIES);
  return renderer;
}

/**
 * Test-only introspection — never re-exported from `./index.ts`, so it is
 * not part of the package's public API or its built `.d.ts` entry point.
 * Exists because round 3's guard (`NESTED_DEFAULT_FINGERPRINT`) has no
 * black-box symptom to assert on today: neither `strict` nor
 * `resolveImport` nor `customTags` changes `@mxlang/html`'s emitted runtime
 * bytes or `compile()`'s own `dependencies` array for an ordinary template
 * (measured directly — see the round-3 commit message), so a
 * `loadMx(A, options)` call that *would* taint the shared nested-tag cache
 * produces byte-identical output either way today. The guard still matters
 * for cache-key hygiene going forward — the moment any option starts
 * affecting emitted bytes or tracked dependencies (e.g. an attribute-tag
 * type error gating codegen), an untested taint here would silently ship a
 * differently-configured compile to an unrelated caller.
 */
export const __testing = {
  /** Whether the shared nested-tag cache (`pathCache`) holds an entry for `path`. */
  hasNested(path: string): boolean {
    for (const key of pathCache.keys()) {
      if (key.startsWith(`${path}\u0000`)) return true;
    }
    return false;
  },
  /** `fingerprintOptions`, exposed so a test can assert on it directly. */
  fingerprintOptions,
};
