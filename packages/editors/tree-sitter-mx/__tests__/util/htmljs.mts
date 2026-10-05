// Resolves htmljs-parser (the reference implementation the tests compare
// against) and its test fixtures. The parser and the fixtures must always be
// the *same* htmljs-parser revision, otherwise behavioral differences between
// versions show up as spurious test failures.
//
// MX: upstream degits htmljs-parser's unpinned HEAD, so its suite fails
// whenever htmljs-parser moves ahead of the grammar (53 failures against
// htmljs-parser 5.18.0 at upstream 7fb2038). This copy pins the revision the
// grammar was released against instead: v5.12.0, tagged the same day as
// @marko/tree-sitter 0.2.0 and carrying the same "comments between concise
// mode line attributes" feature. Bump HTMLJS_REV together with a grammar
// bump, never on its own.
//
//  - HTMLJS_FIXTURES override: point at any htmljs-parser `src/__tests__/
//    fixtures` directory and the adjacent `src` is used as the parser too.
//  - otherwise the pinned revision is fetched with git into `.cache/`
//    (gitignored) once, and reused.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** marko-js/htmljs-parser v5.12.0 (2026-06-26). */
export const HTMLJS_REV = "16f453a6d86502c24578c339d17bc5ba81257539";
const HTMLJS_REPO = "https://github.com/marko-js/htmljs-parser";

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(here, `../../.cache/htmljs-parser-${HTMLJS_REV}`);

export interface HtmljsApi {
  createParser: (typeof import("htmljs-parser"))["createParser"];
  ErrorCode: (typeof import("htmljs-parser"))["ErrorCode"];
  TagType: (typeof import("htmljs-parser"))["TagType"];
}

async function importSrc(src: string): Promise<HtmljsApi> {
  // The htmljs-parser sources transpile to CJS in a way node's named-export
  // detection can't statically analyze; merge the namespaces at runtime.
  const htmljs = (await import(
    pathToFileURL(path.join(src, "index.ts")).href
  )) as any;
  const internal = (await import(
    pathToFileURL(path.join(src, "internal.ts")).href
  )) as any;
  return {
    ...(htmljs.default ?? htmljs),
    ...(internal.default ?? internal),
  } as HtmljsApi;
}

export async function loadHtmljs(): Promise<HtmljsApi> {
  // The parser source lives at `<root>/src`, fixtures at `<root>/src/
  // __tests__/fixtures`, so the parser is always two levels up from the
  // fixtures — keeping the reference parser and the fixtures in lockstep.
  const src = path.join(await fixturesDir(), "../..");
  if (!fs.existsSync(path.join(src, "index.ts"))) {
    throw new Error(`no htmljs-parser sources next to the fixtures at ${src}`);
  }
  return importSrc(src);
}

function fetchPinned() {
  const tmp = `${CACHE}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", tmp, ...args], { stdio: "pipe" });
  git("init", "--quiet");
  git("fetch", "--quiet", "--depth", "1", HTMLJS_REPO, HTMLJS_REV);
  git("checkout", "--quiet", "FETCH_HEAD");
  const head = git("rev-parse", "HEAD").toString().trim();
  if (head !== HTMLJS_REV) {
    throw new Error(`fetched ${head}, expected htmljs-parser ${HTMLJS_REV}`);
  }
  fs.rmSync(path.join(tmp, ".git"), { recursive: true, force: true });
  fs.renameSync(tmp, CACHE);
}

export async function fixturesDir(): Promise<string> {
  if (process.env.HTMLJS_FIXTURES) return process.env.HTMLJS_FIXTURES;

  const cached = path.join(CACHE, "src/__tests__/fixtures");
  if (!fs.existsSync(cached)) fetchPinned();
  return cached;
}
