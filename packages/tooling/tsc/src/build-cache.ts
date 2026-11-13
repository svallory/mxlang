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
 * The key is SHA-256 over, in this order: a format number; the tool (this
 * module's bundle and the externals that compile and check templates); the
 * `typescript` version mx-tsc runs; whether `--astro` was given; the project's
 * tsconfig and build info paths; the build info's `fileNames` and `fileInfos`
 * (tsc's own per-file content hashes of every file the program read, written by
 * the tsc run that just finished); the raw bytes of the tsconfig and every file
 * of its `extends` chain; the raw bytes of every `.mx` file of the program
 * (tsc hashes their authored text, not the lowered text the host config
 * decides); every `package.json` and MX config file that can decide those
 * files' host and Angular config, or "absent" for each probed path; the
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
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCompilerCli, resolveTypescript } from "@mxlang/angular-checker";
import { findMxConfig } from "@mxlang/core";
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

/**
 * The externals that lower and check templates: the first three resolved from
 * this package, the two `@mxlang/typescript-plugin` lowers with resolved from
 * it (`@mxlang/tsx-bridge` is not a dependency of this package).
 */
const EXTERNALS: readonly [name: string, from: "self" | "plugin"][] = [
  ["@mxlang/angular-checker", "self"],
  ["@mxlang/host-angular", "self"],
  ["@mxlang/typescript-plugin", "self"],
  ["@mxlang/core", "plugin"],
  ["@mxlang/tsx-bridge", "plugin"],
];

/**
 * The code that decides a template's lowering and diagnostics: SHA-256 of
 * mx-tsc's own module file (the bundle in a built package, which carries every
 * module it does not leave external), and of each external's entry file plus
 * its version (workspace versions do not move, so a version alone is not
 * enough). `undefined` when any of it cannot be read: then nothing is cached.
 */
export function toolIdentity(): string | undefined {
  const self = fileURLToPath(import.meta.url);
  const selfText = readText(self);
  if (selfText === null) return undefined;
  const parts = [`self:${hashText(selfText)}`];
  const requireFrom = {
    self: createRequire(self),
    plugin: createRequire(self),
  };
  for (const [name, from] of EXTERNALS) {
    let entry: string;
    try {
      entry = requireFrom[from].resolve(name);
    } catch {
      return undefined;
    }
    if (name === "@mxlang/typescript-plugin") {
      requireFrom.plugin = createRequire(entry);
    }
    const text = readText(entry);
    const manifest = readText(join(nearestPackageDir(entry), "package.json"));
    if (text === null || manifest === null) return undefined;
    let version: unknown;
    try {
      version = (JSON.parse(manifest) as { version?: unknown }).version;
    } catch {
      return undefined;
    }
    parts.push(`${name}@${String(version)}:${hashText(text)}`);
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex");
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

/** Extensions a program may hold whose answer the key covers. */
const KNOWN_EXTENSIONS = /\.(?:[cm]?tsx?|[cm]?jsx?|json|mx)$/;

/** What one project of the graph needs to look up or store its answer. */
export interface ProjectCacheContext {
  tsconfigPath: string;
  /** The root files tsc selects for the project (`BuildProject.rootNames`). */
  rootNames: readonly string[];
  astro: boolean;
  tool: string;
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
 * cover (a dialect file, `.astro`), or an input that cannot be read.
 */
export function projectCacheEntry(
  typescript: TypeScript,
  context: ProjectCacheContext,
): ProjectCacheEntry | undefined {
  try {
    return readEntry(typescript, context);
  } catch {
    return undefined;
  }
}

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
  if (!files.every((file) => KNOWN_EXTENSIONS.test(file))) return undefined;
  const listed = new Set(files);
  if (!context.rootNames.every((file) => listed.has(slash(file)))) {
    return undefined;
  }

  const configFiles: FileInput[] = [
    tsconfigPath,
    ...((parsed.options.configFile as ts.TsConfigSourceFile | undefined)
      ?.extendedSourceFiles ?? []),
  ].map((path) => ({ path, text: readText(path) }));
  if (configFiles.some((file) => file.text === null)) return undefined;

  const mxPaths = files.filter((file) => file.endsWith(".mx")).sort();
  const mxFiles = mxPaths.map((path) => ({ path, text: readText(path) }));
  if (mxFiles.some((file) => file.text === null)) return undefined;

  const probed = new Set<string>();
  for (const file of mxPaths) {
    for (const path of packageJsonInputs(file)) probed.add(slash(path));
    for (const path of findMxConfig(dirname(file))?.watch ?? []) {
      probed.add(slash(path));
    }
  }
  const configInputs = [...probed]
    .sort()
    .map((path) => ({ path, text: readText(path) }));

  const ngFiles = mxPaths.filter((file) => file.endsWith(".ng.mx"));
  const compilerCli = [...new Set(ngFiles.map(nearestPackageDir))]
    .sort()
    .map((dir) => compilerCliInput(dir, context.deps));

  const key = cacheKey({
    format: BUILD_CACHE_FORMAT,
    tool: context.tool,
    typescriptVersion: typescript.version,
    astro: context.astro,
    tsconfigPath: slash(tsconfigPath),
    buildInfoPath: slash(buildInfoPath),
    fileNames: fileNames as string[],
    fileInfos,
    configFiles,
    mxFiles,
    configInputs,
    compilerCli,
    previous: context.previous,
    position: context.position,
    claimed: [...context.claimed].sort(),
  });
  return { key, sidecar: sidecarPath(buildInfoPath), ngFiles };
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
