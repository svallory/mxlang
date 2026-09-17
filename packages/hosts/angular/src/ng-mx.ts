/**
 * `.ng.mx` — an ordinary TypeScript module whose `@Component` template is MX.
 *
 * The file kind mirrors `.solid.mx` (design note A4): the parser owns region
 * discovery, this host lowers each region, and the result is spliced back
 * into the surrounding TypeScript. What differs is everything downstream of
 * the hand-off, because Angular's template is *text* rather than JSX —
 * see the divergence list in `packages/hosts/angular/README.md`.
 */

import {
  type CustomTag,
  type GeneratedMapping,
  lower,
  type MxWarning,
  type Node,
  newCtx,
  parseFragment,
  TranslateError,
} from "@mxlang/core";
import {
  type MxRegionCompile,
  type MxRegionCompileInput,
  type MxRegionCompileResult,
  type MxRegionContext,
  type MxRegionPositionCheck,
  parse,
} from "@mxlang/parser";
import MagicString from "magic-string";
import { directivesFor } from "./directives.ts";
import {
  angularDeclarations,
  emitTemplate,
  IMPORTS_ADVICE_CODE,
  type UsedTag,
} from "./emitter.ts";

/**
 * Prints a Marko-owned Babel expression node back to source text.
 *
 * Marko bundles its own Babel and these nodes belong to that instance, so its
 * generator is the one that can print them — and the export is `generator`,
 * not `generate`. `packages/core` keeps an identical private copy for its
 * whole-file path; this is the region path's, which cannot reach it.
 */
function printExpression(node: Node): string {
  const { generator } = require("@marko/compiler/internal/babel");
  return generator(node, { concise: true }).code;
}

/**
 * The message C3's position check reports for a region Angular cannot place.
 *
 * A4 divergence 2: Angular has exactly one home for a template, so unlike
 * `.solid.mx` — where a region is legal in any expression position — every
 * other position is an error rather than something to lower.
 */
export const NG_MX_POSITION_MESSAGE =
  "an MX region in a `.ng.mx` file is only valid as the `template` property of an `@Component({ … })` decorator.";

/**
 * Angular's veto on where a region may appear, as the spike's §Q4 specifies.
 *
 * All four conditions are load-bearing and none implies another:
 * `isDirectPropertyValue` carries no decorator-adjacency guarantee (a region
 * can be the unwrapped value of some property with no decorator above it at
 * all), and `argumentIndex` is what separates `@Component({ template: … })`
 * from `@Component(opts, { template: … })`, which the other three cannot see.
 */
export const ngMxPositionCheck: MxRegionPositionCheck = (
  context: MxRegionContext,
) =>
  context.isDirectPropertyValue &&
  context.propertyKey === "template" &&
  context.decoratorNames.includes("Component") &&
  context.argumentIndex === 0
    ? { ok: true }
    : { ok: false, message: NG_MX_POSITION_MESSAGE };

/**
 * Escapes an emitted Angular template for a backtick template literal.
 *
 * Decision 99 reverses A4 divergence 3's double-quoted form. The hazard that
 * ruling named is real — a template literal makes `${` a live substitution,
 * and `${` can legitimately appear in MX text — but escaping it is the same
 * text-escaping treatment this host already applies to `{`/`}`/`@`, so it is
 * neutralised rather than accepted. What settled the reversal is the mapping
 * cost of the quoted form: Angular reports template diagnostics in *escaped*
 * coordinates, so a double-quoted emit needs an escape-aware inverse at every
 * newline in every template, while a backtick emit is 1:1 (spike §Q3).
 *
 * Only two sequences are escaped, and `\` must come first or it would double
 * the backslashes the other two introduce.
 */
export function escapeTemplateLiteral(template: string): string {
  return template
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
}

/** One region's lowering, keyed by its span in the `.ng.mx` file. */
export interface NgMxRegion {
  /** The region's `[start, end)` offsets in the source file. */
  start: number;
  end: number;
  /** The tags this region's template called, in source order. */
  usedTags: UsedTag[];
  /** Identifier-level mappings from the emitted template back to the source. */
  mappings: GeneratedMapping[];
  /** Warnings the emitter produced while lowering this region. */
  warnings: MxWarning[];
}

export interface CompileNgMxOptions {
  /** Custom tags already discovered and loaded by the calling integration. */
  customTags?: Record<string, CustomTag>;
  /**
   * Collects positioned warnings. Unset, the per-region warnings are still
   * reported on each `NgMxRegion` and on the result.
   */
  warnings?: MxWarning[];
  /** The element-name prefix for an MX tag, `mx.angular.tagSelectorPrefix`. */
  tagSelectorPrefix?: string;
}

export interface CompileNgMxResult {
  /** The emitted TypeScript module. */
  code: string;
  /** A source map for the module, against the `.ng.mx` file. */
  map: ReturnType<MagicString["generateMap"]>;
  /**
   * Identifier-level mappings from each emitted template back to the source,
   * flattened across regions.
   *
   * Identifier-level only today: the Angular emitter records a mapping per
   * name, not per expression, while template type errors land almost entirely
   * on expressions (spike §Q3). Task 2.2b closes that through core's
   * `Expr.span` (C4). This is the seam for it — the shape is already right.
   */
  mappings: GeneratedMapping[];
  /** Every warning, across every region. */
  warnings: MxWarning[];
  /** Every tag called, across every region. */
  usedTags: UsedTag[];
  /** Per-region detail, in source order. */
  regions: NgMxRegion[];
}

/** What one region's lowering produced, before it is spliced into the module. */
interface LoweredRegion extends NgMxRegion {
  /** The backtick template literal replacing the region's source text. */
  literal: string;
  /** Module-level statements this region's IR hoisted out. */
  moduleStatements: string[];
  /** Angular directives the emitted template needs in `imports:`. */
  directives: string[];
  /** Imports the compiler minted for discovered tags this region called. */
  hoistedImports: Array<{
    code: string;
    binding: string;
    specifier: string;
    resolvedPath: string;
  }>;
}

/**
 * Lowers one MX region to an Angular template, as a backtick literal.
 *
 * The page emitter builds the template, exactly as `compileTagModule` does,
 * so the two output kinds cannot disagree about how a construct lowers.
 */
function lowerRegion(
  regionSource: string,
  filename: string,
  base: { baseOffset: number; baseLine: number; baseColumn: number },
  options: CompileNgMxOptions,
): LoweredRegion {
  const warnings: MxWarning[] = [];
  const usedTags: UsedTag[] = [];
  const moduleStatements: string[] = [];

  // `compileSource` is the whole-file front door and takes no base position,
  // so a region goes through `parseFragment` + `lower` instead — the same
  // path `compileSolidMx` takes, and for the same reason: every position the
  // IR carries must be relative to the `.ng.mx` file, not to the region.
  const { body } = parseFragment(regionSource, {
    filename,
    baseOffset: base.baseOffset,
    baseLine: base.baseLine,
    baseColumn: base.baseColumn,
    customTags: options.customTags,
  });

  // Two position systems read this string, exactly as in `compileSolidMx`:
  // `sliceLoc` (line/column, for `import`/`static`/`export`, whose nodes
  // carry no `start`/`end`) and an expression's own file-absolute index
  // slice. Padding out to `baseOffset` satisfies both — `baseLine` newlines
  // fix the line count, and the rest is spaces on the line before the
  // region, which leaves `sliceLoc`'s column arithmetic correct.
  const positionedSource = `${"\n".repeat(base.baseLine)}${" ".repeat(
    Math.max(base.baseOffset - base.baseLine, base.baseColumn),
  )}${regionSource}`;

  const ctx = newCtx(
    positionedSource,
    printExpression,
    angularDeclarations,
    undefined,
    filename,
  );
  ctx.customTags = options.customTags;
  ctx.warnings = warnings;

  const ir = lower(ctx, body);

  // A4 divergence 4, the functional gain of `.ng.mx` over a `.mx` page:
  // module-level MX statements are *hoisted* into the surrounding TypeScript
  // module rather than rejected. `.solid.mx` rejects them (an author there
  // has a real module to put them in); here the module is the file the
  // region already sits in, so they simply move.
  //
  // A *synthesized* import is not hoisted as text: it is the compiler's own
  // import for a discovered tag, and it reaches the surrounding module
  // through `hoistedImports`, deduped by resolved path.
  const hoistedImports: LoweredRegion["hoistedImports"] = [];
  for (const node of ir.imports) {
    if (node.synthesized) {
      const binding = node.bindings[0];
      // All three are set together where a synthesized import is minted
      // (`template-tag.ts`'s `bindingForTemplate`), so one missing is a
      // compiler bug. Failing loudly beats dropping the entry, which would
      // become an unresolved binding far from its cause.
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
      continue;
    }
    moduleStatements.push(node.code);
  }
  for (const node of ir.hoisted) moduleStatements.push(node.code);
  if (ir.inputInterface) moduleStatements.push(ir.inputInterface.code);

  const template = emitTemplate(
    {
      ...ir,
      // The emitter reads the tag-module imports to resolve each call site's
      // selector and import path; everything else was hoisted above and
      // would otherwise be rejected as module-level.
      imports: ir.imports.filter((node) => node.synthesized),
      hoisted: [],
      inputInterface: null,
    },
    ctx,
    filename,
    usedTags,
    options.tagSelectorPrefix,
    // This region *does* own a module — the author's own `.ng.mx` file —
    // which is exactly what a `.solid.mx` region cannot say.
    true,
  );

  return {
    start: base.baseOffset,
    end: base.baseOffset + regionSource.length,
    literal: `\`${escapeTemplateLiteral(template)}\``,
    moduleStatements,
    directives: directivesFor(template),
    usedTags,
    // Identifier-level today and empty in practice: the Angular emitter is a
    // string builder with no `mapped(...)` call anywhere, so there are no
    // node positions to derive mappings from yet (spike §Q3). 2.2b adds them
    // through core's `Expr.span`; the field is the seam, already the right
    // shape, so nothing downstream changes when it starts being populated.
    mappings: [],
    warnings,
    hoistedImports,
  };
}

/** One entry per tag, first occurrence winning, keyed by emitted class. */
function dedupeTags(tags: UsedTag[]): UsedTag[] {
  const seen = new Map<string, UsedTag>();
  for (const tag of tags) {
    const key = `${tag.className}\u0000${tag.specifier}`;
    if (!seen.has(key)) seen.set(key, tag);
  }
  return [...seen.values()];
}

/** The narrow slice of Babel's AST these two edits read. */
interface NgMxNode {
  type?: string;
  start?: number;
  end?: number;
  name?: string;
  key?: NgMxNode;
  value?: NgMxNode;
  computed?: boolean;
  properties?: NgMxNode[];
  elements?: NgMxNode[];
  expression?: NgMxNode;
  callee?: NgMxNode;
  arguments?: NgMxNode[];
  decorators?: NgMxNode[];
  declaration?: NgMxNode;
  local?: NgMxNode;
  body?: NgMxNode[] | NgMxNode;
  program?: { body?: NgMxNode[] };
  source?: { value?: string };
}

/** Walks every node of a Babel AST, depth first. */
function walk(node: unknown, visit: (node: NgMxNode) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.type === "string") visit(record as NgMxNode);
  for (const key of Object.keys(record)) {
    if (key === "loc" || key === "extra") continue;
    walk(record[key], visit);
  }
}

/**
 * Appends the tags a template called to its own `@Component({ imports: [...] })`.
 *
 * **A4 divergence 5, and the edit no other host performs.** Decision 95(3)
 * gives one injected import per module per tag; on Angular the injected
 * symbol must *also* reach the decorator's `imports:` array or the template
 * cannot use the component at all — a silent empty render rather than an
 * error, which is why this is done rather than warned about.
 *
 * Round 1 of the design note put this in the parser bridge, as Solid's
 * import injection is. It is owned here instead: "add an import" is generic,
 * but "mutate a specific decorator's `imports` array" is Angular semantics,
 * and `packages/parser` must stay free of it.
 */
function applyComponentImports(
  rewritten: MagicString,
  decoratorArg: NgMxNode,
  usedTags: UsedTag[],
  directives: string[],
): void {
  const symbols = [...usedTags.map((tag) => tag.className), ...directives];
  if (symbols.length === 0) return;
  if (!decoratorArg.properties) return;

  const existing = decoratorArg.properties.find(
    (property) =>
      property.type === "ObjectProperty" &&
      !property.computed &&
      property.key?.name === "imports",
  );

  if (existing?.value?.type === "ArrayExpression") {
    const array = existing.value;
    // Only the symbols the author has not already listed: a hand-maintained
    // `imports:` is the documented step-1 workflow, so a file migrating to
    // `.ng.mx` very often already names some of them.
    const already = new Set(
      (array.elements ?? [])
        .map((element) =>
          element?.type === "Identifier" ? element.name : undefined,
        )
        .filter((name): name is string => typeof name === "string"),
    );
    const missing = symbols.filter((symbol) => !already.has(symbol));
    if (missing.length === 0) return;

    const elements = array.elements ?? [];
    const last = elements[elements.length - 1];
    if (last?.end !== undefined) {
      // Appended after the last element rather than rewriting the array, so
      // an author's own formatting, comments and trailing comma survive.
      rewritten.appendLeft(last.end, `, ${missing.join(", ")}`);
      return;
    }
    // An **empty** `imports: []` has no last element to append after. It must
    // still be filled: returning early here left the array empty while the
    // hoisted `@angular/common` import was emitted anyway, so the directive
    // was imported but never declared and the binding it powers was silently
    // inert at runtime — no build error, nothing but an unused import to
    // notice. Inserted just inside the `[`.
    if (array.start === undefined) return;
    rewritten.appendLeft(array.start + 1, missing.join(", "));
    return;
  }

  if (existing) return; // an `imports:` that is not an array literal is the author's own.

  // No `imports:` at all: add one after the decorator object's first
  // property, which every `@Component` has (a selector or a template).
  const properties = decoratorArg.properties;
  const first = properties[0];
  if (first?.end === undefined) return;
  rewritten.appendLeft(first.end, `,\n  imports: [${symbols.join(", ")}]`);
}

/** The object literal of the file's `@Component(...)` decorator, if any. */
/** One `@Component({ … })` in the file, with the span of its decorator. */
interface ComponentDecorator {
  /** The decorator call's own `[start, end)`, for attributing a region. */
  start: number;
  end: number;
  /** The object literal `imports:` is read from and written to. */
  argument: NgMxNode;
}

/**
 * Every `@Component(...)` in the file, in source order.
 *
 * Plural, deliberately. Taking only the first was wrong for any file with
 * two components: the used tags and directives are computed as a *union*
 * across regions, so the second component's directives landed in the
 * first's `imports:` while its own array stayed untouched — leaving its
 * bindings silently inert with nothing to notice at build time.
 */
function findComponentDecorators(file: unknown): ComponentDecorator[] {
  const found: ComponentDecorator[] = [];
  walk(file, (node) => {
    if (node.type !== "Decorator") return;
    const call = node.expression;
    if (call?.type !== "CallExpression") return;
    if (
      call.callee?.type !== "Identifier" ||
      call.callee.name !== "Component"
    ) {
      return;
    }
    const [argument] = call.arguments ?? [];
    if (argument?.type !== "ObjectExpression") return;
    if (node.start === undefined || node.end === undefined) return;
    found.push({ start: node.start, end: node.end, argument });
  });
  return found.sort((a, b) => a.start - b.start);
}

/**
 * The decorator a region belongs to: the innermost one whose span contains
 * the region's own start.
 *
 * "Innermost" rather than "first": decorator spans do not nest in practice
 * (a decorator attaches to a declaration), but sorting by span width keeps
 * this correct rather than incidentally correct.
 */
function decoratorForRegion(
  decorators: ComponentDecorator[],
  regionStart: number,
): ComponentDecorator | undefined {
  let best: ComponentDecorator | undefined;
  for (const decorator of decorators) {
    if (regionStart < decorator.start || regionStart >= decorator.end) continue;
    if (!best || decorator.end - decorator.start < best.end - best.start) {
      best = decorator;
    }
  }
  return best;
}

/**
 * Writes a region's hoisted module-level statements into the module.
 *
 * Inserted after the module's last import, or at the top when it has none —
 * the same placement rule `packages/parser`'s `planHoistedImports` uses for
 * `.solid.mx`, so an injected statement never precedes an import the
 * author's own ordering depends on.
 */
function hoistModuleStatements(
  rewritten: MagicString,
  file: unknown,
  statements: string[],
  usedTags: UsedTag[],
  directives: string[],
): void {
  // Every identifier the author's own imports bind.
  //
  // **Both** halves below filter on this one set, by identifier *name*.
  // Filtering tag imports by module specifier instead was a real bug: an
  // authored `import { Other } from "./tags/badge"` suppressed the `Badge`
  // import while `applyComponentImports` — which filters by name — still
  // wrote `imports: [Badge]`, leaving an unresolved identifier. The name is
  // what has to be unique in the module, so the name is what to check.
  const authoredNames = new Set<string>();
  walk(file, (node) => {
    if (node.type === "ImportSpecifier" && node.local?.name) {
      authoredNames.add(node.local.name);
    }
    if (node.type === "ImportDefaultSpecifier" && node.local?.name) {
      authoredNames.add(node.local.name);
    }
    if (node.type === "ImportNamespaceSpecifier" && node.local?.name) {
      authoredNames.add(node.local.name);
    }
  });

  // A tag's import is emitted here rather than by the bridge because its
  // specifier is the *emitted module*'s path, which only this host knows.
  const tagImports = usedTags
    .filter((tag) => !authoredNames.has(tag.className))
    .map((tag) => `import { ${tag.className} } from "${tag.specifier}";`);

  // `applyComponentImports` puts every needed directive in the decorator's
  // `imports:` array; without the matching `import` statement those are
  // unresolved identifiers and the emitted module does not compile.
  const missingDirectives = directives.filter(
    (symbol) => !authoredNames.has(symbol),
  );
  const directiveImport =
    missingDirectives.length > 0
      ? [`import { ${missingDirectives.join(", ")} } from "@angular/common";`]
      : [];

  const lines = [...directiveImport, ...tagImports, ...statements];
  if (lines.length === 0) return;

  let insertAt = 0;
  walk(file, (node) => {
    if (node.type === "ImportDeclaration" && node.end !== undefined) {
      insertAt = Math.max(insertAt, node.end);
    }
  });
  // After the last import's own newline, or at offset 0 when there is none.
  const text = `${lines.join("\n")}\n`;
  rewritten.appendLeft(insertAt, insertAt === 0 ? text : `\n${text.trimEnd()}`);
}

/**
 * Compiles a `.ng.mx` file to an Angular component module.
 *
 * The file stays an ordinary TypeScript module: the parser finds each MX
 * region, `mxRegionCompile` lowers it here, and the emitted template replaces
 * the region in place. Three things then happen that `.solid.mx` does not do,
 * each an A4 divergence — module-level MX statements are *hoisted* into the
 * surrounding module rather than rejected (divergence 4), the used tags are
 * appended to the decorator's own `imports:` array (divergence 5), and the
 * template is emitted as text rather than JSX (divergence 1).
 */
export function compileNgMx(
  source: string,
  filename: string,
  options: CompileNgMxOptions = {},
): CompileNgMxResult {
  const lowered: LoweredRegion[] = [];

  // The hook the parser bridge calls for each region it finds. It returns
  // only the three fields the bridge itself consumes; everything Angular
  // needs downstream (the template's mappings, warnings and used tags) is
  // collected here, keyed by the region's own span, because the parser has
  // no use for it and must not grow a dependency on its shape.
  //
  // `input` is annotated rather than inferred from `MxRegionCompile`: until
  // the parser's `public.d.ts` stops re-exporting its region types through a
  // relative path inside an ambient `declare module` block (TS2439, which
  // every consumer's `skipLibCheck: true` hides), those names resolve to
  // `any` here and the parameter would be implicitly `any` under
  // `noImplicitAny`. The fix is landing in the parser; the annotation is
  // correct either way and can stay.
  const regionCompile: MxRegionCompile = (input: MxRegionCompileInput) => {
    const region = lowerRegion(input.source, filename, input, options);
    lowered.push(region);
    return {
      // The region's *expression* is the template literal: the bridge parses
      // this back and splices it where the region stood, so the decorator's
      // `template:` property ends up holding an ordinary string expression.
      code: region.literal,
      hoistedImports: region.hoistedImports,
      returnVars: [],
    } satisfies MxRegionCompileResult;
  };

  // `mx: true` because a `.ng.mx` filename never matches the parser's own
  // `.solid.mx` extension test, so without it the grammar stays off and no
  // region is ever discovered.
  const file = parse(source, filename, {
    mx: true,
    // `decorators` is not optional for this file kind: the one legal place
    // for a region is `@Component({ template: … })`, so a `.ng.mx` file
    // *always* has a decorator and the parser's default plugin set
    // (`["typescript", "jsx"]`) cannot read it. Angular uses the modern
    // proposal, not `decorators-legacy`.
    plugins: ["typescript", "jsx", "decorators"],
    mxRegionCompile: regionCompile,
    mxRegionPositionCheck: ngMxPositionCheck,
    mxCustomTags: options.customTags,
  });

  lowered.sort((a, b) => a.start - b.start);

  const rewritten = new MagicString(source);
  for (const region of lowered) {
    rewritten.overwrite(region.start, region.end, region.literal);
  }

  const usedTags = dedupeTags(lowered.flatMap((region) => region.usedTags));
  const directives = [
    ...new Set(lowered.flatMap((region) => region.directives)),
  ];

  // `imports:` is edited **per component**, from the regions that decorator
  // actually encloses — not from the file-wide union. A file with two
  // components otherwise gave the first one the second's directives, and
  // left the second's own array untouched.
  //
  // The module-level imports below stay file-wide, because that is what
  // module scope is: one `import` serves every component in the file.
  const decorators = findComponentDecorators(file);
  for (const decorator of decorators) {
    const mine = lowered.filter(
      (region) => decoratorForRegion(decorators, region.start) === decorator,
    );
    if (mine.length === 0) continue;
    applyComponentImports(
      rewritten,
      decorator.argument,
      dedupeTags(mine.flatMap((region) => region.usedTags)),
      [...new Set(mine.flatMap((region) => region.directives))],
    );
  }
  hoistModuleStatements(
    rewritten,
    file,
    lowered.flatMap((region) => region.moduleStatements),
    usedTags,
    directives,
  );

  // Every "add X to the component's imports" warning is dropped here, and
  // only here. Those are step-1 advice: a `.mx` page cannot edit the
  // author's TypeScript, so the emitter tells them to do it by hand. A
  // `.ng.mx` *does* edit it — `applyComponentImports` and
  // `hoistModuleStatements` above just added both the `imports:` entry and
  // its `import` statement — so repeating the instruction would tell the
  // author to fix something MX already did, and adding the symbol a second
  // time is a duplicate-identifier error.
  const warnings = lowered
    .flatMap((region) => region.warnings)
    .filter(
      (warning) => (warning as { code?: string }).code !== IMPORTS_ADVICE_CODE,
    );
  if (options.warnings) options.warnings.push(...warnings);

  return {
    code: rewritten.toString(),
    map: rewritten.generateMap({
      file: filename,
      source: filename,
      includeContent: true,
      hires: true,
    }),
    mappings: lowered.flatMap((region) => region.mappings),
    warnings,
    usedTags,
    regions: lowered.map(
      ({ start, end, usedTags: tags, mappings, warnings: regionWarnings }) => ({
        start,
        end,
        usedTags: tags,
        mappings,
        warnings: regionWarnings,
      }),
    ),
  };
}
