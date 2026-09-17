/**
 * The Vite plugin that feeds a lowered `.amx` file to Astro's own
 * compiler (decision 76c).
 *
 * ## The mechanism, and why it is the only one
 *
 * Astro compiles a component in its `astro:build` plugin, whose `transform`
 * hook is filtered twice on the module id — measured against the pinned
 * `astro@7.3.2`:
 *
 * ```js
 *       transform: {
 *         filter: {
 *           id: {
 *             include: [/\.astro$/, /\.astro\?/],
 *             exclude: [specialQueriesRE, /(?:\?|&)astro(?:&|=|$)/]
 *           }
 *         },
 *         async handler(source, id) {
 *           const parsedId = parseAstroRequest(id);
 *           if (!parsedId.filename.endsWith(".astro")) {
 *             return;
 *           }
 * ```
 *
 * Both gates require the id to end in `.astro`. So an `enforce: "pre"`
 * transform on the real `.amx` id cannot work — Astro's plugin never
 * matches it, and the lowered source would simply be handed to rolldown as
 * plain JS. The only mechanism that reaches Astro's compiler is to make the
 * module id itself end in `.astro`: `resolveId` appends the suffix, and `load`
 * returns the lowered source for that virtual id. Astro's plugin then matches,
 * compiles, and produces its own component module and source map.
 *
 * This mirrors what `@mxlang/vite-plugin` already does for `.solid.mx` and
 * `.mx` (a `.tsx`/`.ts` suffix, for the same class of reason: three stages
 * downstream dispatch on the file extension), so the shape is the codebase's
 * own, not new machinery.
 *
 * The suffixed path comes from **Vite's own resolver**, never from path
 * arithmetic: `resolveId` calls `this.resolve(id, importer, { skipSelf: true })`
 * and appends the suffix to whatever comes back. That is what makes relative
 * ids from nested importers, root-relative and `/@fs/` ids, `resolve.alias`
 * entries and bare specifiers into workspace packages all work — computing the
 * path locally gets each of those wrong.
 */

import { existsSync, readFileSync } from "node:fs";
import { type CustomTag, getCustomTags } from "@mxlang/core";
import type { Plugin } from "vite";
import { AstroTemplateError, lowerAstroMx } from "./astro-template.ts";

/**
 * The extension an MX-templated Astro component is written with (decision 78).
 *
 * A single constant, referenced everywhere this extension is matched (here and
 * in the Zed language definition), so a change of spelling is a one-line edit.
 *
 * **Single-dot, deliberately.** The obvious spelling was `.astro.mx`, and it
 * works for components — but not for pages: Astro's route collection keys on
 * `path.extname(basename)`, which returns only the **last** extension, so
 * `.astro.mx` can never be registered with `addPageExtension`. Measured against
 * `astro@7.3.2`: a `page.astro.mx` under `src/pages` is skipped entirely, or —
 * once `.mx` is registered as a page extension — routed to `/page.astro/`,
 * with a literal `.astro` in the URL. `.amx` has one extension segment, so
 * components, layouts and pages all work from the same spelling.
 */
export const ASTRO_MX_EXT = ".amx";

/**
 * Appended to the resolved path so Astro's own plugin claims the module.
 *
 * See the note above: Astro's `transform` filter requires an id ending in
 * `.astro`, twice over.
 */
export const ASTRO_SUFFIX = ".astro";

/**
 * Queries that mean "do not give me this module's compiled form".
 *
 * Mirrors Vite's own `SPECIAL_QUERY_RE` and `@mxlang/vite-plugin`'s copy of
 * it. `?raw` wants the file's text, `?url` its URL — in every case Vite serves
 * the real file, so this plugin must not claim the id or lower it.
 */
const SPECIAL_QUERY_RE = /[?&](?:worker|sharedworker|raw|url)\b/;

/** Splits a module id into its path and its `?query`/`#hash` suffix. */
function splitId(id: string): [path: string, suffix: string] {
  const index = id.search(/[?#]/);
  return index === -1 ? [id, ""] : [id.slice(0, index), id.slice(index)];
}

/** `/a/Base.amx.astro` -> `/a/Base.amx`, or undefined. */
function sourcePath(path: string): string | undefined {
  if (!path.endsWith(ASTRO_SUFFIX)) return undefined;
  const real = path.slice(0, -ASTRO_SUFFIX.length);
  return real.endsWith(ASTRO_MX_EXT) ? real : undefined;
}

/** A one-line code frame: the offending line plus a caret under `column`. */
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
 * Lowers `.amx` files to Astro template syntax, ahead of Astro's own
 * plugin.
 *
 * `enforce: "pre"` so `resolveId` runs before Vite's default resolution
 * settles the id. Astro's own plugin is also `enforce: "pre"`, but the two
 * never contend: this one owns `.amx`, and hands Astro an id ending in
 * `.astro`, which is the only thing Astro's plugin looks at.
 */
export function mxTemplates(customTags?: Record<string, CustomTag>): Plugin {
  /**
   * The tags callable from one `.amx` file: everything discovered around it
   * (spec §4), with a caller-supplied definition winning over a discovered
   * one of the same name.
   *
   * `.mx` gets the same treatment one plugin over, inside
   * `@mxlang/vite-plugin`; doing it here keeps the two file kinds consistent
   * rather than leaving `.amx` the one place a `tags/` directory is invisible.
   */
  const tagsFor = (file: string): Record<string, CustomTag> | undefined => {
    const discovered = getCustomTags(file, { host: "astro" });
    const merged = customTags ? { ...discovered, ...customTags } : discovered;
    return Object.keys(merged).length > 0 ? merged : undefined;
  };

  return {
    name: "mx-astro-templates",
    enforce: "pre",

    async resolveId(id: string, importer: string | undefined) {
      const [path, suffix] = splitId(id);

      // `?raw`, `?url`, `?worker`: the caller wants the file itself, not the
      // module this plugin would lower. Decline so Vite serves the real file.
      if (SPECIAL_QUERY_RE.test(id)) return null;

      // Already rewritten (a re-resolve of our own id): keep it as is.
      if (sourcePath(path) !== undefined) return id;
      if (!path.endsWith(ASTRO_MX_EXT)) return null;

      const resolved = await this.resolve(id, importer, { skipSelf: true });
      if (!resolved) return null;

      const [resolvedPath, resolvedSuffix] = splitId(resolved.id);
      if (!resolvedPath.endsWith(ASTRO_MX_EXT)) return null;

      // Carry the query across the rewrite: Vite appends its own (`?t=` on an
      // HMR re-fetch, `?import`), and dropping it turns a cache-busted request
      // into a stale one.
      return resolvedPath + ASTRO_SUFFIX + (resolvedSuffix || suffix);
    },

    /**
     * Bridges the on-disk `.amx` file back to its virtual module.
     *
     * Vite keys its module graph by the *resolved* id, which for AstroMX is
     * `<path>.amx.astro` — a path that does not exist on disk. An edit to the
     * real `.amx` file therefore matches no module, so without this hook Vite
     * finds nothing to invalidate and sends no update at all: `astro dev`
     * would serve the previously compiled output until a manual restart.
     *
     * The same hook, for the same reason, as `@mxlang/vite-plugin`'s `mx()`
     * (see its own `handleHotUpdate`) — that plugin synthesizes
     * `<path>.solid.mx.tsx`/`<path>.mx.ts` ids the identical way.
     */
    handleHotUpdate(ctx) {
      const [file] = splitId(ctx.file);
      if (!file.endsWith(ASTRO_MX_EXT)) return;

      const graph = ctx.server.moduleGraph;
      const mod = graph.getModuleById(file + ASTRO_SUFFIX);
      if (!mod) return;

      graph.invalidateModule(mod);
      return [...ctx.modules, mod];
    },

    load(id: string) {
      const [path] = splitId(id);
      const real = sourcePath(path);
      if (real === undefined) return null;

      // A real `Foo.amx.astro` checked into a project is a different
      // module and must not be shadowed: only claim the id when the
      // un-suffixed `.amx` file is the one that actually exists.
      if (!existsSync(real)) return null;

      const source = readFileSync(real, "utf8");
      try {
        return lowerAstroMx(source, real, { customTags: tagsFor(real) }).code;
      } catch (error) {
        if (!(error instanceof AstroTemplateError)) throw error;

        // Re-raise with the shape Vite's overlay reads, so the reported
        // position is the `.amx` source line rather than a position
        // inside text the author never wrote. `parseFragment` has already
        // shifted the position past the fence, so the line is the real one.
        const wrapped = error as AstroTemplateError & {
          id?: string;
          frame?: string;
          loc?: { file: string; line: number; column: number };
        };
        wrapped.id = real;
        wrapped.loc = {
          file: real,
          line: error.line,
          column: error.column,
        };
        wrapped.frame = codeFrame(source, error.line, error.column);
        throw wrapped;
      }
    },
  };
}
