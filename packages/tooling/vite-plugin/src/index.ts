import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { type CustomTag, resolveHostPolicy, scanCached } from "@mxlang/core";
import { print } from "@mxlang/parser";
import type { Plugin } from "vite";

/**
 * Lazily imported, and only inside `transform`'s `.mx` branch:
 * `@mxlang/html` pulls in `@marko/compiler`, a large dependency whose
 * transitive code uses TypeScript parameter-property syntax. A static
 * top-level import here would load that dependency the moment
 * `vite.config.ts` imports this plugin — including for a `.solid.mx`-only
 * project like `examples/counter-app` that never touches `.mx` at all —
 * and break config loading, since Vite's own config loader reads
 * `vite.config.ts` through Node's native strip-only TS mode, which rejects
 * that syntax outright.
 *
 * A dynamic `import()`, not `require()`: `require()` on a bare specifier
 * whose `main` is TS source (`@mxlang/html`'s `src/index.ts`) goes
 * through Node's native module loader with no transform step at all under
 * Vitest's Node-native `require`, hitting the same strip-only-mode error one
 * line of source further in. Dynamic `import()` is handled by Vite's/Vitest's
 * own transform pipeline instead, which strips TypeScript fully rather than
 * in the narrow subset Node's native loader accepts.
 *
 * `@mxlang/html` has no compiled entry (its `main` is `src/index.ts`),
 * so resolving its types at all — even through this dynamic `import()`, cast
 * away below — needs `allowImportingTsExtensions` wherever `tsc` walks that
 * far. Every consumer of this plugin (each example) needs the same flag in
 * its own tsconfig for that reason, not because it imports `.ts` paths
 * itself.
 */
async function compileMarko(
  source: string,
  filename: string,
  strict: boolean,
  customTags: Record<string, CustomTag> | undefined,
): Promise<{ code: string }> {
  // Which host owns this file is the nearest `package.json`'s answer, the
  // same resolver the language server and `mx-tsc` use — so an editor, a
  // `tsc` run and a `vite build` cannot disagree about what a `.mx` file is.
  const { resolveHostPolicy } = await import("@mxlang/core");
  const host = resolveHostPolicy(filename).host;
  if (host === "preact") {
    const { compilePreactMx } = (await import("@mxlang/preact")) as {
      compilePreactMx: (
        source: string,
        filename: string,
        options?: { customTags?: Record<string, CustomTag> },
      ) => { code: string };
    };
    return compilePreactMx(source, filename, { customTags });
  }
  if (host === "react") {
    const { compileReactMx } = (await import("@mxlang/react")) as {
      compileReactMx: (
        source: string,
        filename: string,
        options?: { customTags?: Record<string, CustomTag> },
      ) => { code: string };
    };
    return compileReactMx(source, filename, { customTags });
  }
  if (host === "hono") {
    const { compileHonoMx } = (await import("@mxlang/hono")) as {
      compileHonoMx: (
        source: string,
        filename: string,
        options?: { customTags?: Record<string, CustomTag> },
      ) => { code: string };
    };
    return compileHonoMx(source, filename, { customTags });
  }
  if (host === "angular") {
    // `@mxlang/angular` exists (phase 1) but is not wired into this plugin
    // yet — falling through to the html branch below would silently compile
    // a page template meant for Angular through the vanilla string emitter
    // instead, producing plausible-looking but wrong output with no error.
    throw new Error(
      "the angular host is not wired into @mxlang/vite-plugin yet (phase 2)",
    );
  }
  const { compile } = (await import("@mxlang/html")) as {
    compile: (
      source: string,
      filename: string,
      options?: {
        strict?: boolean;
        customTags?: Record<string, CustomTag>;
      },
    ) => { code: string };
  };
  return compile(source, filename, { strict, customTags });
}

export interface MxPluginOptions {
  /**
   * File extensions handled by the plugin. Defaults to `.solid.mx` and `.mx`.
   */
  extensions?: string[];
  /**
   * Selects `@mxlang/html`'s `strictPolicy` for `.mx` files:
   * reactive constructs (`<let>`, `<effect>`, `<lifecycle>`, `<script>`,
   * `client` blocks, `<id>`) become compile errors naming the construct
   * instead of rendering their initial value or compiling away as inert.
   *
   * A passthrough rather than a policy of this plugin's own: a host that has
   * no reactive target (`@mxlang/astro` renders MX to static markup at build
   * time, decision 71) wants an author's `<let>` to fail the build with a
   * loc-bearing error rather than silently render once. The flag reaches
   * `compile()` unchanged; `.solid.mx` is unaffected, since it never goes
   * through the translator at all.
   */
  strict?: boolean;
  /**
   * Custom tags supplied directly by the caller, merged over whatever the
   * scan discovers for each compiled file.
   *
   * Discovery (spec §4) is the ordinary route and needs no configuration: a
   * `tags/icon.tag.ts` beside a template is callable as `<icon>` with no
   * import. This option remains for a caller that builds a tag map itself —
   * a test, or a tool generating tags — and it wins over a discovered tag of
   * the same name, since an explicitly supplied definition is the more
   * specific statement of intent.
   */
  customTags?: Record<string, CustomTag>;
}

const DEFAULT_EXTENSIONS = [".solid.mx", ".mx"];

/**
 * Multi-dot MX extensions that are *not* this plugin's to compile, but which
 * a shorter registered extension would otherwise swallow.
 *
 * `matchExt` tests a plain `endsWith`, so a registered `.mx` matches
 * `Base.any.mx` just as readily as `Base.mx`. `.solid.mx` is not affected,
 * because it is itself registered and the longest-first sort below puts it
 * ahead of `.mx` — this list is for an extension owned by *another* package's
 * plugin, which this one must decline rather than compile through the `.mx`
 * (`compile()` / string) branch.
 *
 * Empty today: AstroMX settled on the single-dot `.amx` (decision 78), whose
 * last extension segment differs from `.mx`, so it never collides. The guard
 * is kept because the collision is a property of the matching rule, not of
 * that one extension: it was measured while `.astro.mx` was the spelling —
 * `mx()` rewrote `x.astro.mx` to `x.astro.mx.ts`, the Astro plugin re-resolved
 * that to `x.astro.mx.ts.astro`, and the build failed inside `compileMarko`.
 * Any future multi-dot MX extension belonging to another host goes here.
 *
 * Declared as a list rather than inferred from the dot count so the rule is
 * stated where it can be read: a shorter extension never claims a file whose
 * name ends in one of these.
 */
const FOREIGN_EXTENSIONS: string[] = [];

/**
 * Appended to the resolved path so the rest of the pipeline sees a JS-family
 * module. See the note on `resolveId` below for why this is necessary.
 *
 * Always `.tsx`, for every extension this plugin handles. `.solid.mx` prints
 * JSX text (`print()`) and needs it; so does a `.mx` compiled through a JSX
 * host (`@mxlang/preact` emits a component module). A `.mx` compiled through
 * `@mxlang/html` emits no JSX, and used to take `.ts` for that reason — but
 * the suffix has to be decided identically by `resolveId` (which holds the
 * real path) and by `isMxModule` (which holds only the already-suffixed one),
 * and the host is a property of the *file's* nearest `package.json`. Deriving
 * it in both places would mean resolving the host policy from a path that
 * does not exist on disk. One suffix for all of them keeps that round trip
 * exact; a `.tsx` file whose code contains no JSX is still ordinary
 * TypeScript, and rolldown's JSX transform over it is a no-op.
 */
function suffixFor(_ext: string): string {
  return ".tsx";
}

/** `suffixFor(".solid.mx")`, kept as a named export for existing callers/tests. */
export const MX_SUFFIX = ".tsx";

/** A parse error as the vendored Babel parser raises it. */
interface MxSyntaxError extends Error {
  loc?: { line: number; column: number; index?: number };
  pos?: number;
  code?: string;
  reasonCode?: string;
}

function isSyntaxError(err: unknown): err is MxSyntaxError {
  return err instanceof Error && "loc" in err;
}

/** Splits a module id into its path and its `?query`/`#hash` suffix. */
function splitId(id: string): [path: string, suffix: string] {
  const index = id.search(/[?#]/);
  return index === -1 ? [id, ""] : [id.slice(0, index), id.slice(index)];
}

/**
 * Queries that mean "do not give me this module's compiled form".
 *
 * Mirrors Vite's own `SPECIAL_QUERY_RE`. `?raw` wants the file's text, `?url`
 * its URL, `?worker`/`?sharedworker` a worker wrapper — in every case Vite
 * serves the real file itself, so MX must not claim the id or print it.
 */
const SPECIAL_QUERY_RE = /[?&](?:worker|sharedworker|raw|url)\b/;

/**
 * A one-line code frame: the offending line plus a caret under `column`.
 *
 * Vite does not export `generateCodeFrame` from its public entry (checked at
 * runtime against 8.2.2: the export is `undefined`), so the frame the error
 * overlay renders is built here instead. `line` is 1-based and `column` is
 * 0-based, matching what the Babel parser raises.
 */
export function codeFrame(
  source: string,
  line: number,
  column: number,
): string {
  const lines = source.split("\n");
  const target = lines[line - 1];
  if (target === undefined) return "";

  const gutter = `${line} | `;
  const caretPad = " ".repeat(gutter.length + Math.max(0, column));
  return `${gutter}${target}\n${caretPad}^`;
}

/**
 * Compiles `.solid.mx` and `.mx` ahead of the rest of the pipeline.
 *
 * `.solid.mx` prints to JSX source text (`print()`, from `@mxlang/parser`)
 * ahead of `@solidjs/vite-plugin`. Ordering: this plugin is `enforce: "pre"`,
 * matching `@solidjs/vite-plugin`'s own hard-coded `enforce: "pre"`, so
 * relative order between the two is the order they appear in the user's
 * `plugins` array — put `mx()` first. Solid then sees ordinary JSX text and
 * runs whichever compiler it is configured for; both the native (default)
 * and Babel backends consume source text, so neither needs special-casing
 * here.
 *
 * `.mx` compiles to a plain `(input) => string` module (or a JSX component
 * module, per the resolved host) via `compileMarko()` — the same whole-file
 * translator `examples/mx-site` and `@mxlang/html/bun` use, so a `.mx`
 * template behaves identically whether it is loaded by Vite or by Bun.
 * `compile()`'s returned map is presently an identity placeholder (see its
 * own doc comment — the translator builds text directly, not from a printed
 * AST), so this plugin has no real source map to hand Vite yet for that
 * extension; `transform` returns `map: null` for it rather than a
 * placeholder Vite would treat as real. `.marko` is deliberately not
 * accepted here: MX only supports the MX 1.0 subset of Marko syntax, so
 * treating a real `.marko` file as MX would silently claim support it does
 * not have.
 *
 * Why `resolveId` rewrites the id to `<path><ext>.tsx`/`.ts` rather than just
 * returning the resolved path — three separate parts of the pipeline dispatch
 * on the file extension, and neither `.solid.mx` nor `.mx` satisfies any of
 * them:
 *
 * 1. Vite routes a module into the JS pipeline only when its extension matches
 *    `JS_TYPES_RE` (`/\.(?:j|t)sx?$|\.mjs$/`). Without a `resolveId` hook the
 *    import is never resolved at all and `transform` never runs.
 * 2. Rolldown picks its parser dialect from the extension, so printed JSX text
 *    parsed as `.mx` would fail ("Unexpected JSX expression"). Returning
 *    `moduleType: "tsx"` from `transform` fixes the parse but then hands the
 *    module to rolldown's own JSX transform, which resolves
 *    `react/jsx-runtime` — irrelevant for `.mx`'s plain compiled function, and
 *    exactly why it gets `.ts` instead.
 * 3. `@solidjs/vite-plugin` only compiles ids passing its `filter`, whose
 *    default is `src/**\/*.{jsx,tsx,tsrx,ts,js,mjs,cjs}`; that test runs
 *    before its `options.extensions` list is consulted, so registering the
 *    extension there cannot bring `.solid.mx` back in. `.mx` never reaches
 *    Solid's plugin at all — its compiled output has no JSX for Solid to see.
 *
 * A suffixed id satisfies all three at once with no configuration on the
 * user's side, which is why the example's `vite.config.ts` is just
 * `plugins: [mx(), solid()]`. `load` reads the real file from disk (strip the
 * suffix) and `transform` prints or compiles it; diagnostics keep the
 * original filename.
 *
 * The path itself comes from Vite's own resolver (`this.resolve`), never from
 * arithmetic here. Doing the path math locally got every non-trivial form
 * wrong: it mangled the importer's directory, treated root-relative and
 * `/@fs/` ids as filesystem paths, and never resolved aliases or bare
 * specifiers at all.
 */
export default function mx(options: MxPluginOptions = {}): Plugin {
  // MX only supports the MX 1.0 subset of Marko syntax, so a caller cannot
  // opt back into `.marko` through `extensions` — that would silently claim
  // support this plugin does not have. Rejected eagerly, at plugin
  // construction, rather than left to surface later as a confusing runtime
  // mismatch.
  if (options.extensions?.some((ext) => ext.endsWith(".marko"))) {
    throw new Error(
      "@mxlang/vite-plugin: '.marko' is not a supported extension — MX only compiles the MX 1.0 subset of Marko syntax under '.mx'.",
    );
  }
  // Longest first: `.mx` is a string suffix of `.solid.mx`, so a caller-
  // supplied `extensions` in the other order must not silently misroute a
  // `.solid.mx` file through the `.mx` (compile()/HTML) branch instead of
  // `.solid.mx` (print()/JSX) — sorting once here makes both `matchExt` and
  // `isMxModule` order-independent regardless of the order `extensions` is
  // given in.
  const extensions = [...(options.extensions ?? DEFAULT_EXTENSIONS)].sort(
    (a, b) => b.length - a.length,
  );
  // A file whose name ends in a multi-dot extension belonging to another MX
  // host is not this plugin's, even when a shorter registered extension is a
  // string suffix of it. Skipped when the caller registered that extension
  // explicitly, so an opt-in `extensions: [".astro.mx"]` still works.
  const isForeign = (file: string): boolean =>
    FOREIGN_EXTENSIONS.some(
      (ext) => file.endsWith(ext) && !extensions.includes(ext),
    );
  /**
   * Which MX modules depend on which tag *locations*, so an edit to a tag can
   * invalidate the callers that used it.
   *
   * A custom tag is an input to compilation that appears nowhere in the
   * importing module's text, so Vite's own module graph has no edge to
   * follow. This records the missing one as each file is transformed.
   *
   * Keyed by **directory as well as file**. Keying by file alone only covers
   * tags that already existed when the scan ran, so creating
   * `tags/new.tag.ts` matched nothing — and `handleHotUpdate` then fell
   * through to `matchExt`, which is undefined for `.tag.ts` — leaving callers
   * serving stale output until a restart. A new file's *directory* is one the
   * scan already recorded, which is what makes the creation observable.
   */
  const tagSources = new Map<string, Set<string>>();

  /** The locations one caller's last scan consulted, so they can be pruned. */
  const scannedFor = new Map<string, Set<string>>();

  /**
   * The tags callable from one MX file: everything discovered around it, with
   * any caller-supplied definition layered on top.
   *
   * Called per transform rather than once per build, because two files in one
   * project can sit under different `tags/` directories. The scan itself is
   * cached and invalidated by mtime, so this costs one filesystem walk per
   * directory per change, not one per file.
   */
  /**
   * Scan diagnostics already reported, so a rebuild does not repeat them.
   *
   * Keyed by the offending file plus its message: the same misconfigured
   * `package.json` is re-read on every transform in that package, and warning
   * once per compiled file would bury the build log in one typo.
   */
  const reported = new Set<string>();

  const tagsFor = (
    file: string,
    warn: (message: string) => void,
  ): Record<string, CustomTag> | undefined => {
    const host = resolveHostPolicy(file).host;
    const scan = scanCached(file, { host });

    // A misconfigured `mx.tags` is not fatal — the local `tags/` directories
    // still work — but it is silent without this, which is worse: an author
    // sees a tag simply not resolve, with nothing saying why.
    for (const diagnostic of scan.diagnostics) {
      const key = `${diagnostic.file}\u0000${diagnostic.message}`;
      if (reported.has(key)) continue;
      reported.add(key);
      warn(`${diagnostic.file}: ${diagnostic.message}`);
    }
    const locations = new Set<string>([
      ...scan.directories,
      ...scan.files.map((entry) => entry.path),
      ...scan.packageFiles,
    ]);

    // Drop this caller from locations its previous scan used and this one
    // does not, so a long-lived dev server's map tracks the project rather
    // than every state the project has ever been in.
    for (const stale of scannedFor.get(file) ?? []) {
      if (locations.has(stale)) continue;
      const dependents = tagSources.get(stale);
      if (!dependents) continue;
      dependents.delete(file);
      if (dependents.size === 0) tagSources.delete(stale);
    }
    scannedFor.set(file, locations);

    for (const location of locations) {
      const dependents = tagSources.get(location) ?? new Set<string>();
      dependents.add(file);
      tagSources.set(location, dependents);
    }

    const discovered = scan.customTags;
    if (!options.customTags) {
      return Object.keys(discovered).length > 0 ? discovered : undefined;
    }
    return { ...discovered, ...options.customTags };
  };

  /** Forgets a caller entirely: it was deleted, or is no longer ours. */
  const forgetCaller = (file: string): void => {
    for (const location of scannedFor.get(file) ?? []) {
      const dependents = tagSources.get(location);
      if (!dependents) continue;
      dependents.delete(file);
      if (dependents.size === 0) tagSources.delete(location);
    }
    scannedFor.delete(file);
  };

  const matchExt = (file: string): string | undefined =>
    isForeign(file) ? undefined : extensions.find((ext) => file.endsWith(ext));
  const isMxModule = (file: string): string | undefined =>
    extensions.find((ext) => file.endsWith(ext + suffixFor(ext)));
  /** `/a/App.solid.mx.tsx` -> `/a/App.solid.mx`; `/a/x.mx.ts` -> `/a/x.mx` */
  const sourcePath = (file: string, ext: string) =>
    file.slice(0, -suffixFor(ext).length);

  return {
    name: "mx",
    enforce: "pre",

    async resolveId(id: string, importer: string | undefined) {
      const [path, suffix] = splitId(id);

      // `?raw`, `?url`, `?worker`: the caller wants the file itself, not the
      // module MX would print. Decline so Vite serves the real MX file —
      // rewriting here would point its raw handler at a path that does not
      // exist on disk.
      if (SPECIAL_QUERY_RE.test(id)) return null;

      // Already rewritten (a re-resolve of our own id): keep it as is.
      if (isMxModule(path) !== undefined) return id;
      const ext = matchExt(path);
      if (ext === undefined) return null;

      // Delegate to Vite: this handles relative ids against the real importer
      // directory, root-relative (`/src/x.mx`) and `/@fs/` forms,
      // `resolve.alias`, and bare specifiers into workspace packages.
      // `skipSelf` stops this hook from recursing into itself.
      const resolved = await this.resolve(id, importer, { skipSelf: true });
      if (!resolved) return null;

      const [resolvedPath, resolvedSuffix] = splitId(resolved.id);
      const resolvedExt = matchExt(resolvedPath);
      if (resolvedExt === undefined) return null;

      // Carry the query across the rewrite. Vite appends its own (`?t=` on an
      // HMR re-fetch, `?import`), and dropping it would turn a cache-busted
      // request into a stale one.
      return resolvedPath + suffixFor(resolvedExt) + (resolvedSuffix || suffix);
    },

    load(id: string) {
      const [path] = splitId(id);
      const ext = isMxModule(path);
      if (ext === undefined) return null;

      // A real `Foo.solid.mx.tsx` on disk is a different module and must not
      // be shadowed: only claim the id when the un-suffixed MX file is the
      // one that actually exists.
      const source = sourcePath(path, ext);
      if (!existsSync(source)) return null;

      return readFileSync(source, "utf8");
    },

    /**
     * Bridges the on-disk file back to the suffixed module.
     *
     * Vite keys its module graph by the resolved id, which for MX is
     * `<path><ext><suffix>` — a path that does not exist on disk. An edit to
     * the real MX file therefore matches no module, so without this hook Vite
     * finds nothing to invalidate and sends no update at all.
     */
    handleHotUpdate(ctx) {
      const [file] = splitId(ctx.file);
      const graph = ctx.server.moduleGraph;

      // A caller that no longer exists should not keep its edges alive.
      if (matchExt(file) !== undefined && !existsSync(file)) forgetCaller(file);

      // An edited, created or deleted tag file — or a `package.json` carrying
      // `mx.tags` — is not itself a module, but every MX file whose scan read
      // it now compiles differently. Invalidate those, so a saved tag reaches
      // the page without a manual reload.
      //
      // Matched by the file *and* by its directory: a newly created
      // `tags/new.tag.ts` was in no scan's file list, so only the directory
      // entry can connect it to the callers that scanned there.
      const dependents = new Set([
        ...(tagSources.get(file) ?? []),
        ...(tagSources.get(dirname(file)) ?? []),
      ]);
      if (dependents.size > 0) {
        const stale = [...dependents]
          .map((dependent) => {
            const dependentExt = matchExt(dependent);
            return dependentExt === undefined
              ? undefined
              : graph.getModuleById(dependent + suffixFor(dependentExt));
          })
          .filter((mod) => mod !== undefined && mod !== null);
        for (const mod of stale) graph.invalidateModule(mod);
        if (stale.length > 0) return [...ctx.modules, ...stale];
      }

      const ext = matchExt(file);
      if (ext === undefined) return;

      const mod = graph.getModuleById(file + suffixFor(ext));
      if (!mod) return;

      graph.invalidateModule(mod);
      return [...ctx.modules, mod];
    },

    async transform(code: string, id: string) {
      const [path] = splitId(id);
      const ext = isMxModule(path);
      if (ext === undefined) return null;

      // Rollup's own warning channel, so a misconfigured `mx.tags` reaches the
      // build log and the dev-server overlay the way any other plugin warning
      // does. `this` is the plugin context here; captured because `tagsFor`
      // runs below inside a `try`.
      const context = this as unknown as { warn?: (message: string) => void };
      const warn = (message: string): void => {
        if (context.warn) context.warn(`@mxlang/vite-plugin: ${message}`);
        else console.warn(`@mxlang/vite-plugin: ${message}`);
      };

      // Print/compile against the real MX path so the source map and any
      // error position name the file the user actually wrote.
      const source = sourcePath(path, ext);

      try {
        if (ext === ".mx") {
          // `compile()`'s map is presently an identity placeholder (no AST
          // is printed on this path), so there is nothing real to hand Vite
          // — returning it would claim a mapping that does not exist.
          const { code: compiled } = await compileMarko(
            code,
            source,
            options.strict ?? false,
            tagsFor(source, warn),
          );
          return { code: compiled, map: null };
        }

        // `.solid.mx` reaches its host through the parser, which lowers each
        // MX region with `compileSolidMx`; the registered tags have to travel
        // with it or a tag registered here is unknown inside a `.solid.mx`.
        const { code: printed, map } = print(code, source, {
          customTags: tagsFor(source, warn),
        });
        return { code: printed, map };
      } catch (err) {
        if (!isSyntaxError(err) || !err.loc) throw err;

        // Re-raise with the shape Vite's overlay reads, so the reported
        // position is the MX source line rather than a position inside text
        // the user never wrote.
        const wrapped = err as MxSyntaxError & {
          id?: string;
          frame?: string;
          loc: { file: string; line: number; column: number };
        };

        // Babel appends its own 1-based `(line:column)` to the message while
        // `loc.column` is 0-based. Leaving both in place shows the reader two
        // different columns for one error, so drop the suffix and let `loc`
        // and `frame` carry the position.
        wrapped.message = err.message.replace(/\s*\(\d+:\d+\)\s*$/, "");
        wrapped.id = source;
        wrapped.loc = {
          file: source,
          line: err.loc.line,
          column: err.loc.column,
        };
        wrapped.frame = codeFrame(code, err.loc.line, err.loc.column);

        throw wrapped;
      }
    },
  };
}
