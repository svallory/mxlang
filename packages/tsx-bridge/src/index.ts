import { dirname, resolve } from "node:path";
import type { File } from "@babel/types";
import {
  type ParserOptions,
  parse as rawBabelParse,
  parseExpression as rawBabelParseExpression,
} from "@mxlang/babel";
import { checkReservedBindings, dropOwnParserPosition } from "@mxlang/core";
import { mxHooks } from "./mx/bridge.ts";
import {
  type AuthoredImport,
  type HoistedDefine,
  type HoistedImport,
  planHoistedImports,
} from "./mx/hoist-imports.ts";
import { recordHoistedDefineMappings } from "./mx/hoisted-define-mappings.ts";
import {
  programBindings,
  programImports,
  unknownProgramBindings,
} from "./mx/source-bindings.ts";

export type { ParseError, ParseResult, ParserOptions } from "@mxlang/babel";
export type { PrintOptions, PrintResult, RawSourceMap } from "./mx/print.ts";
export { print, printAst } from "./mx/print.ts";
export {
  programBindings,
  SOLID_BUILTIN_TAGS,
  sourceBindings,
  unknownProgramBindings,
  unknownSourceBindings,
} from "./mx/source-bindings.ts";
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

/**
 * The Babel fork imports nothing from this package, so MX syntax reaches it
 * as the `mxHooks` option. Every entry point here supplies ours whenever the
 * grammar is on.
 */
function withMxHooks(options?: ParserOptions): ParserOptions | undefined {
  return options?.mx === true && !options.mxHooks
    ? { ...options, mxHooks }
    : options;
}

function babelParse(source: string, options?: ParserOptions) {
  return rawBabelParse(source, withMxHooks(options));
}

function babelParseExpression(source: string, options?: ParserOptions) {
  return rawBabelParseExpression(source, withMxHooks(options));
}

const MX_DEFAULT_PLUGINS: ParserOptions["plugins"] = ["typescript", "jsx"];

/**
 * Parses a region file (TypeScript with MX regions, `.<host>.mx`) and
 * returns a Babel `File`.
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
  const mx = options.mx ?? options.mxRegionCompile !== undefined;
  // Validate the authored module before any host lowering can introduce
  // declarations. This also catches let/var, nested bindings and Unicode
  // escapes, even when the caller supplied the module binding sets.
  const moduleScan = mx
    ? collectModuleScope(source, filename, options)
    : undefined;
  const importSpecifiers =
    options.mxImportSpecifiers ?? moduleScan?.importSpecifiers ?? new Map();
  const moduleBindings =
    options.mxModuleBindings ?? moduleScan?.moduleBindings ?? new Set();
  const importDefaultFromMarkoOrMx =
    options.mxImportDefaultFromMarkoOrMx ??
    moduleScan?.importDefaultFromMarkoOrMx ??
    new Set();
  const importSites =
    options.mxImportSites ?? moduleScan?.importSites ?? new Map();
  const unknownModuleBindings =
    options.mxUnknownModuleBindings ??
    moduleScan?.unknownModuleBindings ??
    new Set();
  // SAFETY: Babel returns a standard File; its internal AST types differ only at the TypeScript boundary.
  const file = parseWithDiagnosticText(source, {
    sourceType: "module",
    sourceFilename: filename,
    plugins: MX_DEFAULT_PLUGINS,
    ...options,
    // Turns the forked `jsxParseElementAt` on. Without it the vendored parser
    // is byte-for-byte upstream Babel.
    //
    // An explicit `mx` wins. Left unset, the grammar is on exactly when a
    // host's region compile is supplied: the parser names no host and no
    // file suffix, so which file is a region file is the caller's answer
    // (the target registry's region file kinds). A tool passes `mx: true`
    // as well, so a forgotten hook is `MissingRegionCompile` at the first
    // region rather than a plain TSX parse.
    mx,
    mxImportSpecifiers: importSpecifiers,
    mxModuleBindings: moduleBindings,
    mxImportDefaultFromMarkoOrMx: importDefaultFromMarkoOrMx,
    mxImportSites: importSites,
    mxUnknownModuleBindings: unknownModuleBindings,
  } as ParserOptions) as unknown as File;
  if (mx) checkReservedBindings(file);
  hoistRegionImports(file, filename);
  return file;
}

/**
 * MX diagnostics carry their position in `loc`, never Babel's 0-based suffix.
 * Keep the vendored Babel entry points (and explicit `mx: false`) unchanged.
 * This wraps both the declaration prepass and the real region compilation.
 */
function parseWithDiagnosticText(source: string, options: ParserOptions) {
  if (options.mx !== true) return babelParse(source, options);
  try {
    const file = babelParse(source, options);
    for (const error of file.errors ?? []) {
      error.message = dropOwnParserPosition(error, error.message);
    }
    return file;
  } catch (error) {
    if (error instanceof Error) {
      error.message = dropOwnParserPosition(error, error.message);
    }
    throw error;
  }
}

/**
 * Reads the surrounding TypeScript module's scope before lowering any MX
 * region: every import specifier (local binding -> module) and every value
 * that scope binds at its top level (`programBindings`) — a capitalized tag
 * a region references may resolve through either. The real parse must lower
 * a region immediately so Babel can keep parsing the expression, but a
 * callee import or a value binding a region depends on may appear anywhere
 * in the module. A declaration-only pre-pass replaces every region with
 * `null`, avoiding host work and giving us Babel's exact grammar rather
 * than a regex approximation.
 */
function collectModuleScope(
  source: string,
  filename: string,
  options: MxParseOptions,
): {
  importSpecifiers: Map<string, string>;
  moduleBindings: Set<string>;
  importDefaultFromMarkoOrMx: Set<string>;
  importSites: Map<string, { line: number; column: number }>;
  unknownModuleBindings: Set<string>;
} {
  // SAFETY: the declaration prepass returns the same standard Babel File as the real parse.
  const file = parseWithDiagnosticText(source, {
    sourceType: "module",
    sourceFilename: filename,
    plugins: MX_DEFAULT_PLUGINS,
    ...options,
    mx: true,
    mxRegionCompile: () => ({ code: "null" }),
    mxImportSpecifiers: new Map<string, string>(),
    mxModuleBindings: new Set<string>(),
  } as ParserOptions) as unknown as File;
  checkReservedBindings(file);
  const {
    importSpecifiers: imports,
    importDefaultFromMarkoOrMx,
    importSites,
  } = programImports(file.program);
  const moduleBindings = programBindings(file.program);
  const unknownModuleBindings = unknownProgramBindings(file.program);
  return {
    importSpecifiers: imports,
    moduleBindings,
    importDefaultFromMarkoOrMx,
    importSites,
    unknownModuleBindings,
  };
}

/**
 * Writes the imports the compiler minted for discovered tags into the module
 * that contains their regions.
 *
 * An MX region inside a `.solid.mx` file is an *expression*, so a discovered
 * tag's import has no module scope of its own to land in — the surrounding
 * TypeScript module is the only place it can go (design §3.2). Three rules:
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
  // SAFETY: Babel's program body consists of traversable statement records.
  const program = file.program as unknown as {
    body: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(program?.body)) return;

  const hoisted: HoistedImport[] = [];
  // A `<define>` inside a region hoists to module scope the same way:
  // the emitter mints a gensym'd function declaration. That
  // gensym is only unique *within its own region* — a host has no
  // visibility of another region's choices — so two regions in one file
  // each declaring `<define/Row>` can independently mint the identical
  // binding. Each region is kept with its root node and its entries in the
  // host's order, so the collision pass below can rename, per region, the
  // declaration, the region's own references and the references in the
  // region's other hoisted defines together.
  const defineRegions: Array<{ root: unknown; defines: HoistedDefine[] }> = [];
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
              hoistedDefines?: HoistedDefine[];
              returnVars?: string[];
              range?: [number, number];
            };
          }
        | undefined
    )?.mx;
    if (mx?.range) regions.push(mx.range);
    for (const entry of mx?.hoistedImports ?? []) hoisted.push(entry);
    if (mx?.hoistedDefines?.length) {
      defineRegions.push({ root: record, defines: mx.hoistedDefines });
    }
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
    //
    // Explicitly `: any`, not a bare `let` (TODO tag-var-type-from-return):
    // the value is assigned inside the region's `$mxReturn={...}` callback,
    // so TypeScript's control-flow analysis cannot narrow it from the
    // declaration alone — a bare `let n;` reports `noImplicitAny`'s own
    // TS7005 ("Variable 'n' implicitly has an 'any' type") at every read,
    // which is real noise a user would see and is unrelated to whatever the
    // `<return>` value's actual type is. The `<return>` expression's real
    // type cannot be inferred here without changing the emitted runtime JS
    // (firstmate's ruling, tag-var-type-from-return): TypeScript's `typeof`
    // only accepts an identifier, never an arbitrary expression, and the
    // expression can depend on the unit's own body locals, so no type-only
    // declaration beside the component can name it either.
    // SAFETY: this generated declaration is parsed into ordinary Babel statement records.
    const declaration = babelParse(
      `let ${[...returnVars].map((name) => `${name}: any`).join(", ")};`,
      {
        sourceType: "module",
        plugins: MX_DEFAULT_PLUGINS,
      },
    ) as unknown as { program: { body: Array<Record<string, unknown>> } };
    program.body.splice(
      authoredImportsOf(program.body).lastImportIndex + 1,
      0,
      detachLocations(declaration.program.body[0]),
    );
  }

  if (hoisted.length > 0) {
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
      (spec) =>
        spec.startsWith(".") ? resolve(dirname(filename), spec) : null,
    );

    if (renames.size > 0) {
      renameRegionReferences(program.body, renames, regions);
    }
    if (statements.length > 0) {
      const parsed = statements.map((code) =>
        babelParse(code, {
          sourceType: "module",
          plugins: MX_DEFAULT_PLUGINS,
        }),
      );
      program.body.splice(
        lastImportIndex + 1,
        0,
        ...parsed.map((one) => detachLocations(one.program.body[0])),
      );
    }
  }

  if (defineRegions.length === 0) return;

  // A hoisted define's gensym is only unique *within its own region* — a
  // host has no visibility of another region's choices — so two regions in
  // one file each declaring `<define/Row>` can independently mint the
  // identical binding (`__mx_DefineRow1`), which would otherwise splice two
  // functions of the same name into one module scope (a `SyntaxError`,
  // duplicate lexical/function binding). Each region is placed in document
  // order with a map of its own renames, against a pool seeded with every
  // binding this module already uses (so a renamed define also can't collide
  // with an authored name or an already-placed hoisted import):
  //
  // - Each entry's snippet is parsed once, so a rename flips the
  //   declaration's `id.name` on the AST rather than pattern-matching
  //   `entry.code` as text (`function <name>(` broke once on `$`, a regex
  //   metacharacter, and would break on any other generator shape).
  // - The references in an entry's snippet to a define the same region
  //   renamed earlier are renamed first: a host lists a define after every
  //   define its body calls.
  // - An entry is shared with an already placed one only when its binding,
  //   its text and the renames its references took are all equal, so a host
  //   helper every region emits identically is declared once, and a body
  //   that calls a different region's define is never shared.
  // - Otherwise a colliding binding is renamed `<binding>_N`.
  // - The region's own references are renamed last, by walking its root.
  const takenBindings = new Set<string>();
  for (const entry of hoisted) takenBindings.add(entry.binding);
  for (const name of moduleBindingNames(program.body)) {
    takenBindings.add(name);
  }
  // Effective key -> final binding of each placed entry.
  const placedKeys = new Map<string, string>();
  const placed: Array<ReturnType<typeof babelParse>> = [];
  for (const region of defineRegions) {
    const renames = new Map<string, string>();
    for (const entry of region.defines) {
      const snippet = babelParse(entry.code, {
        sourceType: "module",
        plugins: MX_DEFAULT_PLUGINS,
      });
      const applied =
        renames.size > 0
          ? renameRegionReferences(snippet.program, renames)
          : new Set<string>();
      const key = JSON.stringify([
        entry.binding,
        entry.code,
        [...applied].sort().map((name) => [name, renames.get(name)]),
      ]);
      const shared = placedKeys.get(key);
      if (shared !== undefined) {
        if (shared !== entry.binding) renames.set(entry.binding, shared);
        continue;
      }
      let binding = entry.binding;
      if (takenBindings.has(binding)) {
        binding = freshDefineBinding(entry.binding, takenBindings);
        const fn = snippet.program.body[0] as
          | { id?: { name?: string } }
          | undefined;
        if (fn?.id) fn.id.name = binding;
        renames.set(entry.binding, binding);
      }
      takenBindings.add(binding);
      placedKeys.set(key, binding);
      // Where the entry's mappings land in its printed text, measured now,
      // after the renames and while the snippet still has its own
      // locations, which `detachLocations` removes below (`printAst` rebases
      // them onto the printed module).
      recordHoistedDefineMappings(file, snippet, entry);
      placed.push(snippet);
    }
    if (renames.size > 0) renameRegionReferences(region.root, renames);
  }

  // Placed after the module's import block (including any import this pass
  // just spliced in above, so a define calling a discovered tag closes over
  // its binding correctly).
  const { lastImportIndex: defineInsertIndex } = authoredImportsOf(
    program.body,
  );
  program.body.splice(
    defineInsertIndex + 1,
    0,
    // A host helper may be several declarations (the attribute-tag record
    // helper declares a type, constants and functions); every one is kept.
    ...placed.flatMap((one) =>
      one.program.body.map((statement) => detachLocations(statement)),
    ),
  );
}

/**
 * Removes the source locations from a node this pass synthesizes.
 *
 * Each such node is parsed from a snippet of its own, so its `start`/`end`/
 * `loc`/`range` are offsets into that snippet, not into the module it is
 * spliced into. Left in place they read as positions in the authored file:
 * they put source-map tokens at (0, 0) and made a host that reads `end` to
 * find "after the last import" insert inside a decorator. The location is
 * removed rather than repaired, as for a generated `satisfies` type in
 * `bridge.ts`: a node without one is printed where the text already is.
 */
function detachLocations(value: unknown): Record<string, unknown> {
  const visit = (node: unknown) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    delete record.start;
    delete record.end;
    delete record.loc;
    delete record.range;
    for (const [key, child] of Object.entries(record)) {
      if (key !== "extra") visit(child);
    }
  };
  visit(value);
  return value as Record<string, unknown>;
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

/**
 * Every name the module's own top-level statements bind — imports,
 * `const`/`let`/`var`, `function`/`class` declarations — used as the
 * collision pool for renaming a duplicate hoisted `<define>` binding.
 *
 * Deliberately over-collects: it walks each top-level statement with
 * `namesIn` (which also picks up expression-position identifiers wherever a
 * binding-key subtree contains one), not only true declaration positions.
 * That is the same "over-reporting costs a wasted gensym slot, never a
 * silent collision" tradeoff `shadowedNames` already makes for an adjacent
 * problem in this file.
 */
function moduleBindingNames(body: Array<Record<string, unknown>>): string[] {
  const names: string[] = [];
  for (const statement of body) {
    for (const key of Object.keys(statement)) {
      if (key === "loc" || !BINDING_KEYS.has(key)) continue;
      namesIn(statement[key], names);
    }
  }
  return names;
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

/** Mints `<binding>_2`, `<binding>_3`, ... until one is not in `taken`. */
function freshDefineBinding(
  binding: string,
  taken: ReadonlySet<string>,
): string {
  let n = 2;
  let candidate = `${binding}_${n}`;
  while (taken.has(candidate)) candidate = `${binding}_${++n}`;
  return candidate;
}

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
 * this rename exists for. A name inside a binding's type annotation or a
 * parameter default is a read and is renamed.
 *
 * Without `regions`, every node under `root` is renamed whatever its offsets:
 * the define pass walks one region's root, or one hoisted snippet, whole.
 * Returns the original names it replaced.
 */
function renameRegionReferences(
  root: unknown,
  renames: ReadonlyMap<string, string>,
  regions?: ReadonlyArray<[number, number]>,
): Set<string> {
  const replaced = new Set<string>();
  const inRegion = (node: Record<string, unknown>): boolean => {
    if (!regions) return true;
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
      // A declared name's type reads other names: `p: typeof X`.
      walk(record.typeAnnotation, false);
      if (binding || !inRegion(record)) return;
      const name = record.name;
      if (typeof name !== "string") return;
      const replacement = renames.get(name);
      if (replacement) {
        record.name = replacement;
        replaced.add(name);
      }
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
      // A type annotation (`...a: Parameters<typeof X>`), its type
      // arguments (`<typeof X>`, `params` like a declaration's) and a
      // parameter default (`n = X`) read names even under a binding position.
      if (
        key === "typeAnnotation" ||
        (key === "params" && type === "TSTypeParameterInstantiation") ||
        (key === "right" && type === "AssignmentPattern")
      ) {
        walk(record[key], false);
        continue;
      }
      walk(record[key], binding || BINDING_KEYS.has(key));
    }
  };
  walk(root, false);
  return replaced;
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
