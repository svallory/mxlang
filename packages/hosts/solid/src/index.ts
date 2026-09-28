import { parse as parseBabel } from "@babel/parser";
import {
  type AttrTagConfig,
  type AttrTagOf,
  type CustomTag,
  concatMapped,
  type GeneratedMapping,
  lower,
  type MxWarning,
  moduleExportName,
  type Node,
  newCtx,
  parseFragment,
  printExpression,
  registerCalleeInputReader,
  TranslateError,
} from "@mxlang/core";
import { parse as parseMx } from "@mxlang/parser";
import MagicString from "magic-string";
import type { Element as SolidElement } from "solid-js";
import {
  collectReturnVars,
  createEmitter,
  emitSolid,
  emitSolidWithMappings,
  MX_ESCAPE_BINDING,
  MX_RETURN_PROP,
  SolidEmitter,
  solidDeclarations,
} from "./emitter.ts";

export type { AttrTagConfig, AttrTagOf } from "@mxlang/core";
export {
  createEmitter,
  emitSolid,
  emitSolidWithMappings,
  MX_ESCAPE_BINDING,
  MX_RETURN_PROP,
  SolidEmitter,
  solidDeclarations,
};

/** Attribute-tag value specialised to Solid's reusable accessor renderable. */
export type AttrTag<
  // biome-ignore lint/complexity/noBannedTypes: public default from decision 106
  C extends AttrTagConfig = {},
> = AttrTagOf<C, () => SolidElement>;

function parseSolidCalleeProgram(source: string, path: string): Node[] {
  return parseMx(source, path, {
    // The reader only needs module declarations. Compiling region bodies here
    // would resolve their imported callees, which recurses forever for two
    // `.solid.mx` files that import one another.
    mxRegionCompile: () => ({ code: "null" }),
  }).program.body as Node[];
}

registerCalleeInputReader(".solid.mx", ({ path, source, analyze }) => {
  try {
    return analyze(parseSolidCalleeProgram(source, path));
  } catch {
    // A host reader is advisory. Malformed or unsupported SolidMX must never
    // make a caller invalid merely because its Input could not be inspected.
    return { kind: "none", path };
  }
});

export interface CompileSolidMxOptions {
  filename: string;
  /** File-relative position of this region; used by the parser bridge. */
  baseOffset?: number;
  baseLine?: number;
  baseColumn?: number;
  /** Custom tags already discovered and loaded by the calling integration. */
  customTags?: Record<string, CustomTag>;
  /** Surrounding `.solid.mx` module imports, local binding -> specifier. */
  importSpecifiers?: ReadonlyMap<string, string>;
  /**
   * Every value the surrounding `.solid.mx` module binds at its top level —
   * import locals plus top-level `const`/`function`/`class` names, type-only
   * bindings excluded (decision 114). A capitalized tag a region references
   * may resolve through this scope as well as `importSpecifiers`.
   */
  moduleBindings?: ReadonlySet<string>;
  /**
   * The subset of `importSpecifiers`' bindings that are a *default* import
   * from a `.marko`/`.mx` source — Marko's own statically-resolved
   * component case (decision 116). A capitalized tag bound to a name in
   * this set lowers as a direct component call, exactly as before decision
   * 116; any other value import (named, namespace, or a default from any
   * other extension) lowers as a dynamic tag instead.
   */
  importDefaultFromMarkoOrMx?: ReadonlySet<string>;
  /**
   * The subset of `moduleBindings`' *non-import* names (a top-level
   * `const`/`function`/`class` the surrounding module declares) whose value
   * `@mxlang/parser`'s `programBindings` could not statically prove is a
   * function/arrow/class — the local extension of decision 116 (firstmate's
   * ruling under decision 116 in `notes/decisions-2026-09-10.md`). A
   * capitalized tag bound to a name in this set lowers as a dynamic tag
   * instead of the direct call `moduleBindings` alone would give it; a plain
   * `function Foo(){}`/`class Foo{}`/`const Foo = () => {}` is absent from
   * this set and keeps its existing direct call.
   */
  unknownModuleBindings?: ReadonlySet<string>;
  /** Positioned non-fatal diagnostics collected by editor/build tooling. */
  warnings?: MxWarning[];
}

export interface RawSourceMap {
  version: number;
  file?: string;
  sourceRoot?: string;
  sources: string[];
  sourcesContent?: (string | null)[];
  names: string[];
  mappings: string;
}

export interface CompileSolidMxResult {
  code: string;
  map: RawSourceMap;
  mappings: GeneratedMapping[];
  /**
   * Imports the compiler minted for discovered template tags called inside
   * this region, as module-level statement text.
   *
   * A region is an expression, so it cannot hold an import itself. The caller
   * (the parser bridge) is responsible for writing these into the surrounding
   * TypeScript module, once per module per resolved path. Empty for a region
   * that calls no discovered tag.
   */
  hoistedImports: HoistedImport[];
  /**
   * `<define>`s this region hoisted to module scope (decision 110b), as
   * module-level statement text.
   *
   * A region is an expression, so it cannot hold a function declaration
   * either — the same reason `hoistedImports` exists, for the author's own
   * construct rather than a discovered tag's synthesized import. The
   * caller (the parser bridge) writes these into the surrounding module.
   * Empty for a region with no top-level `<define>`.
   */
  hoistedDefines: HoistedDefine[];
  /**
   * `/var` names this region's call sites bind, for the caller to declare.
   *
   * A region is an *expression*, so it has no statement position for the
   * `let` a `/var` needs — the same reason `hoistedImports` exists. The
   * callback prop assigns during the child's synchronous setup (design
   * §2.4), so the declaration has to be somewhere the region's JSX can close
   * over: the surrounding function. Empty for a region that binds none.
   */
  returnVars: string[];
  /** Callee declarations read while resolving this region's attribute tags. */
  dependencies: string[];
}

/** One synthesized import a region needs in its surrounding module. */
export interface HoistedImport {
  /** The `import X from "./y.mx"` statement text. */
  code: string;
  /** The local binding the emitted region references. */
  binding: string;
  /** The module specifier, as written in `code`. */
  specifier: string;
  /**
   * The template's resolved absolute path.
   *
   * Dedupe and authored-import reuse key on this rather than on `specifier`,
   * so two spellings of one file collapse to a single import (decision 95
   * ruling 3).
   */
  resolvedPath: string;
}

/** One `<define>` a region hoisted to module scope (decision 110b). */
export interface HoistedDefine {
  /** The `function $mx_DefineN(params) { return <>...</>; }` text. */
  code: string;
  /** The gensym'd module-scope binding the region calls. */
  binding: string;
}

/**
 * Marko parses attribute-method bodies as ordinary TypeScript, where a nested
 * JSX/MX expression is reported as a `MarkoParseError` statement. SolidMX's
 * surrounding language is TSX, so retry only those statement-shaped failures
 * with Babel's TSX parser. Genuine expression failures remain untouched and
 * are reported by the core with Marko's precise `errorLoc`.
 */
function repairEmbeddedTsx(node: Node, seen = new Set<object>()): void {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index++) {
      const item = node[index];
      if (item?.type === "MarkoParseError" && typeof item.source === "string") {
        try {
          const parsed = parseBabel(item.source, {
            sourceType: "module",
            plugins: ["typescript", "jsx"],
            allowReturnOutsideFunction: true,
          });
          node.splice(index, 1, ...parsed.program.body);
          index += parsed.program.body.length - 1;
          continue;
        } catch {
          // The core reports the original MarkoParseError below this pass.
        }
      }
      repairEmbeddedTsx(item, seen);
    }
    return;
  }
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "extra") continue;
    repairEmbeddedTsx(node[key], seen);
  }
}

/**
 * Compiles one MX markup region to Solid JSX text.
 *
 * A `.solid.mx` file remains an ordinary TypeScript module. The parser owns
 * discovery of each markup region and calls this function with the region
 * text and its file-relative base position; the result is parsed back as JSX
 * before the surrounding TypeScript AST is returned.
 */
export function compileSolidMx(
  source: string,
  options: CompileSolidMxOptions,
): CompileSolidMxResult {
  const baseOffset = options.baseOffset ?? 0;
  const { body } = parseFragment(source, {
    filename: options.filename,
    baseOffset,
    baseLine: options.baseLine ?? 0,
    baseColumn: options.baseColumn ?? 0,
    customTags: options.customTags,
  });
  repairEmbeddedTsx(body);
  // Two position systems read this string: `sliceLoc` (line/column, for
  // `import`/`static`/`export`, whose nodes carry no `start`/`end`) and
  // `expr()`'s index slice (`node.start`/`node.end`, file-absolute after
  // `parseFragment`'s `baseOffset` shift — see packages/core's fragment.ts).
  // `parseFragment`'s own contract (`FragmentBase.baseColumn`) shifts a
  // *first-line* column by exactly `baseColumn`, because "a later line
  // starts at its own column 0 in both the fragment and the file" — so
  // `sliceLoc`'s `ctx.lines[line]` must have *exactly* `baseColumn` filler
  // characters before `source` starts, not more. A prior version padded
  // that same line out to `baseOffset - baseLine` instead, to make an
  // absolute-index slice land correctly for a region after the file's first
  // line — but when anything (e.g. an import statement) precedes the
  // region's own line, `baseOffset - baseLine` overshoots `baseColumn`, and
  // the extra spaces land *before* the sliced column on that very line,
  // silently eating the first few characters of a param/import slice
  // (measured: `<For|item|>` after a leading `import` printed `item` as
  // nothing, `{() => ...}` instead of `{(item) => ...}`).
  // The fix keeps both contracts: put the extra filler *before* the
  // newlines (inert to both `sliceLoc`, which only reads lines at or after
  // `baseLine`, and to `expr()`, which only cares about total length), then
  // exactly `baseLine` newlines, then exactly `baseColumn` spaces on the
  // region's own line.
  const baseLine = options.baseLine ?? 0;
  const baseColumn = options.baseColumn ?? 0;
  const leadingFill = Math.max(baseOffset - baseLine - baseColumn, 0);
  const positionedSource = `${" ".repeat(leadingFill)}${"\n".repeat(baseLine)}${" ".repeat(baseColumn)}${source}`;
  const ctx = newCtx(
    positionedSource,
    printExpression,
    solidDeclarations,
    undefined,
    options.filename,
  );
  ctx.customTags = options.customTags;
  ctx.warnings = options.warnings;
  if (options.importSpecifiers) {
    ctx.importSpecifiers = new Map(options.importSpecifiers);
    for (const name of options.importSpecifiers.keys()) ctx.imports.add(name);
  }
  // A capitalized tag also resolves through the surrounding TypeScript
  // module's own top-level value bindings (decision 114) — not just its
  // imports, since a region has no module scope of its own for a
  // function/class/const the author wrote right there in the same file to
  // live in. Folded into `ctx.imports` rather than a new `Ctx` field: core's
  // precedence order already treats that set as "the file resolves this name
  // to a value", which is exactly what a module-scope binding is too.
  if (options.moduleBindings) {
    for (const name of options.moduleBindings) ctx.imports.add(name);
  }
  if (options.unknownModuleBindings) {
    for (const name of options.unknownModuleBindings) {
      ctx.unknownLocalValue.add(name);
    }
  }
  // decision 116: only a *default* import from a `.marko`/`.mx` source is
  // Marko's own statically-resolved component case; every other value
  // import lowers as a dynamic tag. `moduleBindings` folds every top-level
  // value binding into `ctx.imports` with no source tracking (correct: a
  // `const`/`function`/`class` has no specifier to check), so this set is
  // populated from `importSpecifiers`' own default-import bindings only.
  if (options.importDefaultFromMarkoOrMx) {
    for (const name of options.importDefaultFromMarkoOrMx) {
      ctx.importDefaultFromMarkoOrMx.add(name);
    }
  }
  const ir = lower(ctx, body);
  // An import the *compiler* minted for a discovered tag is not a
  // module-level statement the author wrote, so it is not theirs to move:
  // the region is the only place that call exists, and the import has
  // nowhere to live but the surrounding module. It is handed back for the
  // bridge to write there. Everything else here is authored, and an author
  // who wrote it has a real TypeScript module to put it in.
  const authoredImports = ir.imports.filter((node) => !node.synthesized);
  if (
    authoredImports.length > 0 ||
    ir.hoisted.length > 0 ||
    ir.inputInterface !== null ||
    ir.prelude.length > 0
  ) {
    throw new TranslateError(
      "module-level MX statements cannot appear inside a `.solid.mx` expression; write them in the surrounding TypeScript module",
      (options.baseLine ?? 0) + 1,
      options.baseColumn ?? 0,
    );
  }
  const hoistedImports: HoistedImport[] = ir.imports
    .filter((node) => node.synthesized)
    .map((node) => {
      const binding = node.bindings[0];
      // All three fields are set together at the one place a synthesized
      // import is minted (`template-tag.ts`'s `bindingForTemplate`), so a node
      // missing one is a compiler bug, not anything an author can produce.
      // Failing loudly beats dropping the entry: a silently skipped import
      // becomes an unresolved binding in the emitted module, far from its
      // cause.
      if (!binding || !node.specifier || !node.resolvedPath) {
        throw new TranslateError(
          `internal: synthesized import is missing its binding, specifier or resolved path (${node.code})`,
          node.loc.line,
          node.loc.column,
          node.loc.file,
        );
      }
      return {
        code: node.code,
        binding,
        specifier: node.specifier,
        resolvedPath: node.resolvedPath,
      };
    });
  // One emit, with the `/var` names collected during it: emitting twice to
  // get them separately would also duplicate the mappings work, and any
  // divergence between the two passes would be silent.
  let emitted!: ReturnType<typeof emitSolidWithMappings>;
  const {
    vars: returnVars,
    needsEscapeImport,
    hoistedDefines,
  } = collectReturnVars(() => {
    emitted = emitSolidWithMappings(ir);
    return emitted.code;
  });
  if (needsEscapeImport) {
    hoistedImports.unshift({
      code: `import { escape as ${MX_ESCAPE_BINDING} } from "@solidjs/web";`,
      binding: MX_ESCAPE_BINDING,
      specifier: "@solidjs/web",
      resolvedPath: "@solidjs/web#mx-escape",
    });
  }
  const code = emitted.code;
  const rewritten = new MagicString(source);
  rewritten.overwrite(0, source.length, code);
  const map = rewritten.generateMap({
    file: options.filename,
    source: options.filename,
    includeContent: true,
    hires: true,
  });
  return {
    code,
    map: map as RawSourceMap,
    mappings: emitted.mappings,
    hoistedImports,
    hoistedDefines,
    returnVars,
    dependencies: [...(ctx.dependencies ?? [])],
  };
}

/**
 * Compiles a whole `.mx` file to a Solid component module.
 *
 * This is the tag-unit entry point (decision 95): a `tags/icon.mx` is an
 * ordinary `.mx` file that compiles, per host, into a module exporting the
 * tag, and the caller emits an import plus a call. It differs from
 * `compileSolidMx` in exactly one way, and it is the reason both exist: a
 * *region* is an expression inside someone else's module, so module-level MX
 * statements are an error there, while a *file* is a module of its own and
 * they are placed — the author's `import`s and `static` blocks at module
 * scope, their `export interface Input` as the component's props.
 */
export function compileSolidUnit(
  source: string,
  options: CompileSolidMxOptions,
): CompileSolidMxResult {
  const { body } = parseFragment(source, {
    filename: options.filename,
    customTags: options.customTags,
  });
  repairEmbeddedTsx(body);
  const ctx = newCtx(
    source,
    printExpression,
    solidDeclarations,
    undefined,
    options.filename,
  );
  ctx.customTags = options.customTags;
  ctx.warnings = options.warnings;
  // A tag unit is a whole file compiling to a module, unlike the region path
  // above: it has a `export default function <Name>` to name, so a tag that
  // calls itself resolves to that declaration rather than importing itself.
  ctx.emitsModule = true;
  const ir = lower(ctx, body);
  // A `prelude` node is a statement a hoist hook lifted to the enclosing
  // function's head. No Solid-host construct mints one today, so rather than
  // emit it somewhere plausible and untested, report it at the statement's
  // own position. Placing it is 2b's business if a construct ever does.
  const [hoistedStatement] = ir.prelude;
  if (hoistedStatement) {
    throw new TranslateError(
      "a hoisted statement is not supported in a Solid tag unit",
      hoistedStatement.loc.line,
      hoistedStatement.loc.column,
      hoistedStatement.loc.file,
    );
  }

  const parts: Array<string | ReturnType<typeof emitSolidWithMappings>> = [];
  for (const node of ir.imports) parts.push(`${node.code}\n`);
  for (const node of ir.hoisted) parts.push(`${node.code}\n`);
  // `export interface Input` is deliberately not emitted. Solid's own
  // compiler takes source text and has no TypeScript frontend — the caller
  // is stripped before it ever sees it — so a type declaration here is a
  // syntax error downstream, not a contract the emitted module can carry.
  // Typing a tag unit's props is phase 3's job, through the same virtual-file
  // projection the TypeScript plugin already does for `.solid.mx`.
  // Named after the file, never anonymous: a tag whose template calls its own
  // name resolves to this declaration, so self-recursion needs no self-import
  // (design invariant §7.5-7).
  // A unit that declares `<return>` hands its value back through a
  // **callback prop**, not through the return value — the one host where the
  // `{ value, output }` shape does not fit, because a Solid component's
  // return value is its view and the caller writes JSX rather than a call.
  //
  // Measured against solid-js 2.0.0-rc.7 (design §2.4): the component
  // function runs synchronously at the JSX site under both `dom` and `ssr`
  // generation, so a callback invoked during setup has already run by the
  // caller's next statement. The value is therefore **one-shot, not
  // reactive** — the binding holds the value from that single invocation.
  // That matches `/var`'s meaning on every other host, and it is documented
  // as risk 4: a Solid author may reasonably expect a signal, and a tag
  // wanting reactivity should return an accessor for the caller to call.
  // `/var` names are collected while emitting, because only the emitter
  // knows which call sites declared one — a call inside an `<if>` branch or
  // a `<for>` body reaches a child emitter, not this scope.
  // `allowHoist: false` — a tag unit is a whole file, not a spliced region,
  // so nothing here reads `hoistedDefines`; a `<define>` still gets the
  // positioned "cannot declare a function inside a JSX expression" error
  // rather than hoisting into a list this function never consumes.
  // One emit, with the `/var` names and mappings collected together, the
  // same reasoning `compileSolidMx` gives for its own single emit above.
  let emittedBody!: ReturnType<typeof emitSolidWithMappings>;
  const { vars, needsEscapeImport } = collectReturnVars(() => {
    emittedBody = emitSolidWithMappings(ir);
    return emittedBody.code;
  }, false);
  if (needsEscapeImport) {
    parts.unshift(
      `import { escape as ${MX_ESCAPE_BINDING} } from "@solidjs/web";\n`,
    );
  }
  // Declared above the JSX that fills them: the callback prop assigns during
  // the child's synchronous setup, which happens as the JSX is evaluated.
  const varDecls = vars.length > 0 ? `let ${vars.join(", ")}; ` : "";
  const name = moduleExportName(ir, "@mxlang/solid");
  parts.push(
    ir.returnValue
      ? `export default function ${name}(input) { ${varDecls}input[${JSON.stringify(
          MX_RETURN_PROP,
        )}]?.(${ir.returnValue.code}); return <>`
      : `export default function ${name}(input) { ${varDecls}return <>`,
    emittedBody,
    "</>; }",
  );
  const { code, mappings } = concatMapped(...parts);
  const rewritten = new MagicString(source);
  rewritten.overwrite(0, source.length, code);
  const map = rewritten.generateMap({
    file: options.filename,
    source: options.filename,
    includeContent: true,
    hires: true,
  });
  return {
    code,
    map: map as RawSourceMap,
    mappings,
    hoistedImports: [],
    hoistedDefines: [],
    returnVars: [],
    dependencies: [...(ctx.dependencies ?? [])],
  };
}
