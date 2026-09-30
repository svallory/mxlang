// Stages the extension into `.vsix-stage/` and packs `mxlang.vsix` from it.
//
// Why a stage: `contributes.typescriptServerPlugins` names
// `@mxlang/typescript-plugin`, and VS Code's TypeScript extension resolves that
// name from `<extension dir>/node_modules`. The package is a private workspace
// package that is not an npm dependency of the extension, and `vsce package
// --no-dependencies` (the only mode that works under bun) ships no
// `node_modules` at all, so the plugin was missing from the VSIX.
//
// The stage holds a self-contained plugin: `@mxlang/*`, volar and the other
// pure-JS dependencies are bundled into `dist/*.cjs`; only the packages that
// cannot be bundled (`@marko/compiler`, loaded through `createRequire`, and
// `@astrojs/compiler`, which reads a wasm file next to itself) are copied in,
// with their dependency closure, from the workspace install: no registry access
// and exactly the versions `bun.lock` pins. `typescript` and
// `@angular/compiler-cli` resolve from the user's project (the checker worker
// uses `createRequire(projectDir)`; tsserver hands the plugin its own `ts`);
// `@astrojs/language-server` is an optional peer.

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
import { pluginEntries } from "./plugin-entries.ts";

const extensionDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(extensionDir, "../../..");
const pluginDir = join(repoRoot, "packages/tooling/typescript-plugin");
const stageDir = join(extensionDir, ".vsix-stage");
const pluginStage = join(stageDir, "node_modules/@mxlang/typescript-plugin");

/** Loaded at runtime from the extension's own node_modules, never bundled. */
const INSTALLED = ["@marko/compiler", "@astrojs/compiler"] as const;
/** Never shipped: resolved from the user's project or tsserver. */
const EXTERNAL_UNSHIPPED = [
  "typescript",
  "@angular/compiler-cli",
  "@astrojs/language-server",
] as const;

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
const entries = pluginEntries(pluginDir);
if (!existsSync(join(pluginDir, "dist"))) {
  throw new Error(
    `${pluginDir}/dist is missing: run \`bun run build\` first. The check compares the VSIX against the plugin's own build, so a stage without it is not checkable.`,
  );
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

// 2. The plugin, bundled. Entries come from the plugin's own `build` script
// (e.g. `index` and the Angular `ng-worker`), so a new entry ships without
// touching this script. Externals must match INSTALLED/EXTERNAL_UNSHIPPED.
run(
  "bun",
  [
    "build",
    ...entries.map((name) => join(pluginDir, "src", `${name}.ts`)),
    "--outdir",
    join(pluginStage, "dist"),
    "--target",
    "node",
    "--format",
    "cjs",
    "--entry-naming",
    "[dir]/[name].cjs",
    ...[...INSTALLED, ...EXTERNAL_UNSHIPPED].flatMap((name) => [
      "--external",
      name,
    ]),
  ],
  repoRoot,
);
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
