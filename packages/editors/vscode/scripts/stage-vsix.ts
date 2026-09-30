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
// pure-JS dependencies are bundled into `dist/index.cjs`; only the packages that
// cannot be bundled (`@marko/compiler`, loaded through `createRequire`, and
// `@astrojs/compiler`, which reads a wasm file next to itself) are installed
// with `bun install --production`. `typescript` is type-only in the plugin
// (tsserver hands it the `ts` object); `@angular/compiler-cli` resolves from the
// user's project; `@astrojs/language-server` is an optional peer.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const pluginManifest = JSON.parse(
  readFileSync(join(pluginDir, "package.json"), "utf8"),
) as { version: string; dependencies: Record<string, string> };

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

// 2. The plugin, bundled. Externals must match INSTALLED/EXTERNAL_UNSHIPPED.
// Entries: `src/index.ts`, plus `src/<name>.ts` for every extra `dist/<name>.cjs`
// the plugin's own build emits (e.g. the Angular diagnostics worker), so a new
// worker entry ships without touching this script.
const builtDist = join(pluginDir, "dist");
const extraEntries = existsSync(builtDist)
  ? readdirSync(builtDist)
      .filter((file) => file.endsWith(".cjs") && file !== "index.cjs")
      .map((file) => file.replace(/\.cjs$/, ""))
  : [];
for (const name of extraEntries) {
  if (!existsSync(join(pluginDir, "src", `${name}.ts`))) {
    throw new Error(
      `plugin dist/${name}.cjs has no src/${name}.ts entry to bundle into the VSIX`,
    );
  }
}
run(
  "bun",
  [
    "build",
    join(pluginDir, "src/index.ts"),
    ...extraEntries.map((name) => join(pluginDir, "src", `${name}.ts`)),
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
writeFileSync(
  join(pluginStage, "package.json"),
  `${JSON.stringify(
    {
      name: "@mxlang/typescript-plugin",
      version: pluginManifest.version,
      main: "dist/index.cjs",
      dependencies: Object.fromEntries(
        INSTALLED.map((name) => [name, pluginManifest.dependencies[name]]),
      ),
    },
    null,
    2,
  )}\n`,
);

// 3. Install the un-bundleable dependencies next to the plugin (hoisted into
// the stage's top-level node_modules, where Node resolution finds them).
writeFileSync(
  join(stageDir, "install.package.json"),
  `${JSON.stringify(
    {
      name: "mxlang-vsix-stage",
      private: true,
      dependencies: Object.fromEntries(
        INSTALLED.map((name) => [name, pluginManifest.dependencies[name]]),
      ),
    },
    null,
    2,
  )}\n`,
);
const installDir = join(stageDir, ".install");
mkdirSync(installDir);
cpSync(
  join(stageDir, "install.package.json"),
  join(installDir, "package.json"),
);
run("bun", ["install", "--production", "--no-save"], installDir);
cpSync(join(installDir, "node_modules"), join(stageDir, "node_modules"), {
  recursive: true,
  dereference: true,
});
rmSync(installDir, { recursive: true, force: true });
rmSync(join(stageDir, "install.package.json"));

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
    INSTALLED.map((name) => [name, pluginManifest.dependencies[name]]),
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
