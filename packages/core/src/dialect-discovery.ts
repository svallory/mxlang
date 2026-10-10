/**
 * Dialect discovery and routing (decision 212). A dialect declares itself in
 * its own `package.json` (`mx.dialect`: `id`, `name`, `extensions`,
 * `module`); a project uses the dialects among its direct dependencies, and
 * a file goes to the dialect that claims its extension. Nothing here runs a
 * dialect's code: discovery reads `package.json` files only, never scans
 * `node_modules` and never loads a transitive package. The dialect's module
 * is loaded by `syntax-table.ts`, only for a file with one of its extensions.
 */
import { basename, dirname, join, posix, win32 } from "node:path";
import { TranslateError } from "./core.ts";
import { CORE_DIALECT, DIALECT_ID } from "./dialect-registry.ts";
import { findNearestPackageJson } from "./host-policy.ts";
import { findMxConfig, type MxConfigSource } from "./mx-config.ts";
import {
  jsonKeyPosition,
  type PackageJsonRead,
  readPackageJsonCached,
} from "./package-json.ts";

/**
 * Where a dialect package declares itself, as messages write it: the
 * `dialect` key inside the one top-level `mx` object MX reads (read it as
 * `pkg.mx?.dialect`; this label is not a property key). It is an identity
 * block, never project config: no reader of a project's `mx` settings looks
 * at it.
 */
export const DIALECT_MANIFEST_KEY = "mx.dialect";

/** {@link DIALECT_MANIFEST_KEY} as a path into `package.json`. */
const MANIFEST_PATH = ["mx", "dialect"] as const;

/** MX's own extension: no dialect may claim it. */
const MX_EXTENSION = ".mx";

/** The fields of a dialect's manifest. */
const MANIFEST_FIELDS = ["id", "name", "extensions", "module"] as const;

/** The `package.json` fields that list a project's direct dependencies. */
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** A dialect as its package declares it (`package.json#mx.dialect`). @unstable */
export interface DialectManifest {
  /** Its identity and its key in MX's config (`mesh`). */
  readonly id: string;
  /** What tooling shows its users (`Mesh`). */
  readonly name: string;
  /** The file extensions it claims (`.mesh.mx`), each with its leading dot. */
  readonly extensions: readonly string[];
  /** Its module, relative to its package directory. */
  readonly module: string;
  /** The package that declares it. */
  readonly packageName: string;
  /** That package's `package.json`, absolute. */
  readonly packageFile: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Why a manifest's `module` leaves its package, or `undefined` when it stays
 * inside: an absolute path (POSIX or Windows), or a relative one that climbs
 * out with `..`. `./dialect.js` and `dist/dialect.js` stay inside.
 */
function moduleEscape(module: string): string | undefined {
  if (posix.isAbsolute(module) || win32.isAbsolute(module)) {
    return "an absolute path";
  }
  const normalized = posix.normalize(module.replaceAll("\\", "/"));
  if (normalized === ".." || normalized.startsWith("../")) {
    return "outside the package";
  }
  return undefined;
}

/** Is `value` an extension a dialect may claim (`.mesh.mx`)? */
function validExtension(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:\.[^./\\\s]+)+$/.test(value) &&
    value !== MX_EXTENSION
  );
}

/**
 * The manifest a dependency's `package.json` declares, validated, or
 * `undefined` when it declares none. A malformed manifest is an error in
 * that `package.json` at the offending field.
 */
export function readDialectManifest(
  packageFile: string,
  read: PackageJsonRead,
): DialectManifest | undefined {
  const manifest = read.manifest;
  if (!isRecord(manifest)) return undefined;
  const mx = manifest.mx;
  const value = isRecord(mx) ? mx.dialect : undefined;
  if (value === undefined) return undefined;
  const fail = (message: string, field?: string): never => {
    const path =
      field === undefined ? [...MANIFEST_PATH] : [...MANIFEST_PATH, field];
    const { line, column } = jsonKeyPosition(read.text, path);
    throw new TranslateError(message, line, column, packageFile);
  };
  if (!isRecord(value)) {
    fail(
      `\`${DIALECT_MANIFEST_KEY}\` must be an object declaring the dialect: \`{ "id", "name", "extensions", "module" }\``,
    );
  }
  const fields = value as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (!(MANIFEST_FIELDS as readonly string[]).includes(key)) {
      fail(
        `\`${DIALECT_MANIFEST_KEY}.${key}\` is not a dialect manifest field (${MANIFEST_FIELDS.join(", ")})`,
        key,
      );
    }
  }
  const { id, name, extensions, module } = fields;
  if (typeof id !== "string" || !DIALECT_ID.test(id)) {
    fail(
      `\`${DIALECT_MANIFEST_KEY}.id\` must be a dialect id: lower-case words joined by \`-\` (\`mesh\`)`,
      id === undefined ? undefined : "id",
    );
  }
  if (id === CORE_DIALECT) {
    fail(
      `\`${DIALECT_MANIFEST_KEY}.id\` cannot be \`${CORE_DIALECT}\`: that is MX's own dialect`,
      "id",
    );
  }
  if (typeof name !== "string" || name.trim() === "") {
    fail(
      `\`${DIALECT_MANIFEST_KEY}.name\` must be a non-empty string: the name tooling shows the dialect's users`,
      name === undefined ? undefined : "name",
    );
  }
  if (!Array.isArray(extensions) || extensions.length === 0) {
    fail(
      `\`${DIALECT_MANIFEST_KEY}.extensions\` must be a non-empty array of the file extensions the dialect claims (\`[".mesh.mx"]\`)`,
      extensions === undefined ? undefined : "extensions",
    );
  }
  const seen = new Set<string>();
  for (const extension of extensions as unknown[]) {
    if (extension === MX_EXTENSION) {
      fail(
        `\`${DIALECT_MANIFEST_KEY}.extensions\` cannot claim \`${MX_EXTENSION}\`: it is MX's own; a dialect claims its own extensions (\`.mesh.mx\`)`,
        "extensions",
      );
    }
    if (!validExtension(extension)) {
      fail(
        `\`${DIALECT_MANIFEST_KEY}.extensions\`: ${JSON.stringify(extension)} is not a file extension; write it with its leading dot (\`.mesh.mx\`)`,
        "extensions",
      );
    }
    if (seen.has(extension as string)) {
      fail(
        `\`${DIALECT_MANIFEST_KEY}.extensions\` lists \`${extension}\` twice`,
        "extensions",
      );
    }
    seen.add(extension as string);
  }
  if (typeof module !== "string" || module === "") {
    fail(
      `\`${DIALECT_MANIFEST_KEY}.module\` must be a path, relative to this \`package.json\`, to the module whose default export is the dialect`,
      module === undefined ? undefined : "module",
    );
  }
  const leaves = moduleEscape(module as string);
  if (leaves) {
    fail(
      `\`${DIALECT_MANIFEST_KEY}.module\` must stay inside the dialect's package, so the manifest works wherever the package is installed: ${JSON.stringify(module)} is ${leaves}; write a path relative to this \`package.json\` (\`./dialect.js\`)`,
      "module",
    );
  }
  return Object.freeze({
    id: id as string,
    name: name as string,
    extensions: Object.freeze([...(extensions as string[])]),
    module: module as string,
    packageName:
      typeof manifest.name === "string"
        ? manifest.name
        : basename(dirname(packageFile)),
    packageFile,
  });
}

/** The project's direct dependencies, by package name, with the field naming each. */
function directDependencies(
  manifest: Record<string, unknown>,
): Map<string, string> {
  const names = new Map<string, string>();
  for (const field of DEPENDENCY_FIELDS) {
    const deps = manifest[field];
    if (!isRecord(deps)) continue;
    for (const name of Object.keys(deps)) {
      if (!names.has(name)) names.set(name, field);
    }
  }
  return names;
}

/**
 * A dependency's `package.json`, found the way Node finds the package
 * itself: `node_modules/<name>` in the project directory and each one above
 * it. Only that one file is read; nothing in `node_modules` is listed.
 */
function dependencyPackageFile(
  projectDir: string,
  name: string,
): DependencyFile | undefined {
  let dir = projectDir;
  for (;;) {
    const file = join(dir, "node_modules", name, "package.json");
    const read = readPackageJsonCached(file);
    if (read) return { file, read };
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Where the project lists a dialect package: the dependency field and key. */
interface Listing {
  readonly field: string;
  /** The dependency's key, which differs from its package name for an alias (`"b": "npm:@real/b@1"`). */
  readonly key: string;
}

/** The dialects a project uses, with where each is declared. */
interface Discovered {
  readonly dialects: readonly DialectManifest[];
  /** Where each dialect package is listed; absent for the project itself. */
  readonly listedIn: ReadonlyMap<DialectManifest, Listing>;
}

/**
 * Each dependency `package.json` read's manifest (`null`: it declares none),
 * so an unchanged dependency keeps one manifest object, which is what a
 * loaded dialect is cached by.
 */
const manifests = new WeakMap<PackageJsonRead, DialectManifest | null>();

function manifestOf(
  file: string,
  read: PackageJsonRead,
): DialectManifest | undefined {
  let known = manifests.get(read);
  if (known === undefined) {
    known = readDialectManifest(file, read) ?? null;
    manifests.set(read, known);
  }
  return known ?? undefined;
}

/**
 * The last discovery per project manifest read, with the dependency reads it
 * was built from: it is reused only while every dependency reads the same
 * (installed at the same place, unchanged, still missing), so an install,
 * an upgrade or an edited dependency manifest is seen at the next call.
 */
const byProject = new WeakMap<
  PackageJsonRead,
  {
    readonly found: readonly (DependencyFile | undefined)[];
    readonly discovered: Discovered;
  }
>();

interface DependencyFile {
  readonly file: string;
  readonly read: PackageJsonRead;
}

/** The package label a message uses: the name, and the key it is listed under when that differs. */
function packageLabel(dialect: DialectManifest, listing?: Listing): string {
  return listing === undefined || listing.key === dialect.packageName
    ? dialect.packageName
    : `${dialect.packageName}, as \`${listing.key}\``;
}

function discover(projectFile: string, read: PackageJsonRead): Discovered {
  const manifest = isRecord(read.manifest) ? read.manifest : {};
  const projectDir = dirname(projectFile);
  const dependencies = [...directDependencies(manifest)];
  const found = dependencies.map(([key]) =>
    dependencyPackageFile(projectDir, key),
  );
  const known = byProject.get(read);
  if (
    known &&
    known.found.length === found.length &&
    known.found.every(
      (entry, index) =>
        entry?.file === found[index]?.file &&
        entry?.read === found[index]?.read,
    )
  ) {
    return known.discovered;
  }
  const dialects: DialectManifest[] = [];
  const listedIn = new Map<DialectManifest, Listing>();
  // A dialect package routes its own files too (its tests, its tags).
  const own = readDialectManifest(projectFile, read);
  if (own) dialects.push(own);
  dependencies.forEach(([key, field], index) => {
    const entry = found[index];
    const dialect = entry && manifestOf(entry.file, entry.read);
    if (!dialect) return;
    const listing: Listing = { field, key };
    // An id is the dialect's identity and its config key: two packages
    // cannot both be it, and `mx.extensions` could not tell them apart.
    const same = dialects.find((other) => other.id === dialect.id);
    if (same) {
      const { line, column } = jsonKeyPosition(read.text, [field, key]);
      throw new TranslateError(
        `two dialects have the id \`${dialect.id}\`: ${packageLabel(same, listedIn.get(same))} and ${packageLabel(dialect, listing)}. A dialect's id is its identity; keep one of these dependencies`,
        line,
        column,
        projectFile,
      );
    }
    dialects.push(dialect);
    listedIn.set(dialect, listing);
  });
  const discovered: Discovered = { dialects, listedIn };
  byProject.set(read, { found, discovered });
  return discovered;
}

/**
 * The dialects the project of `projectFile` (a `package.json`) uses: the
 * project's own declaration, if it is a dialect package, then each direct
 * dependency that declares one, in manifest order. @unstable
 */
export function discoverDialects(
  projectFile: string,
): readonly DialectManifest[] {
  const read = readPackageJsonCached(projectFile);
  return read ? discover(projectFile, read).dialects : [];
}

/**
 * The project's `mx.extensions`, from MX's config: which dialect handles which extension, the
 * one dialect fact a user may override (decision 212 item 5). Each key is an
 * extension, each value a discovered dialect's `id`.
 */
function extensionOverrides(
  source: MxConfigSource | undefined,
  dialects: readonly DialectManifest[],
): ReadonlyMap<string, DialectManifest> {
  const value = source?.config?.extensions;
  const overrides = new Map<string, DialectManifest>();
  if (source === undefined || value === undefined) return overrides;
  const fail = (message: string, extension?: string): never => {
    const path =
      extension === undefined ? ["extensions"] : ["extensions", extension];
    const { line, column } =
      source.format === "package.json"
        ? jsonKeyPosition(source.text, ["mx", ...path])
        : source.locate(path, { key: true });
    throw new TranslateError(message, line, column, source.file);
  };
  if (!isRecord(value)) {
    fail(
      '`mx.extensions` must be an object mapping a file extension to the id of the dialect that handles it (`{ ".mesh.mx": "mesh" }`)',
    );
  }
  const ids = dialects.map((dialect) => `\`${dialect.id}\``).join(", ");
  for (const [extension, id] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (extension === MX_EXTENSION) {
      fail(
        `\`mx.extensions\` cannot route \`${MX_EXTENSION}\`: it is MX's own`,
        extension,
      );
    }
    if (!validExtension(extension)) {
      fail(
        `\`mx.extensions\`: ${JSON.stringify(extension)} is not a file extension; write it with its leading dot (\`.mesh.mx\`)`,
        extension,
      );
    }
    const dialect = dialects.find((candidate) => candidate.id === id);
    if (!dialect) {
      fail(
        `\`mx.extensions\` routes \`${extension}\` to ${JSON.stringify(id)}, which is not a dialect this project uses (${ids === "" ? "it uses none" : `it uses ${ids}`}); a dialect is found among the project's direct dependencies`,
        extension,
      );
    }
    overrides.set(extension, dialect as DialectManifest);
  }
  return overrides;
}

/**
 * The dialect that handles `filename`, or `undefined` for MX's own files.
 * The project is the nearest `package.json`, so a dependency's files use
 * the dependency's dialects. The longest extension the file name ends with
 * wins (`.mesh.mx` over `.mx`); `mx.extensions` settles an extension two
 * dialects claim, and without it the clash is an error naming both, in the
 * project's `package.json` at the second one's dependency entry.
 * @unstable
 */
export function routeDialect(filename: string): DialectManifest | undefined {
  const found = findNearestPackageJson(dirname(filename));
  if (!found?.read.manifest) return undefined;
  const { dialects, listedIn } = discover(found.file, found.read);
  // TODO(dialect-1b): `mx.extensions` is read from MX's config here; the
  // rest of a dialect's settings (`mx.<id>`) stay unread until PR 1b.
  const overrides = extensionOverrides(
    findMxConfig(dirname(filename)),
    dialects,
  );
  if (dialects.length === 0) return undefined;
  const name = basename(filename);
  const matches = (extension: string) =>
    name.length > extension.length && name.endsWith(extension);
  let best: string | undefined;
  for (const extension of [
    ...overrides.keys(),
    ...dialects.flatMap((dialect) => dialect.extensions),
  ]) {
    if (matches(extension) && extension.length > (best?.length ?? 0)) {
      best = extension;
    }
  }
  if (best === undefined) return undefined;
  const chosen = overrides.get(best);
  if (chosen) return chosen;
  const claimants = dialects.filter((dialect) =>
    dialect.extensions.includes(best as string),
  );
  if (claimants.length > 1) {
    const [first, second] = claimants as [DialectManifest, DialectManifest];
    const listing = listedIn.get(second);
    const { line, column } = jsonKeyPosition(
      found.read.text,
      listing === undefined ? [] : [listing.field, listing.key],
    );
    throw new TranslateError(
      `two dialects claim \`${best}\`: \`${first.id}\` (${packageLabel(first, listedIn.get(first))}) and \`${second.id}\` (${packageLabel(second, listing)}). Choose one in \`mx.extensions\` in MX's config: \`"extensions": { "${best}": "${first.id}" }\``,
      line,
      column,
      found.file,
    );
  }
  return claimants[0];
}
