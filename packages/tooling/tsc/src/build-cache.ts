/**
 * A cache of the Angular template pass of `mx-tsc -b`, one sidecar file per
 * project of the build graph.
 *
 * `tsc -b` skips a project its build info calls up to date, but its
 * incremental state knows nothing about templates, so the template pass is
 * never skipped on tsc's say-so (`build-templates.ts`). Re-running it means one
 * extra program per project (`compileProjectNgMx` in `index.ts`) and an
 * Angular checker, about 3.7 s per Angular project. A project's stored answer
 * is replayed only when a key proves every input of that answer unchanged by
 * content; any doubt is a miss, and a miss runs the full pass.
 *
 * The key is SHA-256 over, in this order: a format number; the tool (mx-tsc's
 * own code and the externals that lower and check templates, by their bytes);
 * the `typescript` version mx-tsc runs; whether `--astro` was given; the
 * project's tsconfig and build info paths; the build info's `fileNames` and
 * `fileInfos` (tsc's own per-file content hashes of every file the program
 * read, written by the tsc run that just finished); the raw bytes of the
 * tsconfig and every file of its `extends` chain; the raw bytes of every `.mx`
 * file of the program (tsc hashes their authored text, not the lowered text the
 * host config decides); every `package.json` and MX config file that can decide
 * those files' host and Angular config, or "absent" for each probed path; the
 * custom-tag discovery of each `.mx` file (every candidate tag directory's
 * listing and file bytes, and the manifests and configs the scan read); the
 * `@angular/compiler-cli` and checker `typescript` the project resolves; and
 * the previous project's key, this project's position in the graph and the
 * files earlier projects claimed (ownership of an overlapping `.ng.mx`). No
 * modification time is read.
 *
 * The build info is an input only. TypeScript rewrites it wholesale, so the
 * answer lives beside it, in `<tsbuildinfo>.mx-ng.json`.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCompilerCli, resolveTypescript } from "@mxlang/angular-checker";
import {
  createTargetLookup,
  findMxConfig,
  isTranslateError,
  scanCached,
  type TargetDescriptor,
  type TargetLookup,
} from "@mxlang/core";
import type ts from "typescript";
import {
  type NgDiagnosticsResult,
  nearestPackageDir,
} from "./ng-diagnostics.ts";
import { packageJsonInputs } from "./watch-package-json.ts";

type TypeScript = typeof ts;

/** Bump on any change to the key's inputs or the sidecar's layout. */
export const BUILD_CACHE_FORMAT = 1;

/** The sidecar of a project whose build info is at `buildInfoPath`. */
export const sidecarPath = (buildInfoPath: string) =>
  `${buildInfoPath}.mx-ng.json`;

/**
 * Test seam: a caller of `runMxTscArgs` may pass one to count how often the
 * `-b` template pass created a program for a project's `.ng.mx` files and an
 * Angular checker. A cache hit creates neither. The CLI passes none.
 */
export interface BuildPassProbe {
  compiles: number;
  checkers: number;
}

/** What the compiler-cli lookup of one package directory found. */
export interface CompilerCliInput {
  dir: string;
  status: string;
  version?: string | undefined;
  /** Real path of `@angular/compiler-cli/package.json`. */
  packageJson?: string | undefined;
  /** The `typescript` the checker would load, `status:version`. */
  typescript?: string | undefined;
}

/** A file read for the key: its path and content, `null` when absent. */
export interface FileInput {
  path: string;
  text: string | null;
}

/**
 * Every input of one project's key, already read. {@link cacheKey} hashes
 * them in a fixed order; nothing here is a modification time.
 */
export interface CacheKeyInputs {
  format: number;
  /** {@link toolIdentity}: hashes of the code that lowers and checks templates. */
  tool: string;
  /** `ts.version` of the TypeScript mx-tsc itself runs. */
  typescriptVersion: string;
  astro: boolean;
  tsconfigPath: string;
  buildInfoPath: string;
  /** The build info's `fileNames` and `fileInfos`, as read. */
  fileNames: readonly string[];
  fileInfos: readonly unknown[];
  /** The tsconfig and its `extends` chain, in that order. */
  configFiles: readonly FileInput[];
  /** Every `.mx` file of the program, sorted by path. */
  mxFiles: readonly FileInput[];
  /** Every manifest and MX config file that decides an `.mx` file's config. */
  configInputs: readonly FileInput[];
  /**
   * Custom-tag discovery of every `.mx` file: each candidate tag directory
   * (its listing, then each file under it) and the files the scan read.
   */
  tagInputs: readonly FileInput[];
  compilerCli: readonly CompilerCliInput[];
  /** The previous project's key in graph order (`""` for the first). */
  previous: string;
  position: number;
  /** The `.ng.mx` files earlier projects claimed, sorted. */
  claimed: readonly string[];
}

const hashText = (text: string | null) =>
  text === null ? null : createHash("sha256").update(text).digest("hex");

/** SHA-256 over `inputs`, field by field in a fixed order. */
export function cacheKey(inputs: CacheKeyInputs): string {
  const hash = createHash("sha256");
  const add = (label: string, value: unknown) => {
    hash.update(label).update("\0").update(JSON.stringify(value)).update("\0");
  };
  const files = (list: readonly FileInput[]) =>
    list.map(({ path, text }) => [path, hashText(text)]);
  add("format", inputs.format);
  add("tool", inputs.tool);
  add("typescript", inputs.typescriptVersion);
  add("astro", inputs.astro);
  add("tsconfig", inputs.tsconfigPath);
  add("buildinfo", inputs.buildInfoPath);
  add("fileNames", inputs.fileNames);
  add("fileInfos", inputs.fileInfos);
  add("configFiles", files(inputs.configFiles));
  add("mxFiles", files(inputs.mxFiles));
  add("configInputs", files(inputs.configInputs));
  add("tagInputs", files(inputs.tagInputs));
  add("compilerCli", inputs.compilerCli);
  add("previous", inputs.previous);
  add("position", inputs.position);
  add("claimed", inputs.claimed);
  return hash.digest("hex");
}

function readText(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Every file under `dir`, sorted, skipping `node_modules`; `[]` when absent. */
function filesUnder(
  dir: string,
  keep: (path: string) => boolean,
  enter: (name: string) => boolean = (name) => name !== "node_modules",
): string[] {
  const found: string[] = [];
  const visit = (current: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (enter(entry.name)) visit(path);
      } else if (keep(path)) {
        found.push(path);
      }
    }
  };
  visit(dir);
  return found.sort();
}

/** One package the tool's answer depends on (see {@link toolIdentity}). */
export interface ToolExternal {
  name: string;
  /** Resolved from mx-tsc (`"self"`) or from an earlier external's entry. */
  from: string;
  /** Files beside the entry whose bytes count too, relative to it. */
  siblings?: readonly string[];
  /**
   * Not MX code: its `package.json` version and real path stand for it
   * (`@angular/compiler`, which host-angular lowers with).
   */
  manifestOnly?: boolean;
}

/**
 * The externals that lower and check templates. Three resolve from this
 * package; `@mxlang/core` and `@mxlang/tsx-bridge` from the
 * `@mxlang/typescript-plugin` that lowers with them (core with the parse layer
 * its dist loads beside itself); `@mxlang/web-elements` (the element table)
 * and `@angular/compiler` from `@mxlang/host-angular`.
 */
export const TOOL_EXTERNALS: readonly ToolExternal[] = [
  { name: "@mxlang/angular-checker", from: "self" },
  { name: "@mxlang/host-angular", from: "self" },
  { name: "@mxlang/typescript-plugin", from: "self" },
  {
    name: "@mxlang/core",
    from: "@mxlang/typescript-plugin",
    siblings: ["marko-frontend.cjs"],
  },
  { name: "@mxlang/tsx-bridge", from: "@mxlang/typescript-plugin" },
  { name: "@mxlang/web-elements", from: "@mxlang/host-angular" },
  {
    name: "@angular/compiler",
    from: "@mxlang/host-angular",
    manifestOnly: true,
  },
];

const isTestFile = (path: string) => /\.test\.[cm]?tsx?$/.test(path);

/**
 * A directory of mx-tsc's own sources: not `node_modules`, not a fixture
 * directory (`fixtures*`) and not a dot-directory (the scratch projects tests
 * create beside their sources), whose `.ts` files are inputs, not code.
 */
const isCodeDirectory = (name: string) =>
  name !== "node_modules" &&
  !name.startsWith(".") &&
  !name.startsWith("fixtures");

/**
 * The code that decides a template's lowering and diagnostics, by its bytes
 * (workspace versions do not move, so a version alone is not enough):
 *
 * - mx-tsc itself: `self`, the bundle in a built package, which carries every
 *   module it does not leave external. Run from source (`self` is a `.ts`
 *   file), every non-test `.ts` file of the directory `self` is in and below
 *   it, fixture and dot-directories aside, so an edit to any of this
 *   package's modules counts.
 * - each of `externals`: its entry file's bytes, its siblings' bytes (a
 *   missing sibling counts as `missing`), its `package.json` version and the
 *   version and real directory of each of its `dependencies` as installed
 *   beside it (Babel, the template parser, cosmiconfig: a lockfile bump moves
 *   no MX version), or for a manifest-only one its version and the real path
 *   of its `package.json`.
 * - run from source, also each file a relative import of those modules
 *   reaches outside their directory (`../../typescript-plugin/src/...`).
 *
 * `undefined` when any of it cannot be resolved or read: then nothing is
 * cached.
 */
export function toolIdentity(
  options: { self?: string; externals?: readonly ToolExternal[] } = {},
): string | undefined {
  const self = options.self ?? fileURLToPath(import.meta.url);
  const parts: string[] = [];
  const selfFiles = self.endsWith(".ts")
    ? filesUnder(
        dirname(self),
        (p) => p.endsWith(".ts") && !isTestFile(p),
        isCodeDirectory,
      )
    : [self];
  const selfDir = dirname(self);
  const isOutside = (path: string) => relative(selfDir, path).startsWith("..");
  // Run from source: what a relative import reaches outside `src/`, and what
  // those modules import in turn (`typescript-plugin/src/tsconfig-paths.ts`).
  const outside = new Set<string>();
  const pending: string[] = [];
  const follow = (file: string, text: string) => {
    if (!self.endsWith(".ts")) return;
    for (const path of relativeImportsOf(file, text)) {
      if (isOutside(path) && !outside.has(path)) {
        outside.add(path);
        pending.push(path);
      }
    }
  };
  for (const file of selfFiles) {
    const text = readText(file);
    if (text === null) return undefined;
    parts.push(`self:${slash(relative(selfDir, file))}:${hashText(text)}`);
    follow(file, text);
  }
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    const text = readText(file);
    if (text === null) return undefined;
    follow(file, text);
  }
  for (const file of [...outside].sort()) {
    const text = readText(file);
    if (text === null) return undefined;
    parts.push(
      `self-import:${slash(relative(selfDir, file))}:${hashText(text)}`,
    );
  }
  const installed = new Map<string, string>();
  const entries = new Map<string, string>([["self", self]]);
  for (const external of options.externals ?? TOOL_EXTERNALS) {
    const base = entries.get(external.from);
    if (base === undefined) return undefined;
    const require = createRequire(base);
    try {
      if (external.manifestOnly) {
        const manifest = realpathSync(
          require.resolve(`${external.name}/package.json`),
        );
        const version = versionOf(manifest);
        if (version === undefined) return undefined;
        parts.push(`${external.name}@${version}:${manifest}`);
        continue;
      }
      const entry = require.resolve(external.name);
      entries.set(external.name, entry);
      const packageDir = nearestPackageDir(entry);
      const manifest = readText(join(packageDir, "package.json"));
      const version = versionOf(join(packageDir, "package.json"));
      if (manifest === null || version === undefined) return undefined;
      parts.push(`${external.name}@${version}`);
      const text = readText(entry);
      if (text === null) return undefined;
      parts.push(`${basename(entry)}:${hashText(text)}`);
      // A sibling that is gone is an input too: `missing`, not uncacheable.
      for (const sibling of external.siblings ?? []) {
        const siblingText = readText(join(dirname(entry), sibling));
        parts.push(
          `${sibling}:${siblingText === null ? "missing" : hashText(siblingText)}`,
        );
      }
      collectInstalled(packageDir, manifest, installed);
    } catch (error) {
      // Not installed, or not readable: uncacheable. Anything else is a bug.
      if (isUnreadableInput(error)) return undefined;
      throw error;
    }
  }
  for (const [dir, line] of [...installed].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    parts.push(`${line}:${dir}`);
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/**
 * Every package `dependencies` reaches from the package at `packageDir`,
 * transitively (`@babel/core` brings `@babel/traverse`), keyed by its real
 * directory, as `dep:<name>@<version>`; one that is not installed as
 * `dep:<name>:missing`, keyed by where it was looked for from.
 */
function collectInstalled(
  packageDir: string,
  manifest: string,
  installed: Map<string, string>,
): void {
  const queue: [string, string][] = [[packageDir, manifest]];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    const [from, text] = next;
    for (const dependency of dependenciesOf(text)) {
      const dir = installedPackageDir(from, dependency);
      if (dir === undefined) {
        installed.set(
          `${slash(from)}>${dependency}`,
          `dep:${dependency}:missing`,
        );
        continue;
      }
      if (installed.has(dir)) continue;
      const dependencyManifest = readText(join(dir, "package.json"));
      const version =
        dependencyManifest === null
          ? undefined
          : versionOf(join(dir, "package.json"));
      installed.set(dir, `dep:${dependency}@${version ?? "unknown"}`);
      if (dependencyManifest !== null) queue.push([dir, dependencyManifest]);
    }
  }
}

/** The `dependencies` names of a `package.json` text, sorted. */
function dependenciesOf(manifest: string): string[] {
  try {
    const { dependencies } = JSON.parse(manifest) as {
      dependencies?: unknown;
    };
    return typeof dependencies === "object" && dependencies !== null
      ? Object.keys(dependencies).sort()
      : [];
  } catch {
    return [];
  }
}

/**
 * The real directory of package `name` as Node finds it from `fromDir`: the
 * first `node_modules/<name>/package.json` walking up. Read by path, not
 * through `require.resolve`, so a package whose `exports` hides its
 * `package.json` (or has no `require` condition) is found too.
 */
function installedPackageDir(
  fromDir: string,
  name: string,
): string | undefined {
  let dir = realpathSync(fromDir);
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) {
      return realpathSync(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The files a module's relative specifiers ({@link specifiersOf}) name. */
function relativeImportsOf(file: string, text: string): string[] {
  const found: string[] = [];
  for (const spec of specifiersOf(text)) {
    if (!RELATIVE.test(spec)) continue;
    const path = resolve(dirname(file), spec);
    // As written, a `.js` specifier's `.ts` source, extensionless, or a
    // directory's index module.
    const resolved = [
      path,
      ...(/\.[cm]?js$/.test(path)
        ? [path.replace(/\.([cm]?)js$/, ".$1ts")]
        : []),
      `${path}.ts`,
      `${path}.tsx`,
      join(path, "index.ts"),
    ].find((candidate) => existsSync(candidate) && !isDirectory(candidate));
    if (resolved !== undefined) found.push(resolved);
  }
  return found;
}

const RELATIVE = /^\.{1,2}\//;

/**
 * Every module specifier a file writes that reaches code at runtime (`from`,
 * `import`, `import()`, `require()`). A type-only `import type`/`export type`
 * statement is erased, so it is left out.
 */
function specifiersOf(text: string): string[] {
  const code = text.replace(
    /\b(?:import|export)\s+type\b[^;]*?\bfrom\s*["'][^"']+["']/g,
    "",
  );
  return [
    ...code.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g,
    ),
  ].map((match) => match[1] as string);
}

function versionOf(manifest: string): string | undefined {
  const text = readText(manifest);
  if (text === null) return undefined;
  try {
    const version = (JSON.parse(text) as { version?: unknown }).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/** Seams for tests; production uses the real resolvers. */
export interface BuildCacheDeps {
  resolveCompilerCli?: typeof resolveCompilerCli;
  resolveTypescript?: typeof resolveTypescript;
}

/** The compiler-cli and checker TypeScript one package directory resolves. */
export function compilerCliInput(
  dir: string,
  deps: BuildCacheDeps = {},
): CompilerCliInput {
  const resolution = (deps.resolveCompilerCli ?? resolveCompilerCli)(dir);
  if (resolution.status !== "ok") {
    return {
      dir,
      status: resolution.status,
      version: "version" in resolution ? resolution.version : undefined,
    };
  }
  const typescript = (deps.resolveTypescript ?? resolveTypescript)(
    dir,
    resolution.packageJson,
  );
  return {
    dir,
    status: "ok",
    version: resolution.version,
    packageJson: resolution.packageJson,
    typescript:
      typescript.status === "ok"
        ? `ok:${typescript.version}`
        : typescript.status,
  };
}

/** Script and data files a program may hold, which `fileInfos` covers. */
const SCRIPT_EXTENSIONS = /\.(?:[cm]?tsx?|[cm]?jsx?|json)$/;

/**
 * The `.mx` files whose lowering the key covers: `.ng.mx` and a plain `.mx`
 * (a name with no other dot). Their tag discovery is scanned with the Angular
 * target lookup the template pass uses. A region file of another host
 * (`.solid.mx`, `.react.mx`, ...), an `.astro.mx`, or a dialect's file (such
 * as `x.probe.mx`, whose rules live in a module no input covers) would need
 * its own target's scan and lowering in the key, so a project holding one is
 * not cacheable.
 */
function coveredMx(file: string): boolean {
  if (!file.endsWith(".mx")) return false;
  if (file.endsWith(".ng.mx")) return true;
  return !basename(file).slice(0, -".mx".length).includes(".");
}

let angularTargets: TargetLookup | undefined;

/**
 * The descriptor a descriptor module exports by default. In the CommonJS
 * bundle the ESM module arrives through the bundler's interop, which can wrap
 * the namespace once more (`{ default: { default: descriptor } }`), so this
 * unwraps `default` until it reaches an object with a `descriptorVersion`.
 */
export function descriptorOf(module: unknown): TargetDescriptor {
  let value = module;
  for (let depth = 0; depth < 3; depth++) {
    if (typeof value !== "object" || value === null) break;
    if ("descriptorVersion" in value) return value as TargetDescriptor;
    value = (value as { default?: unknown }).default;
  }
  throw new Error("@mxlang/host-angular/descriptor exports no descriptor");
}

/**
 * The inputs of each `.mx` file's custom-tag discovery, by core's own scan
 * (`scanCached`, the walk the compile runs): every candidate tag directory
 * the scan probed, as its listing (absent ones too) and every file under it,
 * plus the manifests, config search places and tag files the scan read.
 * Hashing every file under a tag directory, not only the ones the scan
 * indexed, keeps the answer independent of the target lookup the scan is run
 * with. `undefined` when a module the scan read (a `.tag.ts` sidecar, an
 * `mx.contracts` module, a dialect module) has a relative import that leaves
 * the hashed tag directories: that file's code is no input of the key.
 */
function tagInputsOf(mxPaths: readonly string[]): FileInput[] | undefined {
  // Loaded here, not at module load: only the `-b` cache path reads it.
  angularTargets ??= createTargetLookup([
    descriptorOf(
      createRequire(import.meta.url)("@mxlang/host-angular/descriptor"),
    ),
  ]);
  const inputs = new Map<string, string | null>();
  const directories = new Set<string>();
  const read = new Set<string>();
  for (const file of mxPaths) {
    const scan = scanCached(file, { targets: angularTargets });
    for (const dir of scan.directories) directories.add(dir);
    for (const path of [
      ...scan.packageFiles,
      ...(scan.configFiles ?? []),
      ...scan.files.map((f) => f.path),
    ]) {
      read.add(path);
    }
  }
  // Each directory and file once, however many `.mx` files share it.
  for (const dir of directories) {
    const files = filesUnder(dir, () => true);
    inputs.set(
      `${slash(dir)}/`,
      isDirectory(dir) ? files.map((f) => slash(f)).join("\n") : null,
    );
    for (const f of files) read.add(f);
  }
  for (const path of read) {
    const text = readText(path);
    inputs.set(slash(path), text);
    if (text !== null && MODULE_FILE.test(path)) {
      if (!importsCovered(path, text, directories)) return undefined;
    }
  }
  return [...inputs]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, text]) => ({ path, text }));
}

const MODULE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/**
 * Whether every module a tag-scan module imports is code the key covers or
 * leaves to the `--force` caveat. A relative specifier must point inside a
 * hashed tag directory (as written; existence is not checked). A bare one (a
 * package, a tsconfig path alias) must resolve, from the importing file, to a
 * real path under a `node_modules` directory: an installed package, which an
 * install changes. One that does not resolve, or resolves to a workspace
 * package through a link or to a source path, is code no key field covers.
 */
function importsCovered(
  file: string,
  text: string,
  directories: ReadonlySet<string>,
): boolean {
  const require = createRequire(file);
  return specifiersOf(text).every((spec) => {
    if (RELATIVE.test(spec)) {
      const target = slash(resolve(dirname(file), spec));
      return [...directories].some((dir) =>
        target.startsWith(`${slash(dir)}/`),
      );
    }
    if (isBuiltin(spec)) return true;
    let resolved: string;
    try {
      resolved = realpathSync(require.resolve(spec));
    } catch {
      return false;
    }
    return slash(resolved).includes("/node_modules/");
  });
}

/**
 * Whether an `mx.target`/`mx.host` value is a package or path specifier
 * (core's own test, `host-policy.ts`): core loads that descriptor module, and
 * its code is no input of the key. Conservative: a specifier a built-in target
 * owns counts too.
 */
function isSpecifier(value: unknown): boolean {
  return (
    typeof value === "string" && (value.includes("/") || /^[@./]/.test(value))
  );
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** What one project of the graph needs to look up or store its answer. */
export interface ProjectCacheContext {
  tsconfigPath: string;
  /** The root files tsc selects for the project (`BuildProject.rootNames`). */
  rootNames: readonly string[];
  astro: boolean;
  /** {@link toolIdentity}, asked only once a project has a build info. */
  tool: () => string | undefined;
  previous: string;
  position: number;
  claimed: ReadonlySet<string>;
  deps?: BuildCacheDeps;
}

/** A project whose key could be computed. */
export interface ProjectCacheEntry {
  key: string;
  sidecar: string;
  /** The `.ng.mx` files of the program, as tsc listed them (absolute, `/`). */
  ngFiles: readonly string[];
}

const slash = (path: string) => path.replaceAll("\\", "/");

/**
 * The key of one project, read after tsc ran (its build info is then current)
 * and before the project's `.ng.mx` files are compiled. `undefined` when the
 * project cannot be cached: no build info (not composite or incremental, or
 * tsc wrote none), a build info of an unexpected shape or another TypeScript,
 * a root file the build info does not list, a file kind the key does not
 * cover (a dialect file, `.astro`), an MX config that is a module (the
 * modules it imports are no input), or an input that cannot be read.
 */
export function projectCacheEntry(
  typescript: TypeScript,
  context: ProjectCacheContext,
): ProjectCacheEntry | undefined {
  try {
    return readEntry(typescript, context);
  } catch (error) {
    if (isUnreadableInput(error)) return undefined;
    // A bug in building the key (a TypeError, a descriptor error) must not
    // turn the cache off unseen.
    throw error;
  }
}

/**
 * A throw that says an input could not be read, which makes a project
 * uncacheable: a Node fs error (an errno `code`) or an unresolved module, a malformed JSON input
 * (`SyntaxError`), or core's `TranslateError` for a tag file or manifest the
 * compile reports itself. Anything else is a bug and is rethrown.
 */
function isUnreadableInput(error: unknown): boolean {
  if (error instanceof SyntaxError || isTranslateError(error)) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return (
    error instanceof Error &&
    typeof code === "string" &&
    UNREADABLE_CODES.has(code)
  );
}

/**
 * The codes of an input that cannot be read: fs errno codes and a module
 * that does not resolve. Node's own `ERR_*` codes (`ERR_INVALID_ARG_TYPE`,
 * ...) are programming errors and are rethrown.
 */
const UNREADABLE_CODES = new Set([
  "ENOENT",
  "ENOTDIR",
  "EISDIR",
  "EACCES",
  "EPERM",
  "ELOOP",
  "EMFILE",
  "ENFILE",
  "ENAMETOOLONG",
  "EIO",
  "EBUSY",
  "MODULE_NOT_FOUND",
]);

function readEntry(
  typescript: TypeScript,
  context: ProjectCacheContext,
): ProjectCacheEntry | undefined {
  const { tsconfigPath } = context;
  let unrecoverable = false;
  const parsed = typescript.getParsedCommandLineOfConfigFile(
    tsconfigPath,
    {},
    {
      ...typescript.sys,
      onUnRecoverableConfigFileDiagnostic: () => {
        unrecoverable = true;
      },
    },
  );
  if (!parsed || unrecoverable) return undefined;
  const buildInfoPath = typescript.getTsBuildInfoEmitOutputFilePath(
    parsed.options,
  );
  if (!buildInfoPath) return undefined;
  const buildInfoText = readText(buildInfoPath);
  if (buildInfoText === null) return undefined;
  const buildInfo = JSON.parse(buildInfoText) as {
    version?: unknown;
    fileNames?: unknown;
    fileInfos?: unknown;
  };
  const { fileNames, fileInfos } = buildInfo;
  if (
    buildInfo.version !== typescript.version ||
    !Array.isArray(fileNames) ||
    !Array.isArray(fileInfos) ||
    fileNames.length !== fileInfos.length ||
    !fileNames.every((name) => typeof name === "string") ||
    !fileInfos.every(
      (info) =>
        typeof info === "string" ||
        (typeof info === "object" &&
          info !== null &&
          typeof (info as { version?: unknown }).version === "string"),
    )
  ) {
    return undefined;
  }
  const base = dirname(buildInfoPath);
  const files = (fileNames as string[]).map((name) =>
    slash(resolve(base, name)),
  );
  if (!files.every((file) => SCRIPT_EXTENSIONS.test(file) || coveredMx(file))) {
    return undefined;
  }
  const listed = new Set(files);
  if (!context.rootNames.every((file) => listed.has(slash(file)))) {
    return undefined;
  }
  const tool = context.tool();
  if (tool === undefined) return undefined;

  const configFiles: FileInput[] = [
    tsconfigPath,
    ...((parsed.options.configFile as ts.TsConfigSourceFile | undefined)
      ?.extendedSourceFiles ?? []),
  ].map((path) => ({ path, text: readText(path) }));
  if (configFiles.some((file) => file.text === null)) return undefined;

  const mxPaths = files.filter((file) => file.endsWith(".mx")).sort();
  const mxFiles = mxPaths.map((path) => ({ path, text: readText(path) }));
  if (mxFiles.some((file) => file.text === null)) return undefined;

  // Once per directory: every `.mx` file of a directory probes the same paths.
  const probed = new Set<string>();
  for (const [dir, file] of new Map(mxPaths.map((f) => [dirname(f), f]))) {
    for (const path of packageJsonInputs(file)) probed.add(slash(path));
    const config = findMxConfig(dir);
    // A module's imports, and the files a JSON or YAML config pulls in through
    // cosmiconfig's `$import`, are config inputs core does not list in
    // `watch`. The text check is conservative: `$import` anywhere in the file
    // (a nested key, a string) only costs the cache, never a stale answer.
    // A config whose revision failed to load (malformed, a failed `$import`)
    // is answered from the previous good revision, which no input covers.
    if (
      config?.error !== undefined ||
      config?.format === "module" ||
      config?.text.includes("$import")
    ) {
      return undefined;
    }
    // A target or host given as a specifier is a descriptor module core loads.
    const values = config?.config;
    if (isSpecifier(values?.target) || isSpecifier(values?.host)) {
      return undefined;
    }
    for (const path of config?.watch ?? []) probed.add(slash(path));
  }
  const configInputs = [...probed]
    .sort()
    .map((path) => ({ path, text: readText(path) }));

  const ngFiles = mxPaths.filter((file) => file.endsWith(".ng.mx"));
  const compilerCli = [...new Set(ngFiles.map(nearestPackageDir))]
    .sort()
    .map((dir) => compilerCliInput(dir, context.deps));

  const tagInputs = tagInputsOf(mxPaths);
  if (tagInputs === undefined) return undefined;

  const key = cacheKey({
    format: BUILD_CACHE_FORMAT,
    tool,
    typescriptVersion: typescript.version,
    astro: context.astro,
    tsconfigPath: slash(tsconfigPath),
    buildInfoPath: slash(buildInfoPath),
    fileNames: fileNames as string[],
    fileInfos,
    configFiles,
    mxFiles,
    configInputs,
    tagInputs,
    compilerCli,
    previous: context.previous,
    position: context.position,
    claimed: [...context.claimed].sort(),
  });
  return { key, sidecar: sidecarPath(buildInfoPath), ngFiles };
}

/** What a project's fresh pass produced, as {@link mayStore} weighs it. */
export interface StoreFacts {
  /** Project-level errors of the pass (`NgDiagnosticsResult.errors`). */
  projectErrors: number;
  /** The run's `ambientTypes` errors. */
  ambientErrors: number;
  /** MX compile diagnostics (any category) of the project's own program. */
  compileDiagnostics: number;
  /** Host-policy diagnostics (`TS80003`, warnings too) of that program. */
  policyDiagnostics: number;
  /** The `.ng.mx` files that program compiled. */
  compiled: readonly string[];
  /** The `.ng.mx` files the build info lists (`ProjectCacheEntry.ngFiles`). */
  listed: readonly string[];
  /** Whether any owned file's Angular diagnostics are `"off"` (or unreadable). */
  diagnosticsOff: boolean;
}

/**
 * Whether a project's fresh answer may be stored: only when it is all the pass
 * would print for the project. Compile, policy and ambient-types diagnostics
 * are printed from the project's own program, which a hit skips; a
 * project-level error is environmental (a missing compiler-cli, a bad config);
 * a hit derives ownership from the build info, so the program must have
 * compiled exactly the `.ng.mx` files tsc listed; and `"off"` is never stored.
 */
export function mayStore(facts: StoreFacts): boolean {
  if (
    facts.projectErrors > 0 ||
    facts.ambientErrors > 0 ||
    facts.compileDiagnostics > 0 ||
    facts.policyDiagnostics > 0 ||
    facts.diagnosticsOff
  ) {
    return false;
  }
  const listed = new Set(facts.listed);
  const compiled = new Set(facts.compiled);
  return (
    compiled.size === listed.size &&
    [...compiled].every((name) => listed.has(name))
  );
}

/** What a sidecar holds. */
export interface StoredAnswer {
  format: number;
  key: string;
  ownedFiles: string[];
  ngResult: NgDiagnosticsResult;
}

const CATEGORIES = new Set(["error", "warning", "suggestion", "message"]);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isDiagnostic(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.start === "number" &&
    typeof d.length === "number" &&
    typeof d.code === "number" &&
    typeof d.message === "string" &&
    typeof d.category === "string" &&
    CATEGORIES.has(d.category) &&
    d.source === "angular" &&
    typeof d.mapped === "string"
  );
}

function isReport(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.fileName === "string" &&
    typeof r.source === "string" &&
    Array.isArray(r.diagnostics) &&
    r.diagnostics.every(isDiagnostic)
  );
}

/**
 * The stored answer for `entry`, when its sidecar holds one under the same
 * format and key, of the expected shape, owning exactly the files `entry`
 * would own now. Anything else (no file, an unreadable, empty, truncated or
 * otherwise invalid one) is a miss: `undefined`, never a throw.
 */
export function readStoredAnswer(
  entry: ProjectCacheEntry,
  claimed: ReadonlySet<string>,
): StoredAnswer | undefined {
  const text = readText(entry.sidecar);
  if (text === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const stored = value as Record<string, unknown>;
  const result = stored.ngResult as Record<string, unknown> | undefined;
  if (
    stored.format !== BUILD_CACHE_FORMAT ||
    stored.key !== entry.key ||
    !isStringArray(stored.ownedFiles) ||
    typeof result !== "object" ||
    result === null ||
    !Array.isArray(result.reports) ||
    !result.reports.every(isReport) ||
    !isStringArray(result.warnings) ||
    !isStringArray(result.errors) ||
    result.errors.length > 0
  ) {
    return undefined;
  }
  const owned = entry.ngFiles.filter((file) => !claimed.has(file)).sort();
  const storedOwned = [...stored.ownedFiles].sort();
  if (
    owned.length !== storedOwned.length ||
    owned.some((file, i) => file !== storedOwned[i])
  ) {
    return undefined;
  }
  return value as StoredAnswer;
}

/**
 * Stores `answer` atomically (a temporary file in the same directory, then a
 * rename). A failed write (a read-only directory) is swallowed: the cache only
 * saves time, and the next run is a miss.
 */
export function writeStoredAnswer(
  entry: ProjectCacheEntry,
  ownedFiles: readonly string[],
  ngResult: NgDiagnosticsResult,
): void {
  const answer: StoredAnswer = {
    format: BUILD_CACHE_FORMAT,
    key: entry.key,
    ownedFiles: [...ownedFiles],
    ngResult,
  };
  const temporary = `${entry.sidecar}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(answer));
    renameSync(temporary, entry.sidecar);
  } catch {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Nothing was written, or the directory refuses removal too.
    }
  }
}
