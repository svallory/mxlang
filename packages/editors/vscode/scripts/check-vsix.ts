// Guards the VSIX contents (see `stage-vsix.ts` for why the plugin must ship).
//
//   bun run scripts/check-vsix.ts [path/to/mxlang.vsix]   (default: ./mxlang.vsix)
//
// Unpacks the VSIX and asserts, from the extension root (`extension/`, where VS
// Code's TypeScript extension resolves `typescriptServerPlugins`):
//   - every `typescriptServerPlugins[].name` resolves, `require()`s to a factory
//     function (tsserver skips a module that is not one) and, called with the
//     real `typescript`, returns `{ create }`;
//   - it ships a `dist/<entry>.cjs` for every entry in the plugin's own `build`
//     script (not a dist listing, and not a fixed list);
//   - every bare `require("x")` in a shipped `dist/*.cjs` resolves from that
//     file, except the documented project-resolved modules;
//   - every shipped package's version is one `bun.lock` pins;
//   - `@angular/compiler-cli` and `typescript` are not shipped.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { pluginEntries } from "./plugin-entries.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const defaultPluginDir = join(repoRoot, "packages/tooling/typescript-plugin");
const defaultLockfile = join(repoRoot, "bun.lock");

/** Never ship: resolved from the user's project / handed over by tsserver. */
const FORBIDDEN = ["@angular/compiler-cli", "typescript"];
/**
 * Bare requires that are expected NOT to resolve from the shipped plugin,
 * because they load from the user's project (`createRequire(projectDir)`) or
 * are an optional peer. Matched by package name.
 */
const PROJECT_RESOLVED = [
  "@angular/compiler-cli",
  "typescript",
  "@astrojs/language-server",
];

export interface CheckOptions {
  /** The plugin package dir; its `build` script lists the expected entries. */
  pluginDir?: string;
  /** `bun.lock`, for the shipped-version assertion. */
  lockfile?: string;
}

const packageName = (spec: string) =>
  spec.startsWith("@")
    ? spec.split("/").slice(0, 2).join("/")
    : spec.split("/")[0]!;

const isBuiltin = (spec: string) =>
  spec.startsWith("node:") ||
  builtinModules.includes(spec) ||
  builtinModules.includes(spec.split("/")[0]!);

/** Bare specifiers of `require("x")` calls, including bundler-renamed `require7(...)`. */
export function bareRequires(code: string): string[] {
  const found = new Set<string>();
  for (const m of code.matchAll(
    /(?<![\w$.])require\w*\(\s*["']([^"'./][^"']*)["']\s*\)/g,
  )) {
    if (!isBuiltin(m[1]!)) found.add(m[1]!);
  }
  return [...found].sort();
}

/** Every `name@version` a bun.lock pins, keyed by package name. */
export function lockedVersions(lockfile: string): Map<string, Set<string>> {
  // bun.lock is JSONC: strip trailing commas before parsing.
  const parsed = JSON.parse(
    readFileSync(lockfile, "utf8").replace(/,(\s*[}\]])/g, "$1"),
  ) as { packages: Record<string, [string, ...unknown[]]> };
  const versions = new Map<string, Set<string>>();
  for (const [, [ident]] of Object.entries(parsed.packages)) {
    const at = ident.lastIndexOf("@");
    const name = ident.slice(0, at);
    const set = versions.get(name) ?? new Set<string>();
    set.add(ident.slice(at + 1));
    versions.set(name, set);
  }
  return versions;
}

/** Every `package.json` of a package under `root/node_modules` (nested too). */
function shippedPackages(root: string): { name: string; version: string }[] {
  const out: { name: string; version: string }[] = [];
  const walk = (nodeModules: string) => {
    if (!existsSync(nodeModules)) return;
    for (const entry of readdirSync(nodeModules)) {
      if (entry.startsWith(".")) continue;
      const dirs = entry.startsWith("@")
        ? readdirSync(join(nodeModules, entry)).map((n) => join(entry, n))
        : [entry];
      for (const name of dirs) {
        const dir = join(nodeModules, name);
        const manifest = join(dir, "package.json");
        if (existsSync(manifest)) {
          const { version } = JSON.parse(readFileSync(manifest, "utf8")) as {
            version?: string;
          };
          out.push({ name, version: version ?? "" });
        }
        walk(join(dir, "node_modules"));
      }
    }
  };
  walk(join(root, "node_modules"));
  return out;
}

export function checkExtensionRoot(
  root: string,
  {
    pluginDir = defaultPluginDir,
    lockfile = defaultLockfile,
  }: CheckOptions = {},
): string[] {
  const problems: string[] = [];
  root = realpathSync(root); // resolution reports real paths (macOS /var -> /private/var)
  if (!existsSync(join(pluginDir, "dist"))) {
    // Never silently weaken: an unbuilt plugin means the check cannot compare.
    throw new Error(
      `${pluginDir}/dist is missing: run \`bun run build\` first`,
    );
  }
  const entries = pluginEntries(pluginDir);
  const manifest = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ) as {
    contributes?: { typescriptServerPlugins?: { name: string }[] };
  };
  const plugins = manifest.contributes?.typescriptServerPlugins ?? [];
  if (plugins.length === 0) {
    problems.push("package.json declares no typescriptServerPlugins");
  }
  const requireFromRoot = createRequire(join(root, "package.json"));
  for (const { name } of plugins) {
    let entry: string;
    try {
      entry = requireFromRoot.resolve(name);
    } catch {
      problems.push(
        `typescriptServerPlugins "${name}" does not resolve from ${root}/node_modules`,
      );
      continue;
    }
    if (!entry.startsWith(resolve(root, "node_modules"))) {
      problems.push(`"${name}" resolved outside the extension: ${entry}`);
      continue;
    }
    const pluginRoot = join(root, "node_modules", name);
    for (const file of entries) {
      if (!existsSync(join(pluginRoot, "dist", `${file}.cjs`))) {
        problems.push(`"${name}" is missing dist/${file}.cjs`);
      }
    }

    // The entry tsserver loads: `require(entry)` must be the factory function.
    // DEPENDS ON the plugin-shape PR (fix/typescript-plugin-cjs-factory): until
    // the plugin build emits `module.exports = factory`, this stays red.
    try {
      const loaded: unknown = requireFromRoot(name);
      if (typeof loaded !== "function") {
        problems.push(
          `"${name}" exports ${typeof loaded}, not a factory function: tsserver skips it ("did not expose a proper factory function")`,
        );
      } else {
        const plugin = (loaded as (modules: unknown) => unknown)({
          typescript: ts,
        }) as { create?: unknown } | undefined;
        if (typeof plugin?.create !== "function") {
          problems.push(`"${name}" factory did not return { create }`);
        }
      }
    } catch (err) {
      problems.push(
        `"${name}" could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Every bare require in a shipped bundle must resolve from that bundle.
    const dist = join(pluginRoot, "dist");
    if (existsSync(dist)) {
      for (const file of readdirSync(dist).filter((f) => f.endsWith(".cjs"))) {
        const path = join(dist, file);
        const requireFromFile = createRequire(path);
        for (const spec of bareRequires(readFileSync(path, "utf8"))) {
          if (PROJECT_RESOLVED.includes(packageName(spec))) continue;
          try {
            requireFromFile.resolve(spec);
          } catch {
            problems.push(
              `dist/${file} requires "${spec}", which does not resolve from the shipped plugin`,
            );
          }
        }
      }
    }
  }

  // Shipped versions must be the ones bun.lock pins (no floating transitives).
  const locked = lockedVersions(lockfile);
  for (const { name, version } of shippedPackages(root)) {
    if (name === "@mxlang/typescript-plugin") continue;
    if (!locked.get(name)?.has(version)) {
      problems.push(
        `${name}@${version} is not a version bun.lock pins (${[...(locked.get(name) ?? [])].join(", ") || "not in the lockfile"})`,
      );
    }
  }

  for (const name of FORBIDDEN) {
    if (existsSync(join(root, "node_modules", name))) {
      problems.push(`${name} must not be shipped (found node_modules/${name})`);
    }
  }
  return problems;
}

export function checkVsix(vsix: string, options?: CheckOptions): string[] {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-vsix-check-")));
  try {
    execFileSync("unzip", ["-q", resolve(vsix), "-d", dir]);
    return checkExtensionRoot(join(dir, "extension"), options);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const vsix = process.argv[2] ?? "mxlang.vsix";
  if (!statSync(vsix, { throwIfNoEntry: false })) {
    console.error(`${vsix} does not exist: run \`bun run package\` first`);
    process.exit(1);
  }
  const problems = checkVsix(vsix);
  if (problems.length > 0) {
    console.error(`VSIX check failed for ${vsix}:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`VSIX check passed for ${vsix}`);
}
