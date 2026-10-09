// Decision 159: bundles `@marko/compiler`'s parse layer into
// `dist/marko-frontend.cjs`, with the `htmljs-parser` specifier resolved to
// MX's own template parser (`packages/parser/src/template/`), so a registry
// install of `@mxlang/core` parses `.mx` with MX's rules and installs no npm
// `htmljs-parser`. `src/marko-frontend.ts` loads the file; the main build
// defines `MX_MARKO_FRONTEND` as its path. Deleted when the MX AST replaces
// `@marko/compiler` (decision 158).
//
// One CommonJS bundle, one entry exporting the compiler, its Babel and the
// parser, so every `@marko/compiler/*` self-require inside the compiler lands
// on the same module instance. Only Node built-ins stay external: the bundle
// requires no package, so it can be copied next to another bundle (the VSIX).
// Marko's Babel requires two packages that are not `@marko/compiler`
// dependencies (a stock install resolves them only when something else
// hoisted them):
// - `@babel/preset-typescript`, for a `.cts` Babel config file, which MX never
//   loads: replaced by a module that throws MODULE_NOT_FOUND, which Babel's
//   `try` turns into its own "please install it" error.
// - `browserslist`: Babel asks it for a config file on every compile
//   (`findConfigFile`) and crashes when it is absent. Replaced by a stub that
//   finds no config file, so no browser targets are resolved; MX passes no
//   `targets` and Marko's parse and translate do not read them. A caller that
//   does pass browser targets gets a clear error instead.
//
// Run from `package.json`'s `build` after the main bundle: writes into `dist/`.

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const coreDir = path.resolve(import.meta.dirname, "..");
const distDir = path.join(coreDir, "dist");
const templateDir = path.resolve(coreDir, "../parser/src/template");
const templateEntry = path.join(templateDir, "index.ts");
const fromCompiler = createRequire(
  createRequire(import.meta.url).resolve("@marko/compiler"),
);

/** The file `src/marko-frontend.ts` loads, relative to `dist/index.js`. */
export const FRONTEND_FILE = "marko-frontend.cjs";
const NOTICES_FILE = "marko-frontend.NOTICES.md";

/** Requires inside Marko's Babel that `@marko/compiler` does not install, and what replaces them. */
const STUBS: Record<string, string> = {
  "@babel/preset-typescript": `const error = new Error("Cannot find module '@babel/preset-typescript' (not bundled into @mxlang/core)");
error.code = "MODULE_NOT_FOUND";
throw error;
`,
  browserslist: `function browserslist() {
  throw new Error("@mxlang/core bundles no browserslist: Marko's Babel was asked to resolve browser targets, which MX never configures");
}
browserslist.findConfigFile = () => undefined;
browserslist.loadConfig = () => undefined;
module.exports = browserslist;
`,
};
const STUB_FILTER = /^(@babel\/preset-typescript|browserslist)$/;

const result = await Bun.build({
  entrypoints: [path.join(coreDir, "build/marko-frontend-entry.cjs")],
  outdir: distDir,
  naming: FRONTEND_FILE,
  target: "node",
  format: "cjs",
  plugins: [
    {
      name: "mx-template-parser",
      setup(build) {
        build.onResolve({ filter: /^htmljs-parser$/ }, () => ({
          path: templateEntry,
        }));
        // The MX front end's parse errors are rendered as Marko's
        // `CompileError` (`src/mx-parse.ts`), with Marko's own colours:
        // `kleur` is a dependency of `@marko/compiler`, not hoisted.
        build.onResolve({ filter: /^kleur\/colors$/ }, () => ({
          path: fromCompiler.resolve("kleur/colors"),
        }));
        build.onResolve({ filter: STUB_FILTER }, ({ path: id }) => ({
          path: id,
          namespace: "mx-stub",
        }));
        build.onLoad(
          { filter: /.*/, namespace: "mx-stub" },
          ({ path: id }) => ({
            loader: "js",
            contents: STUBS[id] ?? "",
          }),
        );
      },
    },
  ],
});
if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  throw new Error("core: bundling the Marko front end failed");
}

const out = path.join(distDir, FRONTEND_FILE);
const code = readFileSync(out, "utf8");
const problems = checkFrontend(code);
const index = readFileSync(path.join(distDir, "index.js"), "utf8");
for (const specifier of ["@marko/compiler", "htmljs-parser"]) {
  // Only `src/marko-frontend.ts`'s source branch names these, and the define
  // folds it away: any import or require of them left in the dist would load
  // (or, to a bundle scanner, declare) the npm copy.
  if (
    new RegExp(
      `(from\\s*|\\b(require\\w*|import)\\(\\s*)["']${specifier}`,
    ).test(index)
  ) {
    problems.push(`dist/index.js imports or requires ${specifier}`);
  }
}
if (!index.includes(JSON.stringify(`./${FRONTEND_FILE}`))) {
  problems.push(
    `dist/index.js does not name ./${FRONTEND_FILE} (MX_MARKO_FRONTEND define missing?)`,
  );
}
if (problems.length > 0) {
  throw new Error(
    `core: the Marko front end bundle is wrong:\n  ${problems.join("\n  ")}`,
  );
}
writeFileSync(path.join(distDir, NOTICES_FILE), notices(code));

/** Every bare `require` left in the bundle must be a Node built-in. */
function checkFrontend(source: string): string[] {
  const found: string[] = [];
  const builtins = new Set(
    createRequire(import.meta.url)("node:module").builtinModules as string[],
  );
  for (const [, id] of source.matchAll(/\brequire\("([^"]+)"\)/g)) {
    if (!id || id.startsWith("node:") || builtins.has(id)) continue;
    found.push(`marko-frontend.cjs requires "${id}", which core does not ship`);
  }
  // Bun marks every bundled module with a `// <path>` comment: no npm
  // htmljs-parser may be among them.
  if (/^\/\/ .*node_modules\/.*htmljs-parser/m.test(source)) {
    found.push("marko-frontend.cjs bundles an npm htmljs-parser");
  }
  if (!source.includes("parser/src/template/index.ts")) {
    found.push("marko-frontend.cjs does not bundle MX's template parser");
  }
  return found;
}

/** Licence texts of everything the bundle carries, MIT notices included. */
function notices(source: string): string {
  const packages = new Map<string, string>();
  // `// ../../node_modules/.bun/<name>@<version>/node_modules/<name>/...`, as
  // Bun prints it relative to the core package.
  for (const [, dir] of source.matchAll(
    /^\/\/ (\S*node_modules\/\.bun\/[^/]+\/node_modules\/(?:@[^/]+\/)?[^/]+)\//gm,
  )) {
    if (!dir) continue;
    const pkgDir = path.resolve(coreDir, dir);
    const manifest = JSON.parse(
      readFileSync(path.join(pkgDir, "package.json"), "utf8"),
    ) as { name: string; version: string };
    packages.set(`${manifest.name}@${manifest.version}`, pkgDir);
  }
  const sections = [
    "# Third-party code in marko-frontend.cjs",
    "",
    "`marko-frontend.cjs` bundles the packages below (decision 159). `@marko/compiler`'s",
    "own `dist/babel.js` embeds Babel 7 and its helpers (`@babel/*`, `@jridgewell/*`,",
    "`convert-source-map`, `debug`, `gensync`, `json5`, `semver` and others), each",
    "under its own licence (MIT, ISC or BSD-2-Clause), as `@marko/compiler`",
    "distributes them.",
    "",
    "## htmljs-parser (MX's template parser, `@mxlang/parser` `src/template/`)",
    "",
    readFileSync(path.join(templateDir, "LICENSE"), "utf8").trim(),
  ];
  for (const [id, pkgDir] of [...packages].sort()) {
    const licence = ["LICENSE", "LICENSE.md", "license", "LICENSE.txt"]
      .map((name) => path.join(pkgDir, name))
      .find((file) => {
        try {
          readFileSync(file);
          return true;
        } catch {
          return false;
        }
      });
    sections.push(
      "",
      `## ${id}`,
      "",
      licence
        ? readFileSync(licence, "utf8").trim()
        : "(no licence file shipped)",
    );
  }
  return `${sections.join("\n")}\n`;
}
