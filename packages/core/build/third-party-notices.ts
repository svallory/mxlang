// Writes `dist/THIRD-PARTY-NOTICES.md`: the licence text of the code
// `dist/index.js` bundles from outside this package. `@mxlang/babel` is a
// vendored copy of `@babel/parser` (`packages/babel/UPSTREAM.md`), which
// itself imports `@babel/helper-validator-identifier` and `charcodes`; the
// main build inlines all three. (`marko-frontend.NOTICES.md` covers the
// separate `marko-frontend.cjs` bundle.)
//
// Run from `package.json`'s `build` after the main bundle: writes into `dist/`.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const coreDir = path.resolve(import.meta.dirname, "..");
const babelDir = path.resolve(coreDir, "../babel");
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

const vendored = readFileSync(path.join(babelDir, "LICENSE"), "utf8").trim();
const upstream = readFileSync(path.join(babelDir, "UPSTREAM.md"), "utf8");
const tag = /^- Tag: `(v[^`]+)`/m.exec(upstream)?.[1];
if (!tag) throw new Error("packages/babel/UPSTREAM.md names no `- Tag:` line");

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

const sections = [
  "# Third-party code in dist/index.js",
  "",
  "`dist/index.js` bundles the code below. Each is distributed under its own licence.",
  "",
  `## @babel/parser ${tag.slice(1)} (vendored as \`@mxlang/babel\`)`,
  "",
  `Source: https://github.com/babel/babel, tag \`${tag}\`, \`packages/babel-parser/src\``,
  "(the MX JSX changes are listed in `packages/babel/UPSTREAM.md` in the repository).",
  "MIT licence:",
  "",
  vendored,
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
writeFileSync(
  path.join(coreDir, "dist/THIRD-PARTY-NOTICES.md"),
  `${sections.join("\n")}\n`,
);
