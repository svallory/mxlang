// Stages the extension into `.vsix-stage/` and packs `mxlang.vsix` from it.
//
// Why a stage: `contributes.typescriptServerPlugins` names
// `@mxlang/typescript-plugin`, and VS Code's TypeScript extension resolves that
// name from `<extension dir>/node_modules`. The package is a private workspace
// package that is not an npm dependency of the extension, and `vsce package
// --no-dependencies` (the only mode that works under bun) ships no
// `node_modules` at all, so the plugin was missing from the VSIX.
//
// The stage COPIES the plugin package's own self-contained build
// (`typescript-plugin`'s `bun run build:bundled`, output `bundle/`; entries and
// externals are defined once in its `build/bundled-config.ts`), so the shipped
// plugin gets the same factory-function export as the published build. The
// packages that build leaves external and ships (`@astrojs/compiler`) are
// copied in with their dependency closure from the workspace install: no
// registry access and exactly the versions `bun.lock` pins. The Marko parse
// layer is `@mxlang/core`'s `marko-frontend.cjs` (decision 159), which the
// bundled build already copied into each `bundle/`. The project-resolved ones (`typescript`, `@angular/compiler-cli`,
// `@astrojs/language-server`) are never shipped.
//
// The language server ships the same way: its own self-contained build
// (`bun ../../tooling/language-server/build/bundled.ts`, output `bundle/`,
// `build/bundled-config.ts` the one list) copied to
// `node_modules/@mxlang/language-server/dist/`. The extension runs it with VS
// Code's own Node (`src/server-command.ts`).

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUNDLED_ENTRIES as LS_ENTRIES,
  BUNDLED_INSTALLED as LS_INSTALLED,
  BUNDLED_MAIN as LS_MAIN,
  BUNDLED_OUTDIR as LS_OUTDIR,
} from "../../../tooling/language-server/build/bundled-config.ts";
import {
  BUNDLED_ENTRIES,
  BUNDLED_INSTALLED,
  BUNDLED_OUTDIR,
} from "../../../tooling/typescript-plugin/build/bundled-config.ts";
import { place, readManifest } from "./closure.ts";

const extensionDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(extensionDir, "../../..");
const pluginDir = join(repoRoot, "packages/tooling/typescript-plugin");
const lsDir = join(repoRoot, "packages/tooling/language-server");
const stageDir = join(extensionDir, ".vsix-stage");
const pluginStage = join(stageDir, "node_modules/@mxlang/typescript-plugin");

const lsStage = join(stageDir, "node_modules/@mxlang/language-server");
const lsBundleDir = join(lsDir, LS_OUTDIR);
const bundleDir = join(pluginDir, BUNDLED_OUTDIR);
// Every un-bundleable package either build ships; a name both need is placed once.
const INSTALLED = [...new Set([...BUNDLED_INSTALLED, ...LS_INSTALLED])];

const run = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit" });

const pluginManifest = readManifest(pluginDir);
const lsManifest = readManifest(lsDir);
for (const entry of LS_ENTRIES) {
  if (!existsSync(join(lsBundleDir, `${entry}.cjs`))) {
    throw new Error(
      `${lsBundleDir}/${entry}.cjs is missing: run \`bun build/bundled.ts\` in the language-server package first (\`bun run package\` does)`,
    );
  }
}
for (const entry of BUNDLED_ENTRIES) {
  if (!existsSync(join(bundleDir, `${entry}.cjs`))) {
    throw new Error(
      `${bundleDir}/${entry}.cjs is missing: run \`bun run build:bundled\` in the plugin package first (\`bun run package\` does)`,
    );
  }
}

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(pluginStage, { recursive: true });

// 1. The extension itself.
for (const path of [
  "package.json",
  "README.md",
  "language-configuration.json",
  ".vscodeignore",
  "syntaxes",
  "dist",
]) {
  cpSync(join(extensionDir, path), join(stageDir, path), { recursive: true });
}

// 2. The plugin: a copy of its self-contained build, nothing re-bundled here.
cpSync(bundleDir, join(pluginStage, "dist"), { recursive: true });
const nodeModules = join(stageDir, "node_modules");
writeFileSync(
  join(pluginStage, "package.json"),
  `${JSON.stringify(
    {
      name: "@mxlang/typescript-plugin",
      version: pluginManifest.version,
      main: "dist/index.cjs",
    },
    null,
    2,
  )}\n`,
);

// 3. The language server: a copy of its self-contained build. The extension
// runs `dist/<LS_MAIN>` with VS Code's own Node (src/server-command.ts).
mkdirSync(lsStage, { recursive: true });
cpSync(lsBundleDir, join(lsStage, "dist"), { recursive: true });
writeFileSync(
  join(lsStage, "package.json"),
  `${JSON.stringify(
    {
      name: "@mxlang/language-server",
      version: lsManifest.version,
      main: `dist/${LS_MAIN}`,
    },
    null,
    2,
  )}\n`,
);

// 4. The un-bundleable dependencies and their closure, copied from the
// workspace install so the shipped versions are the ones bun.lock pins. Each
// is resolved from the package that declares it.
const fromPlugin = createRequire(join(pluginDir, "package.json"));
// Whatever the server ships is resolved through @mxlang/core, which it inlines.
const fromLs = createRequire(join(repoRoot, "packages/core/package.json"));
for (const [name, from] of [
  ...BUNDLED_INSTALLED.map((n) => [n, fromPlugin] as const),
  ...LS_INSTALLED.map((n) => [n, fromLs] as const),
]) {
  const pkgJson = from.resolve(`${name}/package.json`);
  place(dirname(realpathSync(pkgJson)), nodeModules);
}

// 5. Pack. `--no-dependencies` would drop the stage's node_modules (vsce globs
// with `ignore: node_modules/**`), so vsce walks dependencies itself via
// `npm list --production`. That needs the stage manifest to declare what sits in
// node_modules; the extension's own package.json stays unchanged.
const stagedManifest = JSON.parse(
  readFileSync(join(stageDir, "package.json"), "utf8"),
) as Record<string, unknown>;
stagedManifest.dependencies = {
  "@mxlang/typescript-plugin": pluginManifest.version,
  "@mxlang/language-server": lsManifest.version,
  ...Object.fromEntries(
    INSTALLED.map((name) => [
      name,
      readManifest(join(nodeModules, name)).version,
    ]),
  ),
};
writeFileSync(
  join(stageDir, "package.json"),
  `${JSON.stringify(stagedManifest, null, 2)}\n`,
);
run(
  "bunx",
  [
    "@vscode/vsce@3.9.2",
    "package",
    "--allow-missing-repository",
    "-o",
    join(extensionDir, "mxlang.vsix"),
  ],
  stageDir,
);
