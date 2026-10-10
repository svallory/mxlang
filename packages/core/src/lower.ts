/**
 * The lowerer (decision 79): Marko's AST in, MX's host-independent IR out.
 *
 * This is the core's whole node walk, with every `out +=` removed. It does all
 * the validation the emitting walk used to do — dispositions and inert shapes,
 * the field guard, `checkBinding`, the four `<for>` forms, if-chain grouping,
 * attribute-tag collection, statement-tag hoisting — and produces `IrNode`s
 * instead of text. A host then emits from the IR and never sees a Marko node.
 *
 * Error messages and positions are preserved **byte for byte** from the
 * emitting walk: `packages/targets/html`'s error fixtures and the oracle's error
 * class both assert them, and a reworded message is a behaviour change even
 * when the construct is still rejected.
 *
 * ## The two decision-70 hooks, as IR annotations
 *
 * `ctx.hoist(code)` and `ctx.bindings` still exist, and still run *here*
 * rather than at emit time: both are lower-time state. A hoisted statement
 * is recorded on the enclosing scope (the template's `prelude`, or the nearest
 * `Define`'s own), and a registered binding rewrites identifier *references*
 * as each expression is printed — so the `Expr.code` a host receives is
 * already rewritten and an emitter stays dumb. Shadowing is applied as the
 * walk enters and leaves each binding construct, exactly as before.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as babelParse, type ParserPlugin } from "@babel/parser";
// Type-only and erased from the emitted .d.ts: the internal signatures take
// the MX AST; the published ones keep `Node` until PR 5 (decision 158 PR 4
// slice 6 ruling B), since `@mxlang/babel` is private.
import type { MxChild } from "@mxlang/babel/mx-ast";
import { freeIdentifiersIn } from "./accessor-reads.ts";
import { assertNoStandIn, atomOf, atomsIn, convertAtoms } from "./atoms.ts";
import {
  attrArgsOf,
  attrNameOf,
  attrValueOf,
  hasExpressionValue,
  isBoundAttr,
  isDefaultAttr,
  isMethodAttr,
} from "./attr-fields.ts";
import { attrLabel } from "./attr-label.ts";
import {
  fallbackAttrTagShape,
  unifyNestedAttrTagPlanGroups,
} from "./attr-tag.ts";
import { coreBabel } from "./babel.ts";
import { BUILTIN_CUSTOM_TAGS } from "./builtin-tags.ts";
import {
  type AttrTagDecl,
  type CalleeInput,
  calleeReturn,
  readCalleeInput,
  readOwnInput,
} from "./callee-input.ts";
import { CALLEE_INPUT_ERROR } from "./callee-input-error.ts";
import {
  attrByName,
  bindingIdentifierNodes,
  bindingIdentifiers,
  bodyChildren,
  type Ctx,
  collectedError,
  DYNAMIC_TAG,
  declName,
  expr,
  fail,
  firstAttributeTag,
  hasContent,
  importBindings,
  importedNames,
  importTypeOnlyBindings,
  isAttributeNode,
  isCommentNode,
  isFunctionLikeValue,
  isMarkoOrMxSpecifier,
  isMxAttributeTag,
  isSpreadAttributeNode,
  isStatementNode,
  isTagNode,
  isTagOrStatementNode,
  isTextNode,
  isTranslateError,
  mxSpanOf,
  type Node,
  newCtx,
  positionAtOffset,
  positionError,
  productOf,
  recover,
  rejectInertShape,
  rejectUnsupportedFields,
  scopeBindings,
  shadowBindings,
  sliceLoc,
  sliceNode,
  TranslateError,
  warn,
} from "./core.ts";
import {
  buildersFor,
  type ChildNode,
  type CustomTag,
  hasAttributeTagContract,
  isContractOnlyDelegated,
  runAnalyzeHooks,
  runFinalizeHooks,
  shadowedBuiltinMessage,
  type TagCall,
  transformCustomTag,
  validateCustomTagChildren,
  validateCustomTagParents,
} from "./custom-tags.ts";
import type { HostDeclarations } from "./declarations.ts";
import { invalidDefaultTagHint, resolveUnnamedTags } from "./default-tag.ts";
import { nearestName } from "./did-you-mean.ts";
import { exportNameFor } from "./export-name.ts";
import { parseFragment } from "./fragment.ts";
import type {
  Attr,
  AttributeTag,
  AttributeTagNode,
  AttrTagProp,
  Block,
  Branch,
  ComponentTarget,
  Expr,
  ExprShape,
  ForHead,
  ForSource,
  Ir,
  IrNode,
  Member,
  Position,
  TagAlias,
  TagTrigger,
} from "./ir.ts";
import type { SourceSpan } from "./mapping.ts";
import { markoViewOf } from "./marko-view.ts";
import {
  endOfInputError,
  isTypeofImport,
  parsedImportDeclarations,
  pendingFrontEndError,
} from "./mx-parse.ts";
import {
  declaredBinding,
  type ScriptletDeclaration,
  scriptletSentence,
} from "./parse-error-hints.ts";
import { payloadOf } from "./payload.ts";
import { checkReservedTemplate } from "./reserved-bindings.ts";
import { CONTROL_FLOW_TAGS } from "./structural-tags.ts";
import type { SyntaxBuildContext } from "./syntax-table.ts";
import {
  hasStaticName,
  tagArgsOf,
  tagAttributesOf,
  tagNameExprOf,
  tagNameOf,
  tagNameSpanOf,
  tagParamsOf,
  tagVarOf,
} from "./tag-fields.ts";
import {
  coreNativeTags,
  ELEMENT_TAGLIB_IDS,
  isNativeVoid,
} from "./tag-table.ts";
import {
  bindingForDiscoveredModule,
  hasTemplate,
  inputMember,
  metadataOfIr,
  registerAuthoredTemplateImport,
  registerTemplateMetadataCompiler,
  type TemplateTag,
} from "./template-tag.ts";
import { childrenWithTriggers, lowerTriggers, memberOf } from "./triggers.ts";
import {
  findUncalledTagFile,
  markoFileTagMessage,
  uncalledTagFileMessage,
} from "./uncalled-tag-file.ts";
import { attributeTagDeclarationFor, tagLabel } from "./wildcard-children.ts";
import {
  type WildcardMatch,
  wildcardIneligibility,
  wildcardMatchOf,
} from "./wildcard-resolve.ts";

/**
 * A node's start position, in `TranslateError`'s own 1-based/0-based shape:
 * a Marko or Babel node's `loc`, else an MX node's offset (`mxSpanOf`)
 * against `ctx.source`.
 */
function posOf(ctx: Ctx, node: Node): Position {
  const span = node?.loc ? undefined : mxSpanOf(node);
  if (span) return positionAtOffset(ctx, span.sourceStart);
  const start = node?.loc?.start ?? node?.start ?? {};
  return { line: start.line ?? 0, column: start.column ?? 0 };
}

/** A node's end position, paired with `posOf` for source-backed code blocks. */
function endPosOf(ctx: Ctx, node: Node): Position {
  const span = node?.loc ? undefined : mxSpanOf(node);
  if (span) return positionAtOffset(ctx, span.sourceEnd);
  const end = node?.loc?.end ?? node?.end ?? {};
  return { line: end.line ?? 0, column: end.column ?? 0 };
}

function offsetOf(ctx: Ctx, position: Position & { index?: number }): number {
  if (typeof position.index === "number") return position.index;
  let offset = 0;
  for (let line = 1; line < position.line; line++) {
    offset += (ctx.lines[line - 1]?.length ?? 0) + 1;
  }
  return Math.min(ctx.source.length, offset + position.column);
}

function attributeTagNamePosition(ctx: Ctx, tag: AttributeTag): Position {
  return positionAtOffset(ctx, tag.nameSpan.sourceStart);
}

function nodeSpan(ctx: Ctx, node: Node): SourceSpan {
  const span = node?.loc ? undefined : mxSpanOf(node);
  if (span) return span;
  const start = node?.loc?.start ?? node?.start ?? {};
  const end = node?.loc?.end ?? node?.end ?? start;
  return {
    sourceStart: offsetOf(ctx, start),
    sourceEnd: offsetOf(ctx, end),
  };
}

/**
 * `nodeSpan`, but `undefined` when `node` carries no `loc` — a synthesized
 * node with no real position. `nodeSpan`/`offsetOf` read `{line, column,
 * index?}`-shaped positions, never a bare number: a node with a numeric
 * `start`/`end` but no `loc` (e.g. `{type:"Id", start:7, end:10}`) is not
 * enough on its own — `offsetOf` would read `.column` off that raw number
 * and produce `NaN`, same as the no-position case this guards against. Only
 * `loc.start`/`loc.end` are ever position-shaped here, so `loc` alone is the
 * correct gate.
 *
 * Exported for `lower.test.ts` alone, to unit-test the guard directly
 * against every construction site that shares it (`Define.nameSpan`,
 * `paramSpansOf`), not only through `exprOf` — same rationale as `exprOf`'s
 * own export comment below.
 */
export function exprSpan(ctx: Ctx, node: Node): SourceSpan | undefined {
  if (!node?.loc) return mxSpanOf(node);
  return nodeSpan(ctx, node);
}

/**
 * Every identifier a `/var` pattern declares, with its authored span, for a
 * host that has to point at one (a region refusing a duplicate binding).
 * Empty for a call without `/var`.
 *
 * A pattern the parser could not read (`{ a, b: a }`, Marko's "Argument name
 * clash.") arrives as a `MarkoParseError` node holding no identifiers; it
 * fails here at the parser's own position rather than yielding `[]`, which a
 * region would take for "binds nothing" and report at a generated position.
 */
function varBindingsOf(ctx: Ctx, pattern: Node | null | undefined) {
  if (pattern?.type === "MarkoParseError") exprOf(ctx, pattern);
  return bindingIdentifierNodes(pattern as Node).map((id) => ({
    name: id.name as string,
    span: exprSpan(ctx, id),
  }));
}

/**
 * Is this character one of the two sigils a shorthand class or id starts with?
 */
function shorthandSigil(char: string | undefined): boolean {
  return char === "#" || char === ".";
}

/** Does `${` open at this offset? */
function interpolationAt(source: string, at: number): boolean {
  return source[at] === "$" && source[at + 1] === "{";
}

/** The offset after the `${…}` opening at `at`, braces balanced. */
function skipInterpolation(source: string, at: number): number {
  let depth = 0;
  for (let i = at + 1; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return i + 1;
  }
  return source.length;
}

/**
 * The span of a tag's shorthand `class` or `id` whose value Marko built
 * (`<div.a.${x}/>`, `<div.a${x}/>`, `<div#a${x}/>`): the first sigil of its
 * kind to the end of the last token of that kind. Marko gives such a value no
 * loc, so the run is read from the tag's own source; null when it is not there.
 * In a mixed run (`<div.a#b.${x}/>`) the class span crosses the id: it is
 * the first sigil to the last token, not the union of the class tokens.
 */
function builtShorthandSpan(
  ctx: Ctx,
  tagLoc: Position,
  name: unknown,
): SourceSpan | null {
  const sigil = name === "class" ? "." : name === "id" ? "#" : null;
  if (!sigil) return null;
  const { source } = ctx;
  let i = offsetOf(ctx, tagLoc);
  if (source[i] === "<") i++;
  // The tag name, up to the first shorthand sigil.
  while (i < source.length && !shorthandSigil(source[i])) {
    if (interpolationAt(source, i)) i = skipInterpolation(source, i);
    else if (/[\s/>=|(]/.test(source[i] as string)) return null;
    else i++;
  }
  let start = -1;
  let end = -1;
  while (shorthandSigil(source[i])) {
    const tokenStart = i++;
    while (i < source.length && !shorthandSigil(source[i])) {
      if (interpolationAt(source, i)) i = skipInterpolation(source, i);
      else if (/[\s/>=|(<,;]/.test(source[i] as string)) break;
      else i++;
    }
    if (source[tokenStart] === sigil) {
      if (start < 0) start = tokenStart;
      end = i;
    }
  }
  return start < 0 ? null : { sourceStart: start, sourceEnd: end };
}

/**
 * The span of an attribute's authored name.
 *
 * A default attribute (`<x="post">`) is `name: "value"` to the parser, but its
 * `loc` starts at the `=`: there is no spelled name. Marko anchors it with an
 * EMPTY range at the attribute start (htmljs-parser 5.18.0 `ensureAttrName`;
 * `@marko/language-tools` 2.7.0 treats the empty range as "default"), so this
 * returns a zero-width span there instead of measuring `"value".length` over
 * the `=` and the value's first characters.
 *
 * The `:modifier` shorthand is the one default attribute that *was* spelled:
 * Marko's parser fills the empty head with `"value"` and remembers the
 * shorthand in `attr.default`, so the authored name is `:foo` — measured from
 * the attribute's own start, which is the `:`.
 */
function attrNameSpan(ctx: Ctx, attr: Node, tagLoc?: Position): SourceSpan {
  // A name-sugar attribute (`:b`, `#b`, `.c`) is spelled as one token.
  if (attr?.sugarNameSpan) {
    return {
      sourceStart: attr.sugarNameSpan.start,
      sourceEnd: attr.sugarNameSpan.end,
    };
  }
  // An MX attribute carries its name's spans: the head through the modifier.
  // The default value is anchored zero-width at the attribute's start, where
  // Marko anchors it (for `<x async(a) {}>` that is `async`, not the `(`).
  if (attr?.type === "MxAttribute" || attr?.type === "MxSpreadAttribute") {
    if (attr.type === "MxSpreadAttribute" || attr.name === null) {
      return { sourceStart: attr.start, sourceEnd: attr.start };
    }
    return {
      sourceStart: attr.nameSpan.start,
      sourceEnd: (attr.modifierSpan ?? attr.nameSpan).end,
    };
  }
  // A tag's own shorthand (`<a#x.y/>`, `a#x.y`) has no attribute position in
  // Marko's AST, only its value does, and that value is the token without its
  // sigil. The name is spelled as the sigil plus the token, the same span the
  // spaced name-sugar form (` .y`) reports.
  if (!attr?.loc && attr?.start == null) {
    const value = exprSpan(ctx, attr?.value);
    // A merged or interpolated shorthand (`.a.${x}`, `.a${x}`, `#a${x}`) is a
    // value Marko built, with no loc to measure: read the run off the tag.
    if (!value && tagLoc) {
      const built = builtShorthandSpan(ctx, tagLoc, attr?.name);
      if (built) return built;
    }
    if (value) {
      const sigilAt = value.sourceStart - 1;
      // A dynamic shorthand (`<a.${x}/>`, `<a#${y}>`) spells its sigil one
      // step further out: the value the parser reports starts at the
      // expression inside `${…}`, so the sigil is the character before the
      // `${`. Same span the static `.c` form reports.
      const dynSigilAt = sigilAt - 2;
      const dyn =
        ctx.source.slice(sigilAt - 1, sigilAt + 1) === "${" &&
        shorthandSigil(ctx.source[dynSigilAt]);
      let start = value.sourceStart;
      let end = value.sourceEnd;
      if (shorthandSigil(ctx.source[sigilAt])) start = sigilAt;
      else if (dyn) {
        start = dynSigilAt;
        // …and its other end is the `}` closing the `${` the expression sits
        // in, so the span reads `.${x}` rather than `.${x`.
        if (ctx.source[end] === "}") end += 1;
      }
      return { sourceStart: start, sourceEnd: end };
    }
  }
  const sourceStart = offsetOf(ctx, attr?.loc?.start ?? attr?.start ?? {});
  const sourceName =
    attr.modifier != null
      ? attr.default
        ? `:${attr.modifier}`
        : `${attr.name}:${attr.modifier}`
      : String(attr.name ?? "");
  if (!ctx.source.startsWith(sourceName, sourceStart)) {
    return { sourceStart, sourceEnd: sourceStart };
  }
  return { sourceStart, sourceEnd: sourceStart + sourceName.length };
}

/**
 * Is this an ordinary colon-named attribute rather than a real modifier?
 *
 * Marko's parser (`babel-plugin/parser.js`, `onAttrName`) splits an attribute
 * name at its LAST `:`; an empty head is filled with `"value"`, so
 * `<div :foo="y"/>` parses as `{ name: "value", modifier: "foo", default: true }`
 * and compiles to `<div value:foo=y>` (`<div value:foo="y"/>` is the same
 * attribute). `attr.default` is the flag that marks the `:foo` spelling, but
 * both spellings are the same attribute, so both answer true here. An empty
 * modifier is still present (`:` becomes `value:`), and a head already starting
 * with `value:` keeps its earlier colons (`value:foo:bar` splits into
 * `name: "value:foo", modifier: "bar"`). Marko joins them again on emission.
 * This applies to every colon name (`x:`, `x:foo`, `data:x`), not just `value`.
 * On native elements only the `class:`, `style:` and `on:` prefixes remain
 * reserved, including additional colons; component props have no reservation.
 * Events retain their suffix too.
 */
function isOrdinaryColonName(attr: Node, isElement: boolean): boolean {
  return (
    attr?.modifier != null &&
    (!isElement || !/^(?:class|style|on)(?::|$)/.test(attr.name))
  );
}

/** Classifies an expression once, while its parsed node is still available. */
export function expressionShape(node: Node): ExprShape {
  switch (node?.type) {
    case "ObjectExpression":
      return "object";
    case "ArrayExpression":
      return "array";
    case "StringLiteral":
    case "TemplateLiteral":
      return "string";
    default:
      return "other";
  }
}

/**
 * An expression, printed and classified through the binding registry.
 *
 * Exported for `lower.test.ts` alone, to unit-test `span`'s guard directly
 * against a loc-less node — no construction site in this file currently
 * hands `exprOf` one (both of `custom-tags.ts`'s synthesized/fabricated
 * `Expr`s build the object literal directly, bypassing this function), but
 * the guard exists precisely so a future one cannot regress into a `NaN`
 * span.
 */
export function exprOf(ctx: Ctx, node: Node): Expr {
  if (node?.type === "MarkoParseError") {
    fail(node.label ?? "invalid expression", {
      loc: { start: node.errorLoc?.start ?? node.loc?.start },
    });
  }
  assertNoStandIn(ctx, node);
  const code = expr(ctx, node);
  checkTagVarReads(ctx, code, node);
  const span = exprSpan(ctx, node);
  const atoms = span ? atomsIn(ctx, span.sourceStart, span.sourceEnd) : [];
  const bodySpan =
    node?.type === "FunctionExpression" && span
      ? methodBodySpan(ctx, node, span)
      : undefined;
  return {
    code,
    shape: expressionShape(node),
    node,
    span,
    ...(atoms.length > 0 ? { atoms } : {}),
    ...(bodySpan
      ? {
          bodySpan,
          bodySource: ctx.source.slice(
            bodySpan.sourceStart,
            bodySpan.sourceEnd,
          ),
        }
      : {}),
  };
}

/**
 * The authored `{ … }` body of an attribute method shorthand
 * (`onClick() { … }`, `async onClick<T>(…) { … }`), read from the parser
 * node's own body position. `code` prints the method as a `function`
 * expression, possibly reformatted, so this is the authored side a host diffs
 * the printed body against. Marko's body position for a method covers only
 * the text between the braces, so it is widened onto them. `undefined` for an
 * authored `function` expression (its `code` is its own text, mapped like any
 * expression) and when the node has no body position or it does not delimit
 * a block in the source.
 */
function methodBodySpan(
  ctx: Ctx,
  node: Node,
  span: SourceSpan,
): SourceSpan | undefined {
  const authored = ctx.source.slice(span.sourceStart, span.sourceEnd);
  if (/^(?:async\s+)?function\b/.test(authored)) return undefined;
  const body = exprSpan(ctx, node?.body);
  if (!body) return undefined;
  const { sourceStart, sourceEnd } = body;
  if (ctx.source[sourceStart] === "{" && ctx.source[sourceEnd - 1] === "}") {
    return body;
  }
  if (ctx.source[sourceStart - 1] === "{" && ctx.source[sourceEnd] === "}") {
    return { sourceStart: sourceStart - 1, sourceEnd: sourceEnd + 1 };
  }
  return undefined;
}

/**
 * Rejects a `/var` read the emitted JS could not honour (design §3.4, C5).
 *
 * Two shapes, both of which JavaScript would let through as `undefined` or a
 * run-time TDZ rather than a diagnostic:
 *
 * - a read **before** the call that declares it, in the same block. Marko
 *   makes this a compile error by comparing sibling indices
 *   (`references.ts:597-602`); the equivalent here is the `pending` flag a
 *   block sets on its own `/var` names before walking and clears when the
 *   walk reaches each declaring call.
 * - a read **outside** the declaring block. Marko hoists the binding into a
 *   getter instead (`hoist-custom-tag-var/`), which changes its
 *   user-visible type; MX rejects the escape and keeps `/var` an ordinary
 *   `let` in the call site's own scope (invariant §7.5-8).
 *
 * The expression is **parsed**, not pattern-matched. A regex over the printed
 * text was measured wrong in both directions on real templates: `${"the
 * letter n"}` matched a string literal's contents and rejected a valid
 * program, and `<for|n|>` matched the loop's own parameter, which shadows the
 * `/var` and has nothing to do with it. `freeIdentifiersIn` reports only
 * genuine free references, and `Ctx.tagVarShadowed` carries the names an
 * enclosing tag's params bind — the shadowing a single expression's own scope
 * cannot see.
 *
 * The walk runs only when a `/var` is in scope at all, which is never for a
 * file that does not use one.
 */
function checkTagVarReads(ctx: Ctx, code: string, node: Node): void {
  const declared = ctx.tagVars;
  if (!declared?.size) return;
  const here = ctx.tagVarBlock ?? [];

  const read = freeIdentifiersIn(code);
  if (read.size === 0) return;

  for (const [name, binding] of declared) {
    if (!read.has(name)) continue;
    // A tag param of the same spelling is a different variable.
    if (ctx.tagVarShadowed?.has(name)) continue;
    // In scope exactly when the declaring block is this block or an ancestor
    // of it — a prefix of the path. A sibling block shares the declaring
    // block's *depth* but not its path, which is the case a depth counter
    // cannot tell apart.
    const inScope =
      binding.block.length <= here.length &&
      binding.block.every((id, index) => here[index] === id);
    if (!inScope) {
      fail(
        `\`${name}\` is a \`/var\` bound inside a nested block and is not in scope here; a \`/var\` binds in the call site's own scope only`,
        node,
      );
    }
    // Still pending: the walk has not reached the declaring call yet, so
    // this read is earlier in the block than the binding.
    if (binding.pending) {
      fail(
        `\`${name}\` is read before the \`/var\` that binds it; move the read after the call that declares it`,
        node,
      );
    }
  }
}

/**
 * Where hoisted statements accumulate for the function currently being
 * resolved.
 *
 * `ctx.prelude` is swapped as the walk enters and leaves a `<define>`, so a
 * `ctx.hoist` from inside one lands on that define's own head rather than the
 * render function's — the same function-boundary rule the lowerer applies to
 * the template body.
 */
function withPrelude<T>(ctx: Ctx, run: () => T): [T, Ctx["prelude"]] {
  const outer = ctx.prelude;
  ctx.prelude = [];
  const result = run();
  const prelude = ctx.prelude;
  ctx.prelude = outer;
  return [result, prelude];
}

/**
 * An event attribute: `on<Name>` (camelCase, lowercased to the DOM name) or
 * `on-<exact>` (verbatim, for a custom event or a name camelCase cannot
 * spell). Marko's own `isEventHandler` regex, deliberately identical — a
 * parity target must not re-derive a rule it can copy.
 */
const EVENT_ATTR = /^on[A-Z-]/;

/**
 * Camel-cased event spellings whose plain lowercase is *not* a DOM event name.
 *
 * MX has no aliases: `onDoubleClick` lowers to `doubleclick` and is emitted as
 * `doubleclick`, which no element ever fires. Rather than rewrite the author's
 * name — which would make one spelling silently mean another, the thing the
 * no-alias rule exists to prevent — core warns and emits what was written.
 *
 * Derived by checking every React DOM event prop against the event names in
 * TypeScript's `lib.dom.d.ts` (`GlobalEventHandlersEventMap` and friends), not
 * by hand: of React's ~80 `on*` props only these three lowercase to a
 * non-event. The other React camelCase spellings a table might list —
 * `onKeyDown`, `onMouseEnter`, `onFocusIn`, `onPointerDown`, `onTimeUpdate`,
 * and so on — lowercase to the real DOM name (`keydown`, `mouseenter`,
 * `focusin`, `pointerdown`, `timeupdate`) and are therefore correct in MX and
 * must not warn.
 *
 * `onDragExit` and `onEncrypted` are React-only synthetic events with no DOM
 * counterpart, so neither has a spelling to suggest.
 */
const NON_DOM_EVENT_SPELLINGS: Record<string, string | null> = {
  onDoubleClick: "onDblClick",
  onDragExit: null,
  onEncrypted: null,
};

/**
 * Warns — without rewriting — when an event attribute uses a spelling whose
 * lowercase is not a real DOM event.
 *
 * Positioned at the attribute name so the language server underlines the
 * attribute rather than the whole tag.
 */
function warnOnNonDomEventSpelling(ctx: Ctx, attr: Node, name: string): void {
  if (!Object.hasOwn(NON_DOM_EVENT_SPELLINGS, name)) return;
  const suggestion = NON_DOM_EVENT_SPELLINGS[name];
  const pos = posOf(ctx, attr);
  warn(ctx, {
    message:
      `\`${name}\` is not a DOM event` +
      (suggestion ? `; did you mean \`${suggestion}\`` : ""),
    line: pos.line,
    column: pos.column,
    file: ctx.filename,
  });
}

/**
 * Marko's attribute-name grammar (`runtime-tags/src/common/helpers.ts`
 * `htmlAttrNameReg` / `userAttrNameReg`, applied in `normalizeTag`): a letter
 * or `_`, then `[a-z0-9._:-]`. `userAttrNameReg` lets a leading `$` through
 * its first alternative, but its second (`[^a-z0-9._:-]` anywhere) rejects that
 * same `$`, so custom tags follow the element rule (`<foo $foo=1/>` errors in
 * 6.3.51).
 */
const ATTR_NAME = /^[a-z_][a-z0-9._:-]*$/i;

/**
 * The characters a tag name may use: letters (any script), digits, marks and
 * `-._:$`. Stock Marko lexes any other name (`&title`) and fails later, in its
 * translator ("Unable to find entry point for custom tag"), so rejecting here,
 * at the name, is earlier wording of the same refusal rather than a
 * divergence.
 */
const TAG_NAME = /^[\p{L}\p{N}\p{M}_$:.-]+$/u;

/**
 * A name Marko's concise mode reads off a `$…` scriptlet line, a `!…` line or
 * a `${…}` placeholder: those are not tag names and keep their own, more
 * specific diagnostics (the data target's "a dynamic tag has no name"), so the
 * charset check leaves them alone.
 */
const NOT_A_NAME_SHAPE = /^[$!]|[{}]/;

/**
 * Bracketed, `#…` and `*…` attribute names (patterns other template languages
 * use) and how to write what they were reaching for, first match wins.
 */
const FOREIGN_ATTR_HINTS: [
  RegExp,
  (m: RegExpMatchArray, product: string) => string,
][] = [
  [
    /^\[\(([^()[\]]+)\)\]$/,
    (m) => `two-way binding is written \`${m[1]}:=expr\``,
  ],
  [/^\[class\.([^[\]]+)\]$/, (m) => `write \`class={ ${m[1]}: cond }\``],
  [
    /^\[style\.([^[\].]+)[^[\]]*\]$/,
    (m) => `write \`style={ ${m[1]}: value }\``,
  ],
  [
    /^\[(?:attr\.)?([^[\]]+)\]$/,
    (m) => `write \`${m[1]}=\` with the expression as the value`,
  ],
  [
    /^#/,
    (_m, mx) => `\`#…\` template reference variables have no meaning in ${mx}`,
  ],
  [
    /^\*/,
    (_m, mx) =>
      `\`*…\` structural directives have no meaning in ${mx}; use \`<if=cond>\` / \`<for|item| of=list>\``,
  ],
];

/**
 * The variable a scriptlet's first statement declares, when it declares one.
 * A scriptlet that does not parse is kept as its source text.
 */
function declaredVariable(scriptlet: Node): ScriptletDeclaration | undefined {
  // An MX scriptlet's statements are its `code` container's payload; one the
  // front end could not parse has only its source, read as Marko's is. The
  // scriptlet is refused either way, so its own message wins over the
  // container's error or trigger: no `payloadOf` here.
  const body =
    scriptlet.type === "MxScriptlet"
      ? (scriptlet.code.node ?? [{ source: scriptlet.code.source }])
      : scriptlet.body;
  const first = body?.[0];
  if (typeof first?.source === "string") return declaredBinding(first.source);
  if (body?.length !== 1) return undefined;
  const declarations = first?.declarations;
  const id = declarations?.length === 1 ? declarations[0]?.id : undefined;
  return id?.type === "Identifier" &&
    ["const", "let", "var"].includes(first.kind)
    ? { name: id.name, keyword: first.kind }
    : undefined;
}

function foreignAttrHint(name: string, product: string): string {
  for (const [pattern, hint] of FOREIGN_ATTR_HINTS) {
    const match = name.match(pattern);
    if (match) return hint(match, product);
  }
  return "an attribute name may use letters, digits and `._:-`";
}

/** Words Babel's `isValidIdentifier` refuses: keywords and strict-mode (module) reserved words. */
const RESERVED_WORDS = new Set(
  (
    "break case catch continue debugger default do else finally for function if return switch " +
    "throw try var const while with new this super class extends export import null true false " +
    "in instanceof typeof void delete enum await implements interface let package private " +
    "protected public static yield"
  ).split(" "),
);

/** Marko's own check for a bound attribute's refinement shorthand (`t.isValidIdentifier`). */
function isRefinementIdentifier(name: string): boolean {
  return (
    /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u.test(name) &&
    !RESERVED_WORDS.has(name)
  );
}

/**
 * The refinement of a bound attribute: `fn` in `v:fn:=q`. Marko runs it as
 * `q = fn(next)` in the change handler; the IR carries it as an `Expr` over
 * the modifier's own text. A modifier that is not a valid JavaScript
 * identifier (`x::=q`, `v:no-update:=q`) is Marko's error, at the
 * modifier.
 */
function boundRefinement(ctx: Ctx, attr: Node): Expr | undefined {
  if (attr.modifier == null) return undefined;
  const modifier = String(attr.modifier);
  // An MX attribute carries the modifier's span; Marko's starts one past the
  // colon after the name.
  const mxAt: number | undefined =
    attr.type === "MxAttribute" ? attr.modifierSpan?.start : undefined;
  const start = attr.loc?.start;
  const nameLength = attr.default ? 0 : String(attr.name).length;
  if (!isRefinementIdentifier(modifier)) {
    const message =
      "Bound attribute refinement shorthand must be a valid JavaScript identifier.";
    if (mxAt !== undefined) fail(message, { span: { start: mxAt, end: mxAt } });
    if (!start) fail(message, attr);
    fail(message, {
      // Marko puts it on the modifier's first character, one past the colon.
      loc: {
        start: { line: start.line, column: start.column + nameLength + 1 },
      },
    });
  }
  const at = mxAt ?? offsetOf(ctx, attr.loc?.start ?? {}) + nameLength + 1;
  return {
    code: modifier,
    shape: "other",
    node: null,
    span: { sourceStart: at, sourceEnd: at + modifier.length },
  };
}

/** Marko refuses a refinement that is not an identifier before any host sees it. */
function rejectBadRefinements(ctx: Ctx, node: Node): void {
  for (const attr of tagAttributesOf(node)) {
    if (isBoundAttr(attr)) boundRefinement(ctx, attr);
  }
}

/** Marko normalizes bindings before tag-specific validation or lowering. */
function validateBoundAttributes(ctx: Ctx, node: Node): void {
  rejectBadRefinements(ctx, node);
  for (const attr of tagAttributesOf(node)) {
    if (!isBoundAttr(attr)) continue;
    // Marko kept a bound value that failed to parse as its parse-error node
    // (`this.#x`, `(a b)`), which this check refused at the value before the
    // parse error was ever read; a compile reports the parse error first.
    if (attr.type === "MxAttribute" && attr.value?.error) {
      fail(
        "Attributes may only be bound to identifiers or member expressions",
        attr.value,
      );
    }
    const value = attrValueOf(ctx, attr);
    if (
      value?.type !== "Identifier" &&
      !(
        (value?.type === "MemberExpression" ||
          value?.type === "OptionalMemberExpression") &&
        value.property?.type !== "PrivateName"
      )
    ) {
      fail(
        "Attributes may only be bound to identifiers or member expressions",
        value,
      );
    }
  }
}

/** Marko's builtin value checks run before any host can drop or claim a tag. */
function validateBuiltinValueAttributes(node: Node, name: string): void {
  if (name === "const" || name === "id") {
    if (tagAttributesOf(node).length > 1) {
      fail(
        `The \`<${name}>\` tag only supports the \`value=\` attribute.`,
        node.name,
      );
    }
  } else if (name === "let" || name === "return") {
    let seen = false;
    for (const attr of tagAttributesOf(node)) {
      if (!isAttributeNode(attr) || attrNameOf(attr) !== "value") continue;
      if (seen) fail("Invalid duplicate value attribute.", attr);
      seen = true;
    }
  }
}

/** Resolves one attribute of an element or component call. */
function lowerAttr(
  ctx: Ctx,
  attr: Node,
  on: "element" | "component" = "element",
  isElement = false,
  tagLoc?: Position,
): Attr {
  const lowered = lowerAttrNamed(ctx, attr, on, isElement, tagLoc);
  // Name sugar (decision 146): remember the token the author wrote, so a
  // diagnostic on the attribute can say `:email` (`name`).
  if (attr?.sugarLabel && lowered.kind !== "spread") {
    lowered.sugar = attr.sugarLabel;
  }
  if (attr?.sugarValueOf && lowered.kind !== "spread") {
    lowered.sugarValueOf = attr.sugarValueOf;
  }
  const args = attrArgsOf(attr);
  if (args && lowered.kind !== "spread") {
    lowered.args = args.map((arg: Node) => exprOf(ctx, arg));
  }
  return lowered;
}

function lowerAttrNamed(
  ctx: Ctx,
  attr: Node,
  on: "element" | "component" = "element",
  isElement = false,
  tagLoc?: Position,
): Attr {
  // A shorthand `#id`/`.class` attribute has no position of its own in
  // Marko's AST; it belongs to its tag, so an error about it points there
  // instead of at 0:0.
  // A merged sugar `class` reports at its first sugar token, even when the
  // attribute is the tag's own shorthand (no position of its own).
  const loc = attr?.sugarAt
    ? attr.sugarAt
    : attr?.loc || attr?.start
      ? posOf(ctx, attr)
      : (tagLoc ?? posOf(ctx, attr));
  const nameSpan = attrNameSpan(ctx, attr, tagLoc);
  // Read once, where Marko's lowering first read `attr.value`: an MX value
  // container can fail (`payloadOf`), and a method's function is rebuilt.
  let valueNode: Node;
  let valueRead = false;
  const readValue = (): Node => {
    if (!valueRead) {
      valueNode = attrValueOf(ctx, attr);
      valueRead = true;
    }
    return valueNode;
  };

  if (isSpreadAttributeNode(attr)) {
    return { kind: "spread", value: exprOf(ctx, readValue()), loc };
  }

  // Marko rejects a name outside its grammar for every tag; only a host with
  // its own attribute syntax opts out (`acceptsForeignAttrNames`). A modifier (`class:x`) is
  // `name` + `modifier` here, both valid, and goes through its own branch.
  if (
    !ctx.declarations.acceptsForeignAttrNames &&
    typeof attr.name === "string" &&
    !ATTR_NAME.test(attr.name)
  ) {
    fail(
      `Invalid attribute name \`${attr.name}\` — ${foreignAttrHint(attr.name, productOf(ctx))}`,
      attr,
    );
  }

  // Preserve the parser's last-colon split, including an empty modifier.
  // Bound attributes retain the base name: Marko uses the modifier as a value
  // conversion there, not as part of the rendered attribute name.
  const name =
    !isBoundAttr(attr) && isOrdinaryColonName(attr, isElement)
      ? `${attr.name}:${attr.modifier}`
      : attrNameOf(attr);

  if (isElement && attr.modifier === "" && attr.name === "on") {
    fail("`on:` is not a valid attribute, did you mean `on`?", attr);
  }

  // Ordinary native colon names are not handler methods. Marko rejects a
  // function value before checking arguments, at the authored attribute name.
  // Events and component props still use their host's callable-prop policy.
  if (
    isElement &&
    isOrdinaryColonName(attr, isElement) &&
    !EVENT_ATTR.test(String(name))
  ) {
    const value = readValue();
    if (
      value?.type === "FunctionExpression" ||
      value?.type === "ArrowFunctionExpression"
    ) {
      fail(`The \`${name}\` attribute cannot be a function.`, attr);
    }
    if (attrArgsOf(attr)) {
      fail(`Unsupported arguments on the \`${name}\` attribute.`, attr);
    }
  }

  if (attrArgsOf(attr) || isMethodAttr(attr)) {
    const hooked = markoViewOf(ctx, attr);
    if (ctx.declarations.resolveAttributeMethod?.(hooked, on) !== true) {
      ctx.declarations.rejectAttributeMethod?.(hooked, on);
      fail(
        `attribute method \`${attrNameOf(attr)}(...)\` is an event handler and requires a runtime; standalone ${productOf(ctx)} renders once to a string`,
        attr,
      );
    }
  }

  if (isBoundAttr(attr)) {
    const refinement = boundRefinement(ctx, attr);
    return {
      kind: "bound",
      name: attrNameOf(attr),
      nameSpan,
      value: exprOf(ctx, readValue()),
      ...(refinement ? { refinement } : {}),
      loc,
    };
  }

  // `class:foo="x"` is a modifier Marko hands over as a base name plus a
  // modifier. Emitting only the base name renders `class="x"` — not a drop but
  // a *wrong* attribute, which is worse. The host gets first refusal so the
  // diagnostic is in its own vocabulary (a Marko-parity target quotes Marko's
  // own fix-it); the core's wording is only the fallback.
  if (attr.modifier != null && name === attr.name) {
    const hookView = markoViewOf(ctx, attr);
    const resolvedName = ctx.declarations.resolveModifier?.(hookView, on);
    if (resolvedName !== undefined) {
      return {
        kind: "dynamic",
        name: resolvedName,
        nameSpan,
        value: exprOf(ctx, readValue()),
        loc,
      };
    }
    // The tag kind travels with the rejection: a modifier on a *component*
    // call is a different diagnostic from one on an element, and the pre-IR
    // walk said so ("… on a component call is not supported"). Losing that
    // distinction was a message regression even though both still fail.
    ctx.declarations.rejectModifier?.(hookView, on);
    fail(
      `attribute modifier \`${attr.name}:${attr.modifier}\` is not supported in a standalone template`,
      attr,
    );
  }

  const value = readValue();
  // `<div :foo/>`: HTML's valueless attribute is an attribute *present with an
  // empty value* — `<div value:foo>` and `<div value:foo="">` are one thing to
  // every HTML parser — and that is what Marko emits (`<div value:foo>`, probed
  // through the real toolchain). Handing a host a `true` instead is how this
  // attribute diverged per renderer: React warns "Received `true` for a
  // non-boolean attribute" and drops it, Hono renders `value:foo="true"`, and
  // only Preact happens to print Marko's own form. The empty string is the one
  // value every host renders as the attribute Marko wrote.
  if (
    name !== attrNameOf(attr) &&
    value?.type === "BooleanLiteral" &&
    value.value
  ) {
    // The empty value has no characters, but it has a position: the end of
    // the spelled name. A consumer that slices `valueSpan` (the data tree)
    // gets a zero-width span instead of an invariant failure.
    const at = nameSpan.sourceEnd;
    return {
      kind: "static",
      name,
      value: "",
      valueSpan: { sourceStart: at, sourceEnd: at },
      nameSpan,
      loc,
    };
  }
  // A bare attribute (`download`, `checked`) is HTML's spelling of `true`.
  if (value?.type === "BooleanLiteral" && value.value === true) {
    return { kind: "boolean", name, nameSpan, loc };
  }
  if (value?.type === "StringLiteral") {
    // Decision 156: a whole-value atom (`mode=:strict`, or the `name` the
    // `:name` sugar sets) is still a static string to every target; the IR
    // marks it so a data consumer or contract can tell it from `"strict"`.
    const atom = atomOf(value);
    // Decision 182 addendum 5: a whole-value member a syntax module built
    // (`ctx.attribute(name, { kind: "member", name })`), marked the same way.
    const member = atom ? undefined : memberOf(value);
    return {
      kind: "static",
      name,
      value: value.value,
      valueSpan: exprSpan(ctx, value),
      nameSpan,
      loc,
      ...(atom ? { atom } : {}),
      ...(member ? { member } : {}),
    };
  }
  // An event attribute is `on<Name>` or `on-<exact>`, and only on a native
  // element: on a component call, a `<define>` call, a custom tag, a host tag
  // (`<try onClick=fn>`) or an attribute tag, `on*` is the author's own prop
  // contract and stays a `dynamic` prop. `on` is a real signal for the three
  // `HostDeclarations` hooks above and must keep its two cases, so the element
  // gate travels as its own boolean rather than a third `on` value.
  //
  // Placed *after* the boolean and string checks, so the kind is derived only
  // when the value is an **expression**. A bare `<div onClick>` is HTML's
  // spelling of `true` and stays `boolean`; `<button onClick="alert(1)">` is
  // an ordinary HTML attribute string and stays `static` (MX does not invent a
  // policy against inline handlers — it only stops *creating* one from a
  // function). Deriving the kind before these checks changed real output:
  // `<div onClick>` rendered as `<div onClick="true">` on html, and Angular
  // emitted `(click)="(true)($event)"`.
  //
  // The attribute-method form (`onClick() { … }`) reaches here too: the check
  // above lets it through on a host that allows methods, and `exprOf` gives
  // the same arrow-function `Expr` the handler-prop form produces, so a host
  // implements one branch and not two.
  //
  // No `!attr.modifier` guard is needed: reserved native prefixes go through
  // the modifier hook above. Other colon names keep their complete spelling:
  // `onClick:foo` is an event, but lowercase `oncapture:click` is an ordinary
  // attribute, not an event or a capture-mode alias.
  if (isElement && EVENT_ATTR.test(String(name))) {
    const eventName = String(name);
    if (eventName === "on-") {
      fail("`on-` needs an event name (`on-<event>`)", attr);
    }
    const event =
      eventName[2] === "-"
        ? eventName.slice(3)
        : eventName.slice(2).toLowerCase();
    warnOnNonDomEventSpelling(ctx, attr, eventName);
    return {
      kind: "event",
      name: eventName,
      event,
      value: exprOf(ctx, value),
      nameSpan,
      loc,
    };
  }

  return {
    kind: "dynamic",
    name,
    value: exprOf(ctx, value),
    nameSpan,
    loc,
  };
}

function lowerAttrs(
  ctx: Ctx,
  node: Node,
  name: string,
  on: "element" | "component" = "element",
  isElement = false,
): Attr[] {
  rejectBadRefinements(ctx, node);
  const lowered = tagAttributesOf(node).map((attr: Node) =>
    lowerAttr(ctx, attr, on, isElement, posOf(ctx, node)),
  );
  rejectSecondMember(lowered);
  const attrs = resolveDuplicateAttrs(ctx, lowered);
  return ctx.declarations.orderAttrs?.(name, attrs, on, ctx) ?? attrs;
}

/**
 * A second member in one name slot (`sort asc &c &d`) is an error, not a
 * duplicate dropped with a warning (decision 182, lead ruling on PR 451):
 * a syntax module's attribute name is a slot, and two members in it is a
 * mistake the author must see. Positioned at the second member.
 */
function rejectSecondMember(attrs: readonly Attr[]): void {
  const first = new Map<string, Member>();
  for (const attr of attrs) {
    if (attr.kind !== "static" || !attr.member) continue;
    const held = first.get(attr.name);
    if (!held) {
      first.set(attr.name, attr.member);
      continue;
    }
    fail(
      `one member per slot: \`${attr.name}\` already holds \`${held.name}\`, so this member cannot also set it`,
      {
        type: "MxTrigger",
        start: attr.member.span.sourceStart,
        end: attr.member.span.sourceEnd,
      },
    );
  }
}

/**
 * Resolves a repeated attribute name to its last occurrence (decision 135).
 * Stock Marko 6.3.51 is last-wins (`class` and `style` are not merged, and the
 * dropped value is never evaluated), and `<div class="a" id="x" class="b">`
 * compiles to `<div id=x class=b>`: the survivor keeps its own position. MX
 * does the same once, here, so the IR carries one attribute per resolved name
 * and no target or delegated-tag consumer ever sees a duplicate.
 *
 * Dropping the earlier occurrence is safe even with a spread between them:
 * `<div a=1 ...x a=2>` already had `a=2` winning over `x.a`.
 *
 * Names compare case-sensitively, as Marko's do, on the resolved `Attr.name`,
 * so `on-click` twice is a duplicate and `onClick` next to `on-click` is not
 * (Marko registers both handlers). A default attribute (`<input="a" value="b">`)
 * is already named `value`. A spread (`...attrs`) has no static name, so it
 * never counts.
 *
 * Each dropped occurrence gets one decision-133 warning, positioned at its
 * name and naming the survivor, so three occurrences warn twice. The text's
 * `line:column` is 1-based, like `mx-tsc` and editors; the structured warning
 * position keeps core's 0-based column. Never an error, `mx.strict` included.
 */
function resolveDuplicateAttrs(ctx: Ctx, attrs: Attr[]): Attr[] {
  const survivor = new Map<string, Exclude<Attr, { kind: "spread" }>>();
  for (const attr of attrs) {
    if (attr.kind !== "spread") survivor.set(attr.name, attr);
  }
  const kept: Attr[] = [];
  for (const attr of attrs) {
    const winner = attr.kind === "spread" ? undefined : survivor.get(attr.name);
    if (attr.kind === "spread" || !winner || winner === attr) {
      kept.push(attr);
      continue;
    }
    // A dropped occurrence: warn in document order, at its own name.
    const at = positionAtOffset(ctx, attr.nameSpan.sourceStart);
    const wins = positionAtOffset(ctx, winner.nameSpan.sourceStart);
    warn(ctx, {
      message: `duplicate attribute ${attrLabel(attr)}: the later one${winner.sugar ? ` (${attrLabel(winner)})` : ""} at ${wins.line}:${wins.column + 1} wins, so this one is dropped`,
      line: at.line,
      column: at.column,
      file: ctx.filename,
    });
  }
  return kept;
}

/**
 * A tag param Babel could not read (`<define/Foo|{a=}|>`) arrives in a recovered
 * parse (`parseFragment`) as a `MarkoParseError` node, which binds no names and
 * has no source of its own to print. It fails here at the parser's position,
 * with the parser's reason, rather than lowering as a param that binds nothing.
 */
function rejectUnreadableParams(ctx: Ctx, node: Node): void {
  for (const param of tagParamsOf(node)) {
    if (param?.type === "MarkoParseError") exprOf(ctx, param);
  }
}

/** The tag params of `<for|a, b|>` / `<@name|p|>`, as source text. */
function paramsOf(ctx: Ctx, node: Node): string[] {
  rejectUnreadableParams(ctx, node);
  return tagParamsOf(node).map((p: Node) => {
    // Babel's generator omits a TypeScript annotation when an Identifier is
    // printed outside its parameter-list context. The Marko node's location
    // covers the complete authored pattern, so use that exact source text for
    // params and preserve annotations as well as destructuring.
    const source = p.loc ? sliceLoc(ctx, p.loc) : "";
    return source || declName(ctx, p);
  });
}

/**
 * File-absolute byte spans of `<for|a, b|>` / `<define|p|>` params, one per
 * `paramsOf`/`paramNodes` entry — same convention as `Expr.span`, `undefined`
 * for a param whose node carries no `loc`.
 *
 * Exported for `lower.test.ts` alone, to unit-test the no-`loc` guard
 * directly against a synthesized param node — same rationale as `exprOf`'s
 * own export comment above.
 */
export function paramSpansOf(
  ctx: Ctx,
  node: Node,
): Array<SourceSpan | undefined> {
  return tagParamsOf(node).map((p: Node) => exprSpan(ctx, p));
}

/** Marko keeps non-empty params as nodes but represents both absent and `||` as `[]`. */
function hasParams(ctx: Ctx, node: Node): boolean {
  if (tagParamsOf(node).length > 0) return true;
  const source = sliceNode(ctx, node);
  const openEnd = source.indexOf(">");
  return (openEnd < 0 ? source : source.slice(0, openEnd)).includes("||");
}

/**
 * Every name a tag's params bind, for shadowing.
 *
 * Also registers each into `ctx.unknownLocalValue`: a tag param's runtime
 * value can never be inspected at lowering time (local extension of decision
 * 116), so it is unconditionally "unknown" whenever used as a tag — unlike
 * `unknownLocalValue`'s other entries, a param name never needs removing on
 * unshadow, since outside its scope it is no longer `ctx.tagVarShadowed`
 * either and so never reaches `fileLocalBinding` at all.
 */
function paramBindings(ctx: Ctx, node: Node): string[] {
  rejectUnreadableParams(ctx, node);
  const names = tagParamsOf(node).flatMap((p: Node) => bindingIdentifiers(p));
  for (const name of names) ctx.unknownLocalValue.add(name);
  return names;
}

/**
 * A child list lowered as a callable block, with its params shadowing.
 *
 * A block's params are in scope for its own body only: inside
 * `<@footer|year|>`, `year` is the parameter, not any host binding of the same
 * name. Restored on the way out.
 */
function lowerBlock(ctx: Ctx, node: Node, body = bodyChildren(node)): Block {
  // A block is its own JS scope: both the params it shadows *and* anything a
  // `<const>` inside it unregisters are confined to it.
  const unscope = scopeBindings(ctx);
  const restore = shadowBindings(ctx, paramBindings(ctx, node));
  const children = lowerChildren(ctx, body);
  restore();
  unscope();
  return {
    hasParams: hasParams(ctx, node),
    params: paramsOf(ctx, node),
    children,
    loc: posOf(ctx, node),
  };
}

interface AttrSchema {
  declarations?: Map<string, AttrTagDecl>;
  otherProps?: Set<string>;
  open: boolean;
  owner: string;
  collisionOwner?: Node;
  /** Decision 138: a registered tag owns recursive bound-literal checks. */
  customTagContract?: boolean;
}

interface LoweredAttributeTags {
  flat: AttributeTag[];
  tree: AttributeTagNode[];
  props: AttrTagProp[];
  contentChildren: Node[];
}

function requireAttrTagsV2(
  ctx: Ctx,
  construct: string,
  verb: "isn't" | "aren't",
  node: Node,
): void {
  if (ctx.declarations.attrTags === 2) return;
  fail(
    `${construct} ${verb} supported by ${ctx.declarations.name ?? "the current host"} yet`,
    node,
  );
}

function attrName(node: Node): string {
  return String(tagNameOf(node) ?? "").replace(/^@/, "");
}

/**
 * The span of an attribute tag's name, `@` excluded. Both parsers start the
 * name's span at the `@`: Marko keeps it in `name.value`, the MX front end
 * drops it from `value` but not from `name.span` (ast §3.7).
 */
function attributeTagNameSpan(ctx: Ctx, node: Node): SourceSpan {
  if (node.type === "MxAttributeTag") {
    return {
      sourceStart: node.name.span.start + 1,
      sourceEnd: node.name.span.end,
    };
  }
  const span = nodeSpan(ctx, tagNameSpanOf(node));
  return { sourceStart: span.sourceStart + 1, sourceEnd: span.sourceEnd };
}

function isLayout(node: Node): boolean {
  return isCommentNode(node) || (isTextNode(node) && node.value.trim() === "");
}

function isControl(node: Node): boolean {
  const name = String(tagNameOf(node) ?? "").replace(/^@/, "");
  return isTagNode(node) && (name === "if" || name === "for");
}

function containsAttributeTags(node: Node): boolean {
  // Hybrid for transition: check Marko `attributeTags` field AND MX body children
  if ((node.attributeTags ?? []).length > 0) return true;
  const body = bodyChildren(node);
  return body.some(
    (c) => isMxAttributeTag(c) || (isControl(c) && containsAttributeTags(c)),
  );
}

/**
 * Marko forbids mixing a named custom tag's positional args with prop-like
 * input (`assertAttributesOrSingleArg`, `data/marko/packages/compiler/src/
 * babel-utils/assert.js:89-107`) — strict for a named custom tag only.
 *
 * A dynamic `<${expr}>` tag and a `<define>` call are different: both compile
 * through the *dynamic-tag* visitor (`dynamic-tag.ts:132-137`'s
 * `defineBodySection` check routes a `<define>` call there too), whose own
 * rule (`assertAttributesOrArgs`, `assert.js:74-82`) is lenient — it allows
 * args plus a body/attribute tag (Marko's "dynamic tag fallback content"),
 * and only rejects args plus a plain *attribute*. `target` absent, or
 * `"dynamic"`/`"define"`, takes this lenient rule; `"name"` stays strict.
 */
function rejectArgsWithProps(node: Node, target?: ComponentTarget): void {
  if ((tagArgsOf(node) ?? []).length === 0) return;
  const lenient =
    !target || target.kind === "dynamic" || target.kind === "define";
  if (lenient) {
    if (tagAttributesOf(node).length === 0) return;
    fail(
      "Tag does not support arguments when attributes present.",
      tagNameSpanOf(node) ?? node,
    );
  }
  if (
    tagAttributesOf(node).length === 0 &&
    !containsAttributeTags(node) &&
    !hasContent(bodyChildren(node))
  ) {
    return;
  }
  fail(
    "Tag does not support arguments when attributes or body present.",
    tagNameSpanOf(node) ?? node,
  );
}

/**
 * A `<define>` call without tag arguments hands the define ONE object (its
 * attributes, attribute tags and `content`) as its first param; every later
 * param is `undefined` (Marko 6.3.51). Before that was fixed, MX looked each
 * param up by name in the call, so `<define/Card|title, head|>` called as
 * `<Card title="a"/>` bound `title` to `"a"`. The source still compiles and now
 * binds `title` to the whole object, so the call is flagged at its tag name.
 */
function warnDefineExtraParams(
  ctx: Ctx,
  node: Node,
  name: string,
  params: string[],
): void {
  if (!ctx.declarations.defineCallPassesAttrs) return;
  if (params.length < 2 || (tagArgsOf(node) ?? []).length > 0) return;
  const carries =
    tagAttributesOf(node).length > 0 ||
    containsAttributeTags(node) ||
    hasContent(bodyChildren(node));
  if (!carries) return;
  const pos = posOf(ctx, tagNameSpanOf(node) ?? node);
  warn(ctx, {
    message: `\`<${name}>\` has ${params.length} params, but only the first parameter receives the attributes object; destructure it (\`|{ a, b }|\`) instead of reading one param per attribute`,
    line: pos.line,
    column: pos.column,
    file: ctx.filename,
  });
}

function validateParentCollision(node: Node, schema: AttrSchema): void {
  const owner = schema.collisionOwner;
  if (!owner) return;
  const parentAttrs = new Set(
    tagAttributesOf(owner)
      .filter((attr: Node) => !isSpreadAttributeNode(attr))
      .map((attr: Node) => attrNameOf(attr)),
  );
  const name = attrName(node);
  if (parentAttrs.has(name)) {
    fail(
      `attribute tag \`@${name}\` collides with attribute \`${name}\``,
      tagNameSpanOf(node) ?? node,
    );
  }
}

function schemaFor(input: CalleeInput, owner: string): AttrSchema {
  if (input.kind === "declared") {
    return {
      declarations: input.attrTags,
      otherProps: input.otherProps,
      open: input.open,
      owner,
    };
  }
  return { open: true, owner };
}

/**
 * A position inside a file, for the `file:line:column` a message names.
 *
 * `column` is **1-based**, because every position MX prints is, like
 * `mx-tsc`'s `file(line,column)` and every editor's (ruling #227). The
 * structured warning/error positions consumers read stay 0-based (Babel's
 * base); only the text is converted, at the print site.
 */
function spanPosition(
  ctx: Ctx,
  span: { file?: string; sourceStart: number },
): { file: string; line: number; column: number } {
  const file = span.file ?? ctx.filename;
  let source = ctx.source;
  if (file !== ctx.filename) {
    try {
      source = readFileSync(file, "utf8");
    } catch {
      source = "";
    }
  }
  const before = source.slice(0, span.sourceStart);
  const line = before.split("\n").length;
  const lastLine = before.lastIndexOf("\n");
  return {
    file,
    line,
    column: span.sourceStart - lastLine + 1,
  };
}

function cleanParseMessage(message: string): string {
  return message.replace(/\s*\(\d+:\d+\)\s*$/, "");
}

/** Raises only an invalid declaration used by this particular call site. */
function raiseInvalidCalleeInput(
  ctx: Ctx,
  input: CalleeInput,
  owner: string,
  tags: AttributeTag[],
): void {
  if (input.kind !== "invalid" || tags.length === 0) return;
  const firstTag = tags[0];
  if (!firstTag) return;
  const parseError = input.errors.get("<parse>");
  if (parseError) {
    const position = spanPosition(ctx, parseError.span);
    fail(
      `can't read \`<${owner}>\`'s Input (${position.file}:${position.line}:${position.column}): ${cleanParseMessage(parseError.message)}`,
      { loc: { start: attributeTagNamePosition(ctx, firstTag) } },
    );
  }
  for (const tag of tags) {
    const entry = [...input.errors].find(
      ([name]) => name === tag.name || name.startsWith(`${tag.name}.`),
    );
    if (!entry) continue;
    const [name, error] = entry;
    const position = spanPosition(ctx, error.span);
    fail(
      `can't read \`<${owner}>\`'s declaration of \`${name}\` (${position.file}:${position.line}); ${error.message}`,
      { loc: { start: attributeTagNamePosition(ctx, tag) } },
    );
  }
}

/** A component's own malformed Input is an error even before it is called. */
function raiseInvalidOwnInput(ctx: Ctx, input: CalleeInput): void {
  if (input.kind !== "invalid") return;
  const [name, error] = input.errors.entries().next().value ?? [];
  if (!name || !error) return;
  const position = spanPosition(ctx, error.span);
  const message =
    name === "<parse>"
      ? `can't read this component's Input (${position.file}:${position.line}:${position.column}): ${cleanParseMessage(error.message)}`
      : `can't read this component's declaration of \`${name}\` (${position.file}:${position.line}); ${error.message}`;
  try {
    fail(message, {
      loc: { start: positionAtOffset(ctx, error.span.sourceStart) },
    });
  } catch (cause) {
    if (cause && typeof cause === "object") {
      Object.defineProperty(cause, CALLEE_INPUT_ERROR, { value: input });
    }
    throw cause;
  }
}

function declarationFor(
  schema: AttrSchema,
  name: string,
  node: Node,
): AttrTagDecl | undefined {
  const declaration = schema.declarations?.get(name);
  if (declaration) return declaration;
  if (schema.otherProps?.has(name)) {
    fail(
      `\`${name}\` is declared as a plain prop; declare it \`AttrTag\` to pass it as \`<@${name}>\``,
      tagNameSpanOf(node) ?? node,
    );
  }
  if (schema.declarations && !schema.open) {
    fail(
      `\`<${schema.owner}>\` declares no attribute tag \`${name}\``,
      tagNameSpanOf(node) ?? node,
    );
  }
  return undefined;
}

function filterAttributeTagNodes(
  nodes: AttributeTagNode[],
  name: string,
): AttributeTagNode[] {
  const filtered: AttributeTagNode[] = [];
  for (const node of nodes) {
    if (node.kind === "AttributeTag") {
      if (node.tag.name === name) filtered.push(node);
      continue;
    }
    if (node.kind === "AttributeTagIf") {
      const branches = node.branches.map((branch) => ({
        ...branch,
        nodes: filterAttributeTagNodes(branch.nodes, name),
      }));
      if (branches.some((branch) => branch.nodes.length > 0)) {
        filtered.push({ ...node, branches });
      }
      continue;
    }
    const nested = filterAttributeTagNodes(node.nodes, name);
    if (nested.length > 0) filtered.push({ ...node, nodes: nested });
  }
  return filtered;
}

function occurrenceRange(
  nodes: AttributeTagNode[],
  name: string,
): { min: number; max: number; inFor: boolean; conditional: boolean } {
  let min = 0;
  let max = 0;
  let inFor = false;
  let conditional = false;
  for (const node of nodes) {
    if (node.kind === "AttributeTag") {
      if (node.tag.name === name) {
        min++;
        max++;
      }
      continue;
    }
    if (node.kind === "AttributeTagFor") {
      const inner = occurrenceRange(node.nodes, name);
      if (inner.max > 0) {
        inFor = true;
        min += 0;
        max = Number.POSITIVE_INFINITY;
      }
      continue;
    }
    const ranges = node.branches.map((branch) =>
      occurrenceRange(branch.nodes, name),
    );
    const hasElse = node.branches.some((branch) => branch.test === undefined);
    if (!hasElse)
      ranges.push({ min: 0, max: 0, inFor: false, conditional: true });
    min += Math.min(...ranges.map((range) => range.min));
    max += Math.max(...ranges.map((range) => range.max));
    inFor ||= ranges.some((range) => range.inFor);
    conditional ||= ranges.some((range) => range.max > 0);
  }
  return { min, max, inFor, conditional };
}

function firstNodeOfKind(
  nodes: AttributeTagNode[],
  kind: "AttributeTagIf" | "AttributeTagFor",
): AttributeTagNode | undefined {
  for (const node of nodes) {
    if (node.kind === kind) return node;
    if (node.kind === "AttributeTagFor") {
      const nested = firstNodeOfKind(node.nodes, kind);
      if (nested) return nested;
    } else if (node.kind === "AttributeTagIf") {
      for (const branch of node.branches) {
        const nested = firstNodeOfKind(branch.nodes, kind);
        if (nested) return nested;
      }
    }
  }
  return undefined;
}

function planAttributeTags(
  ctx: Ctx,
  tree: AttributeTagNode[],
  flat: AttributeTag[],
  schema: AttrSchema,
  ownerNode: Node,
): AttrTagProp[] {
  const names: string[] = [];
  for (const tag of flat) if (!names.includes(tag.name)) names.push(tag.name);
  for (const [name, declaration] of schema.declarations ?? []) {
    if (declaration.cardinality === "array" && !names.includes(name))
      names.push(name);
    if (declaration.cardinality === "required" && !names.includes(name)) {
      fail(
        `missing required attribute tag \`<@${name}>\``,
        ownerNode.name ?? ownerNode,
      );
    }
  }

  return names.map((name) => {
    const declaration = schema.declarations?.get(name);
    const range = occurrenceRange(tree, name);
    if (declaration && declaration.cardinality !== "array") {
      const occurrences = flat.filter((tag) => tag.name === name);
      const first = occurrences[0];
      if (range.inFor) {
        const loop = firstNodeOfKind(
          filterAttributeTagNodes(tree, name),
          "AttributeTagFor",
        );
        fail(
          `\`<@${name}>\` may not appear inside \`<for>\` (\`${name}\` is declared \`AttrTag\`, not \`AttrTag[]\`)`,
          loop ? { loc: { start: loop.loc } } : ownerNode,
        );
      }
      if (range.max > 1) {
        const repeated = occurrences[1] ?? first;
        fail(
          `\`<@${name}>\` may appear at most once (\`${name}\` is declared \`AttrTag\`, not \`AttrTag[]\`)`,
          repeated
            ? { loc: { start: attributeTagNamePosition(ctx, repeated) } }
            : ownerNode,
        );
      }
      if (declaration.cardinality === "required" && range.min === 0) {
        const conditional = firstNodeOfKind(
          filterAttributeTagNodes(tree, name),
          "AttributeTagIf",
        );
        fail(
          `\`<@${name}>\` is required but not provided on every \`<if>\` path`,
          conditional ? { loc: { start: conditional.loc } } : ownerNode,
        );
      }
    }

    const fallbackCardinality =
      range.max <= 1 && !range.inFor ? "single" : "array";
    const cardinality =
      declaration?.cardinality === "array"
        ? "array"
        : declaration
          ? "single"
          : fallbackCardinality;
    const as = declaration?.as ?? fallbackAttrTagShape(flat, name);
    const flatCardinality =
      flat.filter((tag) => tag.name === name).length > 1 ? "array" : "single";
    if (
      declaration &&
      (as === "data" ||
        cardinality !== flatCardinality ||
        (cardinality === "array" && range.max === 0))
    ) {
      requireAttrTagsV2(
        ctx,
        `the declared shape of \`<@${name}>\``,
        "isn't",
        ownerNode.name ?? ownerNode,
      );
    }
    const prop: AttrTagProp = {
      name,
      cardinality,
      as,
      source: filterAttributeTagNodes(tree, name),
    };
    if (declaration) Object.defineProperty(prop, "declared", { value: true });
    return prop;
  });
}

function lowerOneAttributeTag(
  ctx: Ctx,
  node: Node,
  schema: AttrSchema,
): AttributeTag {
  const pop = pushAuthoredAncestor(ctx, `@${attrName(node)}`, node);
  try {
    return lowerAuthoredAttributeTag(ctx, node, schema);
  } finally {
    pop();
  }
}

function lowerAuthoredAttributeTag(
  ctx: Ctx,
  node: Node,
  schema: AttrSchema,
): AttributeTag {
  const name = attrName(node);
  if (schema.customTagContract) rejectBadRefinements(ctx, node);
  else validateBoundAttributes(ctx, node);
  const declaration = declarationFor(schema, name, node);
  validateParentCollision(node, schema);
  const attrs = tagAttributesOf(node);
  const contentAttr = attrs.find(
    (attr: Node) =>
      !isSpreadAttributeNode(attr) && attrNameOf(attr) === "content",
  );
  if (contentAttr) {
    fail(
      "`content` is reserved on an attribute tag; it names the body",
      contentAttr,
    );
  }
  if (attrs.length > 0) {
    requireAttrTagsV2(
      ctx,
      `\`<@${name}>\`: attributes on attribute tags`,
      "aren't",
      attrs[0],
    );
  }
  if (declaration?.as === "renderable" && attrs.length > 0) {
    fail(
      `\`<@${name}>\` is renderable in \`<${schema.owner}>\`; it can't take attributes`,
      tagNameSpanOf(node) ?? node,
    );
  }
  const hasParamsAtCall = hasParams(ctx, node);
  if (declaration && declaration.hasParams !== hasParamsAtCall) {
    fail(
      declaration.hasParams
        ? `\`<@${name}>\` declares params in \`<${schema.owner}>\`; add \`|…|\``
        : `\`<@${name}>\` declares no params in \`<${schema.owner}>\`; remove \`|…|\``,
      tagNameSpanOf(node) ?? node,
    );
  }

  const nestedSchema: AttrSchema = declaration
    ? {
        declarations: declaration.nested,
        open: declaration.nestedOpen,
        owner: `@${name}`,
      }
    : { open: true, owner: `@${name}` };
  nestedSchema.customTagContract = schema.customTagContract;

  const unscope = scopeBindings(ctx);
  const restore = shadowBindings(ctx, paramBindings(ctx, node));
  const nested = lowerAttributeTags(ctx, node, nestedSchema);
  const block: Block = {
    hasParams: hasParamsAtCall,
    params: paramsOf(ctx, node),
    children: lowerChildren(ctx, nested.contentChildren),
    loc: posOf(ctx, node),
  };
  restore();
  unscope();

  if (nested.flat.length > 0) {
    const firstAttrTag = firstAttributeTag(node) ?? node;
    requireAttrTagsV2(
      ctx,
      `\`<@${name}>\`: nested attribute tags`,
      "aren't",
      firstAttrTag,
    );
    if (declaration?.as === "renderable") {
      fail(
        `\`<@${name}>\` is renderable in \`<${schema.owner}>\`; it can't take attributes or nested attribute tags`,
        tagNameSpanOf(node) ?? node,
      );
    }
  }

  return {
    name,
    nameSpan: attributeTagNameSpan(ctx, node),
    span: exprSpan(ctx, node),
    attrs: lowerAttrs(ctx, node, name, "component"),
    block,
    hasBody: hasContent(nested.contentChildren),
    attributeTags: nested.flat,
    attributeTagTree: nested.tree,
    attrTagProps: nested.props,
    loc: posOf(ctx, node),
  };
}

function lowerAttributeFor(
  ctx: Ctx,
  node: Node,
  schema: AttrSchema,
): AttributeTagNode {
  requireAttrTagsV2(ctx, "attribute tags inside `<for>`", "aren't", node);
  const loop = lowerForHead(ctx, node, true);
  const unscope = scopeBindings(ctx);
  const restore = shadowBindings(ctx, loop.bindings);
  const lowered = lowerAttributeTags(ctx, node, schema, true, false);
  restore();
  unscope();
  return {
    kind: "AttributeTagFor",
    loop,
    nodes: lowered.tree,
    loc: posOf(ctx, node),
  };
}

function lowerAttributeIf(
  ctx: Ctx,
  siblings: Node[],
  index: number,
  schema: AttrSchema,
): [AttributeTagNode, number] {
  const first = siblings[index];
  requireAttrTagsV2(ctx, "attribute tags inside `<if>`", "aren't", first);
  const branches: Array<{
    test?: Expr;
    span: SourceSpan;
    nodes: AttributeTagNode[];
  }> = [];
  const branchContent: Node[] = [];
  let cursor = index;
  // Layout after the chain's last branch is not the chain's: a comment
  // there belongs to the parent's next sibling (Marko moved it out first).
  let end = index;
  while (cursor < siblings.length) {
    const branch = siblings[cursor];
    const name = String(tagNameOf(branch) ?? "").replace(/^@/, "");
    if (cursor > index && name !== "else" && name !== "else-if") break;
    validateBoundAttributes(ctx, branch);
    const conditionAttr =
      name === "if"
        ? (attrByName(branch, "value") ?? tagAttributesOf(branch)[0])
        : name === "else-if"
          ? (attrByName(branch, "value") ?? tagAttributesOf(branch)[0])
          : attrByName(branch, "if");
    const unscope = scopeBindings(ctx);
    const lowered = lowerAttributeTags(ctx, branch, schema, true, false);
    unscope();
    branches.push({
      ...(conditionAttr
        ? { test: exprOf(ctx, attrValueOf(ctx, conditionAttr)) }
        : {}),
      span: nodeSpan(ctx, branch),
      nodes: lowered.tree,
    });
    branchContent.push(
      ...lowered.contentChildren.filter((child: Node) => !isLayout(child)),
    );
    cursor++;
    end = cursor;
    while (cursor < siblings.length && isLayout(siblings[cursor])) cursor++;
    if (!conditionAttr) break;
  }
  if (
    branches.some((branch) => branch.nodes.length > 0) &&
    branchContent.length > 0
  ) {
    fail(
      "Cannot have attribute tags and body content under a control flow tag.",
      branchContent[0],
    );
  }
  return [{ kind: "AttributeTagIf", branches, loc: posOf(ctx, first) }, end];
}

function attributeIfChainEnd(body: Node[], index: number): number {
  let cursor = index + 1;
  let end = cursor;
  while (cursor < body.length) {
    while (cursor < body.length && isLayout(body[cursor])) cursor++;
    const branch = body[cursor];
    const name = String(tagNameOf(branch) ?? "").replace(/^@/, "");
    if (name !== "else" && name !== "else-if") break;
    cursor++;
    end = cursor;
    const conditional =
      name === "else-if"
        ? (attrByName(branch, "value") ?? tagAttributesOf(branch)[0])
        : attrByName(branch, "if");
    if (!conditional) break;
  }
  return end;
}

/** Two source-ordered node lists as one, ordered by where each node opens. */
function mergeBySourceOffset(ctx: Ctx, first: Node[], second: Node[]): Node[] {
  const keyed = [...first, ...second].map((node) => ({
    node,
    at: nodeSpan(ctx, node).sourceStart,
  }));
  return keyed.sort((a, b) => a.at - b.at).map(({ node }) => node);
}

/** Lowers direct and control-flow attribute tags, recursively. */
function lowerAttributeTags(
  ctx: Ctx,
  node: Node,
  schema: AttrSchema = { open: true, owner: "dynamic tag" },
  inControl = false,
  makePlan = true,
): LoweredAttributeTags {
  const activeSchema = makePlan ? { ...schema, collisionOwner: node } : schema;
  const candidates: Array<{
    offset: number;
    kind: "tag" | "control";
    node: Node;
    index?: number;
    siblings?: Node[];
  }> = [];
  // Hybrid for transition: Marko puts attribute tags in `attributeTags` field,
  // MX puts them as `MxAttributeTag` nodes in body. Process both sources.
  const directTags = node.attributeTags ?? [];
  // collected up front: the loop below jumps over an `<if>` chain, and the
  // chain scan skips layout comments, so a comment collected in the loop
  // could be skipped with it.
  const hoistedComments: Node[] = directTags.filter((tag: Node) =>
    isCommentNode(tag),
  );
  for (let index = 0; index < directTags.length; index++) {
    const tag = directTags[index];
    if (isCommentNode(tag)) continue;
    if (isControl(tag) && containsAttributeTags(tag)) {
      candidates.push({
        offset: nodeSpan(ctx, tag).sourceStart,
        kind: "control",
        node: tag,
        index,
        siblings: directTags,
      });
      if (String(tagNameOf(tag) ?? "").replace(/^@/, "") === "if") {
        index = attributeIfChainEnd(directTags, index) - 1;
      }
    } else {
      candidates.push({
        offset: nodeSpan(ctx, tag).sourceStart,
        kind: "tag",
        node: tag,
      });
    }
  }
  const body = bodyChildren(node);
  const consumed = new Set<number>();
  for (let index = 0; index < body.length; index++) {
    const child = body[index];
    if (isMxAttributeTag(child) && !isControl(child)) {
      candidates.push({
        offset: nodeSpan(ctx, child).sourceStart,
        kind: "tag",
        node: child,
      });
      consumed.add(index);
      continue;
    }
    if (!isControl(child)) continue;
    const chainEnd =
      tagNameOf(child) === "if" ? attributeIfChainEnd(body, index) : index + 1;
    const hasAttributeTags =
      tagNameOf(child) === "if"
        ? body
            .slice(index, chainEnd)
            .some(
              (branch: Node) =>
                !isLayout(branch) && containsAttributeTags(branch),
            )
        : containsAttributeTags(child);
    if (!hasAttributeTags) continue;
    candidates.push({
      offset: nodeSpan(ctx, child).sourceStart,
      kind: "control",
      node: child,
      index,
    });
  }
  candidates.sort((a, b) => a.offset - b.offset);

  const tree: AttributeTagNode[] = [];
  for (const candidate of candidates) {
    if (candidate.kind === "tag") {
      const tag = lowerOneAttributeTag(ctx, candidate.node, activeSchema);
      tree.push({ kind: "AttributeTag", tag, loc: tag.loc });
    } else if (
      String(tagNameOf(candidate.node) ?? "").replace(/^@/, "") === "for"
    ) {
      tree.push(lowerAttributeFor(ctx, candidate.node, activeSchema));
    } else {
      const [ifNode, next] = lowerAttributeIf(
        ctx,
        candidate.siblings ?? body,
        candidate.index as number,
        activeSchema,
      );
      tree.push(ifNode);
      if (!candidate.siblings) {
        for (let i = (candidate.index as number) + 1; i < next; i++)
          consumed.add(i);
      }
    }
  }

  const controlStarts = new Set(
    candidates
      .filter(
        (candidate) =>
          candidate.kind === "control" && candidate.siblings === undefined,
      )
      .map((candidate) => candidate.index),
  );
  const nonAttrChildren = body.filter(
    (_child: Node, index: number) =>
      !controlStarts.has(index) && !consumed.has(index),
  );
  const contentChildren =
    hoistedComments.length === 0
      ? nonAttrChildren
      : mergeBySourceOffset(ctx, hoistedComments, nonAttrChildren);
  if (inControl && tree.length > 0) {
    const offending = contentChildren.find((child: Node) => !isLayout(child));
    if (offending) {
      fail(
        "Cannot have attribute tags and body content under a control flow tag.",
        offending,
      );
    }
  }

  const flat: AttributeTag[] = [];
  const collect = (nodes: AttributeTagNode[]) => {
    for (const item of nodes) {
      if (item.kind === "AttributeTag") flat.push(item.tag);
      else if (item.kind === "AttributeTagFor") collect(item.nodes);
      else for (const branch of item.branches) collect(branch.nodes);
    }
  };
  collect(tree);
  unifyNestedAttrTagPlanGroups(flat);
  if (makePlan && hasContent(contentChildren)) {
    const childrenTag = flat.find((tag) => tag.name === "children");
    if (childrenTag) {
      fail(
        "attribute tag `@children` collides with the parent's ordinary children",
        {
          loc: {
            start: positionAtOffset(ctx, childrenTag.nameSpan.sourceStart),
          },
        },
      );
    }
  }
  const props = makePlan
    ? planAttributeTags(ctx, tree, flat, activeSchema, node)
    : [];
  return { flat, tree, props, contentChildren };
}

/**
 * `<if>` plus any `<else if>`/`<else>` siblings, grouped into one node.
 *
 * Returns the index of the first sibling it did not consume, so the caller
 * resumes after the whole chain rather than re-reading `<else>` as a tag.
 */
function lowerIfChain(
  ctx: Ctx,
  children: readonly Node[],
  index: number,
): [IrNode, number] {
  const node = children[index];
  validateBoundAttributes(ctx, node);
  rejectUnsupportedFields(ctx, node, "`<if>`");
  const cond = attrByName(node, "value") ?? tagAttributesOf(node)[0];
  if (!cond) fail("`<if>` without a condition", node);

  // Each branch is its own JS block: a `<const>` declared inside one does not
  // shadow the host's binding for the code that follows the chain.
  const branchChildren = (branchNode: Node): IrNode[] => {
    const unscope = scopeBindings(ctx);
    const children = lowerChildren(ctx, bodyChildren(branchNode));
    unscope();
    return children;
  };

  const branches: Branch[] = [
    {
      condition: exprOf(ctx, attrValueOf(ctx, cond)),
      children: branchChildren(node),
      span: exprSpan(ctx, node),
      loc: posOf(ctx, node),
    },
  ];

  let i = index + 1;
  let lastBranch: Node = node;
  while (i < children.length) {
    const child = children[i];
    // Whitespace and comments between branches are layout, not content.
    if (isCommentNode(child)) {
      i++;
      continue;
    }
    if (isTextNode(child) && child.value.trim() === "") {
      i++;
      continue;
    }
    const childName = tagNameOf(child);
    if (
      !isTagNode(child) ||
      (childName !== "else" && childName !== "else-if")
    ) {
      break;
    }

    validateBoundAttributes(ctx, child);
    rejectUnsupportedFields(ctx, child, `\`<${childName}>\``);
    // `<else if=cond>` spells the condition as an `if` attribute; Marko's own
    // `<else-if=cond>` spells it as the tag's first (value) attribute.
    const ifAttr =
      childName === "else-if"
        ? (attrByName(child, "value") ?? tagAttributesOf(child)[0])
        : attrByName(child, "if");
    branches.push({
      condition: ifAttr ? exprOf(ctx, attrValueOf(ctx, ifAttr)) : null,
      children: branchChildren(child),
      span: exprSpan(ctx, child),
      loc: posOf(ctx, child),
    });
    lastBranch = child;
    i++;
    if (!ifAttr) break;
  }

  const startSpan = exprSpan(ctx, node);
  const endSpan = exprSpan(ctx, lastBranch);
  return [
    {
      kind: "IfChain",
      branches,
      // Marko has no single node spanning the chain; it is the `<if>`'s
      // start through the last branch's end.
      span:
        startSpan && endSpan
          ? { sourceStart: startSpan.sourceStart, sourceEnd: endSpan.sourceEnd }
          : undefined,
      loc: posOf(ctx, node),
    },
    i,
  ];
}

/**
 * The first read, in `by=`'s value, of a name the loop's own params bind.
 *
 * A plain walk, as in Marko's translator (`findLoopParamRead` in
 * `packages/runtime-tags/src/translator/core/for.ts`, 6.3.51): functions and
 * classes are skipped, since their own params may shadow, and a member
 * property or a non-computed object key is a name, not a read.
 */
function findLoopParamRead(
  value: Node,
  names: ReadonlySet<string>,
): Node | undefined {
  switch (value.type) {
    case "Identifier":
      return names.has(value.name) ? value : undefined;
    case "MemberExpression":
    case "OptionalMemberExpression":
      return (
        findLoopParamRead(value.object, names) ||
        (value.computed ? findLoopParamRead(value.property, names) : undefined)
      );
  }

  const { types } = coreBabel();
  if (types.isFunction(value) || types.isClass(value)) return undefined;

  for (const key of types.VISITOR_KEYS[value.type] ?? []) {
    if (key === "typeAnnotation" || key === "typeParameters") continue;
    if (key === "key" && !value.computed) continue;
    const child = value[key];
    for (const item of Array.isArray(child) ? child : [child]) {
      const found = item?.type && findLoopParamRead(item, names);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * `by=` runs once, before the loop, so the tag's params are not in scope there
 * (Marko: "The `by=` attribute is evaluated before the loop runs"). Reported at
 * the offending name, as Marko does, instead of surviving to a host's own
 * type error at a generated position or to a render-time ReferenceError.
 */
function rejectLoopParamInBy(node: Node, by: Node): void {
  const { types } = coreBabel();
  const names = new Set<string>();
  for (const param of tagParamsOf(node)) {
    for (const name of Object.keys(types.getBindingIdentifiers(param))) {
      names.add(name);
    }
  }
  if (names.size === 0) return;
  // Marko scans whatever its parser produced; an MX container the front end
  // could not parse has no payload to scan, and fails later at `exprOf`.
  const value = by.type === "MxAttribute" ? by.value?.node : by.value;
  const read = findLoopParamRead(value, names);
  if (!read) return;
  fail(
    `The \`by=\` attribute is evaluated before the loop runs, so \`${read.name}\` is not in scope. Key with a property name string (\`by="id"\`) or a function (\`by=(${read.name}) => key\`).`,
    read,
  );
}

/**
 * All of `<for>`'s forms, normalized to the three a host emits.
 *
 * `by=` names which item a DOM node belongs to across re-renders. A one-shot
 * string host has no reconciliation, so it safely ignores the field (decision
 * 65). A reactive host (Solid) emits it as the `keyed` prop on `<For>`.
 * Carried in the IR so both paths work from the same tree.
 */
function lowerForHead(
  ctx: Ctx,
  node: Node,
  allowAttributeTags = false,
): ForHead {
  validateBoundAttributes(ctx, node);
  rejectUnsupportedFields(ctx, node, "`<for>`", {
    params: true,
    attributeTags: allowAttributeTags,
  });

  const params = paramsOf(ctx, node);
  // A `<for>` with no params names no loop variable. Defaulting it to `item`
  // would bind the body to a name the author never wrote — resolving to an
  // outer-scope `item` if one exists, or failing at render time instead of
  // compile time.
  if (params.length === 0) {
    fail("`<for>` needs tag params: `<for|item| of=…>`", node);
  }

  // The iterable is evaluated *outside* the loop, so a registered name there is
  // still the host's binding; only the body is shadowed by the params.
  const of = attrByName(node, "of");
  const inAttr = attrByName(node, "in");
  const to = attrByName(node, "to");
  const until = attrByName(node, "until");
  const step = attrByName(node, "step");
  const by = attrByName(node, "by");

  // Marko redirects the React/Vue `key=` habit to `by=` before it validates
  // anything else about the loop (`core/for.ts`), because `key=` on a `<for>`
  // is never a key: it is an attribute the loop does not read, so accepting it
  // silently drops the author's intent. The fix-it names the form the loop
  // actually has: `of` iterates items, `in` a record's entries, a range an
  // index.
  const keyAttr = attrByName(node, "key");
  if (keyAttr) {
    fail(
      `The \`<for>\` tag keys items with the \`by=\` attribute, not \`key=\`. ${
        of
          ? 'Use `by="propName"` or `by=(item, index) => key`'
          : inAttr
            ? "Use `by=(key, value) => key`"
            : "Use `by=(num) => key`"
      }.`,
      keyAttr,
    );
  }

  const combos = [of, inAttr, attrByName(node, "from") || to || until].filter(
    Boolean,
  ).length;
  if (combos > 1) {
    fail(
      "`<for>` with more than one of `of=`, `in=`, `from=`/`to=`/`until=`",
      node,
    );
  }
  if (to && until) fail("`<for>` with both `to=` and `until=`", node);
  if (step && !(to || until)) {
    fail("`<for step=...>` is only valid on a range", step);
  }

  const requireValue = (attr: Node | undefined, label: string): void => {
    if (attr && !hasExpressionValue(attr)) {
      fail(`\`<for ${label}=...>\` requires an expression value`, attr);
    }
  };
  requireValue(of, "of");
  requireValue(inAttr, "in");
  requireValue(attrByName(node, "from"), "from");
  requireValue(to, "to");
  requireValue(until, "until");
  requireValue(step, "step");
  requireValue(by, "by");
  if (by) rejectLoopParamInBy(node, by);

  let source: ForSource;
  if (of) {
    source = { kind: "of", list: exprOf(ctx, attrValueOf(ctx, of)) };
  } else if (inAttr) {
    source = { kind: "in", object: exprOf(ctx, attrValueOf(ctx, inAttr)) };
  } else if (to || until) {
    const from = attrByName(node, "from");
    source = {
      kind: "range",
      from: from ? exprOf(ctx, attrValueOf(ctx, from)) : null,
      bound: exprOf(ctx, attrValueOf(ctx, to ?? until)),
      inclusive: Boolean(to),
      step: step ? exprOf(ctx, attrValueOf(ctx, step)) : null,
    };
  } else {
    fail("`<for>` requires `of=`, `in=`, or `from=`/`to=`/`until=`", node);
  }

  // A string `by=` is the property-name shorthand and only `of` has one:
  // `in`/`to`/`until` *call* `by` as a function, so a string would die at
  // render ("by is not a function"). Marko refuses it at compile time, at the
  // quoted key it refuses, rather than letting the failure surface on first
  // paint. `of` keeps the shorthand, so this cannot be "no string `by`".
  const byValue = by ? attrValueOf(ctx, by) : undefined;
  if (!of && byValue?.type === "StringLiteral") {
    fail(
      `The \`<for>\` tag only supports a string \`by\` key with \`of\`; use a \`by=(${
        inAttr ? "key, value" : "index"
      }) => ...\` function for \`<for ${inAttr ? "in" : to ? "to" : "until"}>\`.`,
      byValue,
    );
  }

  const bindings = paramBindings(ctx, node);
  return {
    source,
    params,
    paramNodes: [...tagParamsOf(node)],
    bindings,
    paramSpans: paramSpansOf(ctx, node),
    key: by ? exprOf(ctx, byValue) : null,
  };
}

function lowerFor(ctx: Ctx, node: Node): IrNode {
  const head = lowerForHead(ctx, node);
  // The loop body is a JS block, so a `<const>` inside it is confined to it.
  const unscope = scopeBindings(ctx);
  const restore = shadowBindings(ctx, head.bindings);
  const children = lowerChildren(ctx, bodyChildren(node));
  restore();
  unscope();

  return {
    kind: "For",
    ...head,
    children,
    span: exprSpan(ctx, node),
    loc: posOf(ctx, node),
  };
}

/** `<const/name=expr/>` — a binding at render scope. */
function lowerConst(ctx: Ctx, node: Node): IrNode {
  if (!tagVarOf(node)) {
    fail(
      "`<const>` without a variable name (write `<const/name=value/>`)",
      node,
    );
  }
  rejectUnsupportedFields(ctx, node, "`<const>`", { var: true });
  // Dispatched by the core, before any host sees the tag, so the binding check
  // has to happen here or a host's rule would silently apply to `<let>` and not
  // to `<const>`.
  ctx.declarations.checkBinding?.(tagVarOf(node), "`<const>`");
  const value = attrByName(node, "value") ?? tagAttributesOf(node)[0];
  if (!value) fail("`<const>` without a value", node);

  const name = declName(ctx, tagVarOf(node));
  // The initializer is evaluated *before* the binding exists, so a registered
  // name on the right-hand side is still the host's: `<const/count=count + 1>`
  // resolves to `const count = count() + 1`. Shadowing takes effect only
  // afterwards, for the rest of the render scope.
  const valueNode = attrValueOf(ctx, value);
  const init = exprOf(ctx, valueNode);
  // Local extension of decision 116: a `<const>` bound to a plain identifier
  // whose value isn't statically a function/arrow/class is "unknown" and
  // routes dynamic when later used as a tag — a destructuring pattern
  // (`<const/{a,b}=...>`) never names a single PascalCase tag binding, so it
  // is left out of this check entirely rather than guessed at.
  if (
    tagVarOf(node)?.type === "Identifier" &&
    !isFunctionLikeValue(valueNode)
  ) {
    ctx.unknownLocalValue.add(name);
  }
  shadowBindings(ctx, bindingIdentifiers(tagVarOf(node)));

  return {
    kind: "Const",
    name,
    init,
    span: exprSpan(ctx, node),
    loc: posOf(ctx, node),
  };
}

/** One filesystem probe per tag name per compile, not per occurrence. */
const uncalledTagFiles = new WeakMap<
  Ctx,
  Map<string, ReturnType<typeof findUncalledTagFile>>
>();

function uncalledTagFileOf(ctx: Ctx, name: string) {
  const known = uncalledTagFiles.get(ctx);
  const byName = known ?? new Map();
  if (!known) uncalledTagFiles.set(ctx, byName);
  if (!byName.has(name)) {
    byName.set(name, findUncalledTagFile(ctx.filename, name));
  }
  return byName.get(name);
}

function failUncalled(
  ctx: Ctx,
  name: string,
  found: NonNullable<ReturnType<typeof findUncalledTagFile>>,
  node: Node,
): never {
  fail(
    found.file.endsWith(".marko")
      ? markoFileTagMessage(ctx.filename, name, found.file, productOf(ctx))
      : uncalledTagFileMessage(ctx.filename, name, found, productOf(ctx)),
    node,
  );
}

/**
 * Decision 172: a binding imported from a `.marko` file and used as a tag, static
 * (`<X/>`) or dynamic with that binding directly (`<${X}/>`), is the one error.
 * A binding that reaches a dynamic tag any other way is a value, left alone.
 */
function rejectMarkoImportTag(
  ctx: Ctx,
  binding: string,
  written: string,
  node: Node,
): void {
  const from = ctx.importSpecifiers.get(binding);
  if (
    !from?.endsWith(".marko") ||
    !ctx.importDefaultFromMarkoOrMx.has(binding) ||
    ctx.tagVarShadowed?.has(binding)
  ) {
    return;
  }
  fail(
    markoFileTagMessage(
      ctx.filename,
      written,
      resolve(dirname(ctx.filename), from),
      productOf(ctx),
    ),
    node,
  );
}

/**
 * A tag a host taglib registers (a third-party translator's `taglibs`), not an
 * element, a core tag or a custom tag.
 */
function isRegisteredTaglibTag(ctx: Ctx, name: string): boolean {
  const taglibId = ctx.tagTable?.getTag(name)?.taglibId;
  return (
    taglibId !== undefined &&
    !ELEMENT_TAGLIB_IDS.has(taglibId) &&
    taglibId !== "mx-translator-core"
  );
}

/**
 * The module the host's `resolveDiscoveredTagModule` names for the tag
 * `name`, refused when it is a `.marko` file (decision 172: no `.marko` file
 * is MX input, however the tag was found).
 */
function discoveredTagModuleOf(
  ctx: Ctx,
  name: string,
  node: Node,
): string | undefined {
  const modulePath = ctx.declarations.resolveDiscoveredTagModule?.(name, ctx);
  if (modulePath?.endsWith(".marko"))
    fail(
      markoFileTagMessage(ctx.filename, name, modulePath, productOf(ctx)),
      node,
    );
  return modulePath;
}

/**
 * A tag a translator taglib registers that no module resolves: the bare call
 * would reference a binding nothing declares (or the import of the same
 * name, which addendum 1 says the tag is not).
 */
function failUncallableTaglibTag(ctx: Ctx, name: string, node: Node): never {
  const found = uncalledTagFileOf(ctx, name);
  if (found) failUncalled(ctx, name, found, node);
  fail(
    `\`<${name}>\` is declared by a taglib with no template (a \`renderer\`), which ${productOf(ctx)} cannot call. Write the tag as \`tags/${name}.mx\`, or import it explicitly.`,
    node,
  );
}

/**
 * A default import of a tag module — the only import a lowercase tag could be
 * mistaken to call. A named import from a `.mx`/`.marko` file is a value the
 * module exports, not its tag.
 */
function isTagModuleImport(ctx: Ctx, name: string): boolean {
  return ctx.imports.has(name) && ctx.importDefaultFromMarkoOrMx.has(name);
}

/**
 * The fix a diagnostic offers for a lowercase binding. A name that starts with
 * a letter can be renamed to its capitalized form; `_row` or `$row` has no
 * capitalized spelling Marko reads as a binding (its rule is `/^[A-Z]/`), so
 * only the dynamic tag is offered.
 */
function lowercaseBindingFix(
  name: string,
  rename: (pascal: string) => string,
  or: string,
  close: string,
): string {
  const dynamic = `\`<\${${name}}${close}>\``;
  if (!/^[a-z]/.test(name)) return `Write ${dynamic}`;
  const pascal = name.charAt(0).toUpperCase() + name.slice(1);
  return `${rename(pascal)} ${or} ${dynamic}`;
}

// HTML elements no native table lists (`@mxlang/web-elements` follows
// Marko's element taglibs, which have no `<slot>`), native in a region and a
// whole file alike.
const UNLISTED_NATIVE_ELEMENTS: ReadonlySet<string> = new Set(["slot"]);

/**
 * Whether `name` is a native HTML/SVG/MathML element: by the tag table's
 * taglib id when it knows the name, else by the elements the table was built
 * over (a region has no table): the host's `nativeTags`, or core's own when
 * it declares none.
 */
function isNativeElementName(ctx: Ctx, name: string): boolean {
  const taglibId = ctx.tagTable?.getTag(name)?.taglibId;
  if (taglibId !== undefined) return ELEMENT_TAGLIB_IDS.has(taglibId);
  return (
    (ctx.declarations.nativeTags ?? coreNativeTags()).has(name) ||
    UNLISTED_NATIVE_ELEMENTS.has(name)
  );
}

/**
 * Decision 164's warning: a lowercase tag whose name an in-scope `import` or
 * `<define>` binds is the native element, and the binding is not called.
 */
function warnLowercaseBinding(ctx: Ctx, node: Node, name: string): void {
  const site = ctx.bindingSites.get(name);
  const kind = site?.kind ?? "imported";
  const where = site ? ` at ${site.line}:${site.column + 1}` : "";
  const fix = lowercaseBindingFix(
    name,
    (pascal) => `Rename it \`${pascal}\``,
    "or write",
    "",
  );
  const at = posOf(ctx, node);
  warn(ctx, {
    message: `\`<${name}>\` is the native element; the \`${name}\` ${kind}${where} is not called. ${fix}`,
    line: at.line,
    column: at.column,
  });
}

/** `<define/name|params|>...</define>` — a reusable block. */
/**
 * A `<define>` whose head failed still binds its name, so a later call to it
 * is not reported as a second error (decision 162: a consequence of an earlier
 * error is never its own error). Best effort: whatever cannot be read stays
 * unbound.
 */
function bindFailedDefine(ctx: Ctx, node: Node): void {
  if (!tagVarOf(node)) return;
  try {
    const name = declName(ctx, tagVarOf(node));
    if (ctx.defines.has(name)) return;
    let params: string[] = [];
    try {
      params = paramsOf(ctx, node);
    } catch {
      // The params are what failed; the name alone is still bound.
    }
    ctx.defines.set(name, params);
    ctx.bindingSites.set(name, {
      kind: "defined",
      ...posOf(ctx, tagVarOf(node)),
    });
  } catch {
    // No readable name to bind.
  }
}

function lowerDefine(ctx: Ctx, node: Node): IrNode {
  try {
    return lowerDefineChecked(ctx, node);
  } catch (error) {
    if (ctx.errors && isTranslateError(error)) bindFailedDefine(ctx, node);
    throw error;
  }
}

function lowerDefineChecked(ctx: Ctx, node: Node): IrNode {
  if (!tagVarOf(node)) {
    fail("`<define>` without a name (write `<define/name>`)", node);
  }
  rejectUnsupportedFields(ctx, node, "`<define>`", { var: true, params: true });

  const name = declName(ctx, tagVarOf(node));
  const params = paramsOf(ctx, node);

  // The params shadow the host's bindings inside the body only, and a
  // statement hoisted from inside belongs to *this* function's head — it may
  // read the define's own params.
  //
  // `<define>`'s body is its own JS block, so a `<const>` written inside it
  // must not leak past it either (decision 113 round 2 — the same leak
  // `scopeBindings` closes for `<if>`/`<for>`): `shadowBindings` alone only
  // undoes the *params*, since a `<const>` never calls its own restore by
  // design (it shadows for the rest of *its* enclosing scope, which here is
  // the define body, not the caller's).
  const unscope = scopeBindings(ctx);
  const restore = shadowBindings(ctx, paramBindings(ctx, node));
  const [children, prelude] = withPrelude(ctx, () =>
    lowerChildren(ctx, bodyChildren(node)),
  );
  restore();
  unscope();

  ctx.defines.set(name, params);
  ctx.bindingSites.set(name, {
    kind: "defined",
    ...posOf(ctx, tagVarOf(node) ?? node),
  });

  const loc = posOf(ctx, node);
  const hoisted: IrNode[] = prelude.map(({ code, node }) => ({
    kind: "Hoisted" as const,
    code,
    loc: posOf(ctx, node),
    end: endPosOf(ctx, node),
  }));
  return {
    kind: "Define",
    name,
    nameSpan: exprSpan(ctx, tagVarOf(node)),
    span: exprSpan(ctx, node),
    params,
    paramSpans: paramSpansOf(ctx, node),
    children: [...hoisted, ...children],
    loc,
  };
}

/**
 * Registers every PascalCase name a `static` block's own top-level
 * declarations bind, classifying each by whether its value is statically
 * provable function/arrow/class (local extension of decision 116). Mirrors
 * `lowerStatement`'s `import` branch, which does the equivalent for an
 * `import` line, except `static` may declare several statements
 * (`static { const A = 1; function B(){} }`-style bodies are not MX's
 * `static` grammar, but `static const A = 1, B = () => {}` and a bare
 * `static function Foo(){}` both are), so every top-level statement in the
 * parsed block is walked rather than assuming one declaration.
 *
 * Only a capitalized binding is registered: a lowercase `static const x = 1`
 * is never resolved as a component tag (decision 116's own casing gate,
 * `fileLocalBinding`'s `/^[A-Z]/` test), so classifying it would be dead
 * weight no caller reads.
 */
function registerStaticBindings(ctx: Ctx, code: string): void {
  let file: { program: { body: Node[] } };
  try {
    file = coreBabel().parse(code, {
      sourceType: "module",
      plugins: ["typescript"],
    });
  } catch {
    return;
  }
  for (const statement of file.program.body) {
    if (statement.type === "FunctionDeclaration" && statement.id) {
      const bound = statement.id.name as string;
      if (/^[A-Z]/.test(bound)) ctx.imports.add(bound);
      continue;
    }
    if (statement.type === "ClassDeclaration" && statement.id) {
      const bound = statement.id.name as string;
      if (/^[A-Z]/.test(bound)) ctx.imports.add(bound);
      continue;
    }
    if (statement.type === "VariableDeclaration") {
      for (const declarator of statement.declarations as Node[]) {
        if (declarator.id?.type !== "Identifier") continue;
        const bound = declarator.id.name as string;
        if (!/^[A-Z]/.test(bound)) continue;
        ctx.imports.add(bound);
        if (!isFunctionLikeValue(declarator.init)) {
          ctx.unknownLocalValue.add(bound);
        }
      }
    }
  }
}

/**
 * Statement tags, recovered from source and hoisted to module scope.
 *
 * `import` reaches module scope verbatim; `static` drops its keyword; `export
 * interface Input` is lifted so a host can place it above the render function;
 * any other `export` hoists verbatim as a real module export.
 */
/**
 * The authored range of a statement tag (`import` / `static` / `export`).
 *
 * Marko's statement `loc.end` sits on the next line's column 0 — the raw
 * span would end with the line terminator — so trailing whitespace is
 * trimmed, leaving exactly the authored statement: slicing the source with
 * the result yields the statement text (for `static`, keyword included).
 */
function statementSpan(ctx: Ctx, node: Node): SourceSpan | undefined {
  const span = exprSpan(ctx, node);
  if (!span) return undefined;
  let sourceEnd = span.sourceEnd;
  while (
    sourceEnd > span.sourceStart &&
    /\s/.test(ctx.source[sourceEnd - 1] as string)
  ) {
    sourceEnd--;
  }
  return { sourceStart: span.sourceStart, sourceEnd };
}

/**
 * Marko parses a statement tag's text as a module body and reports a syntax
 * error at the offending character; MX did not, so a statement whose text
 * does not parse (JSX, or a line ending in `>` that swallows the next template
 * line into one invalid expression) was emitted unchecked and the next line
 * vanished silently on html, Solid and Astro, and after decision 168 on the
 * JSX hosts too. Same check, same position: `prefix` is how many characters
 * of the authored statement come before `code` (`static `).
 */
function rejectInvalidStatement(
  ctx: Ctx,
  node: Node,
  code: string,
  prefix: number,
  keyword: string,
): void {
  const options = {
    sourceType: "module",
    // `decorators-legacy` reads `@d m() {}` and `@d() m() {}`, the form a
    // `static class` carried before decision 168 (#395 follow-up).
    plugins: ["typescript", "decorators-legacy"],
    // A top-level `return` is TypeScript's TS1108 to report, with its mapping,
    // in an Astro fence and a template `static` alike; stock Marko 6.3.51
    // compiles a template `static return` too.
    allowReturnOutsideFunction: true,
  };
  const start = posOf(ctx, node);
  const place = (at?: { line: number; column: number }) => ({
    line: start.line + (at ? at.line - 1 : 0),
    column:
      !at || at.line === 1
        ? start.column + prefix + (at?.column ?? 0)
        : at.column,
  });
  try {
    coreBabel().parse(code, options);
  } catch (error) {
    // JSX is not read in a statement. Detected by what the failure is: the
    // text parses once the JSX syntax is on, so the error is the markup's, and
    // it is reported at the first element's `<` instead of wherever Babel's
    // tokenizer gave up ("Unterminated regular expression.").
    const jsx = firstJsxStart(code, options);
    // A `<` right after a `>` is the join of a line ending in `>` with the
    // template line below it (`2 >⏎<div>…`), which Marko reports as the
    // joined expression's own error; that message stays Babel's.
    if (jsx && !followsGreaterThan(code, jsx)) {
      const at = place(jsx);
      throw new TranslateError(
        `JSX is not read inside a \`${keyword}\` statement: its text is TypeScript. Write the markup as a tag in the template, or in a \`<define>\``,
        at.line,
        at.column,
      );
    }
    const at = place((error as { loc?: { line: number; column: number } }).loc);
    throw new TranslateError(
      String((error as Error).message)
        .replace(/\s*\(\d+:\d+\)$/, "")
        .trim(),
      at.line,
      at.column,
    );
  }
}

/** Whether the last non-blank character before `at` in `code` is `>`. */
function followsGreaterThan(
  code: string,
  at: { line: number; column: number },
): boolean {
  const lines = code.split("\n");
  let offset = at.column;
  for (let i = 0; i < at.line - 1; i++) offset += (lines[i]?.length ?? 0) + 1;
  return code.slice(0, offset).trimEnd().endsWith(">");
}

/** Where the first JSX element or fragment of `code` starts, when `code` parses only with JSX on. */
function firstJsxStart(
  code: string,
  options: { plugins: string[] },
): { line: number; column: number } | undefined {
  const parseWithJsx = (text: string): Node =>
    // Marko's slim Babel has no `jsx` plugin; core's own `@babel/parser` does.
    babelParse(text, {
      sourceType: "module",
      allowReturnOutsideFunction: true,
      plugins: [...options.plugins, "jsx"] as ParserPlugin[],
    });
  let file: Node;
  try {
    file = parseWithJsx(code);
  } catch (error) {
    // `<b>hi</b>` followed by the swallowed template line is two adjacent
    // elements, which Babel will not recover from: the text before where it
    // gave up is the evidence.
    const pos = (error as { pos?: number }).pos;
    if (typeof pos !== "number" || pos <= 0) return undefined;
    try {
      file = parseWithJsx(code.slice(0, pos));
    } catch {
      return undefined;
    }
  }
  let found: { line: number; column: number } | undefined;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as Node;
    if (
      (node.type === "JSXElement" || node.type === "JSXFragment") &&
      node.loc?.start
    ) {
      const at = node.loc.start as { line: number; column: number };
      if (
        !found ||
        at.line < found.line ||
        (at.line === found.line && at.column < found.column)
      ) {
        found = { line: at.line, column: at.column };
      }
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "extra") continue;
      visit(node[key]);
    }
  };
  visit(file.program);
  return found;
}

/**
 * The `declaration` field of an `Import` IR node: the Babel `ImportDeclaration`
 * an `MxModuleStatement` carries. Read from the copy taken before the
 * TypeScript strip (`parsedImportDeclarations`, which keeps `import type` and
 * `{ type X }`), else the payload itself (`code.node`, one statement). A Marko statement tag
 * has no parsed payload, and a payload that did not parse (`code.node` null)
 * or is not one import stays absent rather than guessed.
 */
function importDeclarationOf(node: Node): { declaration?: Node } {
  if (node?.type !== "MxModuleStatement") return {};
  const recorded = parsedImportDeclarations.get(node);
  if (recorded) return { declaration: recorded };
  const statements = node.code?.node;
  if (!Array.isArray(statements) || statements.length !== 1) return {};
  return statements[0]?.type === "ImportDeclaration"
    ? { declaration: statements[0] }
    : {};
}

/**
 * MX imports are ES imports: one `import … from "…"` declaration per
 * statement. An `MxModuleStatement` whose payload is anything else is refused
 * at the statement (`import x = …`, several statements in one `import`), and
 * so is Flow's `import typeof` (MX is TypeScript; `import type` is the form).
 * A payload that did not parse is left to `rejectInvalidStatement`.
 */
function refuseUnsupportedImport(node: Node): void {
  if (node?.type !== "MxModuleStatement" || node.code?.error) return;
  const statements = node.code?.node;
  // No payload to judge (the front end always parses one; a hand-built node
  // may carry none): `Import.declaration` stays absent.
  if (!Array.isArray(statements) || statements.length === 0) return;
  const declaration =
    parsedImportDeclarations.get(node) ??
    (statements.length === 1 && statements[0]?.type === "ImportDeclaration"
      ? statements[0]
      : undefined);
  if (!declaration) {
    fail(
      'an `import` statement must be one ES import declaration (`import … from "…"`); `import x = …` and several statements in one `import` are not supported',
      node,
    );
  }
  if (isTypeofImport(declaration)) {
    fail(
      "`import typeof` is Flow syntax; the template language is TypeScript. Use `import type` for an import that binds no value",
      node,
    );
  }
}

function lowerStatement(ctx: Ctx, node: Node, name: string): IrNode {
  // Decision 168: a statement tag is parsed as a statement (Marko: its text
  // is `rawValue`; MX: an `MxModuleStatement`). One the parser read as
  // attributes came from a translator that does not declare the statement
  // tags; recovering its text from the source would hide that, so it is
  // refused.
  if (!isStatementNode(node)) {
    fail(
      `\`${name}\` was parsed as a tag with attributes: this target's translator does not declare the statement tags. Build the translator with \`createTranslator\`, or register core's \`STATEMENT_TAGLIB\` in it`,
      node,
    );
  }
  const line = sliceNode(ctx, node).trim();
  const loc = posOf(ctx, node);
  const end = endPosOf(ctx, node);
  const span = statementSpan(ctx, node);
  if (name === "import") refuseUnsupportedImport(node);
  rejectInvalidStatement(
    ctx,
    node,
    name === "static" ? line.replace(/^static\s+/, "") : line,
    name === "static" ? (/^static\s+/.exec(line)?.[0].length ?? 0) : 0,
    name,
  );

  if (name === "import") {
    const bindings = importBindings(line);
    const typeOnly = importTypeOnlyBindings(line);
    const authoredSpecifier = line.match(/\bfrom\s+["']([^"']+)["']/)?.[1];
    // `default`/`*`/named, per binding — only a `default` import from a
    // `.marko`/`.mx` source is Marko's own statically-resolved component
    // case (decision 116); everything else lowers as a dynamic tag.
    const parsedNames = importedNames(line)?.names ?? [];
    const importedAs = new Map(parsedNames.map((n) => [n.local, n.imported]));
    // Recorded *now*, not in `lower`'s post-pass: a component call later in
    // the body asks `isComponent`, which consults `ctx.imports`, so a binding
    // registered only after the whole body resolved would make every
    // imported component an unbound capitalized tag.
    for (const binding of bindings) {
      ctx.importedNames.add(binding);
      ctx.bindingSites.set(binding, { kind: "imported", ...loc });
      // A type-only binding still occupies the name in the module
      // (`importedNames`), but is not a value a tag could resolve to
      // (`imports` — decision 114/115): neither `import type { X }` nor
      // `{ type X }` introduces a runtime value.
      if (!typeOnly.has(binding)) ctx.imports.add(binding);
      if (authoredSpecifier) {
        ctx.importSpecifiers.set(binding, authoredSpecifier);
        if (
          importedAs.get(binding) === "default" &&
          isMarkoOrMxSpecifier(authoredSpecifier)
        ) {
          ctx.importDefaultFromMarkoOrMx.add(binding);
        }
      }
    }
    registerAuthoredTemplateImport(ctx, line);
    return {
      kind: "Import",
      code: line,
      bindings,
      ...importDeclarationOf(node),
      loc,
      end,
      span,
    };
  }
  if (name === "static") {
    const code = line.replace(/^static\s+/, "");
    registerStaticBindings(ctx, code);
    return {
      kind: "Static",
      code,
      loc,
      end,
      span,
    };
  }
  if (/^export\s+interface\s+Input\b/.test(line)) {
    return { kind: "InputInterface", code: line, loc, end, span };
  }
  if (name === "export") {
    return { kind: "Export", code: line, loc, end, span };
  }
  fail(
    `unrecognized statement tag \`${name}\`; expected \`import\`, \`static\`, or \`export\``,
    node,
  );
}

/** A tag this host claims, with every part lowered for its emitter. */
function lowerDelegatedTag(ctx: Ctx, node: Node, name: string): IrNode {
  const loc = posOf(ctx, node);
  const target: ComponentTarget =
    name === DYNAMIC_TAG
      ? { kind: "dynamic", expr: exprOf(ctx, tagNameExprOf(node)) }
      : { kind: "name", name };
  const resolvedInput =
    ctx.calleeInputFor?.(target) ?? readCalleeInput(target, ctx).input;
  const loweredTags = lowerAttributeTags(
    ctx,
    node,
    schemaFor(resolvedInput, targetName(target)),
  );
  raiseInvalidCalleeInput(
    ctx,
    resolvedInput,
    targetName(target),
    loweredTags.flat,
  );
  const unscope = scopeBindings(ctx);
  const restore = shadowBindings(ctx, paramBindings(ctx, node));
  const children = lowerChildren(ctx, loweredTags.contentChildren);
  restore();
  unscope();

  return {
    kind: "DelegatedTag",
    tag: {
      name,
      ...triggerOf(node),
      nameSpan:
        name === DYNAMIC_TAG ? undefined : exprSpan(ctx, tagNameSpanOf(node)),
      span: exprSpan(ctx, node),
      attrs: lowerAttrs(ctx, node, name),
      args: (tagArgsOf(node) ?? []).map((argument: Node) =>
        exprOf(ctx, argument),
      ),
      children,
      attributeTags: loweredTags.flat,
      attributeTagTree: loweredTags.tree,
      attrTagProps: loweredTags.props,
      params: paramsOf(ctx, node),
      var: tagVarOf(node) ? declName(ctx, tagVarOf(node)) : null,
      data: ctx.declarations.resolveDelegatedTag?.(
        name,
        markoViewOf(ctx, node),
        ctx,
      ),
      loc,
    },
    loc,
  };
}

/**
 * `<return value=EXPR/>` — the unit's value channel (design §3.3).
 *
 * Validated entirely in the tag's *own* compilation, which is what makes the
 * `{ value, output }` signature well-typed: a unit cannot see its callers, so
 * "at most one, unconditional" is decided once, here, rather than resolved
 * from the set of all call sites (invariant §7.5-5). The grammar is Marko's,
 * ported from `translator/core/return.ts` with MX wording; the one deliberate
 * subtraction is `valueChange`, which MX 1 does not ship (value only), so it
 * is rejected by name like any other unknown attribute.
 *
 * `nested` is the whole unconditionality check. Reaching this function from
 * anywhere but the file's own top-level body — inside a native tag, under
 * `<if>`/`<for>`, inside an attribute tag or a `<define>` — means the return
 * would be conditional or scoped, so it is refused there rather than lowered.
 */
function lowerReturn(ctx: Ctx, node: Node, nested: boolean): IrNode {
  rejectUnsupportedFields(ctx, node, "`<return>`");

  if (bodyChildren(node).length) {
    fail("`<return>` does not support body content", node);
  }

  for (const attr of tagAttributesOf(node)) {
    if (isSpreadAttributeNode(attr)) {
      fail("`<return>` does not support spread attributes", attr);
    }
  }

  let valueAttr: Node | undefined;
  for (const attr of tagAttributesOf(node)) {
    if (!isAttributeNode(attr)) continue;
    // The parser spells `<return=x/>` as the `default` attribute and
    // `<return value=x/>` as `value`; both are the same authored thing.
    const attrName = isDefaultAttr(attr) ? "value" : String(attrNameOf(attr));
    if (attrName !== "value") {
      fail(
        attrName === "valueChange"
          ? `\`<return>\` does not support the \`valueChange\` attribute; ${productOf(ctx)} returns a value only, with no two-way channel`
          : `\`<return>\` does not support the \`${attrName}\` attribute`,
        attr,
      );
    }
    if (valueAttr) fail("Invalid duplicate value attribute.", attr);
    valueAttr = attr;
  }

  if (!valueAttr) {
    fail("`<return>` requires a `value=` attribute", node);
  }

  if (nested) {
    fail(
      "`<return>` must be at the top level of its template; it declares the value the whole unit returns, so it cannot be conditional or nested",
      node,
    );
  }

  if (ctx.returnValue) {
    fail("cannot have multiple `<return>` tags for the template", node);
  }

  ctx.returnValue = {
    expr: exprOf(ctx, attrValueOf(ctx, valueAttr)),
    loc: posOf(ctx, node),
  };
  // Contributes nothing to the rendered output: the value is lifted onto the
  // `Ir` and emitted as part of the unit's signature, not in document order.
  return { kind: "Text", value: "", loc: posOf(ctx, node) };
}

/** Check attribute-tag authored bodies before any child can transform away its name. */
function validateCustomAttributeTagBodies(
  ctx: Ctx,
  owner: string,
  node: Node,
  declarations: CustomTag["attributeTags"],
  allowUncontractedTags: boolean,
  controlName?: string,
): void {
  const children = bodyChildren(node);
  const directTags = [
    ...new Set<Node>([
      ...(node.attributeTags ?? []),
      ...children.filter((child: Node) =>
        String(tagNameOf(child) ?? "").startsWith("@"),
      ),
    ]),
  ];
  for (const tag of directTags) {
    if (isControl(tag)) {
      validateCustomAttributeTagBodies(
        ctx,
        owner,
        tag,
        declarations,
        allowUncontractedTags,
        attrName(tag) === "for" ? "for" : "if",
      );
      continue;
    }
    const name = attrName(tag);
    const declaration = attributeTagDeclarationFor(declarations, name);
    const extended = hasAttributeTagContract(declaration);
    if (!allowUncontractedTags && !extended) {
      if (controlName) {
        fail(
          `${owner}: attribute tag \`<@${name}>\` may not appear inside \`<${controlName}>\`; registered custom tags cannot preserve attribute-tag control flow`,
          tagNameSpanOf(tag) ?? tag,
        );
      }
      const attrs = tagAttributesOf(tag);
      if (attrs.length > 0) {
        fail(
          `${owner}: attribute tag \`<@${name}>\` does not support attributes`,
          attrs[0],
        );
      }
      // Marko's `attributeTags` field, or the MX body's first attribute tag
      // or control tag holding one (Marko files those under the field too).
      const nested =
        tag.attributeTags?.[0] ??
        bodyChildren(tag).find(
          (child: Node) =>
            isMxAttributeTag(child) ||
            (isControl(child) && containsAttributeTags(child)),
        );
      if (nested) {
        fail(
          `${owner}: attribute tag \`<@${name}>\` does not support nested attribute tags`,
          tagNameSpanOf(nested) ?? nested.name ?? nested,
        );
      }
    }
    const nestedOwner = `${owner}: \`<@${name}>\``;
    if (declaration) {
      validateCustomTagChildren(
        declaration,
        {
          name: `@${name}`,
          loc: posOf(ctx, tag),
          childTree: authoredChildTree(ctx, bodyChildren(tag)),
        },
        nestedOwner,
      );
    }
    validateCustomAttributeTagBodies(
      ctx,
      nestedOwner,
      tag,
      declaration?.attributeTags,
      allowUncontractedTags ||
        (extended && declaration?.attributeTags === undefined),
    );
  }
  for (const child of children) {
    if (
      isTagNode(child) &&
      CONTROL_FLOW_TAGS.includes(tagNameOf(child) as string) &&
      !directTags.includes(child)
    ) {
      validateCustomAttributeTagBodies(
        ctx,
        owner,
        child,
        declarations,
        allowUncontractedTags,
        tagNameOf(child) === "for" ? "for" : "if",
      );
    }
  }
}

/**
 * The wildcard match for this tag (decision 147), unless a file-local binding
 * of the same PascalCase name is in scope: that binding outranks a registered
 * custom tag (spec §4), so it outranks a wildcard too.
 */
function activeWildcard(ctx: Ctx, node: Node): WildcardMatch | undefined {
  const match = wildcardMatchOf(node);
  if (!match) return undefined;
  const name = match.authored;
  const bound =
    /^[A-Z]/.test(name) &&
    (ctx.defines.has(name) ||
      ctx.imports.has(name) ||
      (ctx.tagVarShadowed?.has(name) ?? false));
  return bound ? undefined : match;
}

/** `{ trigger }` for a tag a syntax module's `ctx.child` built, else nothing. */
function triggerOf(node: Node): { trigger: TagTrigger } | undefined {
  const mark = node.mxTrigger;
  if (!mark) return undefined;
  return {
    trigger: { id: mark.id, span: mark.span, text: mark.text },
  };
}

function aliasOf(ctx: Ctx, node: Node, match: WildcardMatch): TagAlias {
  const span = exprSpan(ctx, tagNameSpanOf(node));
  return {
    authored: match.authored,
    ...(span ? { span } : {}),
    groups: match.groups,
  };
}

/**
 * The did-you-mean guard (decision 147): a wildcard child whose name is one
 * typo from an explicit child of the same parent most likely meant that
 * child, so it is an error on every target and in every tool.
 */
function rejectNearExplicitChild(
  node: Node,
  match: WildcardMatch,
  label: string,
): void {
  const near = nearestName(match.authored, match.parent.explicit);
  if (near === undefined) return;
  fail(
    `${label} matched the wildcard of ${match.parent.label}; did you mean the explicit child \`<${near}>\`?`,
    node,
  );
}

/** Retains authored names and groups transparent control flow without lowering its contents. */
function authoredChildTree(ctx: Ctx, children: readonly Node[]): ChildNode[] {
  const tree: ChildNode[] = [];
  for (let index = 0; index < children.length; index++) {
    const node = children[index];
    const loc = posOf(ctx, node);
    if (isTextNode(node)) {
      if (node.value.trim() !== "") tree.push({ kind: "ChildText", loc });
    } else if (
      node.type === "MarkoPlaceholder" ||
      node.type === "MxPlaceholder"
    ) {
      tree.push({ kind: "ChildText", loc });
    } else if (isTagNode(node)) {
      if (!hasStaticName(node)) {
        tree.push({ kind: "ChildDynamic", loc });
        continue;
      }
      const name = tagNameOf(node) as string;
      if (name === "const" || name === "define" || name.startsWith("@"))
        continue;
      if (name === "for") {
        tree.push({
          kind: "ChildFor",
          nodes: authoredChildTree(ctx, bodyChildren(node)),
          loc,
        });
      } else if (name === "if") {
        const branches = [
          {
            unconditional: false,
            nodes: authoredChildTree(ctx, bodyChildren(node)),
          },
        ];
        let cursor = index + 1;
        while (cursor < children.length) {
          const branch = children[cursor];
          if (isLayout(branch)) {
            cursor++;
            continue;
          }
          const branchName = tagNameOf(branch);
          if (
            !isTagNode(branch) ||
            (branchName !== "else" && branchName !== "else-if")
          )
            break;
          const unconditional =
            branchName === "else" && !attrByName(branch, "if");
          branches.push({
            unconditional,
            nodes: authoredChildTree(ctx, bodyChildren(branch)),
          });
          index = cursor++;
          if (unconditional) break;
        }
        tree.push({ kind: "ChildIf", branches, loc });
      } else if (name === "else" || name === "else-if") {
        // An orphan branch still gets the usual positioned lowerer error.
        tree.push({
          kind: "ChildIf",
          branches: [
            {
              unconditional: false,
              nodes: authoredChildTree(ctx, bodyChildren(node)),
            },
          ],
          loc,
        });
      } else {
        const why = invalidDefaultTagHint(node);
        const wildcard = activeWildcard(ctx, node);
        const known = wildcard ? undefined : wildcardIneligibility(name, ctx);
        tree.push({
          kind: "ChildTag",
          name: wildcard?.canonical ?? name,
          loc,
          ...(why ? { hint: why } : {}),
          ...(wildcard ? { alias: aliasOf(ctx, node, wildcard) } : {}),
          ...(known ? { known } : {}),
        });
      }
    }
  }
  return tree;
}

/**
 * Lowers one registered custom tag call and splices its ordinary IR roots.
 *
 * `content` is gated on `hasContent` for an ordinary (user-registered) tag.
 * Decision 141: retained Marko-normalized whitespace is content, not layout;
 * only comments and empty text mean "no children supplied". A core-owned
 * built-in like `<try>` is a structural pass-through wrapper, so `isBuiltin`
 * still bypasses the gate and always lowers the block, like `lowerDelegatedTag`.
 */
function lowerCustomTag(
  ctx: Ctx,
  node: Node,
  name: string,
  definition: CustomTag,
  isBuiltin = false,
  wildcard?: WildcardMatch,
): IrNode[] {
  rejectBadRefinements(ctx, node);
  const alias = wildcard ? aliasOf(ctx, node, wildcard) : undefined;
  const label = tagLabel(name, alias);
  validateCustomTagParents(
    definition,
    name,
    posOf(ctx, node),
    ctx.authoredAncestors?.at(-2) ?? "#root",
    label,
  );
  if (wildcard) rejectNearExplicitChild(node, wildcard, label);
  rejectUnsupportedFields(ctx, node, label, {
    attributeTags: true,
    params: true,
    // `var: true` only opts out of this generic rejector's own wording;
    // the dedicated check right below still rejects `/var` for every
    // non-builtin call, with the message this construct actually needs.
    var: true,
  });
  // `/var` binds the value the target unit returns with `<return>`. Whether
  // it *has* one is a fact about the other module, so it is checked where
  // that module's metadata is available — `routeTemplateCall`, for a
  // template-backed tag. A tag with no template at all (an L2 sidecar, or a
  // core-owned built-in like `<try>`) has no `<return>` to read and no unit
  // to compile, so the binding could never be filled.
  //
  // A core-owned built-in is exempt: it validates `/var` itself, with its
  // own wording, inside its `transform`.
  if (!isBuiltin && tagVarOf(node) && !hasTemplate(definition)) {
    fail(
      `\`/var\` on ${label} is not supported: it has no template, so it has no \`<return>\` to bind`,
      node,
    );
  }
  validateCustomAttributeTagBodies(
    ctx,
    label,
    node,
    definition.attributeTags,
    hasTemplate(definition),
  );
  const target: ComponentTarget | undefined = hasTemplate(definition)
    ? {
        kind: "name",
        name,
        resolvedPath: definition.template.filename,
      }
    : undefined;
  const input = target
    ? (ctx.calleeInputFor?.(target) ?? readCalleeInput(target, ctx).input)
    : ({ kind: "none" } as const);
  const loweredTags = lowerAttributeTags(ctx, node, {
    ...schemaFor(input, name),
    customTagContract: !isBuiltin,
  });
  raiseInvalidCalleeInput(ctx, input, name, loweredTags.flat);
  const children = loweredTags.contentChildren;
  const childTree = authoredChildTree(ctx, children);
  validateCustomTagChildren(
    definition,
    { name, loc: posOf(ctx, node), childTree },
    label,
  );
  const handsToHost =
    !isBuiltin &&
    !definition.transform &&
    !hasTemplate(definition) &&
    isContractOnlyDelegated(ctx, name, definition);
  const call: TagCall = {
    name,
    ...(alias ? { alias } : {}),
    ...triggerOf(node),
    nameSpan: exprSpan(ctx, tagNameSpanOf(node)),
    span: exprSpan(ctx, node),
    loc: posOf(ctx, node),
    // A contract-only call on a claimed name becomes a DelegatedTag, so its
    // attributes lower as `lowerDelegatedTag` lowers them.
    attrs: lowerAttrs(ctx, node, name, handsToHost ? "element" : "component"),
    // `handsToHost` skips the `hasContent` gate like `isBuiltin`, so the host
    // gets an authored body exactly as an unregistered claimed tag would; a
    // call with no authored body keeps `content: null`, which `openTagOnly`
    // validation relies on. Ordinary tags keep every nonempty normalized text
    // node, including a lone space (decision 141).
    content:
      isBuiltin || (handsToHost && children.length > 0) || hasContent(children)
        ? lowerBlock(ctx, node, children)
        : null,
    childTree,
    attributeTags: loweredTags.flat,
    attributeTagTree: loweredTags.tree,
    attrTagProps: loweredTags.props,
    params: paramsOf(ctx, node),
    var: tagVarOf(node) ? declName(ctx, tagVarOf(node)) : null,
    varBindings: varBindingsOf(ctx, tagVarOf(node)),
  };
  // The binding was pre-registered by `lowerChildList` at its sibling index;
  // reaching the call is what makes it readable, so its sequence drops to
  // "already seen". Recorded after the call's own attributes were lowered,
  // so a tag's attributes cannot read the `/var` that same tag declares —
  // Marko's rule (`references.ts:556-560`), and the emitted order makes it
  // necessary: the binding is assigned from this call's own result.
  if (call.var) {
    ctx.tagVars ??= new Map();
    ctx.tagVars.set(call.var, {
      block: [...(ctx.tagVarBlock ?? [])],
      pending: false,
    });
  }
  // A core-owned built-in like `<try>` is not a registered tag the caller
  // can finalize. The analyze scratch walk records into its own discarded
  // set; a template lower also owns a local set which is stored with the
  // compiled template and replayed into the caller on every cache hit.
  if (!isBuiltin) {
    ctx.customTagsUsed ??= new Set();
    ctx.customTagsUsed.add(name);
  }
  return transformCustomTag(ctx, definition, call, node);
}

/** A component call, with its props, children and attribute tags. */
function lowerComponent(
  ctx: Ctx,
  node: Node,
  target: ComponentTarget,
  // The call is a registered taglib tag, not the same-named binding in scope.
  taglibTag = false,
): IrNode {
  // The host gets first refusal, before any `Component` node exists: a call it
  // will not route must fail here rather than reach an emitter, which no
  // longer has the Marko node to judge it by.
  if (target.kind === "name" && !taglibTag) {
    ctx.declarations.rejectComponentTag?.(
      target.name,
      markoViewOf(ctx, node),
      ctx,
    );
  }
  if (target.kind !== "dynamic") {
    // The dynamic-tag path already ran this check before routing here; a
    // named or `define` call reaches `lowerComponent` directly and needs its
    // own pass so `<Card(1)><@head>…</@head></Card>` fails here instead of
    // reaching a host emitter, which can only silently drop one side.
    rejectArgsWithProps(node, target);
  }
  // `/var` binds an imported `.mx` unit's `<return>` the way it does a
  // discovered tag's. Any other target (a `.ts` module, a `<define>`, a
  // dynamic tag) has no return shape the core can read, so it stays refused.
  const { shape: returnShape, unreadable } = calleeReturn(target, ctx);
  if (tagVarOf(node) && returnShape === "none") {
    fail(
      `\`<${targetName(target)}>\` does not return a value; add \`<return value=…/>\` to the imported file to bind it with \`/var\``,
      node,
    );
  }
  if (tagVarOf(node) && unreadable) {
    fail(
      `\`/${declName(ctx, tagVarOf(node))}\` on \`<${targetName(target)}>\` can't bind: ${unreadable.path} ${unreadable.reason}`,
      node,
    );
  }
  // A host whose dynamic dispatch reaches a returning unit's render path can
  // bind `/var` on a dynamic tag at run time (decision 155); the callee's
  // shape is unknown statically, so the IR carries the binding without
  // `returnsValue`.
  const allowVar =
    returnShape === "returns" ||
    (target.kind === "dynamic" && ctx.declarations.bindsDynamicTagVar === true);
  rejectUnsupportedFields(ctx, node, `\`<${targetName(target)}>\``, {
    attributeTags: true,
    args: true,
    params: true,
    var: allowVar,
  });

  const input =
    ctx.calleeInputFor?.(target) ?? readCalleeInput(target, ctx).input;
  const owner = targetName(target);
  if (input.kind === "unresolved" && containsAttributeTags(node)) {
    const pos = posOf(ctx, tagNameSpanOf(node) ?? node);
    warn(ctx, {
      message: `couldn't read \`<${owner}>\`'s Input (\`${input.specifier}\` not resolvable); attribute-tag shape inferred from this call`,
      line: pos.line,
      column: pos.column,
      file: ctx.filename,
    });
  }
  const loweredTags = lowerAttributeTags(ctx, node, schemaFor(input, owner));
  raiseInvalidCalleeInput(ctx, input, owner, loweredTags.flat);
  const children = loweredTags.contentChildren;
  const callVar = tagVarOf(node) ? declName(ctx, tagVarOf(node)) : null;
  // Lowered before the binding is registered: the call's own attributes and
  // body cannot read the `/var` it declares (Marko `references.ts:556-560`),
  // and the emitted order assigns it from the call's own result.
  const attrs = lowerAttrs(ctx, node, targetName(target), "component");
  // Same normalized-body presence rule as custom template tags (decision 141).
  const content = hasContent(children) ? lowerBlock(ctx, node, children) : null;
  // Reaching the call makes the binding readable; see the discovered path.
  if (callVar) {
    ctx.tagVars ??= new Map();
    ctx.tagVars.set(callVar, {
      block: [...(ctx.tagVarBlock ?? [])],
      pending: false,
    });
  }
  return {
    kind: "Component",
    target,
    ...triggerOf(node),
    nameSpan:
      target.kind === "dynamic" ? null : nodeSpan(ctx, tagNameSpanOf(node)),
    span: exprSpan(ctx, node),
    attrs,
    content,
    attributeTags: loweredTags.flat,
    attributeTagTree: loweredTags.tree,
    attrTagProps: loweredTags.props,
    args: (tagArgsOf(node) ?? []).map((a: Node) => exprOf(ctx, a)),
    // An imported `.mx` unit that declares `<return>` hands back
    // `{ value, output }`; a discovered one already says so through
    // `routeTemplateCall`, which also carries the `/var` the emitters bind.
    var: callVar,
    varBindings: varBindingsOf(ctx, tagVarOf(node)),
    ...(returnShape === "returns" ? { returnsValue: true } : {}),
    loc: posOf(ctx, node),
  };
}

function targetName(target: ComponentTarget): string {
  // An authored dynamic target has no name to report, so the diagnostic
  // names the construct instead. Spelled without a `$`-brace so it is not
  // mistaken for an unintended template placeholder in this file's own
  // source. A decision-116-routed dynamic target carries the real binding
  // name in `valueImportBinding` and reports that instead — its diagnostics
  // (an unresolved/invalid callee Input) should still name the tag the
  // author wrote, not the runtime lowering it now compiles to.
  if (target.kind === "dynamic")
    return target.valueImportBinding ?? "dynamic tag";
  return target.name;
}

function referencesUnboundAttrTagType(typeUnits: string[]): boolean {
  const { parse, traverse } = coreBabel();
  let declaredLocally = false;
  let referenced = false;
  for (const typeText of typeUnits) {
    if (!typeText.trim()) continue;
    try {
      const file = parse(typeText, {
        sourceType: "module",
        plugins: ["typescript"],
        errorRecovery: true,
      });
      traverse(file, {
        ImportDeclaration(path: Node) {
          if (
            path.node.specifiers?.some(
              (specifier: Node) => specifier.local?.name === "AttrTag",
            )
          ) {
            declaredLocally = true;
          }
        },
        ClassDeclaration(path: Node) {
          if (path.node.id?.name === "AttrTag") declaredLocally = true;
        },
        TSEnumDeclaration(path: Node) {
          if (path.node.id?.name === "AttrTag") declaredLocally = true;
        },
        TSTypeAliasDeclaration(path: Node) {
          if (path.node.id?.name === "AttrTag") declaredLocally = true;
        },
        TSInterfaceDeclaration(path: Node) {
          if (path.node.id?.name === "AttrTag") declaredLocally = true;
        },
        TSTypeReference(path: Node) {
          if (
            path.node.typeName?.type === "Identifier" &&
            path.node.typeName.name === "AttrTag"
          ) {
            referenced = true;
          }
        },
        TSExpressionWithTypeArguments(path: Node) {
          if (
            path.node.expression?.type === "Identifier" &&
            path.node.expression.name === "AttrTag"
          ) {
            referenced = true;
          }
        },
      });
    } catch {
      // Type syntax in an independent static unit must not suppress a valid
      // Input reference. If Babel cannot recover, conservatively request the
      // import whenever this unit contains the standalone type name.
      if (/\bAttrTag\b/.test(typeText)) referenced = true;
    }
  }
  return referenced && !declaredLocally;
}

function declaredAttributeTagRead(
  ctx: Ctx,
  expression: string,
):
  | {
      declaration: AttrTagDecl;
      name: string;
      readsContent: boolean;
    }
  | undefined {
  const member = inputMember(expression);
  if (!member || member === "dynamic" || ctx.ownInput?.kind !== "declared") {
    return;
  }
  const declaration = ctx.ownInput.attrTags.get(member.name);
  if (!declaration) return;
  return { declaration, name: member.name, readsContent: member.content };
}

function rejectUncalledParameterizedAttributeTag(
  ctx: Ctx,
  expression: string,
  node: Node,
  argumentCount = 0,
): void {
  const read = declaredAttributeTagRead(ctx, expression);
  if (!read || argumentCount !== 0 || !read.declaration.hasParams) return;
  const readsDeclaredRenderable =
    read.declaration.as === "renderable" && !read.readsContent;
  const readsDeclaredContent =
    read.declaration.as === "data" && read.readsContent;
  if (!readsDeclaredRenderable && !readsDeclaredContent) return;
  fail(
    `\`${expression}\` is a parameterized attribute tag; pass its arguments with \`<\${${expression}(/* arguments */)}/>\``,
    node,
  );
}

/** Stack authored names only, never synthesized transform output; unwind even on errors. */
function pushAuthoredAncestor(ctx: Ctx, name: string, node: Node): () => void {
  ctx.authoredAncestors ??= [];
  ctx.authoredAncestorNodes ??= [];
  const ancestors = ctx.authoredAncestors;
  const nodes = ctx.authoredAncestorNodes;
  ancestors.push(name);
  nodes.push(node);
  return () => {
    ancestors.pop();
    nodes.pop();
  };
}

/** An attribute tag (`name` with its `@`) written outside a component call. */
function strayAttributeTagMessage(name: string): string {
  return `attribute tag \`<${name}>\` is only valid directly inside a component call`;
}

function lowerTag(ctx: Ctx, node: Node): IrNode | IrNode[] {
  const name = hasStaticName(node) ? String(tagNameOf(node)) : `\${…}`;
  // If/else branches lower through lowerIfChain; for lowers through this entry.
  if (name === "for") return lowerAuthoredTag(ctx, node);
  // One identity per tag (decision 147): a wildcard child is its canonical
  // tag to every `parents` check below it.
  const pop = pushAuthoredAncestor(
    ctx,
    activeWildcard(ctx, node)?.canonical ?? name,
    node,
  );
  try {
    return lowerAuthoredTag(ctx, node);
  } finally {
    pop();
  }
}

function lowerAuthoredTag(ctx: Ctx, node: Node): IrNode | IrNode[] {
  // Both a bare `${expr}` line and `<${expr} .../>` parse to a tag whose
  // *name* is the expression — Marko's concise mode has no other shape for
  // a bare one (see the "four Marko facts" in AGENTS.md). Both are dynamic
  // tags: when a host claims DYNAMIC_TAG it gets the DelegatedTag (shape "bare"
  // or "tagged", as before); otherwise core lowers a `Component` with a
  // dynamic target, resolved at run time like any other host.
  if (node.name && !hasStaticName(node)) {
    validateBoundAttributes(ctx, node);
    rejectArgsWithProps(node);
    const isBare =
      tagAttributesOf(node).length === 0 && !bodyChildren(node).length;
    const dynamicExpr = exprOf(ctx, tagNameExprOf(node));
    if (/^[A-Za-z_$][\w$]*$/.test(dynamicExpr.code.trim())) {
      const binding = dynamicExpr.code.trim();
      rejectMarkoImportTag(ctx, binding, `\${${binding}}`, node);
    }
    const read = declaredAttributeTagRead(ctx, dynamicExpr.code);
    if (read) {
      if (read.declaration.as === "data" && !read.readsContent) {
        fail(
          `\`input.${read.name}\` is a data attribute tag; render its body with \`<\${input.${read.name}.content}/>\``,
          node.name,
        );
      }
    }
    rejectUncalledParameterizedAttributeTag(
      ctx,
      dynamicExpr.code,
      node.name,
      (tagArgsOf(node) ?? []).length,
    );
    const claimed = ctx.declarations.isDelegatedTag?.(
      DYNAMIC_TAG,
      ctx,
      isBare ? "bare" : "tagged",
    );
    if (claimed) return lowerDelegatedTag(ctx, node, DYNAMIC_TAG);
    return lowerComponent(ctx, node, {
      kind: "dynamic",
      expr: dynamicExpr,
    });
  }

  const name = String(tagNameOf(node));
  if (!TAG_NAME.test(name) && !NOT_A_NAME_SHAPE.test(name)) {
    fail(
      `Invalid tag name \`${name}\` — a tag name may use letters (any script), digits and \`-._:$\``,
      node.name,
    );
  }
  // A parent's `children["*"]` claimed this tag (decision 147): it is a call
  // of the matched contract, under the canonical name, ahead of every
  // host-specific reading of the authored name (disposition, claim, element).
  const wildcard = activeWildcard(ctx, node);
  if (wildcard) {
    return lowerCustomTag(
      ctx,
      node,
      wildcard.canonical,
      wildcard.definition,
      false,
      wildcard,
    );
  }
  const fileLocalBinding =
    /^[A-Z]/.test(name) &&
    (ctx.defines.has(name) ||
      ctx.imports.has(name) ||
      (ctx.tagVarShadowed?.has(name) ?? false));

  // Only a call actually routed through a registered custom-tag contract is
  // exempt (decision 138, E1). Built-ins and shadowing local bindings are not.
  // Attribute-tag contracts retain their separate bound-value checks too.
  if (
    fileLocalBinding ||
    !ctx.customTags ||
    !Object.hasOwn(ctx.customTags, name) ||
    Object.hasOwn(BUILTIN_CUSTOM_TAGS, name) ||
    Object.hasOwn(ctx.declarations.tags, name) ||
    [
      "import",
      "static",
      "export",
      "for",
      "const",
      "define",
      "return",
      "else",
      "else-if",
    ].includes(name)
  ) {
    validateBoundAttributes(ctx, node);
  }

  // Builtin identity is independent of host rendering policy: default HTML
  // drops `let`, but it remains Marko syntax. A delegated vocabulary or
  // registered custom tag can reclaim `let`/`id`; structural names cannot.
  const compilerValueTag =
    name === "const" ||
    name === "return" ||
    ((name === "let" || name === "id") &&
      (!ctx.customTags || !Object.hasOwn(ctx.customTags, name)) &&
      (ctx.declarations.isBuiltinTag?.(name, ctx) ??
        !ctx.declarations.isDelegatedTag?.(name, ctx)));
  if (!fileLocalBinding && compilerValueTag)
    validateBuiltinValueAttributes(node, name);

  // A `server`/`client` statement's text is checked like any statement
  // (#395 r3), before a host runs it (html's `server`), drops it (html's
  // `client`) or refuses it: Marko parses it first, so an invalid join that
  // swallowed the next template line is its syntax error, never a silent
  // drop. Only a statement-parsed node (`isStatementNode`); data's ordinary
  // `client`/`server` tags are not statements.
  if ((name === "server" || name === "client") && isStatementNode(node)) {
    const text = sliceNode(ctx, node).trim();
    const keyword = new RegExp(`^${name}\\s+`).exec(text)?.[0] ?? name;
    rejectInvalidStatement(
      ctx,
      node,
      text.slice(keyword.length),
      keyword.length,
      name,
    );
  }

  const disposition = Object.hasOwn(ctx.declarations.tags, name)
    ? ctx.declarations.tags[name]
    : undefined;
  if (disposition) {
    if (disposition.kind === "error") fail(disposition.reason, node);
    rejectInertShape(ctx, node, name, disposition);
    // Inert: accepted, contributes nothing to the IR.
    return { kind: "Text", value: "", loc: posOf(ctx, node) };
  }

  switch (name) {
    case "import":
    case "static":
    case "export":
      return lowerStatement(ctx, node, name);
    case "class":
      // Decision 168: `class` is a statement tag so the parser reads its
      // text as code, but MX has no component class on any target. A lookup
      // that makes `class` an ordinary tag (data) leaves it to the generic path.
      if (
        ctx.tagTable &&
        !ctx.tagTable.getTag("class")?.parseOptions?.statement
      )
        break;
      return fail(
        `\`class { … }\` is not supported in ${productOf(ctx)}: a component class has no equivalent on any target — write a function component, or put the state in \`<let>\`/\`static\` code`,
        node,
      );
    case "for":
      return lowerFor(ctx, node);
    case "const":
      return lowerConst(ctx, node);
    case "define":
      return lowerDefine(ctx, node);
    case "return":
      return lowerReturn(ctx, node, ctx.returnDepth !== 0);
    case "else": {
      const label = attrByName(node, "if") ? "else if" : "else";
      return fail(`\`<${label}>\` without a preceding \`<if>\``, node);
    }
    case "else-if":
      return fail(`\`<${name}>\` without a preceding \`<if>\``, node);
  }

  if (name.startsWith("@")) fail(strayAttributeTagMessage(name), node);

  // Core-owned custom tags (`<try>`) are consulted before a caller's own
  // `ctx.customTags`, and win unconditionally: a caller registering the same
  // name is a shadowing attempt on a built-in, rejected here rather than
  // silently ignored.
  const builtinTag = Object.hasOwn(BUILTIN_CUSTOM_TAGS, name)
    ? BUILTIN_CUSTOM_TAGS[name]
    : undefined;
  if (builtinTag) {
    if (ctx.customTags && Object.hasOwn(ctx.customTags, name)) {
      fail(shadowedBuiltinMessage(name), node);
    }
    return lowerCustomTag(ctx, node, name, builtinTag, true);
  }

  // A name the file itself binds — an `import`, a `<define>`, a `<const>`, or
  // a `<for>`/`<define>` tag param — wins over a registered custom tag of the
  // same name (spec §4: explicit import > local `tags/` > `mx.tags`; measured
  // against Marko 6.3.51's own translator, `normalizeTag` in
  // `@marko/runtime-tags/dist/translator/index.js`, which rewrites a
  // capitalized tag name to a dynamic-tag reference whenever
  // `tag.scope.getBinding(tagName)` finds a binding in scope, unconditionally
  // and before any taglib/custom-tag lookup runs). This is a core rule,
  // checked directly on `ctx.imports`/`ctx.defines`/`ctx.tagVarShadowed`
  // rather than by calling a host's own `isComponent` (which also matches
  // taglib-discovered names with no file-local binding, and which Solid's and
  // Astro's implementations never consult at all — both decide purely by
  // case), so a shadowed name routes to the component it names instead of the
  // custom tag before `ctx.customTags` is ever consulted.
  //
  // `ctx.tagVarShadowed` is MX's own scope-tracking set — the exact analog of
  // Babel's `scope.getBinding`, maintained by `shadowBindings`/`scopeBindings`
  // around every `<const>`, `<for|p|>`, and `<define|p|>` body — so it already
  // gives correct lexical scoping for free: a name bound inside an `<if>`
  // branch or a `<for>` body is shadowed only there, and reverts to the
  // registered custom tag immediately outside it, exactly as Marko's own
  // `getBinding` reverts outside the declaring scope.
  //
  // Gated on PascalCase: Marko's own rule (matched by every host's own
  // `isComponent`, e.g. html `translate.ts`, preact `emitter.ts`, and by
  // Marko's own `TAG_NAME_IDENTIFIER_REG = /^[A-Z][a-zA-Z0-9_$]*/`) is that a
  // *lowercase* local variable is never resolved as a component tag — only
  // taglib/`tags/` discovery or a built-in element can claim a lowercase
  // name. An ungated check regressed `import panel from "./p.mx"` +
  // `<panel/>` (a registered `panel` custom tag, or a host-claimed
  // `<style>`): the file-local binding existed but was never meant to be a
  // component call, so it must not shadow the custom tag or the host claim
  // either.

  // Registered custom tags take precedence over host claims so a shared tag
  // may be expressed in terms of `ctx.build.delegatedTag(...)`. Structural tags
  // above remain core-owned and cannot be shadowed; a file-local binding
  // (checked above) outranks a custom tag of the same name.
  const customTag =
    !fileLocalBinding && ctx.customTags && Object.hasOwn(ctx.customTags, name)
      ? ctx.customTags[name]
      : undefined;
  if (customTag) return lowerCustomTag(ctx, node, name, customTag);

  if (!fileLocalBinding && ctx.declarations.isDelegatedTag?.(name, ctx)) {
    return lowerDelegatedTag(ctx, node, name);
  }

  // `fileLocalBinding` alone is sufficient here for a `<const>`/`<for>`-param/
  // `<define>`-param binding: a host's own `isComponent` only ever consults
  // `ctx.imports`/`ctx.defines` (matching Marko's own local-variable-as-
  // component rule), so it does not recognize a `ctx.tagVarShadowed` name —
  // but `fileLocalBinding` already proved it is a capitalized, in-scope local
  // binding, which is exactly what a component call needs to route on.
  // Decision 164: a lowercase tag is a native element whatever `import` or
  // `<define>` binding of that name is in scope (Marko 6.3.51: only a
  // PascalCase name, or a dynamic tag `<${name}>`, calls a local binding).
  // Hosts' `isComponent` answers `imports.has || defines.has` with no casing
  // gate, so the lowercase case is cut off here, once, for every host.
  //
  // Marko's own gate is "not `/^[A-Z]/`" (`fileLocalBinding`'s complement), so
  // `_x` and `$x` names are lowercase here too. A tag a host taglib registers
  // is not a lowercase *binding* call at all: it keeps the host's routing
  // whatever is imported (addendum 1).
  const registeredTag = isRegisteredTaglibTag(ctx, name);
  // A `tags/` file this host cannot call (`tags/x.marko`, `tags/x/index.*`)
  // would otherwise compile as the native element `<x>`, silently.
  if (!registeredTag && !fileLocalBinding && !ctx.imports.has(name)) {
    const found = uncalledTagFileOf(ctx, name);
    if (found) failUncalled(ctx, name, found, node);
  }
  const lowercaseBinding =
    !/^[A-Z]/.test(name) &&
    !registeredTag &&
    (ctx.defines.has(name) || ctx.imports.has(name));
  // The diagnostic fires only for a binding that can be a tag: an in-scope
  // `<define>`, or an import of a tag module (`.mx`, `.marko`). A value import
  // (Angular's `input`, any `.ts` helper) is native and silent.
  const tagBinding =
    lowercaseBinding &&
    (ctx.bindingSites.get(name)?.kind === "defined" ||
      isTagModuleImport(ctx, name));
  if (tagBinding && !isNativeElementName(ctx, name)) {
    const site = ctx.bindingSites.get(name);
    const from = ctx.importSpecifiers.get(name);
    const defined = site?.kind === "defined";
    const bound = defined
      ? `\`${name}\` is defined at ${site.line}:${site.column + 1}`
      : `\`${name}\` is imported from ${from}`;
    const fix = lowercaseBindingFix(
      name,
      (pascal) =>
        `Write \`<${pascal}>\` (rename the ${defined ? "define" : "import"})`,
      "or",
      "/",
    );
    fail(
      `\`<${name}>\` is not a tag here: ${bound}, and a lowercase tag never calls a binding. ${fix}`,
      node,
    );
  }
  // A registered taglib tag called `row` is still `row` when a binding of that
  // name is in scope (addendum 1): call the module the host names for the
  // tag, not the import.
  if (
    registeredTag &&
    !/^[A-Z]/.test(name) &&
    (ctx.defines.has(name) || ctx.imports.has(name))
  ) {
    const modulePath = discoveredTagModuleOf(ctx, name, node);
    if (!modulePath) failUncallableTaglibTag(ctx, name, node);
    const binding = bindingForDiscoveredModule(
      ctx,
      modulePath,
      name,
      posOf(ctx, node),
    );
    // `resolvedPath` keeps every metadata read (return shape, `Input`,
    // attribute tags, `/var`) on the taglib tag too: resolved by name, it
    // would read the authored import the call no longer targets.
    return lowerComponent(
      ctx,
      node,
      { kind: "name", name, resolvedPath: modulePath, binding },
      true,
    );
  }
  if (
    fileLocalBinding ||
    (!lowercaseBinding && ctx.declarations.isComponent(name, ctx))
  ) {
    rejectMarkoImportTag(ctx, name, name, node);
    const params = ctx.defines.get(name);
    if (params) {
      warnDefineExtraParams(ctx, node, name, params);
      return lowerComponent(ctx, node, { kind: "define", name, params });
    }
    // decision 116: a capitalized tag bound to a value **import** that is
    // not a `.marko`/`.mx` default import lowers as a dynamic tag, matching
    // Marko's own `_dynamic_tag` runtime dispatch — only a `.marko`/`.mx`
    // default import is Marko's statically-resolved component case. Gated
    // on `ctx.importSpecifiers`, not `ctx.imports`: the latter also holds
    // every other file-local value binding (a module-scope `const`/
    // `function`/`class`, a `<const>`, a tag param — on Solid, folded in via
    // `moduleBindings`), and decision 116 is scoped to import bindings
    // only. A locally declared component keeps today's direct call on every
    // host, unchanged — routing it through `<Dynamic>` too would silently
    // change the most common Solid authoring pattern (a module-scope
    // function used as a tag) well beyond what decision 116 covers.
    // `valueImportBinding` carries the binding's own name (provenance,
    // never present on an authored `<${expr}/>`) so `readCalleeInput` can
    // still resolve the callee's declared `Input` for typed attribute-tag
    // checking, even though the call now lowers dynamically.
    if (
      ctx.importSpecifiers.has(name) &&
      !ctx.importDefaultFromMarkoOrMx.has(name)
    ) {
      // SAFETY: a named binding is synthetic expression code, not an authored Babel expression; consumers allow no node.
      return lowerComponent(ctx, node, {
        kind: "dynamic",
        expr: {
          code: name,
          shape: "other",
          node: null,
        },
        valueImportBinding: name,
      });
    }
    // Local extension of decision 116 (firstmate's ruling under decision 116
    // in `notes/decisions-2026-09-10.md`): a non-import local (a
    // `static`/module-scope declaration, a `<const>`, a `<for>`/`<define>`
    // tag param) whose value core could not statically prove is a
    // function/arrow/class also lowers dynamic — a plain `function Foo(){}`/
    // `class Foo{}`/`const Foo = () => {}` stays the direct call above,
    // matching every host's pre-existing, most common authoring pattern;
    // `const Foo = lazy(...)`, a conditional, a string, or a tag param (whose
    // runtime value can never be inspected here) is "unknown" and routes
    // here instead. Same `valueImportBinding` provenance channel decision
    // 116 already built, so typed attribute-tag checking is unaffected.
    if (ctx.unknownLocalValue.has(name)) {
      // SAFETY: a named binding is synthetic expression code, not an authored Babel expression; consumers allow no node.
      return lowerComponent(ctx, node, {
        kind: "dynamic",
        expr: {
          code: name,
          shape: "other",
          node: null,
        },
        valueImportBinding: name,
      });
    }
    // A tag the host itself resolves to a module. Not for a file-local
    // binding: that is already in scope.
    const modulePath = fileLocalBinding
      ? undefined
      : discoveredTagModuleOf(ctx, name, node);
    // A host taglib names the tag and nothing resolves it to a module: the
    // bare call would reference a binding nothing declares.
    if (!modulePath && !fileLocalBinding && registeredTag)
      failUncallableTaglibTag(ctx, name, node);
    const binding = modulePath
      ? bindingForDiscoveredModule(ctx, modulePath, name, posOf(ctx, node))
      : undefined;
    return lowerComponent(
      ctx,
      node,
      binding ? { kind: "name", name, binding } : { kind: "name", name },
    );
  }

  // No HTML element is ever capitalized, so an unbound PascalCase tag is a
  // missing or misspelled binding, not an element that happens to be
  // capitalized. Emitting it literally would be a silent misroute.
  if (/^[A-Z]/.test(name)) {
    // The host's own wording first (decision 114): a Marko-parity target
    // reports Marko's own failure for an unresolved custom tag ("Unable to
    // find entry point for custom tag `<Name>`"), which is what its users
    // see and what its fixtures assert. The message below is the fallback
    // for a host that supplies none.
    ctx.declarations.rejectUnknownTag?.(name, markoViewOf(ctx, node), ctx);
    fail(
      `\`<${name}>\` has no matching import or \`<define>\` in scope; a capitalized tag is always a component call`,
      node,
    );
  }

  // An unknown lowercase tag that is neither a binding nor a real element is
  // the silent-failure mode ADR 0001 names: a core tag the host has no
  // lowering for must be an error, never a literal element.
  if (!ctx.declarations.isElement(name, ctx)) {
    // A lowercase tag naming an in-scope binding that is no element keeps the
    // host's own wording for it (Marko: "Local variables must be in a dynamic
    // tag unless they are PascalCase").
    if (lowercaseBinding) {
      ctx.declarations.rejectComponentTag?.(name, markoViewOf(ctx, node), ctx);
    }
    // The host's own wording first: a Marko-parity target reports Marko's
    // failure for an unresolved custom tag, which is what its users see and
    // what the fixtures assert. The message below is the fallback.
    ctx.declarations.rejectUnknownTag?.(name, markoViewOf(ctx, node), ctx);
    fail(
      lowercaseBinding
        ? `unknown tag \`<${name}>\`: not an HTML element, and a lowercase tag never calls the \`${name}\` binding in scope. Rename it \`${name.charAt(0).toUpperCase()}${name.slice(1)}\` or write \`<\${${name}}>\``
        : `unknown tag \`<${name}>\`: not an HTML element, and no matching import or \`<define>\` is in scope`,
      node,
    );
  }
  if (tagBinding) warnLowercaseBinding(ctx, node, name);

  const body = bodyChildren(node);
  // Hybrid: check BOTH Marko field AND MX body children for attribute tags
  const hasAttributeTags =
    (node.attributeTags ?? []).length > 0 || body.some(isMxAttributeTag);
  if (hasAttributeTags) {
    ctx.declarations.rejectElementAttributeTags?.(
      name,
      markoViewOf(ctx, node),
      ctx,
    );
  }
  rejectUnsupportedFields(ctx, node, `\`<${name}>\``);

  // Void by the same table the parse read (the target's `nativeTags`, else
  // core's own HTML elements), so a body the parse kept is never dropped.
  const isVoid = isNativeVoid(ctx.declarations.nativeTags, name);
  // Filter attribute tags from children — they're processed by lowerAttributeTags,
  // not as regular children. MX AST has them in body; Marko AST had them separate.
  const contentChildren = body.filter(
    (child: Node) => !isMxAttributeTag(child),
  );
  return {
    kind: "Element",
    name,
    ...triggerOf(node),
    nameSpan: exprSpan(ctx, tagNameSpanOf(node)),
    span: exprSpan(ctx, node),
    attrs: lowerAttrs(ctx, node, name, "element", true),
    children: isVoid ? [] : lowerChildren(ctx, contentChildren),
    void: isVoid,
    loc: posOf(ctx, node),
  };
}

/**
 * Decision 139's two messages. Marko 6.3.51 rejects both constructs
 * ("CDATA sections are not supported in Marko." / "XML declarations sections
 * are not supported in Marko."); MX keeps Marko's meaning and adds the fix,
 * because a rejection that does not say what to write instead just moves the
 * question. Module-private: a host has no reason to match on them, and the
 * tests assert the literal rather than importing the thing under test.
 */
// biome-ignore-start lint/suspicious/noTemplateCurlyInString: the message quotes MX placeholder syntax, not a JS template
const CDATA_MESSAGE =
  '`<![CDATA[…]]>` is not supported: write the text inline, as `${"…"}` when it must stay raw, or in an attribute value';
// biome-ignore-end lint/suspicious/noTemplateCurlyInString: the message quotes MX placeholder syntax, not a JS template
const DECLARATION_MESSAGE =
  "`<?…?>` (an XML declaration or processing instruction) is not supported: remove it";

/** How deep each `Ctx` is in `lower`/`lowerChildren` calls (`lastly`). */
const loweringDepth = new WeakMap<Ctx, number>();

/**
 * Runs a lowering entry and, at the outermost one for `ctx` only, raises the
 * document's `MX_INPUT_ENDS_IN_DELIMITER` after a walk that raised nothing
 * (decision 161): main reported the cut tag's own lowering error first, and
 * this error stands only where nothing else fires.
 */
function lastly<T>(ctx: Ctx, body: readonly unknown[], run: () => T): T {
  const depth = loweringDepth.get(ctx) ?? 0;
  loweringDepth.set(ctx, depth + 1);
  try {
    const out = run();
    const ended = depth === 0 ? endOfInputError(body) : undefined;
    if (ended) throw ended;
    return out;
  } finally {
    loweringDepth.set(ctx, depth);
  }
}

export function lowerChildren(ctx: Ctx, children: readonly Node[]): IrNode[] {
  try {
    const frontEndError = pendingFrontEndError(children);
    if (frontEndError) throw frontEndError;
    return lastly(ctx, children, () => lowerChildrenOf(ctx, children));
  } catch (error) {
    // A lowering boundary (decision 158, PR 4 addendum): an error raised on
    // an MX node leaves positioned.
    positionError(ctx, error);
    throw error;
  }
}

function lowerChildrenOf(ctx: Ctx, authored: readonly MxChild[]): IrNode[] {
  let children = authored;
  // An external call (not from `lower`) has unresolved unnamed tags; the
  // walk starts with no parents, right for a body lowered on its own.
  if (!ctx.unnamedTagsResolved) {
    if (!ctx.atomsConverted) convertAtoms(ctx, children);
    // A syntax module's atoms (`extra.mxAtom` replacements) join the atoms.
    if (lowerTriggers(ctx, children)) convertAtoms(ctx, children);
    children = childrenWithTriggers(children);
    resolveUnnamedTags(ctx, children);
    ctx.unnamedTagsResolved = true;
    try {
      return lowerChildren(ctx, children);
    } finally {
      ctx.unnamedTagsResolved = false;
    }
  }
  // Every call but the template body's own (`lower`, which resets it to 0
  // around its walk) is lowering the children of *some* container, so
  // counting here rather than at each of the eight call sites is what keeps
  // `<return>`'s position rule from drifting the next time a construct with
  // a child list is added.
  const depth = ctx.returnDepth ?? 0;
  ctx.returnDepth = depth + 1;
  // Each block gets an id, and the path to it is what decides whether a
  // `/var` declared in one block is readable from another (see
  // `checkTagVarReads`). Two sibling blocks get different ids, which is the
  // distinction depth alone cannot make.
  const outerBlock = ctx.tagVarBlock ?? [];
  ctx.tagVarBlockSeq = (ctx.tagVarBlockSeq ?? 0) + 1;
  ctx.tagVarBlock = [...outerBlock, ctx.tagVarBlockSeq];
  try {
    return lowerChildList(ctx, children);
  } finally {
    ctx.returnDepth = depth;
    ctx.tagVarBlock = outerBlock;
    // A `/var` declared in this block goes out of scope with it, exactly as
    // the `let` it emits does. Its entry is kept rather than deleted, holding
    // the *block path* it was declared at: a later read is then a diagnosable
    // escape ("not in scope here") instead of an ordinary unknown identifier
    // that would reach the emitted JS as `undefined`. A sibling block that
    // binds the same name overwrites the entry, which is right — that is a
    // new binding, and ordinary JS.
  }
}

/**
 * The index just past an `<if>` chain starting at `index`: its `else-if` and
 * `else` branches, with the layout between them, as `lowerIfChain` walks them.
 * A chain whose head failed is skipped by this much.
 */
function ifChainEnd(children: readonly Node[], index: number): number {
  let i = index + 1;
  while (i < children.length) {
    const child = children[i];
    if (isCommentNode(child)) {
      i++;
      continue;
    }
    if (isTextNode(child) && child.value.trim() === "") {
      i++;
      continue;
    }
    const name = tagNameOf(child);
    if (!isTagNode(child) || (name !== "else" && name !== "else-if")) {
      break;
    }
    i++;
    if (name === "else" && !attrByName(child, "if")) break;
  }
  return i;
}

function lowerChildList(ctx: Ctx, authored: readonly MxChild[]): IrNode[] {
  // A body read straight off its tag: its line triggers as lowered.
  const children = childrenWithTriggers(authored);
  // Every `/var` this block declares is registered *before* the walk, at the
  // sibling index it is declared at. A read earlier in the same block then
  // finds a binding whose sequence is greater than its own and reports
  // "read before the call", rather than finding nothing and compiling to a
  // reference the emitted JS leaves in the temporal dead zone — Marko's own
  // check (`references.ts:597-602`), which compares sibling indices for
  // exactly this reason.
  // Imports lower in the walk below, after this pass, so the names a sibling
  // `import` statement binds are read off the source here.
  let siblingImports: Set<string> | undefined;
  const importsName = (tagName: string): boolean => {
    siblingImports ??= new Set(
      children.flatMap((child) =>
        isTagOrStatementNode(child) && tagNameOf(child) === "import"
          ? importBindings(sliceNode(ctx, child).trim())
          : [],
      ),
    );
    return siblingImports.has(tagName);
  };
  for (const child of children) {
    if (!isTagNode(child) || !tagVarOf(child)) continue;
    // Only a *custom tag call* binds a `/var` from a unit's `<return>`.
    // `<let>`, `<const>` and every other core construct that takes a `/var`
    // declares an ordinary binding whose scope rules already work, and
    // pre-registering those made a legal read of one report as out of scope.
    const tagName = tagNameOf(child);
    const discovered =
      typeof tagName === "string" &&
      ctx.customTags !== undefined &&
      Object.hasOwn(ctx.customTags, tagName);
    // An imported binding is a call too; `lowerComponent` refuses `/var` on
    // the ones that return nothing.
    if (
      typeof tagName !== "string" ||
      !(discovered || ctx.importSpecifiers.has(tagName) || importsName(tagName))
    ) {
      continue;
    }
    const name = declName(ctx, tagVarOf(child));
    ctx.tagVars ??= new Map();
    ctx.tagVars.set(name, {
      block: [...(ctx.tagVarBlock ?? [])],
      pending: true,
    });
  }

  const out: IrNode[] = [];
  let index = 0;

  while (index < children.length) {
    // Hybrid until PR 5: the arms below still name Marko's kinds, which the
    // MX type cannot hold.
    const child: Node = children[index];

    if (isTagNode(child) && tagNameOf(child) === "if") {
      const lowered = recover(ctx, () => lowerIfChain(ctx, children, index));
      if (lowered) {
        out.push(lowered[0]);
        index = lowered[1];
      } else {
        // The chain's head failed: skip it whole, its `else` branches with it.
        index = ifChainEnd(children, index);
      }
      continue;
    }

    // A hoist from this child belongs to the enclosing function, so the
    // prelude it appends is drained by whichever scope owns it — the template,
    // or the nearest `<define>`.
    // Decision 162: one child's failure is recorded and the child skipped, with
    // its subtree; the walk goes on to the next sibling.
    recover(ctx, () => {
      switch (child.type) {
        case "MarkoText":
        case "MxText":
          // Already decision 33: Marko's own `onText` dropped newline-bearing
          // whitespace runs and collapsed the rest before we saw them. `value`
          // carries that normalized text; `span` covers the authored range.
          out.push({
            kind: "Text",
            value: child.value,
            span: exprSpan(ctx, child),
            loc: posOf(ctx, child),
          });
          break;
        case "MarkoPlaceholder":
        case "MxPlaceholder": {
          const value =
            child.type === "MxPlaceholder"
              ? payloadOf(child.expression)
              : child.value;
          const interpolation = exprOf(ctx, value);
          rejectUncalledParameterizedAttributeTag(
            ctx,
            interpolation.code,
            value,
          );
          out.push({
            kind: "Interpolation",
            expr: interpolation,
            escaped: child.escape,
            span: exprSpan(ctx, child),
            loc: posOf(ctx, child),
          });
          break;
        }
        case "MarkoTag":
        case "MxTag":
        case "MxReturn":
        // A module statement lowers where Marko's statement tag did: the
        // tag path, by its keyword (`tagNameOf`).
        case "MxModuleStatement": {
          // A statement the host hoisted stays on `ctx.prelude` and is drained
          // by the enclosing *function* — `lowerDefine`, or `lower` for the
          // render function — never here. Draining it at every child list would
          // trap a hoist from inside an `<if>` in that branch, which is the one
          // thing decision 70's hoist hook exists to prevent: the declaration
          // has to outlive the block it was written in.
          const lowered = lowerTag(ctx, child);
          if (Array.isArray(lowered)) out.push(...lowered);
          else out.push(lowered);
          break;
        }
        // Marko's `<@name>` here is a `MarkoTag`, rejected by `lowerTag`.
        case "MxAttributeTag":
          fail(strayAttributeTagMessage(`@${child.name.value}`), child);
          break;
        case "MarkoDocumentType":
        case "MxDoctype":
          out.push({
            kind: "DocumentType",
            value: child.value,
            loc: posOf(ctx, child),
          });
          break;
        case "MarkoComment":
        case "MxComment":
          // Marko strips the delimiters, so an HTML comment and a `//` line
          // comment are indistinguishable by value alone; the source decides.
          // MX records which one it read.
          out.push({
            kind: "Comment",
            value: child.value,
            html:
              child.type === "MxComment"
                ? child.kind === "html"
                : sliceNode(ctx, child).startsWith("<!--"),
            span: exprSpan(ctx, child),
            loc: posOf(ctx, child),
          });
          break;
        case "MarkoScriptlet":
        case "MxScriptlet":
          fail(
            `scriptlets (\`$ statement\`) are not supported in ${productOf(ctx)} (decision 54)${scriptletSentence(declaredVariable(child), ctx.declarations)}`,
            child,
          );
          break;
        // Decision 139. The IR has no node for either construct, so before this
        // arm existed both fell off the end of this switch: wrong output and a
        // green build, on every target. `fail` reports `node.loc.start`, which
        // is the `<` — the same place Marko's code frame underlines.
        //
        // A *raw-text* body (`<script>`, `<style>`, `<textarea>`, `<title>`)
        // never reaches here: Marko's parser reads those as one `MarkoText`, so
        // the construct there is text and stays text. That is the parser's call,
        // not this switch's, which is why nothing here has to special-case them.
        case "MarkoCDATA":
        case "MxCDATA":
          fail(CDATA_MESSAGE, child);
          break;
        case "MarkoDeclaration":
        case "MxDeclaration":
          fail(DECLARATION_MESSAGE, child);
          break;
        // Decision 182 seam: a line trigger the trigger pass did not lower
        // (no registered syntax, or a `{ call }` with no `lowerTrigger`) is
        // refused in the table check's wording; a block tag or filter goes
        // to the syntax module's hook (addendum 5), or is refused likewise.
        case "MxTrigger":
          fail(`\`${child.id}\` trigger has no lowering yet`, child);
          break;
        case "MxBlockTag": {
          const hook = ctx.syntaxModule?.lowerBlockTag;
          if (!hook) fail("a block tag has no lowering yet", child);
          out.push(
            ...syntaxHookIr(ctx, child, "lowerBlockTag", (build) =>
              (hook as NonNullable<typeof hook>)(
                child.value,
                { sourceStart: child.start, sourceEnd: child.end },
                build,
              ),
            ),
          );
          break;
        }
        case "MxFilter": {
          const hook = ctx.syntaxModule?.lowerFilter;
          if (!hook) {
            fail(`the \`${child.name}\` filter has no lowering yet`, child);
          }
          out.push(
            ...syntaxHookIr(ctx, child, "lowerFilter", (build) =>
              (hook as NonNullable<typeof hook>)(
                child.name,
                child.value,
                { sourceStart: child.start, sourceEnd: child.end },
                build,
              ),
            ),
          );
          break;
        }
        default:
          // An MX node kind with no lowering is never dropped silently; a
          // Marko kind this switch has no arm for keeps today's behaviour.
          if (String(child.type).startsWith("Mx")) {
            fail(
              `\`${child.type}\` has no lowering yet (not yours: an internal bug)`,
              child,
            );
          }
      }
    });
    index++;
  }

  return out;
}

/**
 * Runs a syntax module's `lowerBlockTag`/`lowerFilter` (decision 182
 * addendum 5) with the IR builders a custom tag's `transform` gets, and
 * returns its IR as a list. Whatever the hook throws leaves positioned at the
 * construct: a `TranslateError` as is, anything else wrapped.
 */
function syntaxHookIr(
  ctx: Ctx,
  node: Node,
  hook: "lowerBlockTag" | "lowerFilter",
  run: (context: SyntaxBuildContext) => IrNode | readonly IrNode[],
): IrNode[] {
  const build = buildersFor(posOf(ctx, node), ctx, null, hook, {});
  let result: IrNode | readonly IrNode[];
  try {
    result = run(Object.freeze({ build }));
  } catch (error) {
    if (isTranslateError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return fail(`the syntax module's \`${hook}\` threw: ${message}`, node);
  }
  const nodes = Array.isArray(result) ? [...result] : [result as IrNode];
  if (nodes.some((each) => !each || typeof each !== "object" || !each.kind)) {
    fail(
      `the syntax module's \`${hook}\` must return IR nodes (build them with \`ctx.build\`)`,
      node,
    );
  }
  return nodes;
}

/**
 * Lowers a whole template body to the IR.
 *
 * Module-level parts (`import`, `static`, `export interface Input`) are lifted
 * out of the body into `Ir`'s own fields, so a host places them without
 * filtering the tree for statement nodes.
 */
export function lower(ctx: Ctx, body: readonly Node[]): Ir {
  try {
    // Port PR 5: the name-sugar errors the MX front end already refuses at
    // token level (its `MX_*` rules) are lowering's errors, as on Marko's
    // tree, with the same text and position.
    const frontEndError = pendingFrontEndError(body);
    if (frontEndError) throw frontEndError;
    return lastly(ctx, body, () => lowerRoot(ctx, body));
  } catch (error) {
    // A lowering boundary (decision 158, PR 4 addendum): an error raised on
    // an MX node leaves positioned.
    positionError(ctx, error);
    throw error;
  }
}

function lowerRoot(ctx: Ctx, authored: readonly MxChild[]): Ir {
  // Before anything reads a tag name: an unnamed tag has none yet. The flag
  // tells `lowerChildren` the whole tree is already resolved, so only a call
  // from outside this walk resolves (and never re-walks a subtree).
  // Decision 156: atoms first, so no expression is ever read as its stand-in.
  if (!ctx.atomsConverted) {
    convertAtoms(ctx, authored);
    ctx.atomsConverted = true;
  }
  // Decision 182 addendum 5: a syntax table's triggers, before anything
  // reads an expression, an attribute list or a body.
  // A syntax module's atoms (`extra.mxAtom` replacements) join the atoms.
  if (lowerTriggers(ctx, authored)) convertAtoms(ctx, authored);
  const body = childrenWithTriggers(authored);
  resolveUnnamedTags(ctx, body);
  const wasResolved = ctx.unnamedTagsResolved;
  ctx.unnamedTagsResolved = true;
  try {
    return lowerTemplate(ctx, body);
  } finally {
    ctx.unnamedTagsResolved = wasResolved;
  }
}

function lowerTemplate(ctx: Ctx, body: readonly MxChild[]): Ir {
  checkReservedTemplate(ctx, body);
  // Each file/template is its own authored root, including recursive units.
  ctx.authoredAncestors = [];
  ctx.authoredAncestorNodes = [];
  const ownInputCode: string[] = [];
  const ownInputAux: string[] = [];
  for (const node of body) {
    if (!isTagOrStatementNode(node) || !hasStaticName(node)) continue;
    const statementName = tagNameOf(node) as string;
    if (
      statementName !== "import" &&
      statementName !== "static" &&
      statementName !== "export"
    )
      continue;
    const code = sliceNode(ctx, node).trim();
    if (/^export\s+(?:interface|type)\s+Input\b/.test(code)) {
      ownInputCode.push(code);
    } else if (statementName === "import") {
      ownInputAux.push(code);
    } else if (statementName === "static") {
      ownInputAux.push(code.replace(/^static\s+/, ""));
    }
  }
  ctx.ownInput ??= readOwnInput(
    ctx,
    ownInputCode.join("\n") || undefined,
    ownInputAux,
  );
  raiseInvalidOwnInput(ctx, ctx.ownInput);

  // The file root owns the collecting hooks; a tag template's own lower is
  // handed the caller's stores and must not run them a second time.
  const isFileRoot = ctx.customTagStores === undefined;
  if (isFileRoot) {
    ctx.customTagStores = new Map();
    // Created eagerly so a template's `Ctx` can share the same set by
    // reference: a tag called only from inside a tag template must still be
    // finalized in the file that called the template.
    ctx.customTagsUsed ??= new Set();
    runCustomTagAnalyze(ctx, body);
  }

  // Computed before the body walk, because a self-recursive call resolves to
  // it *during* that walk: `bindingForTemplate` returns this name instead of
  // minting a self-import (invariant §7.5-7). Minted against what the file
  // already binds, so the declaration a host emits can never shadow an import
  // or a `<define>`. `ctx.source` is scanned too, the same belt-and-braces
  // `generatedBinding` uses: a name can reach the emitted module without
  // passing through `ctx.imports`/`ctx.defines` (a `<const>`, a tag param).
  //
  // Only when the caller actually emits a module. A host module *region* is
  // an expression with no `export default function` of its own, so a name
  // here would be one nothing declares — and `bindingForTemplate` would hand
  // a region calling its own file's tag a dangling identifier rather than an
  // error. `=`, not `??=`: a reused or pre-seeded `Ctx` must not keep a
  // previous file's name.
  ctx.exportName = ctx.emitsModule
    ? exportNameFor(
        ctx.filename,
        (name) =>
          ctx.importedNames.has(name) ||
          ctx.defines.has(name) ||
          new RegExp(`(^|[^\\w$])${name}([^\\w$]|$)`).test(ctx.source),
      )
    : undefined;

  // -1, so the template body's own `lowerChildren` sits at depth 0 — the one
  // position `<return>` is legal in. `=`, not `??=`: a reused `Ctx` must not
  // inherit a previous walk's depth, which would make a legal `<return>`
  // report as nested.
  ctx.returnDepth = -1;
  ctx.returnValue = null;
  // Reset for the same reason: a reused `Ctx` must not carry a previous
  // file's block path, which would make a legal read look out of scope.
  ctx.tagVarBlock = [];
  ctx.tagVars = undefined;

  const [nodes, prelude] = withPrelude(ctx, () => lowerChildren(ctx, body));
  // Decision 162: the walk recorded errors instead of throwing the first. The
  // checks below need a whole file, so none of them runs on a partial one.
  if (ctx.errors?.length) throw collectedError(ctx.errors);

  const ir: Ir = {
    imports: [],
    hoisted: [],
    inputInterface: null,
    needsAttrTagImport: false,
    prelude: prelude.map(({ code, node }) => ({
      kind: "Hoisted",
      code,
      loc: posOf(ctx, node),
      end: endPosOf(ctx, node),
    })),
    body: [],
    tagMetadata: { readsContent: false, attributeTags: [] },
    exportName: ctx.exportName,
  };

  for (const node of nodes) {
    switch (node.kind) {
      case "Import":
        // The bindings were registered as the statement resolved; this only
        // places the statement itself at module scope.
        ir.imports.push(node);
        break;
      case "Static":
        ir.hoisted.push(node);
        break;
      case "Export":
        ir.hoisted.push(node);
        break;
      case "InputInterface":
        ir.inputInterface = node;
        break;
      case "Hoisted":
        ir.prelude.push(node);
        break;
      default:
        ir.body.push(node);
    }
  }

  ir.imports.push(...(ctx.customTagImportNodes ?? []));

  const typeUnits = [
    ir.inputInterface?.code ?? "",
    ...ir.hoisted
      .filter(
        (node): node is Extract<IrNode, { kind: "Static" }> =>
          node.kind === "Static",
      )
      .map((node) => node.code),
  ];
  ir.needsAttrTagImport =
    referencesUnboundAttrTagType(typeUnits) &&
    !ctx.importedNames.has("AttrTag");

  // Decision 156: declare every name of this unit, then check every atom
  // reference, once the whole body (and every `analyze`) has been seen.
  // Decision 183: the check now runs as the first `afterLower` hook,
  // seeded by `newCtx`, so a language can add its own
  // post-lowering checks behind it. Behaviour is unchanged: one function,
  // the same `ctx`, at the same point.
  for (const hook of ctx.afterLower ?? []) hook(ctx);

  if (isFileRoot && ctx.customTags) {
    // Prepended as one block, after the body is assembled: a `finalize` node
    // is program-level output (a sprite sheet, a collected style block), not
    // something that belongs inside whatever construct the last call site
    // happened to sit in.
    const prepended = runFinalizeHooks(
      ctx,
      ctx.customTags,
      ctx.customTagsUsed ?? new Set<string>(),
    );
    if (prepended.length > 0) ir.body.unshift(...prepended);
  }

  // Read off `Ctx` rather than returned from the walk: `lowerReturn` records
  // it wherever the tag was met, and the walk's own result is the body.
  ir.returnValue = (ctx as Ctx).returnValue?.expr ?? null;
  ir.tagMetadata = metadataOfIr(ir);

  return ir;
}

/**
 * Walks the body once on a scratch `Ctx`, then runs every `analyze`.
 *
 * The scratch `Ctx` is the whole trick. It shares what a lower needs to read —
 * the source, the host's declarations, the taglib lookup, the registered tags
 * and the file's stores — and owns fresh copies of everything a lower
 * *writes*: its own prelude, bindings, defines, imports, warnings and template
 * import map. So the pre-pass lowers each call exactly as the real pass will
 * (same enclosing `<for>` params, same binding rewrites, same attribute
 * lowering), which is what lets `analyze` be handed the identical `TagCall`
 * its own `transform` will later receive, while the hoists, warnings and
 * template imports it produces are discarded with the scratch `Ctx` instead of
 * being emitted twice.
 *
 * Skipped entirely when no registered tag defines `analyze`, so a file using
 * only ordinary tags pays for one walk as before.
 */
function runCustomTagAnalyze(ctx: Ctx, body: readonly MxChild[]): void {
  const customTags = ctx.customTags;
  if (!customTags) return;
  if (!Object.values(customTags).some((tag) => tag.analyze)) return;

  const scratch = newCtx(
    ctx.source,
    ctx.generate,
    ctx.declarations,
    ctx.tagTable,
    ctx.filename,
    ctx.targets,
  );
  scratch.customTags = customTags;
  // Mirrors the parent: this walk is the same file, so whether it emits a
  // module is the same answer.
  scratch.emitsModule = ctx.emitsModule;
  // `lower` already resolved this tree; the scratch walk must not redo it.
  scratch.unnamedTagsResolved = true;
  scratch.customTagStores = ctx.customTagStores;
  scratch.customTagGensym = ctx.customTagGensym;
  // -1, exactly as `lower` sets it, because this walk enters through
  // `lowerChildren` rather than through `lower`: the body's own child list
  // then sits at depth 0, the one position `<return>` is legal in. Left
  // unset, `lowerChildren`'s `?? 0` started this walk at depth 1 and a
  // legitimately top-level `<return>` was rejected — but *only* in a file
  // that also used a tag with an `analyze` hook, since nothing else runs
  // this second walk.
  scratch.returnDepth = -1;
  // Absorbed rather than forwarded: every warning this walk raises is raised
  // again by the real walk, at the same position, and reporting a dropped
  // attribute tag twice would read as two mistakes.
  scratch.warnings = [];
  // Recovering, so a failing tag does not stop the walk before `analyze` has
  // seen the calls after it; the real walk reports the same errors.
  const scratchErrors: TranslateError[] = [];
  scratch.errors = scratchErrors;
  const calls = new Map<string, TagCall[]>();
  scratch.customTagAnalyzePass = { calls };

  lowerChildren(scratch, body);
  // `analyze` is a whole-file check: it never runs over a walk that failed, and
  // the walk's errors, not the hook's, are the file's (decision 162).
  if (scratchErrors.length) throw collectedError(scratchErrors);
  runAnalyzeHooks(ctx, customTags, calls);
}

/** Compiles one tag unit only to produce its cached caller metadata. */
registerTemplateMetadataCompiler((ctx: Ctx, tag: TemplateTag) => {
  const { body } = parseFragment(tag.source, {
    filename: tag.filename,
    customTags: ctx.customTags as Record<string, CustomTag> | undefined,
    nativeTags: ctx.declarations.nativeTags,
  });
  const templateCtx = newCtx(
    tag.source,
    ctx.generate,
    ctx.declarations,
    ctx.tagTable,
    tag.filename,
    ctx.targets,
  );
  templateCtx.customTags = ctx.customTags;
  // A tag unit is a file that compiles to a module of its own, whatever the
  // caller is — so its self-recursive calls resolve to its own export.
  templateCtx.emitsModule = true;
  // Shared by reference, which is the whole point of boxing the counter: a
  // name minted while compiling this unit and one minted by the caller must
  // never be the same serial. The unit's names do land in the unit's own
  // module, so a repeat is not observable in today's emitted output — but the
  // counter is the file-level identity supply, and PR #81 fixed exactly this
  // collision for the path this one replaced. Left unshared it silently comes
  // back the moment anything reads a generated name across the boundary.
  templateCtx.customTagGensym = ctx.customTagGensym;
  // Metadata compilation is an independent unit. Its warnings are not caller
  // diagnostics, and its analyze/finalize stores must not run as a side effect
  // of a caller asking only for metadata.
  templateCtx.warnings = [];
  templateCtx.customTagStores = new Map();
  const ir = lower(templateCtx, body);
  return ir.tagMetadata;
});

export type { HostDeclarations };
