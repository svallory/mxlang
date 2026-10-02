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
 * emitting walk: `packages/hosts/html`'s error fixtures and the oracle's error
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
import { freeIdentifiersIn } from "./accessor-reads.ts";
import {
  fallbackAttrTagShape,
  unifyNestedAttrTagPlanGroups,
} from "./attr-tag.ts";
import { BUILTIN_CUSTOM_TAGS } from "./builtin-tags.ts";
import {
  type AttrTagDecl,
  type CalleeInput,
  readCalleeInput,
  readOwnInput,
} from "./callee-input.ts";
import { CALLEE_INPUT_ERROR } from "./callee-input-error.ts";
import {
  attrByName,
  bindingIdentifiers,
  type Ctx,
  DYNAMIC_TAG,
  declName,
  expr,
  fail,
  hasContent,
  importBindings,
  importedNames,
  importTypeOnlyBindings,
  isFunctionLikeValue,
  isMarkoOrMxSpecifier,
  markoBabel,
  type Node,
  newCtx,
  rejectInertShape,
  rejectUnsupportedFields,
  scopeBindings,
  shadowBindings,
  sliceLoc,
  VOID_TAGS,
  warn,
} from "./core.ts";
import {
  type CustomTag,
  runAnalyzeHooks,
  runFinalizeHooks,
  shadowedBuiltinMessage,
  type TagCall,
  transformCustomTag,
} from "./custom-tags.ts";
import type { HostDeclarations } from "./declarations.ts";
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
  Position,
} from "./ir.ts";
import type { SourceSpan } from "./mapping.ts";
import {
  bindingForDiscoveredModule,
  hasTemplate,
  inputMember,
  metadataOfIr,
  registerAuthoredTemplateImport,
  registerTemplateMetadataCompiler,
  type TemplateTag,
} from "./template-tag.ts";

/** A node's start position, in `TranslateError`'s own 1-based/0-based shape. */
function posOf(node: Node): Position {
  const start = node?.loc?.start ?? node?.start ?? {};
  return { line: start.line ?? 0, column: start.column ?? 0 };
}

/** A node's end position, paired with `posOf` for source-backed code blocks. */
function endPosOf(node: Node): Position {
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

function positionAtOffset(ctx: Ctx, offset: number): Position {
  let line = 1;
  let lineStart = 0;
  for (const text of ctx.lines) {
    const lineEnd = lineStart + text.length;
    if (offset <= lineEnd) return { line, column: offset - lineStart };
    line++;
    lineStart = lineEnd + 1;
  }
  return {
    line: Math.max(1, ctx.lines.length),
    column: Math.max(0, offset - lineStart),
  };
}

function attributeTagNamePosition(ctx: Ctx, tag: AttributeTag): Position {
  return positionAtOffset(ctx, tag.nameSpan.sourceStart);
}

function nodeSpan(ctx: Ctx, node: Node): SourceSpan {
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
  if (!node?.loc) return undefined;
  return nodeSpan(ctx, node);
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
 */
function attrNameSpan(ctx: Ctx, attr: Node): SourceSpan {
  const sourceStart = offsetOf(ctx, attr?.loc?.start ?? attr?.start ?? {});
  const sourceName = attr.modifier
    ? `${attr.name}:${attr.modifier}`
    : String(attr.name ?? "");
  if (!ctx.source.startsWith(sourceName, sourceStart)) {
    return { sourceStart, sourceEnd: sourceStart };
  }
  return { sourceStart, sourceEnd: sourceStart + sourceName.length };
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
  const code = expr(ctx, node);
  checkTagVarReads(ctx, code, node);
  return {
    code,
    shape: expressionShape(node),
    node,
    span: exprSpan(ctx, node),
  };
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
 * React spellings whose plain lowercase is *not* a DOM event name.
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
const REACT_EVENT_SPELLINGS: Record<string, string | null> = {
  onDoubleClick: "onDblclick",
  onDragExit: null,
  onEncrypted: null,
};

/**
 * Warns — without rewriting — when an event attribute uses a React spelling
 * whose lowercase is not a real DOM event.
 *
 * Positioned at the attribute name so the language server underlines the
 * attribute rather than the whole tag.
 */
function warnOnReactEventSpelling(ctx: Ctx, attr: Node, name: string): void {
  if (!(name in REACT_EVENT_SPELLINGS)) return;
  const suggestion = REACT_EVENT_SPELLINGS[name];
  const pos = posOf(attr);
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

/** Angular-style names and how to write what they were reaching for, first match wins. */
const FOREIGN_ATTR_HINTS: [RegExp, (m: RegExpMatchArray) => string][] = [
  [
    /^\[\(([^()[\]]+)\)\]$/,
    (m) => `Marko's two-way binding is \`${m[1]}:=expr\``,
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
  [/^#/, () => "template reference variables are Angular syntax"],
  [
    /^\*/,
    () =>
      "structural directives are Angular syntax; use `<if=cond>` / `<for|item| of=list>`",
  ],
];

function foreignAttrHint(name: string): string {
  for (const [pattern, hint] of FOREIGN_ATTR_HINTS) {
    const match = name.match(pattern);
    if (match) return hint(match);
  }
  return "an attribute name may use letters, digits and `._:-`";
}

/** Resolves one attribute of an element or component call. */
function lowerAttr(
  ctx: Ctx,
  attr: Node,
  on: "element" | "component" = "element",
  isElement = false,
): Attr {
  const loc = posOf(attr);
  const nameSpan = attrNameSpan(ctx, attr);

  if (attr.type === "MarkoSpreadAttribute") {
    return { kind: "spread", value: exprOf(ctx, attr.value), loc };
  }

  // Marko rejects a name outside its grammar for every tag; only a host with
  // its own attribute syntax (Angular) opts out. A modifier (`class:x`) is
  // `name` + `modifier` here, both valid, and goes through its own branch.
  if (
    !ctx.declarations.acceptsForeignAttrNames &&
    typeof attr.name === "string" &&
    !ATTR_NAME.test(attr.name)
  ) {
    fail(
      `Invalid attribute name \`${attr.name}\`; Marko rejects it too — ${foreignAttrHint(attr.name)}`,
      attr,
    );
  }

  if (attr.arguments || attr.value?.type === "FunctionExpression") {
    if (ctx.declarations.resolveAttributeMethod?.(attr, on) !== true) {
      ctx.declarations.rejectAttributeMethod?.(attr, on);
      fail(
        `attribute method \`${attr.name}(...)\` is an event handler and requires a runtime; standalone MX renders once to a string`,
        attr,
      );
    }
  }

  if (attr.bound) {
    return {
      kind: "bound",
      name: attr.name,
      nameSpan,
      value: exprOf(ctx, attr.value),
      loc,
    };
  }

  // `class:foo="x"` is a modifier Marko hands over as a base name plus a
  // modifier. Emitting only the base name renders `class="x"` — not a drop but
  // a *wrong* attribute, which is worse. The host gets first refusal so the
  // diagnostic is in its own vocabulary (a Marko-parity target quotes Marko's
  // own fix-it); the core's wording is only the fallback.
  if (attr.modifier) {
    const resolvedName = ctx.declarations.resolveModifier?.(attr, on);
    if (resolvedName !== undefined) {
      return {
        kind: "dynamic",
        name: resolvedName,
        nameSpan,
        value: exprOf(ctx, attr.value),
        loc,
      };
    }
    // The tag kind travels with the rejection: a modifier on a *component*
    // call is a different diagnostic from one on an element, and the pre-IR
    // walk said so ("… on a component call is not supported"). Losing that
    // distinction was a message regression even though both still fail.
    ctx.declarations.rejectModifier?.(attr, on);
    fail(
      `attribute modifier \`${attr.name}:${attr.modifier}\` is not supported in a standalone template`,
      attr,
    );
  }

  const value = attr.value;
  // A bare attribute (`download`, `checked`) is HTML's spelling of `true`.
  if (value?.type === "BooleanLiteral" && value.value === true) {
    return { kind: "boolean", name: attr.name, nameSpan, loc };
  }
  if (value?.type === "StringLiteral") {
    return {
      kind: "static",
      name: attr.name,
      value: value.value,
      valueSpan: exprSpan(ctx, value),
      nameSpan,
      loc,
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
  // No `!attr.modifier` guard is needed: the modifier block above either
  // returns the host's resolved name or fails, so nothing carrying a modifier
  // reaches this point. `on:click`/`oncapture:click` therefore keep going to
  // the host's own modifier hook and never become events here (decision 101b).
  if (isElement && EVENT_ATTR.test(attr.name)) {
    const name = String(attr.name);
    if (name === "on-") {
      fail("`on-` needs an event name (`on-<event>`)", attr);
    }
    const event = name[2] === "-" ? name.slice(3) : name.slice(2).toLowerCase();
    warnOnReactEventSpelling(ctx, attr, name);
    return {
      kind: "event",
      name,
      event,
      value: exprOf(ctx, value),
      nameSpan,
      loc,
    };
  }

  return {
    kind: "dynamic",
    name: attr.name,
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
  const attrs = (node.attributes ?? []).map((attr: Node) =>
    lowerAttr(ctx, attr, on, isElement),
  );
  return ctx.declarations.orderAttrs?.(name, attrs, on, ctx) ?? attrs;
}

/** The tag params of `<for|a, b|>` / `<@name|p|>`, as source text. */
function paramsOf(ctx: Ctx, node: Node): string[] {
  return (node.body?.params ?? []).map((p: Node) => {
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
  return (node.body?.params ?? []).map((p: Node) => exprSpan(ctx, p));
}

/** Marko keeps non-empty params as nodes but represents both absent and `||` as `[]`. */
function hasParams(ctx: Ctx, node: Node): boolean {
  if ((node.body?.params ?? []).length > 0) return true;
  const source = sliceLoc(ctx, node.loc);
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
  const names = (node.body?.params ?? []).flatMap((p: Node) =>
    bindingIdentifiers(p),
  );
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
function lowerBlock(ctx: Ctx, node: Node, body = node.body?.body ?? []): Block {
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
    loc: posOf(node),
  };
}

interface AttrSchema {
  declarations?: Map<string, AttrTagDecl>;
  otherProps?: Set<string>;
  open: boolean;
  owner: string;
  collisionOwner?: Node;
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
  return String(node.name?.value ?? "").replace(/^@/, "");
}

function attributeTagNameSpan(ctx: Ctx, node: Node): SourceSpan {
  const span = nodeSpan(ctx, node.name);
  return { sourceStart: span.sourceStart + 1, sourceEnd: span.sourceEnd };
}

function isLayout(node: Node): boolean {
  return (
    node.type === "MarkoComment" ||
    (node.type === "MarkoText" && node.value.trim() === "")
  );
}

function isControl(node: Node): boolean {
  const name = String(node?.name?.value ?? "").replace(/^@/, "");
  return node?.type === "MarkoTag" && (name === "if" || name === "for");
}

function containsAttributeTags(node: Node): boolean {
  if ((node.attributeTags ?? []).length > 0) return true;
  return (node.body?.body ?? []).some((child: Node) => {
    const name = String(child?.name?.value ?? "");
    return (
      name.startsWith("@") || (isControl(child) && containsAttributeTags(child))
    );
  });
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
  if ((node.arguments ?? []).length === 0) return;
  const lenient =
    !target || target.kind === "dynamic" || target.kind === "define";
  if (lenient) {
    if ((node.attributes ?? []).length === 0) return;
    fail(
      "Tag does not support arguments when attributes present.",
      node.name ?? node,
    );
  }
  if (
    (node.attributes ?? []).length === 0 &&
    !containsAttributeTags(node) &&
    !hasContent(node.body?.body ?? [])
  ) {
    return;
  }
  fail(
    "Tag does not support arguments when attributes or body present.",
    node.name ?? node,
  );
}

function validateParentCollision(node: Node, schema: AttrSchema): void {
  const owner = schema.collisionOwner;
  if (!owner) return;
  const parentAttrs = new Set(
    (owner.attributes ?? [])
      .filter((attr: Node) => attr.type !== "MarkoSpreadAttribute")
      .map((attr: Node) => attr.name),
  );
  const name = attrName(node);
  if (parentAttrs.has(name)) {
    fail(
      `attribute tag \`@${name}\` collides with attribute \`${name}\``,
      node.name ?? node,
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
    column: span.sourceStart - lastLine,
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
      node.name ?? node,
    );
  }
  if (schema.declarations && !schema.open) {
    fail(
      `\`<${schema.owner}>\` declares no attribute tag \`${name}\``,
      node.name ?? node,
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
  const name = attrName(node);
  const declaration = declarationFor(schema, name, node);
  validateParentCollision(node, schema);
  const attrs = node.attributes ?? [];
  const contentAttr = attrs.find(
    (attr: Node) =>
      attr.type !== "MarkoSpreadAttribute" && attr.name === "content",
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
      node.name ?? node,
    );
  }
  const hasParamsAtCall = hasParams(ctx, node);
  if (declaration && declaration.hasParams !== hasParamsAtCall) {
    fail(
      declaration.hasParams
        ? `\`<@${name}>\` declares params in \`<${schema.owner}>\`; add \`|…|\``
        : `\`<@${name}>\` declares no params in \`<${schema.owner}>\`; remove \`|…|\``,
      node.name ?? node,
    );
  }

  const nestedSchema: AttrSchema = declaration
    ? {
        declarations: declaration.nested,
        open: declaration.nestedOpen,
        owner: `@${name}`,
      }
    : { open: true, owner: `@${name}` };

  const unscope = scopeBindings(ctx);
  const restore = shadowBindings(ctx, paramBindings(ctx, node));
  const nested = lowerAttributeTags(ctx, node, nestedSchema);
  const block: Block = {
    hasParams: hasParamsAtCall,
    params: paramsOf(ctx, node),
    children: lowerChildren(ctx, nested.contentChildren),
    loc: posOf(node),
  };
  restore();
  unscope();

  if (nested.flat.length > 0) {
    requireAttrTagsV2(
      ctx,
      `\`<@${name}>\`: nested attribute tags`,
      "aren't",
      node.attributeTags?.[0] ?? node,
    );
    if (declaration?.as === "renderable") {
      fail(
        `\`<@${name}>\` is renderable in \`<${schema.owner}>\`; it can't take attributes or nested attribute tags`,
        node.name ?? node,
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
    loc: posOf(node),
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
    loc: posOf(node),
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
  while (cursor < siblings.length) {
    const branch = siblings[cursor];
    const name = String(branch.name?.value ?? "").replace(/^@/, "");
    if (cursor > index && name !== "else" && name !== "else-if") break;
    const conditionAttr =
      name === "if"
        ? (attrByName(branch, "value") ?? branch.attributes?.[0])
        : name === "else-if"
          ? (attrByName(branch, "value") ?? branch.attributes?.[0])
          : attrByName(branch, "if");
    const unscope = scopeBindings(ctx);
    const lowered = lowerAttributeTags(ctx, branch, schema, true, false);
    unscope();
    branches.push({
      ...(conditionAttr ? { test: exprOf(ctx, conditionAttr.value) } : {}),
      span: nodeSpan(ctx, branch),
      nodes: lowered.tree,
    });
    branchContent.push(
      ...lowered.contentChildren.filter((child: Node) => !isLayout(child)),
    );
    cursor++;
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
  return [{ kind: "AttributeTagIf", branches, loc: posOf(first) }, cursor];
}

function attributeIfChainEnd(body: Node[], index: number): number {
  let cursor = index + 1;
  while (cursor < body.length) {
    while (cursor < body.length && isLayout(body[cursor])) cursor++;
    const branch = body[cursor];
    const name = String(branch?.name?.value ?? "").replace(/^@/, "");
    if (name !== "else" && name !== "else-if") break;
    cursor++;
    const conditional =
      name === "else-if"
        ? (attrByName(branch, "value") ?? branch.attributes?.[0])
        : attrByName(branch, "if");
    if (!conditional) break;
  }
  return cursor;
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
  const directTags = node.attributeTags ?? [];
  for (let index = 0; index < directTags.length; index++) {
    const tag = directTags[index];
    if (isControl(tag) && containsAttributeTags(tag)) {
      candidates.push({
        offset: nodeSpan(ctx, tag).sourceStart,
        kind: "control",
        node: tag,
        index,
        siblings: directTags,
      });
      if (String(tag.name?.value ?? "").replace(/^@/, "") === "if") {
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
  const body = node.body?.body ?? [];
  const consumed = new Set<number>();
  for (let index = 0; index < body.length; index++) {
    const child = body[index];
    if (String(child?.name?.value ?? "").startsWith("@") && !isControl(child)) {
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
      child.name?.value === "if" ? attributeIfChainEnd(body, index) : index + 1;
    const hasAttributeTags =
      child.name?.value === "if"
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
      String(candidate.node.name?.value ?? "").replace(/^@/, "") === "for"
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
  const contentChildren = body.filter(
    (_child: Node, index: number) =>
      !controlStarts.has(index) && !consumed.has(index),
  );
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
  children: Node[],
  index: number,
): [IrNode, number] {
  const node = children[index];
  rejectUnsupportedFields(ctx, node, "`<if>`");
  const cond = attrByName(node, "value") ?? node.attributes?.[0];
  if (!cond?.value) fail("`<if>` without a condition", node);

  // Each branch is its own JS block: a `<const>` declared inside one does not
  // shadow the host's binding for the code that follows the chain.
  const branchChildren = (branchNode: Node): IrNode[] => {
    const unscope = scopeBindings(ctx);
    const children = lowerChildren(ctx, branchNode.body?.body ?? []);
    unscope();
    return children;
  };

  const branches: Branch[] = [
    {
      condition: exprOf(ctx, cond.value),
      children: branchChildren(node),
      loc: posOf(node),
    },
  ];

  let i = index + 1;
  while (i < children.length) {
    const child = children[i];
    // Whitespace and comments between branches are layout, not content.
    if (child.type === "MarkoComment") {
      i++;
      continue;
    }
    if (child.type === "MarkoText" && child.value.trim() === "") {
      i++;
      continue;
    }
    const childName = child.name?.value;
    if (
      child.type !== "MarkoTag" ||
      (childName !== "else" && childName !== "else-if")
    ) {
      break;
    }

    rejectUnsupportedFields(ctx, child, `\`<${childName}>\``);
    // `<else if=cond>` spells the condition as an `if` attribute; Marko's own
    // `<else-if=cond>` spells it as the tag's first (value) attribute.
    const ifAttr =
      childName === "else-if"
        ? (attrByName(child, "value") ?? child.attributes?.[0])
        : attrByName(child, "if");
    branches.push({
      condition: ifAttr ? exprOf(ctx, ifAttr.value) : null,
      children: branchChildren(child),
      loc: posOf(child),
    });
    i++;
    if (!ifAttr) break;
  }

  return [{ kind: "IfChain", branches, loc: posOf(node) }, i];
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

  const { types } = markoBabel();
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
  const { types } = markoBabel();
  const names = new Set<string>();
  for (const param of node.body?.params ?? []) {
    for (const name of Object.keys(types.getBindingIdentifiers(param))) {
      names.add(name);
    }
  }
  if (names.size === 0) return;
  const read = findLoopParamRead(by.value, names);
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
    if (
      attr &&
      (!attr.value?.loc ||
        attr.arguments ||
        attr.value.type === "FunctionExpression")
    ) {
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
    source = { kind: "of", list: exprOf(ctx, of.value) };
  } else if (inAttr) {
    source = { kind: "in", object: exprOf(ctx, inAttr.value) };
  } else if (to || until) {
    const from = attrByName(node, "from");
    source = {
      kind: "range",
      from: from ? exprOf(ctx, from.value) : null,
      bound: exprOf(ctx, (to ?? until).value),
      inclusive: Boolean(to),
      step: step ? exprOf(ctx, step.value) : null,
    };
  } else {
    fail("`<for>` requires `of=`, `in=`, or `from=`/`to=`/`until=`", node);
  }

  const bindings = paramBindings(ctx, node);
  return {
    source,
    params,
    paramNodes: [...(node.body?.params ?? [])],
    bindings,
    paramSpans: paramSpansOf(ctx, node),
    key: by ? exprOf(ctx, by.value) : null,
  };
}

function lowerFor(ctx: Ctx, node: Node): IrNode {
  const head = lowerForHead(ctx, node);
  // The loop body is a JS block, so a `<const>` inside it is confined to it.
  const unscope = scopeBindings(ctx);
  const restore = shadowBindings(ctx, head.bindings);
  const children = lowerChildren(ctx, node.body?.body ?? []);
  restore();
  unscope();

  return {
    kind: "For",
    ...head,
    children,
    loc: posOf(node),
  };
}

/** `<const/name=expr/>` — a binding at render scope. */
function lowerConst(ctx: Ctx, node: Node): IrNode {
  if (!node.var) {
    fail(
      "`<const>` without a variable name (write `<const/name=value/>`)",
      node,
    );
  }
  rejectUnsupportedFields(ctx, node, "`<const>`", { var: true });
  // Dispatched by the core, before any host sees the tag, so the binding check
  // has to happen here or a host's rule would silently apply to `<let>` and not
  // to `<const>`.
  ctx.declarations.checkBinding?.(node.var, "`<const>`");
  const value = attrByName(node, "value") ?? node.attributes?.[0];
  if (!value?.value) fail("`<const>` without a value", node);

  const name = declName(ctx, node.var);
  // The initializer is evaluated *before* the binding exists, so a registered
  // name on the right-hand side is still the host's: `<const/count=count + 1>`
  // resolves to `const count = count() + 1`. Shadowing takes effect only
  // afterwards, for the rest of the render scope.
  const init = exprOf(ctx, value.value);
  // Local extension of decision 116: a `<const>` bound to a plain identifier
  // whose value isn't statically a function/arrow/class is "unknown" and
  // routes dynamic when later used as a tag — a destructuring pattern
  // (`<const/{a,b}=...>`) never names a single PascalCase tag binding, so it
  // is left out of this check entirely rather than guessed at.
  if (node.var?.type === "Identifier" && !isFunctionLikeValue(value.value)) {
    ctx.unknownLocalValue.add(name);
  }
  shadowBindings(ctx, bindingIdentifiers(node.var));

  return { kind: "Const", name, init, loc: posOf(node) };
}

/** `<define/name|params|>...</define>` — a reusable block. */
function lowerDefine(ctx: Ctx, node: Node): IrNode {
  if (!node.var) {
    fail("`<define>` without a name (write `<define/name>`)", node);
  }
  rejectUnsupportedFields(ctx, node, "`<define>`", { var: true, params: true });

  const name = declName(ctx, node.var);
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
    lowerChildren(ctx, node.body?.body ?? []),
  );
  restore();
  unscope();

  ctx.defines.set(name, params);

  const loc = posOf(node);
  const hoisted: IrNode[] = prelude.map(({ code, node }) => ({
    kind: "Hoisted" as const,
    code,
    loc: posOf(node),
    end: endPosOf(node),
  }));
  return {
    kind: "Define",
    name,
    nameSpan: exprSpan(ctx, node.var),
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
    file = markoBabel().parse(code, {
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
function lowerStatement(ctx: Ctx, node: Node, name: string): IrNode {
  const line = sliceLoc(ctx, node.loc).trim();
  const loc = posOf(node);
  const end = endPosOf(node);

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
    return { kind: "Import", code: line, bindings, loc, end };
  }
  if (name === "static") {
    const code = line.replace(/^static\s+/, "");
    registerStaticBindings(ctx, code);
    return {
      kind: "Static",
      code,
      loc,
      end,
    };
  }
  if (/^export\s+interface\s+Input\b/.test(line)) {
    return { kind: "InputInterface", code: line, loc, end };
  }
  if (name === "export") {
    return { kind: "Export", code: line, loc, end };
  }
  fail(
    `unrecognized statement tag \`${name}\`; expected \`import\`, \`static\`, or \`export\``,
    node,
  );
}

/** A tag this host claims, with every part lowered for its emitter. */
function lowerHostTag(ctx: Ctx, node: Node, name: string): IrNode {
  const loc = posOf(node);
  const target: ComponentTarget =
    name === DYNAMIC_TAG
      ? { kind: "dynamic", expr: exprOf(ctx, node.name) }
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
    kind: "HostTag",
    tag: {
      name,
      nameSpan: name === DYNAMIC_TAG ? undefined : exprSpan(ctx, node.name),
      span: exprSpan(ctx, node),
      attrs: lowerAttrs(ctx, node, name),
      args: (node.arguments ?? []).map((argument: Node) =>
        exprOf(ctx, argument),
      ),
      children,
      attributeTags: loweredTags.flat,
      attributeTagTree: loweredTags.tree,
      attrTagProps: loweredTags.props,
      params: paramsOf(ctx, node),
      var: node.var ? declName(ctx, node.var) : null,
      data: ctx.declarations.resolveHostTag?.(name, node, ctx),
      loc,
    },
    loc,
  };
}

/**
 * Lowers one registered custom tag call and splices its ordinary IR roots.
 *
 * `content` is gated on `hasContent` for an ordinary (user-registered) tag:
 * whitespace-only body text means "no children supplied", which is the right
 * default for a template-authored tag deciding what an empty call means. A
 * core-owned built-in like `<try>` is a structural pass-through wrapper, not
 * a template — its whole job is to reproduce the caller's body unchanged, the
 * way `lowerHostTag` always did (`lowerChildren(node.body?.body ?? [])`,
 * unconditionally). Gating it the same way silently dropped whitespace-only
 * bodies (`<try>  </try>`) that used to render. `isBuiltin` therefore skips
 * the gate and always lowers the raw block.
 */
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

  if (node.body?.body?.length) {
    fail("`<return>` does not support body content", node);
  }

  for (const attr of node.attributes ?? []) {
    if (attr.type === "MarkoSpreadAttribute") {
      fail("`<return>` does not support spread attributes", attr);
    }
  }

  let valueAttr: Node | undefined;
  for (const attr of node.attributes ?? []) {
    if (attr.type !== "MarkoAttribute") continue;
    // The parser spells `<return=x/>` as the `default` attribute and
    // `<return value=x/>` as `value`; both are the same authored thing.
    const attrName = attr.default ? "value" : String(attr.name);
    if (attrName !== "value") {
      fail(
        attrName === "valueChange"
          ? "`<return>` does not support the `valueChange` attribute; MX returns a value only, with no two-way channel"
          : `\`<return>\` does not support the \`${attrName}\` attribute`,
        attr,
      );
    }
    if (valueAttr) fail("invalid duplicate `value` attribute", attr);
    valueAttr = attr;
  }

  if (!valueAttr?.value) {
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

  ctx.returnValue = { expr: exprOf(ctx, valueAttr.value), loc: posOf(node) };
  // Contributes nothing to the rendered output: the value is lifted onto the
  // `Ir` and emitted as part of the unit's signature, not in document order.
  return { kind: "Text", value: "", loc: posOf(node) };
}

function rejectCustomAttributeTagShapes(
  ownerName: string,
  node: Node,
  controlName?: string,
): void {
  for (const tag of node.attributeTags ?? []) {
    const name = attrName(tag);
    if (controlName) {
      fail(
        `\`<${ownerName}>\`: attribute tag \`<@${name}>\` may not appear inside \`<${controlName}>\`; registered custom tags cannot preserve attribute-tag control flow`,
        tag.name ?? tag,
      );
    }
    const attrs = tag.attributes ?? [];
    if (attrs.length > 0) {
      fail(
        `\`<${ownerName}>\`: attribute tag \`<@${name}>\` does not support attributes`,
        attrs[0],
      );
    }
    const nested = tag.attributeTags ?? [];
    if (nested.length > 0) {
      fail(
        `\`<${ownerName}>\`: attribute tag \`<@${name}>\` does not support nested attribute tags`,
        nested[0]?.name ?? nested[0],
      );
    }
  }
  for (const child of node.body?.body ?? []) {
    const childName = child.name?.value;
    if (
      child.type === "MarkoTag" &&
      (childName === "if" ||
        childName === "else-if" ||
        childName === "else" ||
        childName === "for")
    ) {
      rejectCustomAttributeTagShapes(
        ownerName,
        child,
        childName === "for" ? "for" : "if",
      );
    }
  }
}

function lowerCustomTag(
  ctx: Ctx,
  node: Node,
  name: string,
  definition: CustomTag,
  isBuiltin = false,
): IrNode[] {
  rejectUnsupportedFields(ctx, node, `\`<${name}>\``, {
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
  if (!isBuiltin && node.var && !hasTemplate(definition)) {
    fail(
      `\`/var\` on \`<${name}>\` is not supported: it has no template, so it has no \`<return>\` to bind`,
      node,
    );
  }
  if (!hasTemplate(definition)) {
    rejectCustomAttributeTagShapes(name, node);
  }
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
  const loweredTags = lowerAttributeTags(ctx, node, schemaFor(input, name));
  raiseInvalidCalleeInput(ctx, input, name, loweredTags.flat);
  const children = loweredTags.contentChildren;
  const call: TagCall = {
    name,
    loc: posOf(node),
    attrs: lowerAttrs(ctx, node, name, "component"),
    content:
      isBuiltin || hasContent(children)
        ? lowerBlock(ctx, node, children)
        : null,
    attributeTags: loweredTags.flat,
    attributeTagTree: loweredTags.tree,
    attrTagProps: loweredTags.props,
    params: paramsOf(ctx, node),
    var: node.var ? declName(ctx, node.var) : null,
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
function lowerComponent(ctx: Ctx, node: Node, target: ComponentTarget): IrNode {
  // The host gets first refusal, before any `Component` node exists: a call it
  // will not route must fail here rather than reach an emitter, which no
  // longer has the Marko node to judge it by.
  if (target.kind === "name") {
    ctx.declarations.rejectComponentTag?.(target.name, node, ctx);
  }
  if (target.kind !== "dynamic") {
    // The dynamic-tag path already ran this check before routing here; a
    // named or `define` call reaches `lowerComponent` directly and needs its
    // own pass so `<Card(1)><@head>…</@head></Card>` fails here instead of
    // reaching a host emitter, which can only silently drop one side.
    rejectArgsWithProps(node, target);
  }
  rejectUnsupportedFields(ctx, node, `\`<${targetName(target)}>\``, {
    attributeTags: true,
    args: true,
    params: true,
  });

  const input =
    ctx.calleeInputFor?.(target) ?? readCalleeInput(target, ctx).input;
  const owner = targetName(target);
  if (input.kind === "unresolved" && containsAttributeTags(node)) {
    const pos = posOf(node.name ?? node);
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
  return {
    kind: "Component",
    target,
    nameSpan: target.kind === "dynamic" ? null : nodeSpan(ctx, node.name),
    span: exprSpan(ctx, node),
    attrs: lowerAttrs(ctx, node, targetName(target), "component"),
    content: hasContent(children) ? lowerBlock(ctx, node, children) : null,
    attributeTags: loweredTags.flat,
    attributeTagTree: loweredTags.tree,
    attrTagProps: loweredTags.props,
    args: (node.arguments ?? []).map((a: Node) => exprOf(ctx, a)),
    loc: posOf(node),
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
  const { parse, traverse } = markoBabel();
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

function lowerTag(ctx: Ctx, node: Node): IrNode | IrNode[] {
  // Both a bare `${expr}` line and `<${expr} .../>` parse to a tag whose
  // *name* is the expression — Marko's concise mode has no other shape for
  // a bare one (see the "four Marko facts" in AGENTS.md). Both are dynamic
  // tags: when a host claims DYNAMIC_TAG it gets the HostTag (shape "bare"
  // or "tagged", as before); otherwise core lowers a `Component` with a
  // dynamic target, resolved at run time like any other host.
  if (node.name && node.name.type !== "StringLiteral") {
    rejectArgsWithProps(node);
    const isBare =
      (node.attributes ?? []).length === 0 && !node.body?.body?.length;
    const dynamicExpr = exprOf(ctx, node.name);
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
      (node.arguments ?? []).length,
    );
    const claimed = ctx.declarations.claimsTag?.(
      DYNAMIC_TAG,
      ctx,
      isBare ? "bare" : "tagged",
    );
    if (claimed) return lowerHostTag(ctx, node, DYNAMIC_TAG);
    return lowerComponent(ctx, node, {
      kind: "dynamic",
      expr: dynamicExpr,
    });
  }

  const name = String(node.name.value);

  const disposition = ctx.declarations.tags[name];
  if (disposition) {
    if (disposition.kind === "error") fail(disposition.reason, node);
    rejectInertShape(ctx, node, name, disposition);
    // Inert: accepted, contributes nothing to the IR.
    return { kind: "Text", value: "", loc: posOf(node) };
  }

  switch (name) {
    case "import":
    case "static":
    case "export":
      return lowerStatement(ctx, node, name);
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

  if (name.startsWith("@")) {
    fail(
      `attribute tag \`<${name}>\` is only valid directly inside a component call`,
      node,
    );
  }

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
  const fileLocalBinding =
    /^[A-Z]/.test(name) &&
    (ctx.defines.has(name) ||
      ctx.imports.has(name) ||
      (ctx.tagVarShadowed?.has(name) ?? false));

  // Registered custom tags take precedence over host claims so a shared tag
  // may be expressed in terms of `ctx.build.hostTag(...)`. Structural tags
  // above remain core-owned and cannot be shadowed; a file-local binding
  // (checked above) outranks a custom tag of the same name.
  const customTag =
    !fileLocalBinding && ctx.customTags && Object.hasOwn(ctx.customTags, name)
      ? ctx.customTags[name]
      : undefined;
  if (customTag) return lowerCustomTag(ctx, node, name, customTag);

  if (!fileLocalBinding && ctx.declarations.claimsTag?.(name, ctx)) {
    return lowerHostTag(ctx, node, name);
  }

  // `fileLocalBinding` alone is sufficient here for a `<const>`/`<for>`-param/
  // `<define>`-param binding: a host's own `isComponent` only ever consults
  // `ctx.imports`/`ctx.defines` (matching Marko's own local-variable-as-
  // component rule), so it does not recognize a `ctx.tagVarShadowed` name —
  // but `fileLocalBinding` already proved it is a capitalized, in-scope local
  // binding, which is exactly what a component call needs to route on.
  if (fileLocalBinding || ctx.declarations.isComponent(name, ctx)) {
    const params = ctx.defines.get(name);
    if (params) {
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
      return lowerComponent(ctx, node, {
        kind: "dynamic",
        expr: { code: name, shape: "other", node: null as unknown as Node },
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
      return lowerComponent(ctx, node, {
        kind: "dynamic",
        expr: { code: name, shape: "other", node: null as unknown as Node },
        valueImportBinding: name,
      });
    }
    // A taglib-discovered tag the host imports (Marko imports every tag its
    // lookup finds). Not for a file-local binding: that is already in scope.
    const modulePath = fileLocalBinding
      ? undefined
      : ctx.declarations.resolveDiscoveredTagModule?.(name, ctx);
    const binding = modulePath
      ? bindingForDiscoveredModule(ctx, modulePath, name, posOf(node))
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
    ctx.declarations.rejectUnknownTag?.(name, node, ctx);
    fail(
      `\`<${name}>\` has no matching import or \`<define>\` in scope; a capitalized tag is always a component call`,
      node,
    );
  }

  // An unknown lowercase tag that is neither a binding nor a real element is
  // the silent-failure mode ADR 0001 names: a core tag the host has no
  // lowering for must be an error, never a literal element.
  if (!ctx.declarations.isElement(name, ctx)) {
    // The host's own wording first: a Marko-parity target reports Marko's
    // failure for an unresolved custom tag, which is what its users see and
    // what the fixtures assert. The message below is the fallback.
    ctx.declarations.rejectUnknownTag?.(name, node, ctx);
    fail(
      `unknown tag \`<${name}>\`: not an HTML element, and no matching import or \`<define>\` is in scope`,
      node,
    );
  }

  if (node.attributeTags?.length) {
    ctx.declarations.rejectElementAttributeTags?.(name, node, ctx);
  }
  rejectUnsupportedFields(ctx, node, `\`<${name}>\``);

  const isVoid = VOID_TAGS.has(name);
  return {
    kind: "Element",
    name,
    nameSpan: exprSpan(ctx, node.name),
    span: exprSpan(ctx, node),
    attrs: lowerAttrs(ctx, node, name, "element", true),
    children: isVoid ? [] : lowerChildren(ctx, node.body?.body ?? []),
    void: isVoid,
    loc: posOf(node),
  };
}

export function lowerChildren(ctx: Ctx, children: Node[]): IrNode[] {
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

function lowerChildList(ctx: Ctx, children: Node[]): IrNode[] {
  // Every `/var` this block declares is registered *before* the walk, at the
  // sibling index it is declared at. A read earlier in the same block then
  // finds a binding whose sequence is greater than its own and reports
  // "read before the call", rather than finding nothing and compiling to a
  // reference the emitted JS leaves in the temporal dead zone — Marko's own
  // check (`references.ts:597-602`), which compares sibling indices for
  // exactly this reason.
  for (const child of children) {
    if (child?.type !== "MarkoTag" || !child.var) continue;
    // Only a *custom tag call* binds a `/var` from a unit's `<return>`.
    // `<let>`, `<const>` and every other core construct that takes a `/var`
    // declares an ordinary binding whose scope rules already work, and
    // pre-registering those made a legal read of one report as out of scope.
    const tagName = child.name?.value;
    if (
      typeof tagName !== "string" ||
      !ctx.customTags ||
      !Object.hasOwn(ctx.customTags, tagName)
    ) {
      continue;
    }
    const name = declName(ctx, child.var);
    ctx.tagVars ??= new Map();
    ctx.tagVars.set(name, {
      block: [...(ctx.tagVarBlock ?? [])],
      pending: true,
    });
  }

  const out: IrNode[] = [];
  let index = 0;

  while (index < children.length) {
    const child = children[index];

    if (child.type === "MarkoTag" && child.name?.value === "if") {
      const [node, next] = lowerIfChain(ctx, children, index);
      out.push(node);
      index = next;
      continue;
    }

    // A hoist from this child belongs to the enclosing function, so the
    // prelude it appends is drained by whichever scope owns it — the template,
    // or the nearest `<define>`.
    switch (child.type) {
      case "MarkoText":
        // Already decision 33: Marko's own `onText` dropped newline-bearing
        // whitespace runs and collapsed the rest before we saw them.
        out.push({ kind: "Text", value: child.value, loc: posOf(child) });
        break;
      case "MarkoPlaceholder": {
        const interpolation = exprOf(ctx, child.value);
        rejectUncalledParameterizedAttributeTag(
          ctx,
          interpolation.code,
          child.value,
        );
        out.push({
          kind: "Interpolation",
          expr: interpolation,
          escaped: child.escape,
          loc: posOf(child),
        });
        break;
      }
      case "MarkoTag": {
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
      case "MarkoDocumentType":
        out.push({
          kind: "DocumentType",
          value: child.value,
          loc: posOf(child),
        });
        break;
      case "MarkoComment":
        // Marko strips the delimiters, so an HTML comment and a `//` line
        // comment are indistinguishable by value alone; the source decides.
        out.push({
          kind: "Comment",
          value: child.value,
          html: sliceLoc(ctx, child.loc).startsWith("<!--"),
          loc: posOf(child),
        });
        break;
      case "MarkoScriptlet":
        fail(
          "scriptlets (`$ statement`) are not supported in MX (decision 54)",
          child,
        );
        break;
    }
    index++;
  }

  return out;
}

/**
 * Lowers a whole template body to the IR.
 *
 * Module-level parts (`import`, `static`, `export interface Input`) are lifted
 * out of the body into `Ir`'s own fields, so a host places them without
 * filtering the tree for statement nodes.
 */
export function lower(ctx: Ctx, body: Node[]): Ir {
  const ownInputCode: string[] = [];
  const ownInputAux: string[] = [];
  for (const node of body) {
    if (node.type !== "MarkoTag" || node.name?.type !== "StringLiteral")
      continue;
    const statementName = node.name.value as string;
    if (
      statementName !== "import" &&
      statementName !== "static" &&
      statementName !== "export"
    )
      continue;
    const code = sliceLoc(ctx, node.loc).trim();
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

  const ir: Ir = {
    imports: [],
    hoisted: [],
    inputInterface: null,
    needsAttrTagImport: false,
    prelude: prelude.map(({ code, node }) => ({
      kind: "Hoisted",
      code,
      loc: posOf(node),
      end: endPosOf(node),
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
function runCustomTagAnalyze(ctx: Ctx, body: Node[]): void {
  const customTags = ctx.customTags;
  if (!customTags) return;
  if (!Object.values(customTags).some((tag) => tag.analyze)) return;

  const scratch = newCtx(
    ctx.source,
    ctx.generate,
    ctx.declarations,
    ctx.lookup,
    ctx.filename,
  );
  scratch.customTags = customTags;
  // Mirrors the parent: this walk is the same file, so whether it emits a
  // module is the same answer.
  scratch.emitsModule = ctx.emitsModule;
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
  const calls = new Map<string, TagCall[]>();
  scratch.customTagAnalyzePass = { calls };

  lowerChildren(scratch, body);
  runAnalyzeHooks(ctx, customTags, calls);
}

/** Compiles one tag unit only to produce its cached caller metadata. */
registerTemplateMetadataCompiler((ctx: Ctx, tag: TemplateTag) => {
  const { body } = parseFragment(tag.source, {
    filename: tag.filename,
    customTags: ctx.customTags as Record<string, CustomTag> | undefined,
  });
  const templateCtx = newCtx(
    tag.source,
    ctx.generate,
    ctx.declarations,
    ctx.lookup,
    tag.filename,
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
