// Writes `THIRD-PARTY-NOTICES.md` beside the bundles that inline code from
// outside MX: the licence text of every package a bundle carries. Bun's
// unminified output starts each inlined module with a `// <path>` comment,
// relative to the directory Bun ran in; `inlinedThirdParty` reads those
// comments, so the notice lists what the build actually inlined rather than a
// list that can go stale:
//
// - a module under `node_modules/` is an npm package: a section with its
//   `name version` and its licence file;
// - a module in another workspace package's `dist/` is followed into that
//   file (Bun drops an inlined file's own comments when it re-bundles a dist);
// - any other workspace module whose nearest licence file is not MX's own
//   (the repository's `LICENSE`) is vendored code: a section for its dir, or
//   the fork's section when the licence is `packages/babel/LICENSE`.
//
// `@mxlang/babel` is a vendored copy of `@babel/parser`
// (`packages/babel/UPSTREAM.md`) that imports `@babel/helper-validator-identifier`
// and `charcodes`; a file that contains `BABEL_FORK_MARKER`, a method only the
// fork defines, gets the fork's section and both helpers' whatever its
// comments say. A JS file with its own `<stem>.NOTICES.md` beside it (core's
// `marko-frontend.cjs`) is covered by that notice and never scanned.
//
// `bun scripts/third-party-notices.ts <outDir>`, run from a package's `build`
// after its last bundle step, writes into `<outDir>` and fails when nothing
// there inlines third-party code. `bundledBuild` (`scripts/bundled-build.ts`)
// calls `writeThirdPartyNotices` with `required: false`;
// `scripts/pack-hygiene.ts` (`noticeProblems`) checks every tarball packs a
// notice with exactly the sections its JS files need.

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** A method name only the fork defines (`packages/babel/UPSTREAM.md` item 5). */
export const BABEL_FORK_MARKER = "jsxParseElementAtOriginal";
/** The notice's file name, written beside the bundles it covers. */
export const NOTICES_FILE = "THIRD-PARTY-NOTICES.md";

/** The repository root: workspace paths are judged relative to it. */
export const REPO_ROOT = path.resolve(import.meta.dirname, "..");

const babelDir = path.join(REPO_ROOT, "packages/babel");
const fromBabel = createRequire(path.join(babelDir, "package.json"));

interface Manifest {
  name: string;
  version: string;
  license?: string;
  author?: string;
}

/** The directory of an installed package, found through its `package.json`. */
function installedDir(name: string): string {
  return path.dirname(fromBabel.resolve(`${name}/package.json`));
}

function manifestOf(dir: string): Manifest {
  return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
}

/** The first file of `dir` named `licen[cs]e…`, by name, or undefined. */
function licenceFileIn(dir: string): string | undefined {
  const name = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^licen[cs]e/i.test(entry.name))
    .map((entry) => entry.name)
    .sort()[0];
  return name === undefined ? undefined : path.join(dir, name);
}

function licenceOf(dir: string): string | undefined {
  const file = licenceFileIn(dir);
  return file ? readFileSync(file, "utf8").trim() : undefined;
}

/** The fork's upstream tag (`v7.29.0`), from `packages/babel/UPSTREAM.md`. */
export function upstreamTag(): string {
  const upstream = readFileSync(path.join(babelDir, "UPSTREAM.md"), "utf8");
  const tag = /^- Tag: `(v[^`]+)`/m.exec(upstream)?.[1];
  if (!tag) {
    throw new Error("packages/babel/UPSTREAM.md names no `- Tag:` line");
  }
  return tag;
}

/** The standard MIT text, for a dependency that ships no licence file. */
function standardMit(holder: string): string {
  return `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
}
/** MIT text for a package whose manifest names MIT and an author but ships no file. */
function noFileLicence(manifest: Manifest): string {
  if (manifest.license !== "MIT" || !manifest.author) {
    throw new Error(
      `${manifest.name} ships no licence file and its package.json does not name MIT and an author: add its notice by hand`,
    );
  }
  return `${standardMit(manifest.author)}

(${manifest.name} ships no licence file; the licence and author are from its package.json, which gives no copyright year.)`;
}

/** One section of a notice: `## <heading>`, then `text`. */
export interface ThirdPartyEntry {
  heading: string;
  text: string;
}

/** An entry with its place in a notice: the fork, vendored dirs, npm packages. */
interface RankedEntry extends ThirdPartyEntry {
  rank: 0 | 1 | 2;
}

/** The npm entry of the package installed in `dir`. */
function npmEntry(dir: string): RankedEntry {
  const manifest = manifestOf(dir);
  return {
    rank: 2,
    heading: `${manifest.name} ${manifest.version}`,
    text: licenceOf(dir) ?? noFileLicence(manifest),
  };
}

/** The fork's section and its two helpers'. */
function forkEntries(): RankedEntry[] {
  const tag = upstreamTag();
  return [
    {
      rank: 0,
      heading: `@babel/parser ${tag.slice(1)} (vendored as \`@mxlang/babel\`)`,
      text: [
        `Source: https://github.com/babel/babel, tag \`${tag}\`, \`packages/babel-parser/src\``,
        "(the MX JSX changes are listed in `packages/babel/UPSTREAM.md` in the repository).",
        "MIT licence:",
        "",
        readFileSync(path.join(babelDir, "LICENSE"), "utf8").trim(),
      ].join("\n"),
    },
    ...["@babel/helper-validator-identifier", "charcodes"].map((name) =>
      npmEntry(installedDir(name)),
    ),
  ];
}

/** `entries` deduplicated by heading: the fork, then vendored, then npm, each by heading. */
function ordered(entries: Iterable<RankedEntry>): RankedEntry[] {
  const byHeading = new Map<string, RankedEntry>();
  for (const entry of entries) {
    if (!byHeading.has(entry.heading)) byHeading.set(entry.heading, entry);
  }
  return [...byHeading.values()].sort((a, b) =>
    a.rank !== b.rank
      ? a.rank - b.rank
      : a.heading < b.heading
        ? -1
        : a.heading > b.heading
          ? 1
          : 0,
  );
}

/** Bun's per-module comment: `// <path>` alone on a line. */
const MODULE_COMMENT = /^\/\/ (\S+\.(?:[cm]?[jt]sx?|json))$/gm;

/** The package dir of a real path under `node_modules/` (scope-aware). */
function npmPackageDir(real: string): string {
  const at = real.lastIndexOf("/node_modules/") + "/node_modules/".length;
  const [first = "", second = ""] = real.slice(at).split("/");
  return (
    real.slice(0, at) + (first.startsWith("@") ? `${first}/${second}` : first)
  );
}

/** The nearest ancestor of `file` (exclusive) holding a `package.json`. */
function packageDirOf(file: string, repoRoot: string): string {
  let dir = path.dirname(file);
  while (!existsSync(path.join(dir, "package.json"))) {
    const up = path.dirname(dir);
    if (dir === repoRoot || up === dir) {
      throw new Error(`${file} is in no package (no package.json above it)`);
    }
    dir = up;
  }
  return dir;
}

/** The ranked entries `file` inlines; `visited` stops a dist cycle. */
function scan(
  file: string,
  baseDir: string,
  repoRoot: string,
  visited: Set<string>,
): RankedEntry[] {
  const real = realpathSync(file);
  if (visited.has(real)) return [];
  visited.add(real);
  const source = readFileSync(real, "utf8");
  const entries: RankedEntry[] = [];
  let fork = source.includes(BABEL_FORK_MARKER);
  const rootLicence = readFileSync(path.join(repoRoot, "LICENSE"));
  const forkLicence = path.join(repoRoot, "packages/babel/LICENSE");
  const npmDirs = new Set<string>();
  const licenceDirs = new Set<string>();
  const licenceByDir = new Map<string, string>();
  for (const [, comment = ""] of source.matchAll(MODULE_COMMENT)) {
    const resolved = path.resolve(baseDir, comment);
    if (!existsSync(resolved)) {
      throw new Error(
        `${file}: module comment ${comment} does not resolve from ${baseDir}`,
      );
    }
    const module = realpathSync(resolved);
    if (module.includes("/node_modules/")) {
      npmDirs.add(npmPackageDir(module));
      continue;
    }
    const relative = path.relative(repoRoot, module);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(
        `${file}: module comment ${comment} resolves outside the repository, to ${module}`,
      );
    }
    if (relative.split(path.sep).includes("dist")) {
      entries.push(
        ...scan(module, packageDirOf(module, repoRoot), repoRoot, visited),
      );
      continue;
    }
    const moduleDir = path.dirname(module);
    const licence =
      licenceByDir.get(moduleDir) ?? nearestLicence(moduleDir, repoRoot);
    licenceByDir.set(moduleDir, licence);
    if (licence === forkLicence) {
      fork = true;
    } else if (!readFileSync(licence).equals(rootLicence)) {
      licenceDirs.add(path.dirname(licence));
    }
  }
  for (const dir of licenceDirs) {
    const where = path.relative(repoRoot, dir).split(path.sep).join("/");
    entries.push({
      rank: 1,
      heading: `Vendored code in \`${where}\``,
      text: readFileSync(licenceFileIn(dir) as string, "utf8").trim(),
    });
  }
  for (const dir of npmDirs) entries.push(npmEntry(dir));
  if (fork) entries.push(...forkEntries());
  return entries;
}

/** The first `licen[cs]e…` file walking up from `dir` to `repoRoot`. */
function nearestLicence(dir: string, repoRoot: string): string {
  for (let at = dir; ; at = path.dirname(at)) {
    const file = licenceFileIn(at);
    if (file) return file;
    if (at === repoRoot || path.dirname(at) === at) {
      throw new Error(`no licence file between ${dir} and ${repoRoot}`);
    }
  }
}

/**
 * What `file` inlines from outside MX, read from Bun's `// <path>` module
 * comments resolved against `baseDir` (the directory Bun ran in), one entry
 * per npm package (`name version`) and per vendored workspace dir, plus the
 * fork's (with its two helpers) when `file` carries `BABEL_FORK_MARKER` or
 * inlines `packages/babel`. Deduplicated by heading and ordered: the fork,
 * then vendored dirs, then npm packages, each by heading. Throws when a
 * comment does not resolve: a wrong `baseDir` must fail, never come back empty.
 */
export function inlinedThirdParty(
  file: string,
  baseDir: string,
  repoRoot: string = REPO_ROOT,
): ThirdPartyEntry[] {
  return ordered(scan(file, baseDir, realpathSync(repoRoot), new Set())).map(
    ({ heading, text }) => ({ heading, text }),
  );
}

/** Each JS file of `files` that is not covered by its own `<stem>.NOTICES.md`. */
function scannedJs(files: readonly string[]): string[] {
  return files
    .filter((f) => /\.(c|m)?js$/.test(f))
    .filter((f) => !files.includes(f.replace(/\.(c|m)?js$/, ".NOTICES.md")))
    .sort();
}

/** The ranked entries of each carrier among `files`, sorted by file. */
function carrierEntries(
  dir: string,
  files: readonly string[],
  baseDir: string,
  repoRoot: string,
): [string, RankedEntry[]][] {
  const root = realpathSync(repoRoot);
  return scannedJs(files)
    .map((f): [string, RankedEntry[]] => [
      f,
      ordered(scan(path.join(dir, f), baseDir, root, new Set())),
    ])
    .filter(([, entries]) => entries.length > 0);
}

/**
 * The JS files of `files` (paths relative to `dir`) that inline third-party
 * code, sorted, their comments resolved against `baseDir`. Declarations and
 * other files are never carriers, nor is a file `<stem>.<ext>` when `files`
 * also holds `<stem>.NOTICES.md` beside it: that notice covers it, and it is
 * not scanned.
 */
export function thirdPartyCarriers(
  dir: string,
  files: readonly string[],
  baseDir: string,
  repoRoot: string = REPO_ROOT,
): string[] {
  return carrierEntries(dir, files, baseDir, repoRoot).map(([f]) => f);
}

/** The notice for `carriers`: the union of their `entries`, in notice order. */
function noticeText(
  carriers: readonly string[],
  entries: Iterable<RankedEntry>,
): string {
  const listed = carriers.map((f) => `\`${f}\``).join(", ");
  const lines = [
    `# Third-party code in ${carriers.join(", ")}`,
    "",
    `${listed} ${carriers.length === 1 ? "bundles" : "bundle"} the code below. Each is distributed under its own licence.`,
  ];
  for (const { heading, text } of ordered(entries)) {
    lines.push("", `## ${heading}`, "", text);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Writes `<outDir>/THIRD-PARTY-NOTICES.md` naming the top-level JS files of
 * `outDir` that inline third-party code (comments resolved against
 * `baseDir`), with a section for each package they inline, and returns those
 * files. When none does, throws if `required` (a build that should inline
 * third-party code no longer does) and otherwise writes nothing and returns
 * `[]`.
 */
export function writeThirdPartyNotices(
  outDir: string,
  {
    required,
    baseDir = process.cwd(),
    repoRoot = REPO_ROOT,
  }: { required: boolean; baseDir?: string; repoRoot?: string },
): string[] {
  const files = readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const carriers = carrierEntries(outDir, files, baseDir, repoRoot);
  if (carriers.length === 0) {
    if (required) {
      throw new Error(
        `no JS file in ${outDir} inlines third-party code, so it needs no ${NOTICES_FILE}: drop the notice step from this build, or find why it no longer inlines what it did`,
      );
    }
    return [];
  }
  writeFileSync(
    path.join(outDir, NOTICES_FILE),
    noticeText(
      carriers.map(([f]) => f),
      carriers.flatMap(([, entries]) => entries),
    ),
  );
  return carriers.map(([f]) => f);
}

if (import.meta.main) {
  const outDir = process.argv[2];
  if (!outDir) {
    throw new Error("usage: bun scripts/third-party-notices.ts <outDir>");
  }
  writeThirdPartyNotices(path.resolve(outDir), { required: true });
}
