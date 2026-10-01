// Guards the VSIX contents (see `stage-vsix.ts` for why the plugin must ship).
//
//   bun run scripts/check-vsix.ts [path/to/mxlang.vsix]   (default: ./mxlang.vsix)
//
// Unpacks the VSIX and asserts, from the extension root (`extension/`, where VS
// Code's TypeScript extension resolves `typescriptServerPlugins`):
//   - every `typescriptServerPlugins[].name` resolves, `require()`s to a factory
//     function (tsserver skips a module that is not one) and, called with the
//     real `typescript`, returns `{ create }`;
//   - it ships a `dist/<entry>.cjs` for every entry of the plugin's bundled
//     build (`build/bundled-config.ts`, the one list);
//   - the language server (`@mxlang/language-server`) resolves from the same
//     root, to a `main` that exists, and ships `dist/<entry>.cjs` for every
//     entry of its own bundled build (`build/bundled-config.ts`);
//   - every bare `require("x")` in a shipped `dist/*.cjs` of the plugin or the
//     language server resolves from that file, except the documented
//     project-resolved modules;
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
import { bakedPathsIn } from "../../../../scripts/baked-paths.ts";
import {
  BUNDLED_ENTRIES as LS_ENTRIES,
  BUNDLED_MAIN as LS_MAIN,
  BUNDLED_PROJECT_RESOLVED as LS_PROJECT_RESOLVED,
} from "../../../tooling/language-server/build/bundled-config.ts";
import {
  BUNDLED_ENTRIES,
  BUNDLED_PROJECT_RESOLVED,
} from "../../../tooling/typescript-plugin/build/bundled-config.ts";

const LS_NAME = "@mxlang/language-server";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const defaultLockfile = join(repoRoot, "bun.lock");

/**
 * Never shipped, and the only modules a bundler-renamed (`createRequire`)
 * require may load without them being in the VSIX: the plugin build's
 * project-resolved externals, from its one list.
 */
const PROJECT_RESOLVED: readonly string[] = BUNDLED_PROJECT_RESOLVED;
const FORBIDDEN = PROJECT_RESOLVED;

export interface CheckOptions {
  /** The `dist/<entry>.cjs` files the VSIX must carry (default: the plugin build's entries). */
  entries?: readonly string[];
  /** The `dist/<entry>.cjs` files the language server must carry (default: its bundled build's entries). */
  lsEntries?: readonly string[];
  /** The checkout the bundles were built in; no shipped bundle may name it (default: this repo). */
  buildRoot?: string;
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

export interface BareRequire {
  spec: string;
  /**
   * False for a bundler-renamed callee (`require7(...)`): the bundle's
   * `createRequire(projectDir)` results are renamed that way, so only those may
   * load project-resolved modules. A plain `require(...)` or `__require(...)`
   * resolves from the bundle's own location.
   */
  fromBundleLocation: boolean;
}

/** Bare `require("x")` calls, including bundler-renamed `require7(...)`. */
export function bareRequires(code: string): BareRequire[] {
  const found = new Map<string, BareRequire>();
  for (const m of code.matchAll(
    /(?<![\w$.])(require\w*|__require)\(\s*["']([^"'./][^"']*)["']\s*\)/g,
  )) {
    const callee = m[1]!;
    const spec = m[2]!;
    if (isBuiltin(spec)) continue;
    const fromBundleLocation = callee === "require" || callee === "__require";
    const key = `${fromBundleLocation}:${spec}`;
    found.set(key, { spec, fromBundleLocation });
  }
  return [...found.values()].sort((a, b) =>
    a.spec === b.spec
      ? Number(a.fromBundleLocation) - Number(b.fromBundleLocation)
      : a.spec < b.spec
        ? -1
        : 1,
  );
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

interface Shipped {
  name: string;
  version: string;
  dir: string;
  dependencies: string[];
}

/** Every package under `root/node_modules` (nested too). */
function shippedPackages(root: string): Shipped[] {
  const out: Shipped[] = [];
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
          const json = JSON.parse(readFileSync(manifest, "utf8")) as {
            version?: string;
            dependencies?: Record<string, string>;
          };
          out.push({
            name,
            version: json.version ?? "",
            dir,
            dependencies: Object.keys(json.dependencies ?? {}),
          });
        }
        walk(join(dir, "node_modules"));
      }
    }
  };
  walk(join(root, "node_modules"));
  return out;
}

/** Whether `dep` resolves from `fromDir`, walking up `node_modules` to `root`. */
function resolvesFrom(fromDir: string, dep: string, root: string): boolean {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules", dep, "package.json"))) return true;
    if (dir === root || dirname(dir) === dir) return false;
  }
}

/**
 * A bundle must find its own files at run time. Bun's CJS output bakes
 * `import.meta.url` as the build machine's `file:///` URL, which made every
 * `createRequire(import.meta.url)` resolve from the build tree (the workspace
 * copy where it was built, nothing on a user's machine). Fail on any
 * `file:///` literal or on the build root appearing in a shipped bundle.
 */
function bakedPaths(pkgRoot: string, buildRoot: string): string[] {
  const dist = join(pkgRoot, "dist");
  if (!existsSync(dist)) return [];
  const problems: string[] = [];
  for (const file of readdirSync(dist).filter((f) => f.endsWith(".cjs"))) {
    for (const what of bakedPathsIn(
      readFileSync(join(dist, file), "utf8"),
      buildRoot,
    )) {
      problems.push(`dist/${file} contains ${what}`);
    }
  }
  return problems;
}

/** Every bare require in a package's shipped `dist/*.cjs` must resolve from that bundle. */
function unresolvedRequires(
  pkgRoot: string,
  what: string,
  /** Modules a bundler-renamed (`createRequire(projectDir)`) require may load without shipping. */
  projectResolved: readonly string[],
): string[] {
  const problems: string[] = [];
  const dist = join(pkgRoot, "dist");
  if (!existsSync(dist)) return problems;
  for (const file of readdirSync(dist).filter((f) => f.endsWith(".cjs"))) {
    const path = join(dist, file);
    const requireFromFile = createRequire(path);
    for (const { spec, fromBundleLocation } of bareRequires(
      readFileSync(path, "utf8"),
    )) {
      // Only a project `createRequire` may load a project-resolved module;
      // a plain top-level require of one is the HIGH-2 regression.
      if (!fromBundleLocation && projectResolved.includes(packageName(spec))) {
        continue;
      }
      try {
        requireFromFile.resolve(spec);
      } catch {
        problems.push(
          `dist/${file} requires "${spec}", which does not resolve from the ${what}`,
        );
      }
    }
  }
  return problems;
}

/**
 * The extension runs `node_modules/@mxlang/language-server/dist/bin.cjs` with
 * VS Code's Node (`src/server-command.ts`), so it must resolve inside the
 * VSIX, be complete, and resolve every bare require it makes.
 */
function checkLanguageServer(
  root: string,
  requireFromRoot: NodeRequire,
  entries: readonly string[],
  buildRoot: string,
): string[] {
  let main: string;
  try {
    main = requireFromRoot.resolve(LS_NAME);
  } catch {
    return [`${LS_NAME} does not resolve from ${root}/node_modules`];
  }
  const problems: string[] = [];
  const lsRoot = join(root, "node_modules", LS_NAME);
  if (!main.startsWith(resolve(lsRoot))) {
    problems.push(`"${LS_NAME}" resolved outside the extension: ${main}`);
  }
  if (main !== join(lsRoot, "dist", LS_MAIN)) {
    problems.push(`"${LS_NAME}" main is ${main}, expected dist/${LS_MAIN}`);
  }
  for (const file of entries) {
    if (!existsSync(join(lsRoot, "dist", `${file}.cjs`))) {
      problems.push(`"${LS_NAME}" is missing dist/${file}.cjs`);
    }
  }
  problems.push(
    ...unresolvedRequires(
      lsRoot,
      "shipped language server",
      LS_PROJECT_RESOLVED,
    ),
    ...bakedPaths(lsRoot, buildRoot),
  );
  return problems;
}

export function checkExtensionRoot(
  root: string,
  {
    entries = BUNDLED_ENTRIES,
    lsEntries = LS_ENTRIES,
    lockfile = defaultLockfile,
    buildRoot = repoRoot,
  }: CheckOptions = {},
): string[] {
  const problems: string[] = [];
  root = realpathSync(root); // resolution reports real paths (macOS /var -> /private/var)
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

    problems.push(
      ...unresolvedRequires(pluginRoot, "shipped plugin", PROJECT_RESOLVED),
      ...bakedPaths(pluginRoot, buildRoot),
    );
  }

  problems.push(
    ...checkLanguageServer(root, requireFromRoot, lsEntries, buildRoot),
  );

  // Shipped versions must be the ones bun.lock pins (no floating transitives).
  const locked = lockedVersions(lockfile);
  const shipped = shippedPackages(root);
  for (const { name, version } of shipped) {
    if (name === "@mxlang/typescript-plugin" || name === LS_NAME) continue;
    if (!locked.get(name)?.has(version)) {
      problems.push(
        `${name}@${version} is not a version bun.lock pins (${[...(locked.get(name) ?? [])].join(", ") || "not in the lockfile"})`,
      );
    }
  }

  // The copied closure must be complete: every non-optional dependency of a
  // shipped package resolves from that package's own location, walking up
  // node_modules like Node does (a lazily-required package would otherwise
  // crash at first use, not at load).
  for (const pkg of shipped) {
    for (const dep of pkg.dependencies) {
      if (!resolvesFrom(pkg.dir, dep, root)) {
        problems.push(
          `${pkg.name}@${pkg.version} depends on ${dep}, which is not shipped (does not resolve from ${pkg.dir.slice(root.length + 1)})`,
        );
      }
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
