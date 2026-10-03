/**
 * The pages-directory guard (decision 134, addendum).
 *
 * An `.astro.mx` file is an Astro component or layout, never a page. Astro's
 * route collection strips only the **last** extension of a file under
 * `src/pages`, so `about.astro.mx` becomes the route `/about.astro` (measured
 * on astro 7.3.2, `create-manifest.js`), and `injectRoute` cannot repair it.
 * The integration therefore refuses the file instead of letting it route to a
 * URL nobody wrote, and puts the fix in the message.
 */

import { type Dirent, readdirSync, realpathSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ASTRO_MX_EXT } from "./vite-templates.ts";

/**
 * Whether Astro's route walk looks at `basename` at all. Mirrors the two
 * skips in `create-manifest.js:88-96` (astro 7.3.2) exactly: a name (the
 * basename without its last extension) starting with `_`, and a basename
 * starting with `.` except `.well-known`, which Astro does walk into.
 */
function astroWalksInto(basename: string): boolean {
  const ext = extname(basename);
  const name = ext ? basename.slice(0, -ext.length) : basename;
  if (name[0] === "_") return false;
  if (basename[0] === "." && basename !== ".well-known") return false;
  return true;
}

/**
 * Every `.astro.mx` file Astro would treat as a route under `pagesDir`,
 * sorted. Follows Astro's walk: the skip rule above, and symlinked
 * directories are entered because Astro asks `fs.statSync(...).isDirectory()`,
 * which follows links (`create-manifest.js:92`). Real paths are tracked so a
 * link cycle ends; a dangling link is skipped. A missing directory has no
 * pages.
 */
export function findAstroMxPages(pagesDir: string): string[] {
  const found: string[] = [];
  const active = new Set<string>();
  const walk = (dir: string): void => {
    let real: string;
    let entries: Dirent[];
    try {
      real = realpathSync(dir);
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Only the directories on the current path: a cycle revisits one, while a
    // directory reachable through two links is walked (and reported) twice,
    // as Astro creates a route for each.
    if (active.has(real)) return;
    active.add(real);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!astroWalksInto(entry.name)) continue;
      const path = join(dir, entry.name);
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDir = statSync(path).isDirectory();
        } catch {
          continue;
        }
      }
      if (isDir) walk(path);
      else if (entry.name.endsWith(ASTRO_MX_EXT)) found.push(path);
    }
    active.delete(real);
  };
  walk(pagesDir);
  return found;
}

/**
 * The error text for `files`, one positioned line per file (`path:1:1`, the
 * file as a whole), each carrying why and the fix. Every file is listed, not
 * only the first.
 */
export function astroMxPagesMessage(files: string[], pagesDir: string): string {
  const lines = files.map((file) => {
    const page = relative(pagesDir, file);
    const route = page.slice(0, -ASTRO_MX_EXT.length);
    const base = route.split(/[\\/]/).pop() ?? route;
    // The route the author meant: an `index` file is its directory's route.
    const intended =
      base === "index"
        ? `/${route.slice(0, -"index".length)}`.replace(/(.)\/$/, "$1")
        : `/${route}`;
    const head = `${file}:1:1: \`${page}\` cannot be a page: Astro routes it to /${route}.astro, not ${intended}.`;
    if (base.includes("[")) {
      return (
        `${head} Astro reads it as a dynamic route ending in \`.astro\` and ` +
        `then requires \`getStaticPaths()\`. Write the page as \`${base}.mx\`, ` +
        `or write \`${base}.astro\` and import the \`${ASTRO_MX_EXT}\` ` +
        `component from it.`
      );
    }
    return (
      `${head} Write \`${base}.astro\` and import the \`${ASTRO_MX_EXT}\` ` +
      `component from it, or write the page as \`${base}.mx\`.`
    );
  });
  return `@mxlang/astro: ${files.length} \`${ASTRO_MX_EXT}\` file${files.length === 1 ? "" : "s"} under the pages directory (\`${ASTRO_MX_EXT}\` is for components and layouts, decision 134):\n${lines.join("\n")}`;
}

/** Throws the error for every `.astro.mx` file under `<srcDir>/pages`. */
export function assertNoAstroMxPages(srcDir: URL): void {
  const pagesDir = fileURLToPath(new URL("pages/", srcDir));
  const files = findAstroMxPages(pagesDir);
  if (files.length > 0) {
    throw new Error(astroMxPagesMessage(files, pagesDir));
  }
}
