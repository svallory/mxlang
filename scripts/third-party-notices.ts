// Writes `THIRD-PARTY-NOTICES.md` beside the bundles that inline MX's Babel
// fork: the licence text of the code those bundles carry from outside the
// repository. `@mxlang/babel` is a vendored copy of `@babel/parser`
// (`packages/babel/UPSTREAM.md`), which itself imports
// `@babel/helper-validator-identifier` and `charcodes`; a bundle that inlines
// the fork inlines all three. (`marko-frontend.NOTICES.md` covers core's
// separate `marko-frontend.cjs` bundle.)
//
// A bundle carries the fork when its text contains `BABEL_FORK_MARKER`, a
// method only the fork defines, so the notice's heading lists whatever the
// build actually inlined rather than a list that can go stale.
//
// `bun scripts/third-party-notices.ts <outDir>`, run from a package's `build`
// after its last bundle step, writes into `<outDir>` and fails when nothing
// there carries the fork. `bundledBuild` (`scripts/bundled-build.ts`) calls
// `writeThirdPartyNotices` with `required: false`; `scripts/pack-hygiene.ts`
// uses `forkCarriers` to check every tarball packs the notice.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** A method name only the fork defines (`packages/babel/UPSTREAM.md` item 5). */
export const BABEL_FORK_MARKER = "jsxParseElementAtOriginal";
/** The notice's file name, written beside the bundles it covers. */
export const NOTICES_FILE = "THIRD-PARTY-NOTICES.md";

const babelDir = path.resolve(import.meta.dirname, "../packages/babel");
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

function licenceOf(dir: string): string | undefined {
  const file = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license"]
    .map((name) => path.join(dir, name))
    .find((candidate) => existsSync(candidate));
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

/**
 * The `files` (paths relative to `dir`) that are JavaScript and inline the
 * fork, sorted. Declarations and other files are never carriers.
 */
export function forkCarriers(dir: string, files: readonly string[]): string[] {
  return files
    .filter((f) => /\.(c|m)?js$/.test(f))
    .filter((f) =>
      readFileSync(path.join(dir, f), "utf8").includes(BABEL_FORK_MARKER),
    )
    .sort();
}

/** The notice for `carriers` (file names in the notice's own dir). */
function noticeText(carriers: readonly string[]): string {
  const tag = upstreamTag();
  const listed = carriers.map((f) => `\`${f}\``).join(", ");
  const sections = [
    `# Third-party code in ${carriers.join(", ")}`,
    "",
    `${listed} ${carriers.length === 1 ? "bundles" : "bundle"} the code below. Each is distributed under its own licence.`,
    "",
    `## @babel/parser ${tag.slice(1)} (vendored as \`@mxlang/babel\`)`,
    "",
    `Source: https://github.com/babel/babel, tag \`${tag}\`, \`packages/babel-parser/src\``,
    "(the MX JSX changes are listed in `packages/babel/UPSTREAM.md` in the repository).",
    "MIT licence:",
    "",
    readFileSync(path.join(babelDir, "LICENSE"), "utf8").trim(),
  ];
  for (const name of ["@babel/helper-validator-identifier", "charcodes"]) {
    const dir = installedDir(name);
    const manifest = manifestOf(dir);
    const licence = licenceOf(dir);
    sections.push(
      "",
      `## ${manifest.name} ${manifest.version}`,
      "",
      licence ?? noFileLicence(manifest),
    );
  }
  return `${sections.join("\n")}\n`;
}

/**
 * Writes `<outDir>/THIRD-PARTY-NOTICES.md` naming the top-level JS files of
 * `outDir` that carry the fork, and returns them. When none does, throws if
 * `required` (a build that should inline the fork no longer does, or the
 * marker stopped surviving the build) and otherwise writes nothing and
 * returns `[]`.
 */
export function writeThirdPartyNotices(
  outDir: string,
  { required }: { required: boolean },
): string[] {
  const files = readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const carriers = forkCarriers(outDir, files);
  if (carriers.length === 0) {
    if (required) {
      throw new Error(
        `no JS file in ${outDir} carries the Babel fork (${BABEL_FORK_MARKER}), so it needs no ${NOTICES_FILE}: drop the notice step from this build, or find why the fork is no longer inlined`,
      );
    }
    return [];
  }
  writeFileSync(path.join(outDir, NOTICES_FILE), noticeText(carriers));
  return carriers;
}

if (import.meta.main) {
  const outDir = process.argv[2];
  if (!outDir) {
    throw new Error("usage: bun scripts/third-party-notices.ts <outDir>");
  }
  writeThirdPartyNotices(path.resolve(outDir), { required: true });
}
