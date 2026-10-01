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
// packages that build leaves external and ships (`@marko/compiler`,
// `@astrojs/compiler`) are copied in with their dependency closure from the
// workspace install: no registry access and exactly the versions `bun.lock`
// pins. The project-resolved ones (`typescript`, `@angular/compiler-cli`,
// `@astrojs/language-server`) are never shipped.

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
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUNDLED_ENTRIES,
  BUNDLED_INSTALLED,
  BUNDLED_OUTDIR,
} from "../../../tooling/typescript-plugin/build/bundled-config.ts";

const extensionDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(extensionDir, "../../..");
const pluginDir = join(repoRoot, "packages/tooling/typescript-plugin");
const stageDir = join(extensionDir, ".vsix-stage");
const pluginStage = join(stageDir, "node_modules/@mxlang/typescript-plugin");

const INSTALLED = BUNDLED_INSTALLED;
const bundleDir = join(pluginDir, BUNDLED_OUTDIR);

const run = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit" });

interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}
const readManifest = (dir: string) =>
  JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;

/** The directory of `name` as installed for a package living in `fromDir`. */
function findPackage(name: string, fromDir: string): string | undefined {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) {
      return realpathSync(candidate);
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * Copy `realDir` (an installed package) and its dependency closure into the
 * stage, hoisting each name once; a second version of a name nests under its
 * dependent so Node resolution still finds it.
 */
function place(realDir: string, into: string): void {
  const manifest = readManifest(realDir);
  const target = join(into, manifest.name);
  if (existsSync(target)) {
    if (readManifest(target).version === manifest.version) return;
    throw new Error(`unexpected version clash placing ${manifest.name}`);
  }
  cpSync(realDir, target, {
    recursive: true,
    dereference: true,
    // A package's own node_modules would be a second, unpinned copy.
    filter: (src) => basename(src) !== "node_modules",
  });
  const deps = { ...manifest.dependencies, ...manifest.optionalDependencies };
  for (const dep of Object.keys(deps)) {
    const depDir = findPackage(dep, realDir);
    if (!depDir) {
      // An optional dependency that is not installed for this platform.
      if (manifest.optionalDependencies?.[dep]) continue;
      throw new Error(
        `${manifest.name} needs ${dep}, not found from ${realDir}`,
      );
    }
    const hoisted = join(into, dep);
    if (
      existsSync(hoisted) &&
      readManifest(hoisted).version !== readManifest(depDir).version
    ) {
      place(depDir, join(target, "node_modules"));
    } else {
      place(depDir, into);
    }
  }
}

const pluginManifest = readManifest(pluginDir);
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

// 3. The un-bundleable dependencies and their closure, copied from the
// workspace install so the shipped versions are the ones bun.lock pins.
const fromPlugin = createRequire(join(pluginDir, "package.json"));
for (const name of INSTALLED) {
  const pkgJson = fromPlugin.resolve(`${name}/package.json`);
  place(dirname(realpathSync(pkgJson)), nodeModules);
}

// 4. Pack. `--no-dependencies` would drop the stage's node_modules (vsce globs
// with `ignore: node_modules/**`), so vsce walks dependencies itself via
// `npm list --production`. That needs the stage manifest to declare what sits in
// node_modules; the extension's own package.json stays unchanged.
const stagedManifest = JSON.parse(
  readFileSync(join(stageDir, "package.json"), "utf8"),
) as Record<string, unknown>;
stagedManifest.dependencies = {
  "@mxlang/typescript-plugin": pluginManifest.version,
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
