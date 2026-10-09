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
const sections = [
  "# Third-party code in dist/index.js",
  "",
  "`dist/index.js` bundles the code below. Each is distributed under its own licence.",
  "",
  "## @babel/parser 7.29.8 (vendored as `@mxlang/babel`)",
  "",
  "Source: https://github.com/babel/babel, tag `v7.29.8`, `packages/babel-parser/src`",
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
    licence ??
      `Licence: ${manifest.license ?? "unspecified"} (per its package.json; the package ships no licence file). Author: ${manifest.author ?? "unspecified"}.`,
  );
}
writeFileSync(
  path.join(coreDir, "dist/THIRD-PARTY-NOTICES.md"),
  `${sections.join("\n")}\n`,
);
