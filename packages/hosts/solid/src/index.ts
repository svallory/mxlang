import { parse as parseBabel } from "@babel/parser";
import {
  type AttrTagConfig,
  type AttrTagOf,
  type CustomTag,
  concatMapped,
  createTargetLookup,
  type GeneratedMapping,
  lower,
  type MxWarning,
  moduleExportName,
  type Node,
  newCtx,
  parseFragment,
  positionRegionSource,
  printExpression,
  registerCalleeInputReader,
  type TargetLookup,
  TranslateError,
} from "@mxlang/core";
import MagicString from "magic-string";
import type { Element as SolidElement } from "solid-js";
import { readSolidCalleeInput } from "./callee-reader.ts";
import descriptor from "./descriptor.ts";
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

/** Local names for the body-channel helpers a unit imports from `solid-js`. */
const MX_CHILDREN_BINDING = "$mxChildren";
const MX_MERGE_BINDING = "$mxMerge";

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

registerCalleeInputReader(".solid.mx", readSolidCalleeInput);

/**
 * This package's own target table (decisions 129 and 132): the one descriptor
 * it exports, defaulting for a caller that names no lookup of its own (design
 * note §5.1, rule (c)). A tool compiling several targets passes the built-in
 * registry's lookup through `options.targets` instead.
 */
const ownTargets: TargetLookup = createTargetLookup([descriptor]);

/**
 * This package's own target lookup, for a caller that needs one and has no
 * registry to hand: the default behind `options.targets` (design note §5.1,
 * rule (c)). Exported so this package's own tests resolve a callee under the
 * same set a direct entry compiles under.
 */
export const solidTargets = ownTargets;

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
  /**
   * The registered targets this compile runs under (decisions 129 and 132).
   * Defaults to this package's own descriptor, which is right for a direct
   * entry; a tool compiling several targets passes the built-in registry's
   * lookup, so a callee importing `AttrTag` from another registered target's
   * package reads the same as it does today.
   */
  targets?: TargetLookup;
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
  // `positionRegionSource` builds the `Ctx` source and the matching
  // `parseFragment` base together (the padding contract on `FragmentBase`), so
  // `sliceLoc`'s line/column reads and `expr()`'s index slice agree with the
  // file and a violating position throws instead of mis-mapping.
  const { padded: positionedSource, base } = positionRegionSource(
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
  repairEmbeddedTsx(body);
  const ctx = newCtx(
    positionedSource,
    printExpression,
    solidDeclarations,
    undefined,
    options.filename,
    options.targets ?? ownTargets,
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
    options.targets ?? ownTargets,
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
  // The author's `export interface Input` is emitted and the component
  // parameter is annotated with it, exactly as `@mxlang/preact` and
  // `@mxlang/html` do, so a caller's `<Card title=1/>` is a JSX props check
  // against `Input` (TS2322). The output is therefore TSX carrying types, and
  // every runtime consumer must run a TypeScript-aware step over it. The vite
  // plugin already hands a whole-file unit to `@solidjs/vite-plugin` under a
  // `.tsx` id, and Solid's native compiler parses TS and passes the types
  // through for vite's own transform to strip. A component with no `Input`
  // gets an empty one, again as on the other hosts.
  parts.push(`${ir.inputInterface?.code ?? "export interface Input {}"}\n`);
  if (ir.needsAttrTagImport) {
    parts.unshift(`import type { AttrTag } from "@mxlang/solid";\n`);
  }
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
  //
  // Explicitly `: any`, not a bare `let` (TODO tag-var-type-from-return):
  // the value is assigned inside the `$mxReturn={...}` callback, so
  // TypeScript's control-flow analysis cannot narrow it from the
  // declaration alone — a bare `let n;` reports `noImplicitAny`'s own
  // TS7005 at every read, unrelated noise regardless of the `<return>`
  // value's real type. That real type cannot be inferred here without
  // changing the emitted runtime JS (firstmate's ruling): TypeScript's
  // `typeof` only accepts an identifier, never an arbitrary expression, and
  // the expression can depend on the unit's own body locals, so no
  // type-only declaration beside the component can name it either.
  const varDecls =
    vars.length > 0
      ? `let ${vars.map((name) => `${name}: any`).join(", ")}; `
      : "";
  const name = moduleExportName(ir, "@mxlang/solid");
  // The return callback is not part of the author's `Input`, so a unit that
  // declares `<return>` widens its parameter with it; the caller's generated
  // `$mxReturn={...}` then type-checks against exactly the units that return.
  const inputType = ir.returnValue
    ? `Input & { ${JSON.stringify(MX_RETURN_PROP)}?: (value: unknown) => void }`
    : "Input";
  // Marko names a tag's body `content` and a template reads it as
  // `${input.content}`; a Solid component receives the same slot as
  // `props.children`, and this host emits calls that way so a hand-written
  // Solid component called from MX, and an MX tag called from plain TSX,
  // both work. A unit that reads `input.content` therefore gets `input` as a
  // lazy view over its props whose `content` is the body — an explicit
  // `content=` prop winning, else `children` — so `props.children` is left
  // untouched. Without this `<Card><p/></Card>` compiled cleanly and rendered
  // an empty card. A unit that never reads it is emitted unchanged.
  //
  // `merge` keeps `props` reactive (a spread would snapshot it), and
  // `children` resolves the body once into a memo: reading `input.content`
  // twice (`<if=input.content>` then `<${input.content}/>`) must not create
  // the body's nodes twice. A bare string or number body becomes a fragment
  // because `<${input.content}/>` lowers to a dynamic tag that reads a string
  // as a tag NAME; an empty string becomes `undefined` (renders nothing and
  // stays falsy for `<if=input.content>`). `<${tagName}/>` never comes
  // through `input.content`, so it is unaffected.
  const bodyAlias = ir.tagMetadata.readsContent;
  if (bodyAlias) {
    parts.unshift(
      `import { children as ${MX_CHILDREN_BINDING}, merge as ${MX_MERGE_BINDING} } from "solid-js";\n`,
    );
  }
  const head = bodyAlias
    ? `export default function ${name}($mxProps: ${inputType}) { const $mxBody = ${MX_CHILDREN_BINDING}(() => ($mxProps as { content?: unknown }).content ?? ($mxProps as { children?: unknown }).children); const input = ${MX_MERGE_BINDING}($mxProps, { get content() { const $mxValue = $mxBody() as unknown; return typeof $mxValue === "string" || typeof $mxValue === "number" ? $mxValue === "" ? undefined : <>{String($mxValue)}</> : $mxValue; } }) as ${inputType} & { content?: unknown }; ${varDecls}`
    : `export default function ${name}(input: ${inputType}) { ${varDecls}`;
  parts.push(
    ir.returnValue
      ? `${head}input[${JSON.stringify(
          MX_RETURN_PROP,
        )}]?.(${ir.returnValue.code}); return <>`
      : `${head}return <>`,
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
