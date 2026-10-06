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
  type Ir,
  lower,
  type MxWarning,
  newCtx,
  parseFragment,
  positionRegionSource,
  printExpression,
  resolveSpecifier,
  type TargetLookup,
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
  EVENT_HELPER_ADVICE_CODE,
  EVENT_HELPER_MARKER,
  EVENT_HELPER_MEMBERS,
  EVENT_HELPER_NAMES,
  emitTemplate,
  IMPORTS_ADVICE_CODE,
  RUNTIME_SPECIFIER,
  type UsedTag,
} from "./emitter.ts";
import {
  type AngularMapping,
  type NodeAnchor,
  offsetAnchors,
  offsetMappings,
  rebaseAnchorsThroughEscaping,
  rebaseThroughEscaping,
} from "./mapping.ts";
import { angularOwnTargets } from "./own-targets.ts";
import { withStructuralAttrHint } from "./structural-attr-hint.ts";

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
 * The same veto for a fragment `<>…</>`. In a `.ng.mx` file a fragment is MX
 * syntax (`mxRegionFragment`), not TSX, and Angular has one place for it: as
 * the root of a `template:` region. Before fragments were regions, `<></>`
 * elsewhere parsed as TSX and was emitted as raw `<>`, invalid TypeScript;
 * this makes it an error that says why.
 */
export const NG_MX_FRAGMENT_POSITION_MESSAGE =
  "in a `.ng.mx` file a fragment `<>…</>` is only allowed as the root of the `template:` region of an `@Component({ … })` decorator.";

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
    : {
        ok: false,
        message: context.fragment
          ? NG_MX_FRAGMENT_POSITION_MESSAGE
          : NG_MX_POSITION_MESSAGE,
      };

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

/**
 * A problem with one authored import, found while lowering a region that has
 * no source position for it. `compileNgMx` re-throws it at the import's own
 * line and column once the module AST is available.
 */
class AuthoredImportError extends Error {
  constructor(
    readonly local: string,
    message: string,
  ) {
    super(message);
  }
}

const MIXED_IMPORT_MESSAGE =
  'an authored `.mx` tag import must be a sole default import (`import A from "./x.mx"`); import other names in a separate statement, or use the discovered `<kebab-name/>` spelling.';
const MARKO_TAG_MESSAGE =
  "a `.marko` component cannot be used as a tag in an Angular `.ng.mx` module: it is not an Angular component. Use an MX tag file (`.mx`) instead, imported with a sole default import or through the discovered `<kebab-name/>` spelling.";

/** One region's lowering, keyed by its span in the `.ng.mx` file. */
export interface NgMxRegion {
  /** The region's `[start, end)` offsets in the source file. */
  start: number;
  end: number;
  /**
   * The `[generatedStart, generatedEnd)` offsets of the region's template
   * literal in the emitted module (`CompileNgMxResult.code`). A diagnostic
   * tool uses it to find the region an emitted-module offset falls in when
   * no mapping covers that offset.
   */
  generatedStart: number;
  generatedEnd: number;
  /** The tags this region's template called, in source order. */
  usedTags: UsedTag[];
  /** Identifier-level mappings from the emitted template back to the source. */
  mappings: AngularMapping[];
  /** Start-tag and attribute anchors; see {@link NodeAnchor}. */
  anchors: NodeAnchor[];
  /** Warnings the emitter produced while lowering this region. */
  warnings: MxWarning[];
}

export interface CompileNgMxOptions {
  /** Custom tags already discovered and loaded by the calling integration. */
  customTags?: Record<string, CustomTag>;
  /** `package.json#mx.angular-template.defaultTag`, already validated (decision 145). */
  defaultTag?: string;
  /**
   * Collects positioned warnings. Unset, the per-region warnings are still
   * reported on each `NgMxRegion` and on the result.
   */
  warnings?: MxWarning[];
  /** The element-name prefix for an MX tag, `mx.angular.tagSelectorPrefix`. */
  tagSelectorPrefix?: string;
  /**
   * The registered targets this compile runs under (decisions 129 and 132).
   * Defaults to this package's own descriptor, which is right for a direct
   * entry; a tool compiling several targets passes the built-in registry's
   * lookup, so a callee importing `AttrTag` from another registered target's
   * package reads the same as it does today.
   */
  targets?: TargetLookup;
}

export interface CompileNgMxResult {
  /** The emitted TypeScript module. */
  code: string;
  /** A source map for the module, against the `.ng.mx` file. */
  map: ReturnType<MagicString["generateMap"]>;
  /**
   * Module-absolute mappings from each emitted template back to the source,
   * flattened across regions: one whole-to-whole span per source-derived
   * expression (`user.name.toUpperCase()`, `a.b > 2`), not per identifier.
   * The module text outside the regions is not covered here; it maps through
   * {@link CompileNgMxResult.map}.
   */
  mappings: AngularMapping[];
  /**
   * Module-absolute start-tag and attribute anchors, flattened across
   * regions: where an element- or attribute-level Angular diagnostic (NG8001,
   * NG8002), which starts at generated punctuation no mapping covers,
   * resolves to in the source.
   */
  anchors: NodeAnchor[];
  /** Every warning, across every region. */
  warnings: MxWarning[];
  /** Every tag called, across every region. */
  usedTags: UsedTag[];
  /** Per-region detail, in source order. */
  regions: NgMxRegion[];
}

/** What one region's lowering produced, before it is spliced into the module. */
interface LoweredRegion
  extends Omit<NgMxRegion, "generatedStart" | "generatedEnd"> {
  /** The backtick template literal replacing the region's source text. */
  literal: string;
  /** Module-level statements this region's IR hoisted out. */
  moduleStatements: string[];
  /** Angular directives the emitted template needs in `imports:`. */
  directives: string[];
  /** The module's own `.mx` default imports visible to this region. */
  authoredTagImports: Array<{ local: string }>;
  /** Imports the compiler minted for discovered tags this region called. */
  hoistedImports: Array<{
    code: string;
    binding: string;
    specifier: string;
    resolvedPath: string;
  }>;
}

/** What stands in for a fragment's `<>` while `parseFragment` reads it. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: MX dynamic-tag syntax
const FRAGMENT_WRAPPER_OPEN = "<${0}>";

/** The children of the wrapper node `lowerRegion` put around a fragment. */
type FragmentBody = ReturnType<typeof parseFragment>["body"];

function unwrapFragment(body: FragmentBody, filename: string): FragmentBody {
  const [wrapper] = body as Array<{ body?: { body?: FragmentBody } }>;
  if (body.length !== 1 || !Array.isArray(wrapper?.body?.body)) {
    throw new Error(
      `@mxlang/angular internal: a fragment region did not parse to one wrapper node in ${filename}`,
    );
  }
  return wrapper.body.body;
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
  base: MxRegionCompileInput,
  options: CompileNgMxOptions,
): LoweredRegion {
  const warnings: MxWarning[] = [];
  const usedTags: UsedTag[] = [];
  const moduleStatements: string[] = [];

  // `compileSource` is the whole-file front door and takes no base position,
  // so a region goes through `parseFragment` + `lower` instead — the same
  // path `compileSolidMx` takes, and for the same reason: every position the
  // IR carries must be relative to the `.ng.mx` file, not to the region.
  //
  // A fragment region (`<>…</>`) hands over its children, which Marko would
  // read in concise mode when they open with text (`hello` is a tag there).
  // Wrapping them forces HTML mode. The wrapper is a *dynamic* tag,
  // `<${0}>…</>`, so that no project tag can be confused with it: a tag's
  // parse options (`text`, `preserveWhitespace`, `openTagOnly`) are looked up
  // by its static name in the taglib built from `customTags`, and a dynamic
  // name has none. It is also unwrapped by position, not name — the single
  // top-level node the parse returns — and anything else is an internal error.
  //
  // Composition with `parseFragment`'s padding contract (`FragmentBase`): it
  // adds `baseOffset` to every index, and `baseColumn` to a column only on
  // the fragment's *first line*, later lines starting at their own column 0.
  // The wrapper's `FRAGMENT_WRAPPER_OPEN` characters precede the children on
  // that first line, so the children sit that much later than they do in the
  // file. `positionRegionSource` owns the correction: `parseBase` is the
  // file's base minus the wrapper (index and first-line column), `padded`
  // describes the file itself (the `Ctx` source, without the wrapper), so the
  // two position systems agree by construction, not by a formula kept in step
  // by hand.
  const fragment = base.fragment === true;
  const { padded: positionedSource, base: parseBase } = positionRegionSource(
    regionSource,
    base,
    { wrapper: fragment ? FRAGMENT_WRAPPER_OPEN.length : 0, filename },
  );
  const parsed = parseFragment(
    fragment ? `${FRAGMENT_WRAPPER_OPEN}${regionSource}</>` : regionSource,
    { filename, ...parseBase, customTags: options.customTags },
  );
  const body = fragment ? unwrapFragment(parsed.body, filename) : parsed.body;

  const ctx = newCtx(
    positionedSource,
    printExpression,
    angularDeclarations,
    undefined,
    filename,
    options.targets ?? angularOwnTargets,
  );
  ctx.customTags = options.customTags;
  ctx.defaultTag = options.defaultTag;
  ctx.warnings = warnings;
  // Seed the module's own bindings exactly as `compileSolidMx` does, so a
  // capitalized tag bound by the surrounding module (an authored
  // `import Badge from "./tags/badge.mx"`) resolves instead of hitting
  // Marko's "Unable to find entry point" (LiUNA gap G7).
  //
  // A `.marko` import is deliberately not seeded: a Marko component is not an
  // Angular component, so the tag keeps the unresolved-tag error (upgraded
  // below to a message that says why).
  const specifiers = base.importSpecifiers ?? new Map<string, string>();
  const markoLocals = new Set(
    [...specifiers].filter(([, s]) => s.endsWith(".marko")).map(([n]) => n),
  );
  for (const [name, specifier] of specifiers) {
    if (markoLocals.has(name)) continue;
    ctx.importSpecifiers.set(name, specifier);
    ctx.imports.add(name);
  }
  for (const name of base.moduleBindings ?? []) {
    if (!markoLocals.has(name)) ctx.imports.add(name);
  }
  for (const [name, site] of base.importSites ?? []) {
    if (ctx.importSpecifiers.has(name)) {
      ctx.bindingSites.set(name, { kind: "imported", ...site });
    }
  }
  for (const name of base.unknownModuleBindings ?? []) {
    if (!markoLocals.has(name)) ctx.unknownLocalValue.add(name);
  }
  for (const name of base.importDefaultFromMarkoOrMx ?? []) {
    if (specifiers.get(name)?.endsWith(".mx")) {
      ctx.importDefaultFromMarkoOrMx.add(name);
    }
  }

  let ir: ReturnType<typeof lower>;
  try {
    // A `*ngIf="…"` after another attribute fails in `lower` with Marko's
    // message about an assignment; the hint names the cause.
    ir = withStructuralAttrHint(positionedSource, () => lower(ctx, body));
  } catch (error) {
    const tag = /Unable to find entry point for custom tag `<([^>]+)>`/.exec(
      (error as Error).message,
    )?.[1];
    if (tag && markoLocals.has(tag)) {
      throw new AuthoredImportError(tag, MARKO_TAG_MESSAGE);
    }
    throw error;
  }

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
  if (ir.needsAttrTagImport) {
    moduleStatements.push('import type { AttrTag } from "@mxlang/angular";');
  }
  if (ir.inputInterface) moduleStatements.push(ir.inputInterface.code);

  // The author's own `.mx` default imports live in the surrounding module,
  // not in the region, so the IR never carries them. They are handed to the
  // emitter as imports (its constructor already resolves an authored `.mx`
  // import to the same selector, class and path a discovered tag gets), and
  // reported back so `compileNgMx` can rewrite the module's own line.
  const authoredTagImports: LoweredRegion["authoredTagImports"] = [];
  const authoredImportNodes: Ir["imports"] = [];
  const unresolved = new Map<string, string>();
  for (const name of base.importDefaultFromMarkoOrMx ?? []) {
    const specifier = base.importSpecifiers?.get(name);
    if (!specifier?.endsWith(".mx")) continue;
    authoredTagImports.push({ local: name });
    // An unresolvable path is an error only if the import is called as a
    // tag; the emitter would reject it eagerly, so it is withheld here and
    // checked against the tags actually used below.
    if (
      !resolveSpecifier(specifier, {
        importer: filename,
        targets: options.targets ?? angularOwnTargets,
      })
    ) {
      unresolved.set(name, specifier);
      continue;
    }
    authoredImportNodes.push({
      kind: "Import",
      code: `import ${name} from ${JSON.stringify(specifier)};`,
      bindings: [name],
      loc: { line: base.baseLine + 1, column: base.baseColumn, file: filename },
      end: { line: base.baseLine + 1, column: base.baseColumn, file: filename },
    } as Ir["imports"][number]);
  }

  const templateMappings: AngularMapping[] = [];
  const templateAnchors: NodeAnchor[] = [];
  const template = emitTemplate(
    {
      ...ir,
      // The emitter reads the tag-module imports to resolve each call site's
      // selector and import path; everything else was hoisted above and
      // would otherwise be rejected as module-level.
      imports: [
        ...ir.imports.filter((node) => node.synthesized),
        ...authoredImportNodes,
      ],
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
    templateMappings,
    templateAnchors,
  );

  // An authored import called as a tag is referenced by its own local name
  // (`imports: [Chip]`), and an unresolvable one is an error at the import.
  const authoredLocals = new Set(authoredTagImports.map((i) => i.local));
  for (const tag of usedTags) {
    if (!authoredLocals.has(tag.name)) continue;
    const missing = unresolved.get(tag.name);
    if (missing !== undefined) {
      throw new AuthoredImportError(
        tag.name,
        `cannot resolve \`${missing}\` to read its \`export const selector\`; check the import path.`,
      );
    }
    tag.local = tag.name;
  }

  return {
    // A fragment region replaces its `<>` (2 characters) and `</>` (3) too.
    start: base.baseOffset - (fragment ? 2 : 0),
    end: base.baseOffset + regionSource.length + (fragment ? 3 : 0),
    literal: `\`${escapeTemplateLiteral(template)}\``,
    moduleStatements,
    directives: directivesFor(template),
    usedTags,
    // Real mappings since 2.2b, from core's `Expr.span` (C4) through the
    // emitter's own span recording.
    //
    // Offsets are relative to this region's **literal**, not to the module:
    // the module's text is not built until every region has been spliced and
    // the hoisted statements inserted, and each insertion shifts everything
    // after it. `compileNgMx` rebases these onto the finished module once it
    // knows where each literal landed.
    //
    // The +1 skips the opening backtick, and the escaping is the template
    // literal's own (`\``, `\${`, `\\`): a run containing any of those
    // occupies more bytes escaped than raw, so it is dropped rather than
    // mapped to bytes it does not cover. The `\${` case is a 2-char escape —
    // `$` gains its backslash only when `{` follows — so the escaper is
    // given the lookahead rather than `escapeTemplateLiteral` per character.
    mappings: rebaseThroughEscaping(
      template,
      templateMappings,
      1,
      escapeForLiteral,
    ),
    // Anchors take the same literal-relative offsets and escaping as the
    // mappings, but are kept when their extent contains an escaped character.
    anchors: rebaseAnchorsThroughEscaping(
      template,
      templateAnchors,
      1,
      escapeForLiteral,
    ),
    warnings,
    hoistedImports,
    authoredTagImports,
  };
}

/**
 * One character's form inside the emitted backtick literal. `$` is escaped
 * only when `{` follows, so the escaper is given the lookahead rather than
 * `escapeTemplateLiteral` per character.
 */
const escapeForLiteral = (char: string, next: string | undefined): string =>
  char === "$" && next === "{" ? "\\$" : escapeTemplateLiteral(char);

/** One entry per tag, first occurrence winning, keyed by emitted class. */
function dedupeTags(tags: UsedTag[]): UsedTag[] {
  // Class identity is the key (emitted class + module), not the local name.
  // An authored import's alias wins over the discovered spelling of the same
  // class, so the class is listed once and only under a name the module
  // actually imports.
  const seen = new Map<string, UsedTag>();
  for (const tag of tags) {
    const key = `${tag.className}\u0000${tag.specifier}`;
    const existing = seen.get(key);
    if (!existing || (!existing.local && tag.local)) seen.set(key, tag);
  }
  return [...seen.values()];
}

/** The identifier a tag is referenced by in `imports:`. */
function symbolOf(tag: UsedTag): string {
  return tag.local ?? tag.className;
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
  superClass?: NgMxNode;
  declaration?: NgMxNode;
  local?: NgMxNode;
  imported?: NgMxNode;
  specifiers?: NgMxNode[];
  object?: NgMxNode;
  property?: NgMxNode;
  id?: NgMxNode | null;
  body?: NgMxNode[] | NgMxNode;
  program?: { body?: NgMxNode[]; directives?: NgMxNode[] };
  comments?: NgMxNode[];
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
  const symbols = [...usedTags.map(symbolOf), ...directives];
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

/**
 * Replaces the author's `import Badge from "./tags/badge.mx"` with the named
 * class import the discovered spelling of the same tag gets.
 *
 * The `.mx` file itself is not importable from TypeScript; the class lives in
 * the generated sibling `.ts` (`./tags/badge`). Only an import some region
 * actually called as a tag is rewritten, and only when the default binding is
 * the declaration's sole specifier — anything else is the author's own to
 * keep. The alias is written only when the local name differs from the class,
 * so the author's other references to the binding still resolve; the
 * class's own un-aliased import, when needed, comes from
 * `hoistModuleStatements`.
 */
function rewriteAuthoredTagImports(
  rewritten: MagicString,
  file: unknown,
  source: string,
  filename: string,
  regions: readonly LoweredRegion[],
  listedLocals: ReadonlySet<string>,
): void {
  const called = new Map<string, UsedTag>();
  for (const region of regions) {
    for (const tag of region.usedTags) {
      if (tag.local) called.set(tag.local, tag);
    }
  }
  if (called.size === 0) return;
  walk(file, (node) => {
    if (node.type !== "ImportDeclaration") return;
    if (!node.source?.value?.endsWith(".mx")) return;
    if (node.start === undefined || node.end === undefined) return;
    const specifiers = node.specifiers ?? [];
    const defaultSpecifier = specifiers.find(
      (specifier) => specifier.type === "ImportDefaultSpecifier",
    );
    const tag = called.get(defaultSpecifier?.local?.name ?? "");
    if (!tag) return;
    if (specifiers.length > 1) {
      throw importError(source, filename, node.start, MIXED_IMPORT_MESSAGE);
    }
    const local = defaultSpecifier?.local?.name as string;
    // A second alias of a class another alias already lists is named in no
    // `imports:` array, so its import would be unused (TS6133 under
    // `noUnusedLocals`). It is dropped — unless the author's own TypeScript
    // still reads the name, in which case the aliased import stays.
    if (!listedLocals.has(local) && !isReferencedElsewhere(file, local)) {
      removeImportLine(rewritten, source, node.start, node.end);
      return;
    }
    const binding =
      local === tag.className ? local : `${tag.className} as ${local}`;
    rewritten.overwrite(
      node.start,
      node.end,
      `import { ${binding} } from "${tag.specifier}";`,
    );
  });
}

/** A Babel node as this file's scope walk reads it: any field by name. */
type ScopeNode = Record<string, unknown> & { type: string };

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
  "TSDeclareFunction",
  "TSDeclareMethod",
]);

const isNode = (value: unknown): value is ScopeNode =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string";

/** Every identifier a binding pattern (`a`, `{ a, b: [c] }`, `a = 1`, `...r`) declares. */
function patternNames(pattern: unknown, out: string[] = []): string[] {
  if (!isNode(pattern)) return out;
  switch (pattern.type) {
    case "Identifier":
      out.push(pattern.name as string);
      break;
    case "ObjectPattern":
      for (const property of pattern.properties as unknown[]) {
        patternNames(
          isNode(property) && property.type === "ObjectProperty"
            ? property.value
            : property,
          out,
        );
      }
      break;
    case "ArrayPattern":
      for (const element of pattern.elements as unknown[]) {
        patternNames(element, out);
      }
      break;
    case "AssignmentPattern":
      patternNames(pattern.left, out);
      break;
    case "RestElement":
      patternNames(pattern.argument, out);
      break;
    case "TSParameterProperty":
      patternNames(pattern.parameter, out);
      break;
  }
  return out;
}

/** Names a statement list declares in its own lexical scope. */
function lexicalNames(statements: unknown): string[] {
  const out: string[] = [];
  for (const statement of Array.isArray(statements) ? statements : []) {
    if (!isNode(statement)) continue;
    const declaration =
      (statement.type === "ExportNamedDeclaration" ||
        statement.type === "ExportDefaultDeclaration") &&
      isNode(statement.declaration)
        ? statement.declaration
        : statement;
    if (
      declaration.type === "VariableDeclaration" &&
      declaration.kind !== "var"
    ) {
      for (const d of declaration.declarations as ScopeNode[]) {
        patternNames(d.id, out);
      }
    } else if (
      declaration.type === "ClassDeclaration" ||
      declaration.type === "FunctionDeclaration" ||
      declaration.type === "TSEnumDeclaration"
    ) {
      patternNames(declaration.id, out);
    }
  }
  return out;
}

/** Names `var` declares anywhere in a function body, not crossing into nested functions. */
function varNames(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) varNames(item, out);
    return out;
  }
  if (!isNode(node) || FUNCTION_TYPES.has(node.type)) return out;
  if (node.type === "VariableDeclaration" && node.kind === "var") {
    for (const d of node.declarations as ScopeNode[]) patternNames(d.id, out);
  }
  for (const [key, child] of Object.entries(node)) {
    if (key !== "loc" && key !== "extra") varNames(child, out);
  }
  return out;
}

/** Whether `node` opens a scope in which `name` is declared afresh. */
function scopeDeclares(node: ScopeNode, name: string): boolean {
  if (FUNCTION_TYPES.has(node.type)) {
    const names: string[] = [];
    for (const param of (node.params as unknown[]) ?? []) {
      patternNames(param, names);
    }
    if (node.type === "FunctionExpression") patternNames(node.id, names);
    const body = node.body;
    if (isNode(body) && body.type === "BlockStatement") {
      varNames(body.body, names);
    }
    return names.includes(name);
  }
  switch (node.type) {
    case "BlockStatement":
    case "StaticBlock":
      return lexicalNames(node.body).includes(name);
    case "SwitchStatement":
      return (node.cases as ScopeNode[]).some((c) =>
        lexicalNames(c.consequent).includes(name),
      );
    case "CatchClause":
      return patternNames(node.param).includes(name);
    case "ClassExpression":
      return patternNames(node.id).includes(name);
    case "ForStatement":
      return lexicalNames([node.init]).includes(name);
    case "ForInStatement":
    case "ForOfStatement":
      return lexicalNames([node.left]).includes(name);
    default:
      return false;
  }
}

const COMPUTABLE_KEY_PARENTS = new Set([
  "ObjectProperty",
  "ObjectMethod",
  "ClassProperty",
  "ClassMethod",
  "ClassPrivateProperty",
  "ClassPrivateMethod",
  "ClassAccessorProperty",
  "TSPropertySignature",
  "TSMethodSignature",
]);

/** Whether an identifier at `parent[key]` is a read of a binding (not a name). */
function isReadPosition(parent: ScopeNode | undefined, key: string): boolean {
  if (!parent) return true;
  switch (parent.type) {
    case "MemberExpression":
    case "OptionalMemberExpression":
      return key !== "property" || parent.computed === true;
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
    case "MetaProperty":
    case "TSEnumMember":
    case "TSNamedTupleMember":
    case "TSTypePredicate":
    case "TSImportEqualsDeclaration":
    case "TSDeclareFunction":
      return false;
    case "ExportSpecifier":
      return key === "local";
    case "TSQualifiedName":
      return key !== "right";
  }
  if (COMPUTABLE_KEY_PARENTS.has(parent.type) && key === "key") {
    return parent.computed === true;
  }
  return true;
}

/** Whether `parent[key]` holds a binding pattern, whose identifiers declare rather than read. */
function isPatternSlot(parent: ScopeNode, key: string): boolean {
  if (FUNCTION_TYPES.has(parent.type)) return key === "params" || key === "id";
  switch (parent.type) {
    case "VariableDeclarator":
      return key === "id";
    case "CatchClause":
      return key === "param";
    case "ClassDeclaration":
    case "ClassExpression":
      return key === "id";
    case "AssignmentExpression":
      return key === "left";
    default:
      return false;
  }
}

/**
 * Whether the module-scope binding `name` is read anywhere: a scope-aware
 * walk of the Babel AST. A property key (`{ name: 1 }`), a member name
 * (`o.name`), an object-pattern key, and a shadowing binding in a nested
 * scope (a parameter, a `let`/`const`/`var`/`class`/`function`, a `catch`
 * parameter) are not reads of the import. A type-position use
 * (`typeof name`, `x: name`) is one, since the import still serves it.
 *
 * Hand-rolled rather than `@babel/traverse`, which this public package does
 * not depend on and its build would bundle into `dist/` — the same choice
 * `packages/hosts/solid/src/emitter.ts`'s `freeJsxNames` (line 257) makes.
 * Coarse in the safe direction: anything it cannot classify counts as a
 * read, which keeps an import rather than dropping one the module uses.
 */
function isReferencedElsewhere(file: unknown, name: string): boolean {
  let found = false;
  const visit = (
    node: unknown,
    parent: ScopeNode | undefined,
    key: string,
    shadowed: boolean,
    pattern: boolean,
  ): void => {
    if (found) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, parent, key, shadowed, pattern);
      return;
    }
    if (!isNode(node) || node.type === "ImportDeclaration") return;
    if (node.type === "Identifier") {
      if (
        !shadowed &&
        !pattern &&
        node.name === name &&
        isReadPosition(parent, key)
      ) {
        found = true;
      }
      // A binding identifier carries its own type annotation
      // (`const t: typeof Pill`), which is a use like any other.
      visit(node.typeAnnotation, node, "typeAnnotation", shadowed, false);
      return;
    }
    const inner = shadowed || scopeDeclares(node, name);
    for (const [childKey, child] of Object.entries(node)) {
      if (childKey === "loc" || childKey === "extra") continue;
      const computedKey = childKey === "key" && node.computed === true;
      const childPattern =
        !computedKey &&
        ((pattern &&
          !(node.type === "AssignmentPattern" && childKey === "right")) ||
          isPatternSlot(node, childKey));
      visit(child, node, childKey, inner, childPattern);
    }
  };
  visit((file as { program?: unknown }).program, undefined, "", false, false);
  return found;
}

/**
 * Removes the import at `[start, end)`. When it owns its line the whole line
 * goes, newline included; when other text shares the line only the statement
 * (and the space after it) goes, so the next statement is never joined onto
 * the previous line.
 */
function removeImportLine(
  rewritten: MagicString,
  source: string,
  start: number,
  end: number,
): void {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const eol = source.indexOf("\n", end);
  const lineEnd = eol === -1 ? source.length : eol;
  const ownsLine =
    source.slice(lineStart, start).trim() === "" &&
    source.slice(end, lineEnd).trim() === "";
  if (ownsLine) {
    rewritten.remove(lineStart, eol === -1 ? lineEnd : lineEnd + 1);
    return;
  }
  let stop = end;
  while (source[stop] === " " || source[stop] === "\t") stop++;
  rewritten.remove(start, stop);
}

/** A `TranslateError` at the start of the import declaration at `offset`. */
function importError(
  source: string,
  filename: string,
  offset: number,
  message: string,
): TranslateError {
  const { line, column } = positionAt(source, offset);
  return new TranslateError(message, line, column, filename);
}

/** Re-throws an `AuthoredImportError` at the import that binds its local. */
function throwAtImport(
  file: unknown,
  source: string,
  filename: string,
  error: AuthoredImportError,
): never {
  let offset: number | undefined;
  walk(file, (node) => {
    if (node.type !== "ImportDeclaration" || offset !== undefined) return;
    if (node.specifiers?.some((s) => s.local?.name === error.local)) {
      offset = node.start;
    }
  });
  if (offset === undefined) throw new Error(error.message);
  throw importError(source, filename, offset, error.message);
}

/** The property of a decorator object literal named `name` (bare or quoted key). */
function decoratorProperty(
  decoratorArg: NgMxNode,
  name: string,
): NgMxNode | undefined {
  return (decoratorArg.properties ?? []).find((property) => {
    if (property.type !== "ObjectProperty" || property.computed) return false;
    const key = property.key as { name?: string; value?: unknown } | undefined;
    return key?.name === name || key?.value === name;
  });
}

/**
 * What a decorator's `standalone` value says: `false` (literal, possibly
 * wrapped in `as`/`satisfies`/`!`), `standalone` (literal true or absent), or
 * `unknown` (anything else: a variable, a negation, a call). `unknown` keeps
 * the standalone behaviour but must never be silent — see `compileNgMx`.
 */
function standaloneKind(
  decoratorArg: NgMxNode,
): { kind: "false" | "standalone" } | { kind: "unknown"; at: NgMxNode } {
  const value = decoratorProperty(decoratorArg, "standalone")?.value;
  if (!value) return { kind: "standalone" };
  let node: NgMxNode | undefined = value;
  while (
    node &&
    (node.type === "TSAsExpression" ||
      node.type === "TSSatisfiesExpression" ||
      node.type === "TSNonNullExpression" ||
      node.type === "ParenthesizedExpression")
  ) {
    node = node.expression;
  }
  if (node?.type === "BooleanLiteral") {
    return {
      kind:
        (node as { value?: unknown }).value === false ? "false" : "standalone",
    };
  }
  return { kind: "unknown", at: value };
}

/** `XComponent (selector "app-x")`, for a warning. */
function describeComponent(decorator: ComponentDecorator): string {
  const selector = decoratorProperty(decorator.argument, "selector")?.value as
    | { type?: string; value?: unknown }
    | undefined;
  const literal =
    selector?.type === "StringLiteral" && typeof selector.value === "string"
      ? ` (selector "${selector.value}")`
      : "";
  return `${decorator.className ?? "anonymous default-exported component"}${literal}`;
}

/** 1-based line, 0-based column of a source offset (Babel's `loc` convention). */
function positionAt(
  source: string,
  offset: number,
): { line: number; column: number } {
  const before = source.slice(0, offset);
  return {
    line: before.split("\n").length,
    column: offset - (before.lastIndexOf("\n") + 1),
  };
}

/**
 * The warning a `standalone: false` component gets instead of an `imports:`
 * edit: Angular rejects `imports` on it, so the declaring NgModule has to
 * provide what the template uses. Positioned at the region.
 */
function ngModuleWarning(
  source: string,
  regionStart: number,
  component: string,
  symbols: { name: string; from: string }[],
): MxWarning {
  const needs = symbols.map((s) => `${s.name} (from ${s.from})`).join(", ");
  return {
    message: `${component} is \`standalone: false\`, so MX does not add \`imports:\`; its declaring NgModule must provide ${needs}`,
    ...positionAt(source, regionStart),
  };
}

/** The object literal of the file's `@Component(...)` decorator, if any. */
/** One `@Component({ … })` in the file, with the span of its decorator. */
interface ComponentDecorator {
  /** The decorator call's own `[start, end)`, for attributing a region. */
  start: number;
  end: number;
  /** The object literal `imports:` is read from and written to. */
  argument: NgMxNode;
  /** The decorated class's name, from the AST; absent for an anonymous class. */
  className?: string;
  /** Offset just after the decorated class body's `{`, where members go. */
  classBodyStart?: number;
  /**
   * Member names the decorated class has: its own, and those of any
   * `extends` chain whose classes are declared in this file, plus the event
   * invoker members when the chain reaches `MxHandlers` / `MxHandlersMixin`
   * from the runtime subpath. Any other base that cannot be seen (an import,
   * a call such as a mixin) contributes nothing.
   */
  members?: Set<string>;
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
  // The decorated class, by the decorator's start. Read from the AST rather
  // than the source text after the decorator: a second decorator, a comment
  // or `extends` can sit between the two.
  const classOf = new Map<number, NgMxNode>();
  walk(file, (node) => {
    if (node.type !== "ClassDeclaration" && node.type !== "ClassExpression") {
      return;
    }
    for (const decorator of node.decorators ?? []) {
      if (decorator.start !== undefined) classOf.set(decorator.start, node);
    }
  });
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
    const className = classOf.get(node.start)?.id?.name;
    found.push({ start: node.start, end: node.end, argument, className });
  });
  // The class each decorator is attached to, for member injection.
  const declared = new Map<string, NgMxNode>();
  walk(file, (node) => {
    if (node.type === "ClassDeclaration" && node.id?.name) {
      declared.set(node.id.name, node);
    }
  });
  // What the file imports from the runtime subpath (`MxHandlers`,
  // `MxHandlersMixin`), by the local name it is bound to. A class that extends
  // one of them (or wraps its base in the mixin) already has the invoker
  // members, so they must not be injected a second time: the injected
  // `protected` property would clash with the inherited public one.
  const runtimeLocals = new Set<string>();
  const runtimeNamespaces = new Set<string>();
  walk(file, (node) => {
    if (node.type !== "ImportDeclaration") return;
    if (node.source?.value !== RUNTIME_SPECIFIER) return;
    for (const specifier of node.specifiers ?? []) {
      const local = specifier.local?.name;
      if (!local) continue;
      if (specifier.type === "ImportNamespaceSpecifier") {
        runtimeNamespaces.add(local);
      } else if (specifier.type === "ImportSpecifier") {
        const imported =
          specifier.imported?.name ??
          (specifier.imported as { value?: string } | undefined)?.value;
        if (imported === "MxHandlers" || imported === "MxHandlersMixin") {
          runtimeLocals.add(local);
        }
      }
    }
  });
  // Exactly three heritage shapes count, each resolved through an import
  // from the runtime subpath: `extends X`, `extends X(...)` (the mixin) and
  // `extends ns.X` / `extends ns.X(...)` with `ns` a namespace import of it.
  // A runtime name merely mentioned inside the expression (a callback, a
  // wrapper call's argument), or bound to something else, does not count: an
  // indirect base gets the members injected and TypeScript reports the clash.
  const isRuntimeRef = (node: NgMxNode | undefined): boolean => {
    if (node?.type === "Identifier") {
      return runtimeLocals.has(node.name ?? "");
    }
    return (
      node?.type === "MemberExpression" &&
      !node.computed &&
      node.object?.type === "Identifier" &&
      runtimeNamespaces.has(node.object.name ?? "") &&
      (node.property?.name === "MxHandlers" ||
        node.property?.name === "MxHandlersMixin")
    );
  };
  const extendsRuntime = (klass: NgMxNode): boolean => {
    const base = klass.superClass;
    return base?.type === "CallExpression"
      ? isRuntimeRef(base.callee)
      : isRuntimeRef(base);
  };
  const membersOf = (klass: NgMxNode, seen = new Set<NgMxNode>()) => {
    const names = new Set<string>();
    if (seen.has(klass)) return names;
    seen.add(klass);
    if (extendsRuntime(klass)) {
      for (const name of EVENT_HELPER_NAMES) names.add(name);
    }
    const body = Array.isArray(klass.body) ? undefined : klass.body;
    for (const member of (body?.body as NgMxNode[] | undefined) ?? []) {
      if (member.computed) continue;
      const key = member.key;
      const name =
        key?.type === "Identifier"
          ? key.name
          : key?.type === "StringLiteral"
            ? (key as { value?: string }).value
            : undefined;
      if (name) names.add(name);
    }
    const base =
      klass.superClass?.type === "Identifier" && klass.superClass.name
        ? declared.get(klass.superClass.name)
        : undefined;
    if (base) for (const name of membersOf(base, seen)) names.add(name);
    return names;
  };
  walk(file, (node) => {
    if (node.type !== "ClassDeclaration" && node.type !== "ClassExpression") {
      return;
    }
    const bodyStart = Array.isArray(node.body) ? undefined : node.body?.start;
    if (bodyStart === undefined) return;
    for (const attached of node.decorators ?? []) {
      const decorator = found.find((d) => d.start === attached.start);
      if (decorator) {
        decorator.classBodyStart = bodyStart + 1;
        decorator.members = membersOf(node);
      }
    }
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
 * Inserted after the module's last import. Without an authored import,
 * preserve its directive prologue and any detached leading comment block.
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
  // A tag called through an authored import already has its import: the
  // author's line is rewritten in place (`rewriteAuthoredTagImports`).
  const tagImports = [
    ...new Map(
      usedTags
        .filter((tag) => !tag.local && !authoredNames.has(tag.className))
        .map((tag) => [`${tag.className}\u0000${tag.specifier}`, tag]),
    ).values(),
  ].map((tag) => `import { ${tag.className} } from "${tag.specifier}";`);

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
  if (insertAt === 0) {
    const module = file as NgMxNode;
    const program = module.program;
    for (const directive of program?.directives ?? []) {
      insertAt = Math.max(insertAt, directive.end ?? 0);
    }
    // Comments belong to the original module, as do MagicString's offsets.
    // Scan through the prologue to the first authored non-directive statement
    // (bridge imports have no start). A detached header may follow directives;
    // the last attached declaration comment must still stay with its declaration.
    const firstCode =
      program?.body?.find((node) => node.start !== undefined)?.start ??
      rewritten.original.length;
    const leading = (module.comments ?? []).filter(
      (comment) => comment.end !== undefined && comment.end <= firstCode,
    );
    for (let index = 0; index < leading.length; index++) {
      const end = leading[index]?.end ?? 0;
      const next = leading[index + 1]?.start ?? firstCode;
      const start = leading[index]?.start ?? 0;
      const trailingInline =
        insertAt > 0 &&
        start >= insertAt &&
        /^[\t ]*$/.test(rewritten.original.slice(insertAt, start));
      if (
        trailingInline ||
        /\r?\n[\t ]*\r?\n/.test(rewritten.original.slice(end, next))
      ) {
        insertAt = Math.max(insertAt, end);
      }
    }
  }
  const text = `${lines.join("\n")}\n`;
  rewritten.appendLeft(insertAt, insertAt === 0 ? text : `\n${text.trimEnd()}`);
}

/**
 * Rebases each region's mappings onto the finished module.
 *
 * Each region's mappings are relative to its own literal (see `lowerRegion`),
 * so they are rebased by where that literal actually landed — after every
 * splice and every hoisted statement has shifted the text. The literal is
 * located by search rather than by arithmetic over the insertions, which
 * would have to model each one; `searchFrom` advances monotonically so two
 * regions emitting the same literal cannot both resolve to the first
 * occurrence.
 *
 * A literal that is not in `code` throws: it was written into the module by
 * this same function's caller, so a miss means the search and the splice have
 * diverged. Skipping the region would silently drop its mappings — "this
 * template has no positions" — where `compileTagModule` throws on the same
 * divergence.
 *
 * Exported for `test/ng-mx.test.ts`; not part of the package's public API.
 */
export function rebaseRegionMappings(
  code: string,
  regions: readonly { literal: string; mappings: readonly AngularMapping[] }[],
  filename: string,
): AngularMapping[] {
  const offsets = locateRegionLiterals(code, regions, filename);
  return regions.flatMap((region, i) =>
    offsetMappings(region.mappings, offsets[i] as number),
  );
}

/**
 * Where each region's template literal landed in `code`, in region order.
 * The search resumes after the previous literal, so regions emitting the same
 * literal resolve to distinct offsets. Throws when a literal is absent.
 */
function locateRegionLiterals(
  code: string,
  regions: readonly { literal: string }[],
  filename: string,
): number[] {
  let searchFrom = 0;
  return regions.map((region) => {
    const at = code.indexOf(region.literal, searchFrom);
    if (at < 0) {
      throw new Error(
        `@mxlang/angular internal: a region's template literal is not present in the emitted module for ${filename}`,
      );
    }
    searchFrom = at + region.literal.length;
    return at;
  });
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
  let deferred: AuthoredImportError | undefined;
  const regionCompile: MxRegionCompile = (input: MxRegionCompileInput) => {
    let region: LoweredRegion;
    try {
      region = lowerRegion(input.source, filename, input, options);
    } catch (error) {
      if (!(error instanceof AuthoredImportError)) throw error;
      // No module AST yet to position it against: let the parse finish with
      // an empty stand-in, then throw at the import (below).
      deferred ??= error;
      return { code: '""', hoistedImports: [], returnVars: [] };
    }
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
    // `<>…</>` is a region here, not TSX: a template has nothing to lower a
    // TSX fragment to, so the several roots of a template are written as one.
    mxRegionFragment: true,
    mxCustomTags: options.customTags,
  });

  if (deferred) {
    throwAtImport(file, source, filename, deferred as AuthoredImportError);
  }

  lowered.sort((a, b) => a.start - b.start);

  const rewritten = new MagicString(source);
  for (const region of lowered) {
    rewritten.overwrite(region.start, region.end, region.literal);
  }

  const usedTags = dedupeTags(lowered.flatMap((region) => region.usedTags));

  // `imports:` is edited **per component**, from the regions that decorator
  // actually encloses — not from the file-wide union. A file with two
  // components otherwise gave the first one the second's directives, and
  // left the second's own array untouched.
  //
  // The module-level imports below stay file-wide, because that is what
  // module scope is: one `import` serves every component in the file.
  const decorators = findComponentDecorators(file);
  const nonStandalone = new Set<ComponentDecorator>();
  const moduleWarnings: MxWarning[] = [];
  // Which authored aliases end up named in some `imports:` array. Dedupe by
  // class keeps one alias per component, so a second alias of the same class
  // is otherwise an import nothing references. A non-standalone component's
  // tags, and a region no component encloses, have no `imports:` here and
  // keep their alias untouched.
  const listedLocals = new Set<string>();
  for (const region of lowered) {
    if (decoratorForRegion(decorators, region.start)) continue;
    for (const tag of region.usedTags)
      if (tag.local) listedLocals.add(tag.local);
  }
  for (const decorator of decorators) {
    const mine = lowered.filter(
      (region) => decoratorForRegion(decorators, region.start) === decorator,
    );
    if (mine.length === 0) continue;
    const standalone = standaloneKind(decorator.argument);
    const tags = dedupeTags(mine.flatMap((region) => region.usedTags));
    const dirs = [...new Set(mine.flatMap((region) => region.directives))];
    // Only when MX is about to inject something: with nothing to add the
    // warning would claim an edit that was never made.
    if (
      standalone.kind === "unknown" &&
      standalone.at.start !== undefined &&
      tags.length + dirs.length > 0
    ) {
      moduleWarnings.push({
        message: `cannot determine whether ${describeComponent(decorator)} is standalone; assuming standalone, so MX adds any missing directives and tags to \`imports:\`. If it is \`standalone: false\`, drop \`imports:\` and provide the symbols in the declaring NgModule`,
        ...positionAt(source, standalone.at.start),
      });
    }
    if (standalone.kind === "false") {
      nonStandalone.add(decorator);
      for (const tag of tags) if (tag.local) listedLocals.add(tag.local);
      const symbols = [
        ...dirs.map((name) => ({ name, from: "@angular/common" })),
        ...tags.map((tag) => ({ name: symbolOf(tag), from: tag.specifier })),
      ];
      if (symbols.length > 0) {
        moduleWarnings.push(
          ngModuleWarning(
            source,
            Math.min(...mine.map((region) => region.start)),
            describeComponent(decorator),
            symbols,
          ),
        );
      }
      continue;
    }
    for (const tag of tags) if (tag.local) listedLocals.add(tag.local);
    applyComponentImports(rewritten, decorator.argument, tags, [
      ...new Set(mine.flatMap((region) => region.directives)),
    ]);
    // The template calls the event invoker on the component instance, so the
    // class must carry it. The author's own class body, so this is the one
    // place MX edits it beyond `imports:`. Each member is judged on its own,
    // per class and from the AST: one the class declares (any spelling — a
    // property or a method) or inherits from a base visible in this file is
    // left alone, and only the missing ones are written.
    if (
      decorator.classBodyStart !== undefined &&
      mine.some((region) => region.literal.includes(EVENT_HELPER_MARKER))
    ) {
      const missing = EVENT_HELPER_MEMBERS.filter(
        (_member, index) =>
          !decorator.members?.has(EVENT_HELPER_NAMES[index] as string),
      );
      if (missing.length > 0) {
        rewritten.appendLeft(
          decorator.classBodyStart,
          `\n${missing.join("\n")}\n`,
        );
      }
    }
  }
  rewriteAuthoredTagImports(
    rewritten,
    file,
    source,
    filename,
    lowered,
    listedLocals,
  );
  // A non-standalone component's directives and tags are not imported: it
  // has no `imports:` to name them in, and the NgModule imports them itself.
  const standaloneRegions = lowered.filter((region) => {
    const owner = decoratorForRegion(decorators, region.start);
    return !owner || !nonStandalone.has(owner);
  });
  hoistModuleStatements(
    rewritten,
    file,
    lowered.flatMap((region) => region.moduleStatements),
    // Merged per component, exactly as its `imports:` was, so a class that a
    // component lists under an authored alias is not also imported plain.
    [
      ...new Set(
        standaloneRegions.map((region) =>
          decoratorForRegion(decorators, region.start),
        ),
      ),
    ].flatMap((owner) =>
      dedupeTags(
        standaloneRegions
          .filter(
            (region) => decoratorForRegion(decorators, region.start) === owner,
          )
          .flatMap((region) => region.usedTags),
      ),
    ),
    [...new Set(standaloneRegions.flatMap((region) => region.directives))],
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
      (warning) =>
        (warning as { code?: string }).code !== IMPORTS_ADVICE_CODE &&
        (warning as { code?: string }).code !== EVENT_HELPER_ADVICE_CODE,
    );
  warnings.push(...moduleWarnings);
  if (options.warnings) options.warnings.push(...warnings);

  const code = rewritten.toString();
  const moduleMappings = rebaseRegionMappings(code, lowered, filename);
  const literalOffsets = locateRegionLiterals(code, lowered, filename);
  const moduleAnchors = lowered.flatMap((region, i) =>
    offsetAnchors(region.anchors, literalOffsets[i] as number),
  );

  return {
    code,
    map: rewritten.generateMap({
      file: filename,
      source: filename,
      includeContent: true,
      hires: true,
    }),
    mappings: moduleMappings,
    anchors: moduleAnchors,
    warnings,
    usedTags,
    regions: lowered.map(
      (
        {
          start,
          end,
          literal,
          usedTags: tags,
          mappings,
          anchors,
          warnings: regionWarnings,
        },
        i,
      ) => ({
        start,
        end,
        generatedStart: literalOffsets[i] as number,
        generatedEnd: (literalOffsets[i] as number) + literal.length,
        usedTags: tags,
        mappings,
        anchors,
        warnings: regionWarnings,
      }),
    ),
  };
}
