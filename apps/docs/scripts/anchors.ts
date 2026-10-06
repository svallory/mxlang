/**
 * The fragment-link gate for the built site.
 *
 * `docmd validate` checks that a link's *page* exists; nothing in the docs
 * pipeline checked the `#fragment`. docmd's heading ids are not the plain
 * slug a reader can derive from the markdown: `headingIdPlugin`
 * (`@docmd/parser/dist/markdown-processor.js:97-150`) prefixes a heading with
 * the id of its nearest preceding parent heading and the page's own `# Title`
 * is the root of that chain, so `#the-idea` under a page titled "Angular" is
 * really `#angular-the-idea`. Twenty-one links in the docs had been written
 * with the plain slug and did not resolve on the built site.
 *
 * Only the built HTML knows the answer, so this walks `apps/docs/site`: every
 * `href` with a fragment is resolved against the ids of the page it points at
 * (the containing page for a bare `#frag`, the site root for a root-relative
 * `/page/#frag`, the file's own directory for a relative one), and anything
 * without a matching `id` is reported as `page: href -> missing id`.
 *
 * This is deliberately a walk of the *output*, not of the markdown: a
 * reproduction of docmd's slug algorithm would be a second implementation of
 * a rule that lives in a dependency, and it would silently go stale when
 * docmd changes how it derives ids. The same reasoning is why the check runs
 * after `docmd build` (see `build-home.ts --check`, which reads `site/` for
 * the same reason).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** `apps/docs/site`, where `docmd build` writes; the walk's only input. */
export const siteRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "site");

// `sep` is used to normalize the relative paths in the report to posix.

/** A fragment href on the built site that no page in the site can resolve. */
export type BrokenAnchor = {
  /** The page carrying the link, site-root-relative (`language/atoms/index.html`). */
  from: string;
  /** The href as written, e.g. `/custom-tags/sidecars/#atoms-in-contracts`. */
  href: string;
  /** The fragment that resolved to nothing. */
  fragment: string;
  /** The page the href points at, site-root-relative, or `null` if it has none. */
  to: string | null;
};

/** `href="…"` and `href='…'`; the site is minified onto few lines, so no line-based parse. */
const HREF_RE = /href\s*=\s*"([^"]*)"|href\s*=\s*'([^']*)'/g;
/** Every `id="…"` in a page. */
const ID_RE = /\sid\s*=\s*"([^"]*)"/g;

/** Hrefs that name somewhere other than this site. */
function isExternal(href: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(href) || // http:, mailto:, tel:, https:
    href.startsWith("//") // protocol-relative
  );
}

/** Every `.html` file under `siteDir`, sorted so the report is stable. */
export function siteHtmlFiles(siteDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".html")) found.push(full);
    }
  };
  walk(siteDir);
  return found;
}

/**
 * The ids a built page offers, decoded: docmd writes the slug it computed,
 * which is already percent-free, but a link can percent-encode one.
 */
export function pageIds(html: string): Set<string> {
  const ids = new Set<string>();
  for (const match of html.matchAll(ID_RE)) {
    ids.add(safeDecode(match[1]));
  }
  return ids;
}

/** `decodeURIComponent` that keeps a malformed escape literal instead of throwing. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The file a fragment href points at, or `null` when it names no page in
 * this site (an asset, a path the build never emitted).
 *
 * Root-relative hrefs resolve from `siteDir`; a relative one from the
 * directory of the page carrying it; a bare `#frag` is that same page, which
 * the caller answers by passing its own file.
 */
export function resolveTarget(
  href: string,
  fromFile: string,
  siteDir: string,
): string | null {
  const path = href.split("#")[0].split("?")[0] ?? "";
  if (path === "") return fromFile;

  let candidates: string[];
  if (path.startsWith("/")) {
    candidates = [resolve(join(siteDir, path))];
  } else {
    candidates = [resolve(dirname(fromFile), path)];
  }

  // docmd emits `<page>/index.html`; accept the other shapes a reader can
  // write for the same page (`<page>.html`) so the check judges the link, not
  // the spelling.
  for (const base of candidates) {
    if (existsSync(join(base, "index.html"))) return join(base, "index.html");
    if (existsSync(`${base}.html`)) return `${base}.html`;
  }
  return null;
}

/**
 * Every fragment href on the built site that resolves to no id.
 *
 * An empty array is the only acceptable answer; the caller reports them as
 * `page: href -> missing id`.
 */
export function findBrokenAnchors(siteDir: string): BrokenAnchor[] {
  const broken: BrokenAnchor[] = [];
  const files = siteHtmlFiles(siteDir);
  /** id sets per file, so a site with many cross-page links reads each page once. */
  const idsByFile = new Map<string, Set<string>>();

  const idsOf = (file: string): Set<string> => {
    const cached = idsByFile.get(file);
    if (cached) return cached;
    const ids = pageIds(readFileSync(file, "utf8"));
    idsByFile.set(file, ids);
    return ids;
  };

  for (const from of files) {
    const html = readFileSync(from, "utf8");
    for (const match of html.matchAll(HREF_RE)) {
      const href = match[1] ?? match[2] ?? "";
      if (isExternal(href) || !href.includes("#")) continue;
      const fragment = safeDecode(href.slice(href.indexOf("#") + 1));
      if (fragment === "") continue;
      const target = resolveTarget(href, from, siteDir);
      const ok = target !== null && idsOf(target).has(fragment);
      if (ok) continue;
      broken.push({
        from: relative(siteDir, from).split(sep).join(posix.sep),
        href,
        fragment,
        to: target === null ? null : relative(siteDir, target).split(sep).join(posix.sep),
      });
    }
  }
  return broken;
}

/** One `page: href -> missing id` line per broken link, in report order. */
export function formatBrokenAnchors(broken: BrokenAnchor[]): string[] {
  return broken.map((b) => `${b.from}: ${b.href} -> missing id`);
}
