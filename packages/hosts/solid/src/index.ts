import generate from "@babel/generator";
import { parse as parseBabel } from "@babel/parser";
import {
  type CustomTag,
  type GeneratedMapping,
  lower,
  moduleExportName,
  type Node,
  newCtx,
  parseFragment,
  TranslateError,
} from "@mxlang/core";
import MagicString from "magic-string";
import {
  createEmitter,
  emitSolid,
  emitSolidWithMappings,
  SolidEmitter,
  solidDeclarations,
} from "./emitter.ts";

export {
  createEmitter,
  emitSolid,
  emitSolidWithMappings,
  SolidEmitter,
  solidDeclarations,
};

export interface CompileSolidMxOptions {
  filename: string;
  /** File-relative position of this region; used by the parser bridge. */
  baseOffset?: number;
  baseLine?: number;
  baseColumn?: number;
  /** Custom tags already discovered and loaded by the calling integration. */
  customTags?: Record<string, CustomTag>;
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

/**
 * `@babel/generator` ships as CJS with an interop default; under
 * `esModuleInterop` the namespace can arrive as either the function itself or
 * a `{ default }` wrapper depending on the loader. Normalize once.
 */
const generator = (
  typeof generate === "function"
    ? generate
    : (generate as { default: typeof generate }).default
) as typeof generate;

function generateExpression(node: Node): string {
  return generator(node, { concise: true }).code;
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
  // A `baseLine` newlines + `baseColumn` spaces prefix satisfies the first but
  // is far shorter than `baseOffset`, so an absolute-index slice against it
  // silently returns "" (measured: `value=count()` printed as `value={}` for
  // any region after the file's first line). Padding out to `baseOffset`
  // exactly satisfies both: `baseLine` newlines fix the line count, and the
  // remaining fill is spaces on the line before `source`, which still leaves
  // `sliceLoc`'s `.slice(start.column, end.column)` correct (it reads only
  // from `start.column` onward, so extra padding before that column is inert).
  const baseLine = options.baseLine ?? 0;
  const baseColumn = options.baseColumn ?? 0;
  const positionedSource = `${"\n".repeat(baseLine)}${" ".repeat(Math.max(baseOffset - baseLine, baseColumn))}${source}`;
  const ctx = newCtx(
    positionedSource,
    generateExpression,
    solidDeclarations,
    undefined,
    options.filename,
  );
  ctx.customTags = options.customTags;
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
  const emitted = emitSolidWithMappings(ir);
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
): { code: string } {
  const { body } = parseFragment(source, {
    filename: options.filename,
    customTags: options.customTags,
  });
  repairEmbeddedTsx(body);
  const ctx = newCtx(
    source,
    generateExpression,
    solidDeclarations,
    undefined,
    options.filename,
  );
  ctx.customTags = options.customTags;
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

  const lines: string[] = [];
  for (const node of ir.imports) lines.push(node.code);
  for (const node of ir.hoisted) lines.push(node.code);
  // `export interface Input` is deliberately not emitted. Solid's own
  // compiler takes source text and has no TypeScript frontend — the caller
  // is stripped before it ever sees it — so a type declaration here is a
  // syntax error downstream, not a contract the emitted module can carry.
  // Typing a tag unit's props is phase 3's job, through the same virtual-file
  // projection the TypeScript plugin already does for `.solid.mx`.
  // Named after the file, never anonymous: a tag whose template calls its own
  // name resolves to this declaration, so self-recursion needs no self-import
  // (design invariant §7.5-7).
  lines.push(
    `export default function ${moduleExportName(ir, "@mxlang/solid")}(input) { return <>${emitSolid(ir)}</>; }`,
  );
  return { code: lines.join("\n") };
}
