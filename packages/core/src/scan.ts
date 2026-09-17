/**
 * Custom tag discovery (spec §4): MX owns the scan.
 *
 * From a calling file's directory upward to the package root (the nearest
 * `package.json`), every `tags/` directory found is indexed; a tag's name is
 * its filename's basename. `package.json#mx.tags` extends that walk with
 * explicitly named directories carrying directory-level defaults. The result
 * is the `customTags` map every host, loader, plugin and the language server
 * already accept (P1) — discovery is the only thing this module adds.
 *
 * Three properties shape the implementation, each load-bearing:
 *
 * 1. **Synchronous.** Every integration that needs the map calls into it from
 *    a synchronous position: Bun's `onLoad`, Volar's `createVirtualCode`, the
 *    language server's `diagnoseDocument`, `mx-tsc`'s program construction.
 *    Only the Vite plugin could await. One synchronous scan is therefore the
 *    only shape that serves all of them from a single implementation, which
 *    is what keeps an editor, a `tsc` run and a build from disagreeing about
 *    which tags a file can call.
 *
 * 2. **Indexed without execution.** A tag's `parseOptions` must reach Marko
 *    *before* the calling file is parsed, so the scan cannot wait for the
 *    sidecar's hooks to be usable. It reads `parseOptions` statically out of
 *    the sidecar's default export instead (see `readParseOptions`), and
 *    defers loading the module itself until a `transform` is actually needed.
 *
 * 3. **Lazily loaded, through the runtime's own loader.** The hooks arrive
 *    via a synchronous `require` of the `.tag.ts` file. Bun compiles
 *    TypeScript natively, and Node strips types on `require` of a `.ts` file
 *    (measured on Node 26 and Bun 1.3), so neither needs a transform step
 *    from MX. A sidecar that throws while loading surfaces as a positioned
 *    `TranslateError` naming the file, never as a crash — the language server
 *    depends on that.
 *
 * Reading the filesystem is the point of this module, so unlike the rest of
 * `@mxlang/core` it imports `node:fs`, as `host-policy.ts` already does for
 * the same reason.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { BUILTIN_CUSTOM_TAGS } from "./builtin-tags.ts";
import { TranslateError } from "./core.ts";
import type { CustomTag, CustomTagParseOptions } from "./custom-tags.ts";
import type { TemplateTag } from "./template-tag.ts";

const require = createRequire(import.meta.url);

/** The directory a tag file lives in, relative to its package. */
const TAGS_DIR = "tags";

/** A sidecar: the hooks half of a custom tag. */
const SIDECAR_SUFFIX = ".tag.ts";

/** A template tag (L1). Expansion itself is P3; discovery is here. */
const TEMPLATE_SUFFIX = ".mx";

/**
 * What a tag file's basename may be, and therefore what a call name may be.
 *
 * The rule: a letter, digit or underscore to start, then letters, digits,
 * underscores, hyphens and dots. It is Marko's own tag-name vocabulary, minus
 * the shapes that break the compiler rather than merely looking odd.
 *
 * This is a guard with teeth, not tidiness. `tags/.mx` has an empty basename,
 * and an empty tag name makes `@marko/compiler` throw `Error while applying
 * option of "<>". Cause: "tag.name" is required` — which fails *every* file in
 * the package, not just the one that would have called it. Dotfiles are the
 * same class from the other side: `.DS_Store.mx` would register a tag named
 * `.DS_Store`, and a `tags/` directory is an ordinary directory that collects
 * ordinary junk.
 *
 * Case is preserved: `tags/Icon.tag.ts` is `<Icon>`, not `<icon>`. A tag name
 * is the filename, and the filename is the author's.
 */
const TAG_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/**
 * A `package.json#mx.tags` entry, normalized.
 *
 * `dir` is resolved against the `package.json`'s own directory, so a config
 * is portable: it names a location in the package, not on one machine.
 */
export interface MxTagsEntry {
  dir: string;
  prefix?: string;
  hosts?: string[];
  parseOptions?: CustomTagParseOptions;
}

/** One discovered tag, before its sidecar is loaded. */
export interface DiscoveredTag {
  /** The call name: the file's basename, plus any configured prefix. */
  name: string;
  /** The `x.mx` template, when one exists. */
  template?: string;
  /** The `x.tag.ts` sidecar, when one exists. */
  sidecar?: string;
  /**
   * `parseOptions` as the scan knows them before any hook runs: the
   * directory-level default from `mx.tags`, overridden by whatever the
   * sidecar's default export declares statically.
   */
  parseOptions?: CustomTagParseOptions;
  /** The directory this tag was found in; drives the nearest-wins rule. */
  sourceDir?: string;
}

/** What one scan found, plus everything needed to know when it went stale. */
export interface ScanResult {
  /** Discovered tags by call name; nearest directory wins. */
  tags: Map<string, DiscoveredTag>;
  /**
   * The map to hand a compiler. Each entry's hooks load on first use, so
   * building this costs no module evaluation.
   */
  customTags: Record<string, CustomTag>;
  /** Directories whose contents were read, for invalidation. */
  directories: string[];
  /** `package.json` files consulted, for invalidation. */
  packageFiles: string[];
  /** Every tag file found, with the mtime it had when read. */
  files: Array<{ path: string; mtimeMs: number }>;
  /**
   * Configuration problems that do not stop discovery.
   *
   * An `mx.tags` entry naming a directory that is not there is a real mistake
   * an author wants told about, but it is not a reason to fail every file in
   * the package: the local `tags/` directories are still perfectly good, and
   * throwing here would make one typo in `package.json` break compilation of
   * files that never used that entry — with the language server landing the
   * error on whichever document happened to be open. Callers surface these
   * how they surface anything else; the scan itself carries on.
   */
  diagnostics: ScanDiagnostic[];
}

/** One non-fatal configuration problem, positioned in the file that caused it. */
export interface ScanDiagnostic {
  /** The file to point an author at: the `package.json` that declared it. */
  file: string;
  message: string;
  line: number;
  column: number;
}

/**
 * The scan has no position to report against the *calling* file, since a
 * broken sidecar is a fact about the sidecar. Diagnostics therefore name the
 * offending file and carry that file's own position, which is what lets the
 * language server point an author at the real problem.
 */
function failIn(file: string, message: string, line = 1, column = 0): never {
  throw new TranslateError(`${file}: ${message}`, line, column);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates and normalizes `package.json#mx.tags`.
 *
 * A string is shorthand for one directory with no defaults. Anything that is
 * neither a string nor an array of `{ dir, ... }` objects is a configuration
 * error naming the `package.json`, rather than a silently ignored key: a
 * misspelled config that discovers nothing looks exactly like a tag that does
 * not exist, which is the failure mode hardest to diagnose from a call site.
 */
export function normalizeMxTags(
  value: unknown,
  packageDir: string,
  packageFile: string,
): MxTagsEntry[] {
  if (value === undefined) return [];
  if (typeof value === "string") {
    return [{ dir: resolve(packageDir, value) }];
  }
  if (!Array.isArray(value)) {
    failIn(
      packageFile,
      "`mx.tags` must be a string or an array of { dir, prefix?, hosts?, parseOptions? }",
    );
  }

  return value.map((entry, index) => {
    if (typeof entry === "string") {
      return { dir: resolve(packageDir, entry) };
    }
    if (!isRecord(entry) || typeof entry.dir !== "string") {
      failIn(
        packageFile,
        `\`mx.tags[${index}]\` must be a string or an object with a \`dir\` string`,
      );
    }
    const normalized: MxTagsEntry = {
      dir: isAbsolute(entry.dir) ? entry.dir : resolve(packageDir, entry.dir),
    };
    if (entry.prefix !== undefined) {
      if (typeof entry.prefix !== "string") {
        failIn(packageFile, `\`mx.tags[${index}].prefix\` must be a string`);
      }
      normalized.prefix = entry.prefix;
    }
    if (entry.hosts !== undefined) {
      if (
        !Array.isArray(entry.hosts) ||
        entry.hosts.some((host) => typeof host !== "string")
      ) {
        failIn(
          packageFile,
          `\`mx.tags[${index}].hosts\` must be an array of strings`,
        );
      }
      normalized.hosts = entry.hosts as string[];
    }
    if (entry.parseOptions !== undefined) {
      normalized.parseOptions = checkParseOptions(
        entry.parseOptions,
        packageFile,
        `mx.tags[${index}].parseOptions`,
      );
    }
    return normalized;
  });
}

/**
 * The accepted `parseOptions` shape, enforced wherever one is declared.
 *
 * Only the three documented switches exist, and each is a boolean. An unknown
 * key is an error rather than an ignored one: the whole point of
 * `parseOptions` is that the scan understands it without executing anything,
 * so a key the scan does not understand cannot be honored later either.
 */
export function checkParseOptions(
  value: unknown,
  file: string,
  what: string,
  line = 1,
  column = 0,
): CustomTagParseOptions {
  if (!isRecord(value)) {
    failIn(file, `\`${what}\` must be an object literal`, line, column);
  }
  const result: CustomTagParseOptions = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      key !== "text" &&
      key !== "preserveWhitespace" &&
      key !== "openTagOnly"
    ) {
      failIn(
        file,
        `\`${what}.${key}\` is not a parse option; expected \`text\`, \`preserveWhitespace\` or \`openTagOnly\``,
        line,
        column,
      );
    }
    if (typeof entry !== "boolean") {
      failIn(file, `\`${what}.${key}\` must be a boolean`, line, column);
    }
    result[key] = entry;
  }
  return result;
}

/**
 * Reads a sidecar's `parseOptions` without executing it.
 *
 * The file is parsed with the Babel instance `@marko/compiler` already
 * bundles — the same one `fragment.ts` uses — rather than a second copy of
 * `@babel/parser` added as a dependency.
 *
 * The accepted shape is narrow and stated here because an author hits it as a
 * diagnostic: the module's `export default` must be an object literal, or an
 * identifier bound once at module scope to an object literal (the form every
 * sidecar in this repo uses, since it needs the `CustomTag` type annotation).
 * Within that literal, `parseOptions` must itself be an object literal of
 * boolean-valued known keys. Anything else — a spread, a call, a conditional,
 * a value imported from elsewhere — cannot be read without running code, so
 * it is a positioned diagnostic rather than a guess.
 *
 * A sidecar with no `parseOptions` at all is not an error: it simply declares
 * none, which is the common case.
 */
export function readParseOptions(
  source: string,
  file: string,
): CustomTagParseOptions | undefined {
  const babel = require("@marko/compiler/internal/babel");
  let ast: {
    program: { body: Array<Record<string, unknown>> };
  };
  try {
    ast = babel.parse(source, {
      sourceType: "module",
      plugins: ["typescript"],
      // A sidecar is a module, not a file Babel should resolve config for.
      configFile: false,
      babelrc: false,
    });
  } catch (cause) {
    const loc = (cause as { loc?: { line?: number; column?: number } }).loc;
    failIn(
      file,
      `could not be parsed: ${(cause as Error).message}`,
      loc?.line ?? 1,
      loc?.column ?? 0,
    );
  }

  const body = ast.program.body;
  const defaultExport = body.find(
    (node) => node.type === "ExportDefaultDeclaration",
  ) as { declaration?: Record<string, unknown> } | undefined;
  if (!defaultExport?.declaration) return undefined;

  const literal = resolveObjectLiteral(defaultExport.declaration, body);
  if (!literal) return undefined;

  const property = findProperty(literal, "parseOptions");
  if (!property) return undefined;

  const loc = (property.loc as { start?: { line: number; column: number } })
    ?.start;
  const value = property.value as Record<string, unknown>;
  if (value?.type !== "ObjectExpression") {
    failIn(
      file,
      "`parseOptions` must be an object literal, so the scan can read it without executing the sidecar",
      loc?.line ?? 1,
      loc?.column ?? 0,
    );
  }

  return checkParseOptions(
    literalToValue(value, file),
    file,
    "parseOptions",
    loc?.line ?? 1,
    loc?.column ?? 0,
  );
}

/**
 * Resolves `export default X` to the object literal it names, following at
 * most one module-scope binding. `export default { ... }` and
 * `const t: CustomTag = { ... }; export default t;` are the two forms.
 */
function resolveObjectLiteral(
  declaration: Record<string, unknown>,
  body: Array<Record<string, unknown>>,
): Record<string, unknown> | null {
  if (declaration.type === "ObjectExpression") return declaration;
  if (declaration.type !== "Identifier") return null;

  const name = declaration.name as string;
  for (const statement of body) {
    const node =
      statement.type === "ExportNamedDeclaration"
        ? (statement.declaration as Record<string, unknown> | undefined)
        : statement;
    if (node?.type !== "VariableDeclaration") continue;
    for (const raw of node.declarations as Array<Record<string, unknown>>) {
      const id = raw.id as { type?: string; name?: string } | undefined;
      if (id?.type !== "Identifier" || id.name !== name) continue;
      const init = raw.init as Record<string, unknown> | undefined;
      if (!init) return null;
      if (init.type === "ObjectExpression") return init;
      // `satisfies`/`as` wrappers keep the literal one level down.
      if (
        init.type === "TSSatisfiesExpression" ||
        init.type === "TSAsExpression"
      ) {
        const inner = init.expression as Record<string, unknown>;
        if (inner?.type === "ObjectExpression") return inner;
      }
      return null;
    }
  }
  return null;
}

function findProperty(
  object: Record<string, unknown>,
  name: string,
): Record<string, unknown> | undefined {
  const properties = object.properties as
    | Array<Record<string, unknown>>
    | undefined;
  if (!properties) return undefined;
  return properties.find((property) => {
    if (property.type !== "ObjectProperty" || property.computed) return false;
    const key = property.key as {
      type?: string;
      name?: string;
      value?: string;
    };
    return (
      (key.type === "Identifier" && key.name === name) ||
      (key.type === "StringLiteral" && key.value === name)
    );
  });
}

/**
 * Converts an object literal of boolean literals to a plain value.
 *
 * Deliberately total: anything that is not a boolean literal becomes a
 * non-boolean here, and `checkParseOptions` reports it against the declared
 * key, so the diagnostic names the option rather than an AST node type.
 */
function literalToValue(
  object: Record<string, unknown>,
  file: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const properties = (object.properties ?? []) as Array<
    Record<string, unknown>
  >;
  for (const property of properties) {
    if (property.type !== "ObjectProperty" || property.computed) {
      const loc = (property.loc as { start?: { line: number; column: number } })
        ?.start;
      failIn(
        file,
        "`parseOptions` must be a plain object literal; a spread or computed key cannot be read without executing the sidecar",
        loc?.line ?? 1,
        loc?.column ?? 0,
      );
    }
    const key = property.key as { name?: string; value?: string };
    const value = property.value as { type?: string; value?: unknown };
    result[(key.name ?? key.value) as string] =
      value?.type === "BooleanLiteral" ? value.value : (value?.type ?? null);
  }
  return result;
}

/**
 * Loads a sidecar's hooks, synchronously, through the runtime's own loader.
 *
 * `require`, not `import()`: every caller is synchronous (see the module
 * doc). Both supported runtimes handle a `.ts` file here without a transform
 * from MX — Bun natively, Node by stripping types on `require`.
 *
 * A module that throws while evaluating, or that does not default-export an
 * object, becomes a `TranslateError` naming the file. That is the difference
 * between the language server reporting a diagnostic and the language server
 * dying.
 *
 * **Two constraints on a sidecar**, because the two runtimes that load one do
 * not accept exactly the same module. Both are measured, not inferred:
 *
 * - **No top-level `await`.** Bun loads it; Node refuses with `require() cannot
 *   be used on an ESM graph with top-level await`.
 * - **Explicit extensions on relative imports.** `./helper` resolves on Bun;
 *   Node refuses with `Cannot find module`. Write `./helper.ts`.
 *
 * A sidecar is compile-time configuration, so neither costs an author anything
 * real — but a sidecar that violates one works in a `bun` build and fails in
 * the editor, which is exactly the disagreement a single loader exists to
 * prevent. The catch below names the file and, when the runtime's own message
 * identifies one of these two, restates the constraint rather than leaving an
 * author to map Node's wording onto their sidecar.
 *
 * The runtime's module cache is dropped for this file first. The scan cache
 * already notices an edited sidecar and rebuilds its entry, but a long-lived
 * process would then `require` the same path and be handed the *previous*
 * evaluation — so an author's edit would change the tag's `parseOptions` and
 * not its hooks. Evicting here rather than in the cache keeps the two facts
 * together: whoever loads the module is who must decide it is stale.
 */
function sidecarHint(message: string): string {
  if (message.includes("top-level await")) {
    return " — a custom tag sidecar may not use top-level `await`, because it is loaded synchronously before the calling file is parsed";
  }
  if (message.includes("Cannot find module")) {
    return " — a custom tag sidecar's relative imports need explicit extensions (`./helper.ts`, not `./helper`)";
  }
  return "";
}

export function loadSidecar(file: string): CustomTag {
  let module: { default?: unknown } | undefined;
  try {
    const resolved = require.resolve(file);
    delete require.cache[resolved];
    module = require(file) as { default?: unknown };
  } catch (cause) {
    const message = (cause as Error).message;
    failIn(file, `sidecar failed to load: ${message}${sidecarHint(message)}`);
  }
  const definition = module?.default;
  if (!isRecord(definition)) {
    failIn(file, "sidecar must `export default` a CustomTag object");
  }
  return definition as CustomTag;
}

/**
 * Wraps one discovered tag as a `CustomTag` whose hooks load on first use.
 *
 * `parseOptions` is already known statically and is present eagerly, because
 * the taglib is built before the caller parses. Everything else is a getter
 * that loads the sidecar once, so a project with fifty tags evaluates only
 * the modules a file actually calls.
 */
function lazyTag(tag: DiscoveredTag): CustomTag {
  const definition: CustomTag = {};
  if (tag.parseOptions) definition.parseOptions = tag.parseOptions;

  // The `x.mx` template, when one exists, read on first use. A tag with a
  // template and no sidecar (L1-only) is complete as it stands: the call
  // routes to the template's own compiled module. A tag with both is
  // composed — the sidecar's `transform` wins and may route the call to this
  // template through `ctx.build.template(call)` — so the template is attached
  // either way.
  //
  // Read lazily, and re-read per scan rather than cached here, for the same
  // reason the sidecar hooks are lazy: a project with fifty tags should touch
  // only the files a compilation actually calls. The unit's own metadata cache
  // (keyed by path, mtime and source) is what keeps repeated calls cheap.
  if (tag.template) {
    const path = tag.template;
    Object.defineProperty(definition, "template", {
      enumerable: true,
      configurable: true,
      get: (): TemplateTag => ({
        filename: path,
        source: readFileSync(path, "utf8"),
        mtimeMs: statSync(path).mtimeMs,
      }),
    });
  }

  const sidecar = tag.sidecar;
  if (!sidecar) return definition;

  let loaded: CustomTag | undefined;
  const load = (): CustomTag => {
    loaded ??= loadSidecar(sidecar);
    return loaded;
  };

  for (const key of ["attributes", "attributeTags"] as const) {
    Object.defineProperty(definition, key, {
      enumerable: true,
      configurable: true,
      get: () => load()[key],
    });
  }
  for (const key of ["analyze", "transform", "finalize"] as const) {
    Object.defineProperty(definition, key, {
      enumerable: true,
      configurable: true,
      get: () => {
        const hook = load()[key];
        return hook ? hook.bind(loaded) : undefined;
      },
    });
  }
  return definition;
}

interface IndexOptions {
  /** Directory-level defaults from an `mx.tags` entry. */
  prefix?: string;
  parseOptions?: CustomTagParseOptions;
}

/**
 * Indexes one directory of tag files into `into`, without overwriting a tag a
 * nearer directory already claimed.
 *
 * Only `.mx` and `.tag.ts` are tag files; anything else in a `tags/`
 * directory (a README, a test, a `.css`) is ignored rather than reported, so
 * a `tags/` directory can hold the things a directory normally holds.
 */
function indexDirectory(
  dir: string,
  into: Map<string, DiscoveredTag>,
  files: Array<{ path: string; mtimeMs: number }>,
  diagnostics: ScanDiagnostic[],
  options: IndexOptions = {},
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  // Sorted so a directory holding both `x.mx` and `x.tag.ts` indexes them in
  // a fixed order regardless of the filesystem's own enumeration.
  for (const entry of entries.sort()) {
    // A dotfile is never a tag. `.DS_Store.mx` would otherwise register as
    // `<.DS_Store>` and `tags/.mx` as a tag with no name at all; see
    // `TAG_NAME_RE`.
    if (entry.startsWith(".")) continue;

    const isSidecar = entry.endsWith(SIDECAR_SUFFIX);
    const isSolidTemplate = entry.endsWith(`.solid${TEMPLATE_SUFFIX}`);
    const isTemplate = entry.endsWith(TEMPLATE_SUFFIX) && !isSolidTemplate;

    // `.solid.mx` is a different file kind — a TypeScript module with MX
    // regions, compiled by the Solid host — not a tag template. Silently
    // skipping it would leave an author wondering why their file is invisible,
    // so say so.
    if (isSolidTemplate) {
      failIn(
        join(dir, entry),
        "tag templates are `.mx`; `.solid.mx` is not supported as a tag",
      );
    }
    if (!isSidecar && !isTemplate) continue;

    const bare = isSidecar
      ? basename(entry, SIDECAR_SUFFIX)
      : basename(entry, TEMPLATE_SUFFIX);
    if (!TAG_NAME_RE.test(bare)) {
      failIn(
        join(dir, entry),
        `\`${bare}\` is not a usable tag name; a tag file's name must start with a letter, digit or underscore and may then contain letters, digits, underscores, hyphens and dots`,
      );
    }
    const path = join(dir, entry);
    const name = `${options.prefix ?? ""}${bare}`;

    // A core-owned tag (`<try>`) cannot be shadowed: `rejectShadowedRegistration`
    // refuses the *whole* map when one appears in it, so handing this name
    // onward would break every file in the package — including files that
    // never call the tag — over one misnamed file. Reported and skipped
    // instead, the same way a misconfigured `mx.tags` entry is: the author is
    // told, and everything else keeps working.
    if (Object.hasOwn(BUILTIN_CUSTOM_TAGS, name)) {
      diagnostics.push({
        file: path,
        message: `\`<${name}>\` is a core-owned custom tag and cannot be redefined by a tag file; rename this file`,
        line: 1,
        column: 0,
      });
      continue;
    }

    let mtimeMs = 0;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }

    // Nearest directory wins: a name already claimed by a nearer `tags/` dir
    // is not overwritten, and neither half of it is re-read here.
    const existing = into.get(name);
    if (existing && existing.sourceDir !== dir) continue;

    files.push({ path, mtimeMs });
    const tag: DiscoveredTag = existing ?? { name, sourceDir: dir };
    if (isSidecar) {
      tag.sidecar = path;
      // The sidecar's own declaration overrides the directory default, which
      // is what "directory-level defaults a sidecar may override" means.
      const declared = readParseOptions(readFileSync(path, "utf8"), path);
      const merged = { ...options.parseOptions, ...declared };
      if (Object.keys(merged).length > 0) tag.parseOptions = merged;
    } else {
      tag.template = path;
      if (!tag.sidecar && options.parseOptions) {
        tag.parseOptions = { ...options.parseOptions };
      }
    }
    into.set(name, tag);
  }
}

export interface ScanOptions {
  /**
   * Stops the upward walk at this directory, for a test that must not reach
   * the real repository above its fixture. Defaults to the package root (the
   * nearest `package.json`), as the spec describes.
   */
  stopAt?: string;
}

/**
 * Scans for the custom tags callable from `filePath`.
 *
 * Precedence, highest first (spec §4): an explicit import in the template
 * (which the core resolves before ever consulting this map), then local
 * `tags/` directories with the nearest winning, then `package.json#mx.tags`
 * entries in array order.
 */
export function scanCustomTags(
  filePath: string,
  options: ScanOptions = {},
): ScanResult {
  const tags = new Map<string, DiscoveredTag>();
  const directories: string[] = [];
  const packageFiles: string[] = [];
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const diagnostics: ScanDiagnostic[] = [];

  let dir = dirname(resolve(filePath));
  let packageDir: string | undefined;
  let packageJson: string | undefined;

  for (;;) {
    const candidate = join(dir, TAGS_DIR);
    directories.push(candidate);
    if (existsSync(candidate)) {
      indexDirectory(candidate, tags, files, diagnostics);
    }

    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      packageDir = dir;
      packageJson = manifest;
      break;
    }

    const parent = dirname(dir);
    if (parent === dir || dir === options.stopAt) break;
    dir = parent;
  }

  // `mx.tags` entries are lowest precedence, so they are indexed last: a name
  // a local `tags/` directory already claimed is left alone.
  if (packageDir && packageJson) {
    packageFiles.push(packageJson);
    let manifest: { mx?: { tags?: unknown } } | undefined;
    try {
      manifest = JSON.parse(readFileSync(packageJson, "utf8"));
    } catch {
      manifest = undefined;
    }
    const entries = normalizeMxTags(
      manifest?.mx?.tags,
      packageDir,
      packageJson,
    );
    for (const entry of entries) {
      directories.push(entry.dir);
      if (!existsSync(entry.dir)) {
        // Recorded, not thrown: see `ScanResult.diagnostics`.
        diagnostics.push({
          file: packageJson,
          message: `\`mx.tags\` names a directory that does not exist: ${entry.dir}`,
          line: 1,
          column: 0,
        });
        continue;
      }
      indexDirectory(entry.dir, tags, files, diagnostics, {
        prefix: entry.prefix,
        parseOptions: entry.parseOptions,
      });
    }
  }

  const customTags: Record<string, CustomTag> = Object.create(null);
  for (const [name, tag] of tags) customTags[name] = lazyTag(tag);

  return { tags, customTags, directories, packageFiles, files, diagnostics };
}
