/**
 * The shared JSX **region** entry: one MX region of a `.<segment>.mx`
 * TypeScript module (`.react.mx` today), compiled for a JSX dialect.
 *
 * A region file is TypeScript (TSX) with MX regions, exactly as `.solid.mx`
 * is for Solid: hooks and logic live in the surrounding module, and each
 * region lowers to one JSX expression the parser bridge splices back in
 * place. The markup is emitted by the same `createEmitter` + `drive` as a
 * whole-file `.mx` (`compile.ts`), so a region renders what the same markup
 * renders as a whole file; only the module assembly differs:
 *
 * - module-scope needs (runtime imports, discovered-tag imports, attribute
 *   helpers, `__mxDynamic`) are handed back as `hoistedImports` /
 *   `hoistedDefines`, which the bridge places once per module;
 * - the statements a whole-file component declares above its `return` (a
 *   top-level `<define>`, a `/var` call, a component alias) stay with the
 *   region inside an immediately-invoked arrow, so they keep closing over the
 *   surrounding component's locals (its `useState` values) exactly as the
 *   whole-file text does;
 * - module-level MX (`import`, `static`, `export`, `export interface Input`,
 *   `<return>`) and `<const>` are errors: the region has a real TypeScript
 *   module and component around it to hold them.
 *
 * Host-agnostic across the JSX dialects: `@mxlang/react` (and later
 * `@mxlang/preact`/`@mxlang/hono`) wrap it with their dialect, region
 * declarations and segment.
 */

import { dirname, resolve } from "node:path";
import {
  type CustomTag,
  concatMapped,
  drive,
  type HostDeclarations,
  type Ir,
  lower,
  type MappedCode,
  type MxWarning,
  newCtx,
  parseFragment,
  positionRegionSource,
  printExpression,
  type TargetLookup,
  TranslateError,
} from "@mxlang/core";
import {
  attributeHelpers,
  type JsxHelper,
  MX_DYNAMIC,
  runtimeImports,
} from "./compile.ts";
import type { JsxDialect } from "./dialect.ts";
import { componentAlias, createRegionEmitter } from "./emitter.ts";

export interface CompileJsxRegionOptions {
  filename: string;
  /** File-relative position of this region; used by the parser bridge. */
  baseOffset?: number;
  baseLine?: number;
  baseColumn?: number;
  /** Custom tags already discovered and loaded by the calling integration. */
  customTags?: Record<string, CustomTag>;
  /** `package.json#mx.<target>.defaultTag`, already validated (decision 145). */
  defaultTag?: string;
  /** Surrounding module imports, local binding -> specifier. */
  importSpecifiers?: ReadonlyMap<string, string>;
  /** Every value the surrounding module binds at its top level (decision 114). */
  moduleBindings?: ReadonlySet<string>;
  /** Bindings that are a default import from a `.marko`/`.mx` source (decision 116). */
  importDefaultFromMarkoOrMx?: ReadonlySet<string>;
  /** Non-import names whose value is not statically a function, arrow or class. */
  unknownModuleBindings?: ReadonlySet<string>;
  /** Positioned non-fatal diagnostics collected by editor/build tooling. */
  warnings?: MxWarning[];
  /** The registered targets this compile runs under. */
  targets: TargetLookup;
  /** The JSX dialect to emit for. */
  dialect: JsxDialect;
  /** The dialect's *region* declarations (`createJsxDeclarations(name, { region: true })`). */
  declarations: HostDeclarations;
  /** The file kind's segment (`react` for `.react.mx`), named in region errors. */
  segment: string;
}

/** One import a region needs in its surrounding module (Solid's shape). */
export interface JsxHoistedImport {
  /** The import statement text. */
  code: string;
  /** The local binding the emitted region references. */
  binding: string;
  /** The module specifier, as written in `code`. */
  specifier: string;
  /** The key the bridge de-duplicates and reuses authored imports by. */
  resolvedPath: string;
}

export interface CompileJsxRegionResult {
  /** The region as one JSX expression. */
  code: string;
  hoistedImports: JsxHoistedImport[];
  /** Fixed-binding helpers; identical in every region, declared once by the bridge. */
  hoistedDefines: JsxHelper[];
  /** Always empty: a `/var` binds inside the region's own arrow (see the file doc). */
  returnVars: string[];
  /** Callee declarations read while resolving this region's attribute tags. */
  dependencies: string[];
}

/** The position an IR node reports, or the region start when it has none. */
function positionOf(
  node: { loc?: { line: number; column: number; file?: string } } | undefined,
  fallback: { line: number; column: number },
): { line: number; column: number; file?: string } {
  return node?.loc ?? fallback;
}

/**
 * Refuses module-level MX inside a region, at the offending statement.
 *
 * Same rule and wording as `.solid.mx` (`compileSolidMx`), with the file kind
 * named from `segment`. Positioned at the statement the author wrote rather
 * than the region start, so the diagnostic lands on the line to move.
 */
function rejectModuleLevel(
  ir: Ir,
  segment: string,
  regionStart: { line: number; column: number },
  returnTag: { line: number; column: number; file?: string } | undefined,
): void {
  const offending: Array<
    { loc?: { line: number; column: number; file?: string } } | undefined
  > = [
    ...ir.imports.filter((node) => !node.synthesized),
    ...ir.hoisted,
    ...(ir.inputInterface ? [ir.inputInterface] : []),
    ...ir.prelude,
  ];
  // `<return>` at its tag (core keeps the tag's position on the `Ctx`, the
  // IR only the value), so the error points where the author wrote it.
  if (ir.returnValue)
    offending.push(returnTag ? { loc: returnTag } : undefined);
  if (offending.length === 0) return;
  // Earliest first, so the reported statement is the first one in the file.
  const first = offending
    .map((node) => positionOf(node, regionStart))
    .sort((a, b) => a.line - b.line || a.column - b.column)[0] as {
    line: number;
    column: number;
    file?: string;
  };
  throw new TranslateError(
    `module-level MX statements cannot appear inside a \`.${segment}.mx\` expression; write them in the surrounding TypeScript module`,
    first.line,
    first.column,
    first.file,
  );
}

/** `MX_DYNAMIC` as two declarations: the bridge renames only a define's first statement. */
function dynamicHelpers(): JsxHelper[] {
  const split = MX_DYNAMIC.indexOf("\nfunction __mxDynamic(");
  return [
    {
      binding: "__mxIsHostComponentObject",
      code: MX_DYNAMIC.slice(0, split),
    },
    { binding: "__mxDynamic", code: MX_DYNAMIC.slice(split + 1) },
  ];
}

/** Compiles one MX region to a JSX expression for `options.dialect`. */
export function compileJsxRegion(
  source: string,
  options: CompileJsxRegionOptions,
): CompileJsxRegionResult {
  const { dialect, segment } = options;
  const regionStart = {
    line: (options.baseLine ?? 0) + 1,
    column: options.baseColumn ?? 0,
  };
  // The padded `Ctx` source and the matching `parseFragment` base, built
  // together so every IR position is file-absolute (`FragmentBase`).
  const { padded, base } = positionRegionSource(
    source,
    {
      baseOffset: options.baseOffset ?? 0,
      baseLine: options.baseLine ?? 0,
      baseColumn: options.baseColumn ?? 0,
    },
    { filename: options.filename },
  );
  const { body } = parseFragment(source, {
    filename: options.filename,
    ...base,
    customTags: options.customTags,
  });
  const ctx = newCtx(
    padded,
    printExpression,
    options.declarations,
    undefined,
    options.filename,
    options.targets,
  );
  ctx.customTags = options.customTags;
  ctx.defaultTag = options.defaultTag;
  ctx.warnings = options.warnings;
  ctx.unsupportedIn = `a \`.${segment}.mx\` region`;
  if (options.importSpecifiers) {
    ctx.importSpecifiers = new Map(options.importSpecifiers);
    for (const name of options.importSpecifiers.keys()) ctx.imports.add(name);
  }
  // The surrounding module's own top-level values resolve a capitalized tag
  // too (decision 114), as in `compileSolidMx`.
  if (options.moduleBindings) {
    for (const name of options.moduleBindings) ctx.imports.add(name);
  }
  if (options.unknownModuleBindings) {
    for (const name of options.unknownModuleBindings) {
      ctx.unknownLocalValue.add(name);
    }
  }
  if (options.importDefaultFromMarkoOrMx) {
    for (const name of options.importDefaultFromMarkoOrMx) {
      ctx.importDefaultFromMarkoOrMx.add(name);
    }
  }
  const ir = lower(ctx, body);
  rejectModuleLevel(ir, segment, regionStart, ctx.returnValue?.loc);

  // A region is one root element, so its `<define>`s sit in markup; the
  // region emitter lifts those outside a callback into `liftedDefines`.
  // The padded source is file-shaped (offset = file offset), so a span's
  // offset maps straight to the file's line and column.
  const emitter = createRegionEmitter(dialect, segment, (offset) => {
    const before = padded.slice(0, offset);
    const lastBreak = before.lastIndexOf("\n");
    return {
      line: before.split("\n").length,
      column: offset - (lastBreak + 1),
    };
  });
  drive(emitter, ir.body);
  const markupCode = emitter.result();
  // Defines first, then the `/var` calls, as a whole-file module orders them.
  const statements: MappedCode[] = [
    ...emitter.liftedDefines,
    ...emitter.varStatements.map((statement) => concatMapped(statement)),
  ];

  const hoistedImports: JsxHoistedImport[] = [];
  for (const node of ir.imports) {
    // Only synthesized imports survive `rejectModuleLevel`. All three fields
    // are minted together (`template-tag.ts`), so a missing one is a
    // compiler bug: fail loudly rather than emit an unbound reference.
    const binding = node.bindings[0];
    if (!binding || !node.specifier || !node.resolvedPath) {
      throw new TranslateError(
        `internal: synthesized import is missing its binding, specifier or resolved path (${node.code})`,
        node.loc.line,
        node.loc.column,
        node.loc.file,
      );
    }
    hoistedImports.push({
      code: node.code,
      binding,
      specifier: node.specifier,
      resolvedPath: node.resolvedPath,
    });
  }
  // A component JSX would read as an element is called under a capitalized
  // alias (`componentAlias`). A name the module binds gets a local alias
  // beside the region's other statements; a `tags/`-discovered `.marko` tag
  // gets the import a whole-file module synthesizes, hoisted. Its key carries
  // a suffix so the bridge never swaps the alias for an authored default
  // import of the same file, whose lowercase name JSX would read as an element.
  for (const name of emitter.aliases) {
    const alias = componentAlias(name);
    if (ctx.imports.has(name)) {
      statements.unshift(concatMapped(`const ${alias} = ${name};`));
      continue;
    }
    const specifier = `./tags/${name}.marko`;
    hoistedImports.push({
      code: `import ${alias} from "${specifier}";`,
      binding: alias,
      specifier,
      resolvedPath: `${resolve(dirname(options.filename), specifier)}#mx-alias`,
    });
  }
  for (const entry of runtimeImports(emitter.runtimeImports, dialect)) {
    hoistedImports.push({
      ...entry,
      resolvedPath: `${entry.specifier}#mx-${entry.binding}`,
    });
  }
  if (ir.needsAttrTagImport) {
    hoistedImports.push({
      code: `import type { AttrTag } from "${dialect.attrTagModule}";`,
      binding: "AttrTag",
      specifier: dialect.attrTagModule,
      resolvedPath: `${dialect.attrTagModule}#mx-attr-tag`,
    });
  }

  const usesDynamic = emitter.runtimeImports.has("__mxDynamic");
  const helperInput = [
    markupCode.code,
    ...statements.map((statement) => statement.code),
    ...(usesDynamic ? [MX_DYNAMIC] : []),
  ].join("\n");
  const hoistedDefines = [
    ...attributeHelpers(helperInput, dialect),
    ...(usesDynamic ? dynamicHelpers() : []),
  ];

  // Always a fragment: a region sits in expression *and* JSX-child position,
  // and only a JSX element reads the same in both (a bare `{…}` or call in a
  // child position would print as text). The statements' arrow is called
  // inside it for the same reason.
  const jsx = `<>${markupCode.code}</>`;
  const code =
    statements.length === 0
      ? jsx
      : `<>{(() => { ${statements.map((statement) => statement.code).join(" ")} return (${jsx}); })()}</>`;
  return {
    code,
    hoistedImports,
    hoistedDefines,
    returnVars: [],
    dependencies: [...(ctx.dependencies ?? [])],
  };
}
