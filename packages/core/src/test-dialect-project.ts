/**
 * Test support: a project that uses a dialect the way decision 212 has it.
 * The project's `package.json` lists a dialect package as a direct
 * dependency, and that package's own `package.json#mxDialect` declares the
 * dialect. Not exported from the package.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What a test dialect package declares, and the project around it. */
export interface DialectProjectOptions {
  /** The dialect package's name, as the project depends on it. Default `test-dialect`. */
  readonly packageName?: string;
  /**
   * The `mxDialect` field as written; its defaults are `id: "test"`,
   * `name: "Test"`, `extensions: [".tst"]` and `module: "./index.mjs"`.
   * `null` removes a default field; a non-object replaces the whole field.
   */
  readonly manifest?: unknown;
  /** The dialect module's source, written at the manifest's `module` when it is relative. */
  readonly module?: string;
  /** The project's own `mx` config. */
  readonly mx?: unknown;
  /** The dependency field the project lists the package in. Default `devDependencies`. */
  readonly field?: string;
  /** Project manifest fields besides `name`, the dependency and `mx`. */
  readonly project?: Readonly<Record<string, unknown>>;
}

const DEFAULTS = {
  id: "test",
  name: "Test",
  extensions: [".tst"],
  module: "./index.mjs",
};

function manifestOf(value: unknown): unknown {
  if (value === undefined) return DEFAULTS;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const merged: Record<string, unknown> = { ...DEFAULTS };
  for (const [key, field] of Object.entries(value)) {
    if (field === null) delete merged[key];
    else merged[key] = field;
  }
  return merged;
}

/**
 * Writes the project at `dir` and its dialect package under
 * `dir/node_modules`. Returns the two `package.json` paths. Call it again
 * with another `packageName` to add a second dialect; the project manifest
 * keeps every package listed so far.
 */
export function dialectProject(
  dir: string,
  options: DialectProjectOptions = {},
): { projectFile: string; packageFile: string; packageDir: string } {
  const packageName = options.packageName ?? "test-dialect";
  const field = options.field ?? "devDependencies";
  const packageDir = join(dir, "node_modules", packageName);
  mkdirSync(packageDir, { recursive: true });
  const manifest = manifestOf(options.manifest);
  const packageFile = join(packageDir, "package.json");
  writeFileSync(
    packageFile,
    `${JSON.stringify({ name: packageName, mxDialect: manifest }, null, 2)}\n`,
  );
  const module = (manifest as { module?: unknown } | undefined)?.module;
  if (options.module !== undefined && typeof module === "string") {
    const file = join(packageDir, module);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, `${options.module}\n`);
  }
  const projectFile = join(dir, "package.json");
  const listed = (listedPackages.get(dir) ?? new Map<string, string>()).set(
    packageName,
    field,
  );
  listedPackages.set(dir, listed);
  const project: Record<string, unknown> = {
    name: "app",
    ...options.project,
  };
  for (const [name, at] of listed) {
    project[at] = { ...(project[at] as object | undefined), [name]: "0.0.0" };
  }
  if (options.mx !== undefined) project.mx = options.mx;
  writeFileSync(projectFile, `${JSON.stringify(project, null, 2)}\n`);
  return { projectFile, packageFile, packageDir };
}

/**
 * A CommonJS dialect module that re-exports `file` (an absolute path), for a
 * package whose manifest names `./index.cjs`: a manifest's `module` stays
 * inside its package, so a test reaches core's reference modules this way.
 */
export function reexport(file: string): string {
  return `module.exports = require(${JSON.stringify(file)});`;
}

/** The packages each project directory lists, across calls. */
const listedPackages = new Map<string, Map<string, string>>();
