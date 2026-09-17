import { dirname, resolve } from "node:path";
import type { File } from "@babel/types";
import {
  parse as babelParse,
  parseExpression as babelParseExpression,
  type ParserOptions,
} from "./babel/index.ts";
import {
  type AuthoredImport,
  type HoistedImport,
  planHoistedImports,
} from "./mx/hoist-imports.ts";

export type { ParseError, ParseResult, ParserOptions } from "./babel/index.ts";
export type { PrintOptions, PrintResult, RawSourceMap } from "./mx/print.ts";
export { print, printAst } from "./mx/print.ts";
export type {
  MxAttr,
  MxChild,
  MxElement,
  MxRange,
  MxTagName,
  MxWalkError,
} from "./mx/walk.ts";
export { isVoidTag } from "./mx/walk.ts";

/**
 * The vendored `@babel/parser` entry points, unchanged. Use these to parse
 * plain `.tsx`/`.ts`: they behave exactly like npm `@babel/parser` 7.29.8,
 * including for JSX, because the MX bridge is opt-in (see `parse` below).
 */
export {
  babelParse as parseBabel,
  babelParseExpression as parseBabelExpression,
};

export interface MxParseOptions extends ParserOptions {}

const MX_DEFAULT_PLUGINS: ParserOptions["plugins"] = ["typescript", "jsx"];

/**
 * Parses a `.solid.mx` file and returns a Babel `File`.
 *
 * The AST contains only standard Babel node types — MX elements come back as
 * ordinary lowered `JSXElement`s, so `@babel/traverse`, `@babel/generator` and
 * existing Babel plugins work on it unmodified. MX-specific facts live in
 * `node.extra.mx`.
 */
export function parse(
  source: string,
  filename: string,
  options: MxParseOptions = {},
): File {
  const file = babelParse(source, {
    sourceType: "module",
    sourceFilename: filename,
    plugins: MX_DEFAULT_PLUGINS,
    ...options,
    // Turns the forked `jsxParseElementAt` on. Without it the vendored parser
    // is byte-for-byte upstream Babel.
    //
    // An explicit `mx` wins, so a caller owning another file kind (`.ng.mx`,
    // whose regions this extension test would never match) can turn the
    // grammar on for itself. Left unset it is the `.solid.mx` test that has
    // always been here, so every existing caller is unaffected.
    mx: options.mx ?? filename.endsWith(".solid.mx"),
  } as ParserOptions) as unknown as File;
  hoistRegionImports(file, filename);
  return file;
}

/**
 * Writes the imports the compiler minted for discovered tags into the module
 * that contains their regions.
 *
 * An MX region inside a `.solid.mx` file is an *expression*, so a discovered
 * tag's import has no module scope of its own to land in — the surrounding
 * TypeScript module is the only place it can go (design §3.2; decision 95
 * ruling 3). Three rules, all of them decision 95's:
 *
 * - **Once per module per resolved path**, so two regions calling `<icon>`
 *   share one import — and a path, not a specifier, because two spellings can
 *   name one file.
 * - **An authored import of the same file wins.** If the module already
 *   imports that path itself, its binding is reused: nothing is injected and
 *   the region's own reference is pointed at the author's name.
 * - **Inserted after the module's last import**, or at the top when it has
 *   none, so the injected statement never precedes an import the author's own
 *   ordering depends on.
 */
function hoistRegionImports(file: File, filename: string): void {
  const program = file.program as unknown as {
    body: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(program?.body)) return;

  const hoisted: HoistedImport[] = [];
  // A `/var` inside a region binds a value the region's own JSX has no
  // statement position for, so the module declares the `let` and the
  // region's callback prop assigns it (design §2.4). Same channel as the
  // imports beside it, and the same speculative-parse discipline: only a
  // region that survived into the final AST contributes one.
  const returnVars = new Set<string>();
  const regions: Array<[number, number]> = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    const mx = (
      record.extra as
        | {
            mx?: {
              hoistedImports?: HoistedImport[];
              returnVars?: string[];
              range?: [number, number];
            };
          }
        | undefined
    )?.mx;
    if (mx?.range) regions.push(mx.range);
    for (const entry of mx?.hoistedImports ?? []) hoisted.push(entry);
    for (const name of mx?.returnVars ?? []) returnVars.add(name);
    for (const key of Object.keys(record)) {
      if (key === "loc") continue;
      visit(record[key]);
    }
  };
  visit(program.body);

  if (returnVars.size > 0) {
    // Placed directly after the module's imports, which is above every
    // region that could fill one: a `let` declared *after* the region that
    // references it would be a temporal-dead-zone error at run time, and a
    // region can appear in any statement of the module.
    const declaration = babelParse(`let ${[...returnVars].join(", ")};`, {
      sourceType: "module",
      plugins: MX_DEFAULT_PLUGINS,
    }) as unknown as { program: { body: Array<Record<string, unknown>> } };
    program.body.splice(
      authoredImportsOf(program.body).lastImportIndex + 1,
      0,
      declaration.program.body[0] as Record<string, unknown>,
    );
  }

  if (hoisted.length === 0) return;

  const { authored, lastImportIndex } = authoredImportsOf(program.body);
  // An authored binding that some scope between the module and a region
  // re-declares is not the import at that point — `function f(Icon) { <icon/> }`
  // would resolve the renamed reference to the parameter. Reuse is only safe
  // for a name nothing shadows, so a shadowed one is dropped from the pool and
  // the import is injected under its generated name instead.
  const shadowed = shadowedNames(
    program.body,
    new Set(authored.map((one) => one.local)),
    regions,
  );
  const { statements, renames } = planHoistedImports(
    hoisted,
    authored.filter((one) => !shadowed.has(one.local)),
    (spec) => (spec.startsWith(".") ? resolve(dirname(filename), spec) : null),
  );

  if (renames.size > 0) renameRegionReferences(program.body, renames, regions);
  if (statements.length === 0) return;

  const parsed = statements.map(
    (code) =>
      babelParse(code, {
        sourceType: "module",
        plugins: MX_DEFAULT_PLUGINS,
      }) as unknown as { program: { body: Array<Record<string, unknown>> } },
  );
  program.body.splice(
    lastImportIndex + 1,
    0,
    ...parsed.map((one) => one.program.body[0] as Record<string, unknown>),
  );
}

/**
 * The module's own default imports, and where its import block ends.
 *
 * A **type-only** import is skipped, both in its declaration form
 * (`import type Icon from …`) and its specifier form
 * (`import { type default as Icon }`). It binds no runtime value, so reusing
 * it would leave the emitted module referencing a name that is erased before
 * it runs — the tag would be `undefined` at the call. Such a declaration still
 * counts for `lastImportIndex`, since it is still an import the injected one
 * should follow.
 */
function authoredImportsOf(body: Array<Record<string, unknown>>): {
  authored: AuthoredImport[];
  lastImportIndex: number;
} {
  const authored: AuthoredImport[] = [];
  let lastImportIndex = -1;
  for (let index = 0; index < body.length; index++) {
    const statement = body[index] as {
      type?: string;
      importKind?: string;
      source?: { value?: unknown };
      specifiers?: Array<{
        type?: string;
        importKind?: string;
        local?: { name?: unknown };
      }>;
    };
    if (statement?.type !== "ImportDeclaration") continue;
    lastImportIndex = index;
    if (statement.importKind === "type") continue;
    const specifier = statement.source?.value;
    if (typeof specifier !== "string") continue;
    const local = statement.specifiers?.find(
      (one) =>
        one.type === "ImportDefaultSpecifier" && one.importKind !== "type",
    )?.local?.name;
    if (typeof local !== "string") continue;
    authored.push({ specifier, local });
  }
  return { authored, lastImportIndex };
}

/**
 * Which of `names` some scope enclosing a region re-declares.
 *
 * Reusing an authored import means emitting its local name *inside the
 * region*, so the name has to still mean that import there. A function whose
 * parameter or local shadows it (`function f(Icon) { <icon/> }`) makes the
 * reused reference resolve to the parameter instead — silently, and to
 * whatever the caller passed. Such a name is dropped from the reuse pool.
 *
 * Deliberately coarse: any binder of the name anywhere on the path from the
 * module root down to a region disqualifies it, without modelling block scope
 * or hoisting. Over-reporting costs one extra import under a generated name,
 * which is always correct; under-reporting is the silent bug.
 */
function shadowedNames(
  root: unknown,
  names: ReadonlySet<string>,
  regions: ReadonlyArray<[number, number]>,
): Set<string> {
  const shadowed = new Set<string>();
  if (names.size === 0 || regions.length === 0) return shadowed;

  const seen = new Set<unknown>();
  const walk = (node: unknown, bound: ReadonlySet<string>): void => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, bound);
      return;
    }
    const record = node as Record<string, unknown>;
    const start = record.start;
    if (
      typeof start === "number" &&
      record.extra !== undefined &&
      regions.some(([from, to]) => start >= from && start < to)
    ) {
      for (const name of bound) shadowed.add(name);
      return;
    }

    // Every name this node introduces, from any binding position under it.
    let inner: Set<string> | null = null;
    for (const key of Object.keys(record)) {
      if (key === "loc" || !BINDING_KEYS.has(key)) continue;
      for (const name of namesIn(record[key])) {
        if (!names.has(name)) continue;
        inner ??= new Set(bound);
        inner.add(name);
      }
    }
    const next = inner ?? bound;
    for (const key of Object.keys(record)) {
      if (key === "loc") continue;
      walk(record[key], next);
    }
  };
  walk(root, new Set());
  return shadowed;
}

/** Every identifier name appearing in a binding position's subtree. */
function namesIn(node: unknown, out: string[] = []): string[] {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) namesIn(item, out);
    return out;
  }
  const record = node as Record<string, unknown>;
  if (record.type === "Identifier" && typeof record.name === "string") {
    out.push(record.name);
    return out;
  }
  for (const key of Object.keys(record)) {
    if (key === "loc") continue;
    namesIn(record[key], out);
  }
  return out;
}

/** Node keys whose `Identifier` child is a name being *introduced*, not read. */
const BINDING_KEYS = new Set([
  "id",
  "local",
  "imported",
  "exported",
  "param",
  "params",
  "key",
]);

/**
 * Points a dropped generated binding's references at the author's own name.
 *
 * Deliberately narrow, because this rewrites names in a module the author
 * wrote. Three guards, each one a way the naive version was wrong:
 *
 * - **Only inside a region's stamped `[start, end)` range.** A generated name
 *   is minted against the caller's bindings, but "unlikely" is not "cannot":
 *   a module that happens to write `const $mx_Icon1 = …` outside any region
 *   must not have that declaration renamed onto the author's import, which
 *   produces a duplicate-binding `SyntaxError`.
 * - **Never a declaration.** A name in a binding position (`id`, `local`, a
 *   parameter) is introducing that name, not reading it.
 * - **Never a property name.** A non-computed `ObjectProperty` key or
 *   `MemberExpression` property is not a reference to a binding at all, so
 *   `{ $mx_Icon1: 1 }` and `o.$mx_Icon1` are left alone.
 *
 * `JSXIdentifier` counts alongside `Identifier`: a region lowers to JSX, so
 * its tag reference (`<$mx_Icon1 …/>`) is the former, and that is the shape
 * this rename exists for.
 */
function renameRegionReferences(
  root: unknown,
  renames: Map<string, string>,
  regions: ReadonlyArray<[number, number]>,
): void {
  const inRegion = (node: Record<string, unknown>): boolean => {
    const start = node.start;
    if (typeof start !== "number") return false;
    return regions.some(([from, to]) => start >= from && start < to);
  };

  const seen = new Set<unknown>();
  const walk = (node: unknown, binding: boolean): void => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, binding);
      return;
    }
    const record = node as Record<string, unknown>;
    const type = record.type;

    if (type === "Identifier" || type === "JSXIdentifier") {
      if (binding || !inRegion(record)) return;
      const name = record.name;
      if (typeof name !== "string") return;
      const replacement = renames.get(name);
      if (replacement) record.name = replacement;
      return;
    }

    for (const key of Object.keys(record)) {
      if (key === "loc") continue;
      // A non-computed property name is not a reference: `{ x: 1 }` and `o.x`
      // both name a property, never the binding `x`.
      if (
        key === "key" &&
        (type === "ObjectProperty" || type === "ObjectMethod") &&
        record.computed !== true
      ) {
        continue;
      }
      if (
        key === "property" &&
        (type === "MemberExpression" || type === "OptionalMemberExpression") &&
        record.computed !== true
      ) {
        continue;
      }
      walk(record[key], binding || BINDING_KEYS.has(key));
    }
  };
  walk(root, false);
}

/**
 * Parses the file and collects every MX region's `[start, end)` absolute
 * source offsets, read off `node.extra.mx.range` (stamped by the bridge on
 * each region root — see `mx/bridge.ts`'s `stampRoot`) rather than threading
 * a dedicated parser option: the AST already carries this fact.
 *
 * Only a region's *boundary* is read back, never its lowered content, so a
 * caller with no host of its own (grammar-differential tooling, an editor
 * merely mapping region extents) does not need one either: absent an
 * explicit `mxRegionCompile`, this defaults to a stub that returns a trivial,
 * always-parseable placeholder.
 */
export function collectMxRegions(
  source: string,
  filename: string,
  options: MxParseOptions = {},
): Array<{ start: number; end: number }> {
  const regions: Array<{ start: number; end: number }> = [];
  let file: File;
  try {
    file = parse(source, filename, {
      mxRegionCompile: () => ({ code: "null" }),
      ...options,
      errorRecovery: true,
    });
  } catch {
    return regions;
  }

  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    const extra = record.extra as
      | { mx?: { range?: [number, number] } }
      | undefined;
    if (extra?.mx?.range) {
      const [start, end] = extra.mx.range;
      regions.push({ start, end });
      return;
    }
    for (const key of Object.keys(record)) {
      if (key === "loc") continue;
      visit(record[key]);
    }
  };
  visit(file);

  regions.sort((a, b) => a.start - b.start);
  return regions;
}
