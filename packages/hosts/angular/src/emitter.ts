/**
 * `@mxlang/angular`'s emitter (design note A1/A2, tasks 1.2 and 1.3).
 *
 * Emits an Angular template string from the core IR.
 */

import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import {
  type Attr,
  type AttributeTag,
  type AttributeTagNode,
  type AttrTagProp,
  type ComponentTarget,
  type Ctx,
  contractDefaultTag,
  DYNAMIC_TAG,
  type Emitter,
  type Expr,
  exportNameFor,
  expr,
  type ForSource,
  type HostDeclarations,
  hostModuleSegment,
  type Ir,
  type IrNode,
  isTranslateError,
  type MxWarning,
  metadataForTemplate,
  type Position,
  resolveSpecifier,
  type SourceSpan,
  type TemplateMetadata,
  TranslateError,
  unresolvedCustomTagMessage,
  warn,
} from "@mxlang/core";
import { literalSyntaxWarnings } from "./literal-syntax-hint.ts";
import {
  type AngularMapping,
  lineColumnAt,
  type NodeAnchor,
  TemplateWriter,
} from "./mapping.ts";

type TryData = { kind: "try" };
type HtmlCommentData = { kind: "html-comment" };
export type DynamicComponentData = { kind: "dynamic-component"; expr: Expr };

/** The span of a Marko-nested Babel node, or null when it has no position. */
function spanOf(node: {
  start?: number;
  end?: number;
  loc?: { start?: { index?: number }; end?: { index?: number } };
}): SourceSpan | null {
  const start = node.start ?? node.loc?.start?.index;
  const end = node.end ?? node.loc?.end?.index;
  return typeof start === "number" && typeof end === "number"
    ? { sourceStart: start, sourceEnd: end }
    : null;
}

function positionOf(node: { loc: Position }): Position {
  return node.loc;
}

function fail(message: string, node: { loc: Position }): never {
  const { line, column, file } = positionOf(node);
  throw new TranslateError(message, line, column, file);
}

function rawPosition(node: { loc?: { start?: Position } }): Position {
  const loc = node.loc?.start;
  if (!loc) {
    throw new Error(
      "@mxlang/angular: raw Marko node has no loc.start; every node reaching rawFail must carry a position",
    );
  }
  return loc;
}

function rawFail(message: string, node: { loc?: { start?: Position } }): never {
  const { line, column, file } = rawPosition(node);
  throw new TranslateError(message, line, column, file);
}

/** Keep the shared unresolved-tag wording, with Angular's control-flow fix. */
function unknownTagMessage(name: string): string {
  const base = unresolvedCustomTagMessage(name);
  return name === "switch" || name === "case"
    ? `${base} MX has no switch; use \`<if=…>\` / \`<else if=…>\`.`
    : base;
}

const MODULE_LEVEL_MESSAGE =
  "cannot be emitted into an Angular template: an Angular template has no module scope. Move it into the component's TypeScript file, or use `.ng.mx` (step 2), where MX emits the module for you.";

const TRY_MESSAGE =
  "`<try>` cannot be emitted into an Angular template: Angular has no template-level error boundary. `@defer`'s `@error` block only covers a failed lazy chunk load, not a render error. Handle the error in the component and render the fallback with `<if>`.";

/**
 * The Marko stateful tags this host refuses, each naming what to write
 * instead on Angular (spec §11, §13.3 bug 1). Same wording family as
 * `@mxlang/preact`'s `statefulErrors` and `@mxlang/solid`'s
 * `STATEFUL_ERRORS` — these are Marko's own reactivity, and Angular has its
 * own. Left undeclared, each name falls through `isElement`'s bare case test
 * and becomes a literal lowercase element in the emitted template (the S8
 * silent-wrong-render class), which is the bug this table closes.
 */
const STATEFUL_ERRORS: HostDeclarations["tags"] = {
  let: {
    kind: "error",
    reason:
      "`<let>` is Marko reactive state; use Angular's `signal`/`WritableSignal` in the component class, or a `@Input()`",
  },
  effect: {
    kind: "error",
    reason:
      "`<effect>` is a Marko reactive effect; use Angular's `effect()` in the component class",
  },
  lifecycle: {
    kind: "error",
    reason:
      "`<lifecycle>` is a Marko lifecycle hook; use Angular's own lifecycle hooks (`ngOnInit`, etc.) in the component class",
  },
  script: {
    kind: "error",
    reason:
      "`<script>` is a Marko client-runtime tag; write client code in the component class",
  },
  log: {
    kind: "error",
    reason:
      "`<log>` is a Marko debug tag; call `console.log` from the component class",
  },
  debug: {
    kind: "error",
    reason:
      "`<debug>` is a Marko debugger hook; use the component class instead",
  },
  client: {
    kind: "error",
    reason:
      "a `client` block is Marko's client-runtime split; an Angular component is already client code — move its statements into the component class",
  },
  server: {
    kind: "error",
    reason:
      "a `server` block runs only during a server render; Angular has no server-render pass to run it in — move its statements into the component class",
  },
  id: {
    kind: "error",
    reason:
      "`<id>` allocates an identifier for Marko's reactive runtime; use Angular's own `inject(...)`-based id generation or a static string",
  },
  await: {
    kind: "error",
    reason:
      "`<await>` needs Marko's suspense; use `@defer` with an `@placeholder`/`@loading` block instead",
  },
};

/** Resolve-time questions for Angular's template target. */
/** Angular's built-in `defaultTag`: the descriptor's field and the ladder's last rung. */
export const DEFAULT_TAG = "div";

export const angularDeclarations: HostDeclarations = {
  name: "@mxlang/angular",
  attrTags: 2,
  // The ladder (decision 145): the parent's contract `defaultTag`, then
  // `mx.<target>.defaultTag`, then the target's built-in (the registry folds
  // the host override into `configured`). This host permits the contract rung:
  // it sets no `allowContractDefaultTag: false`.
  resolveDefaultTag: (_node, parents, context) =>
    contractDefaultTag(parents, context, [DEFAULT_TAG]) ??
    context.configured ??
    DEFAULT_TAG,
  scriptletReplacement: (name, keyword) =>
    keyword === "const" ? `declare a value with \`<const/${name}=…/>\`` : "",
  // `[prop]=`, `#ref`, `*ngIf` are the target's own syntax and pass through.
  acceptsForeignAttrNames: true,
  claimsAttributeHash: true,
  tags: {
    ...STATEFUL_ERRORS,
    try: { kind: "error", reason: TRY_MESSAGE },
  },
  // Element-vs-component follows Marko's own rule — what the taglib lookup
  // resolves the name to — with casing only as the fallback for a name no
  // taglib knows, so a `tags/`-discovered `<badge/>` is the component it is
  // in Marko. Matches the JSX hosts' `isElement`; `isComponent` below still
  // wins for a file-local binding, and the core consults it first.
  isElement: (name, ctx) => {
    const taglibId = ctx.lookup?.getTag(name)?.taglibId;
    if (taglibId !== undefined) return ELEMENT_TAGLIBS.has(taglibId);
    return !/^[A-Z]/.test(name);
  },
  // Decision 114: routing by PascalCase alone made `<TotallyUndefined/>` —
  // no import, binding, or taglib entry — a "component" that emitted
  // `<mx-totally-undefined>` plus a step-1 import warning, where Marko
  // 6.3.51 fails at compile time. A name is a component here only when
  // something resolves it: a file-local binding (an import, a `<define>`),
  // or a taglib entry — and no HTML element is ever capitalized, so any
  // taglib hit for a capitalized name is a component, not an element.
  // Anything else falls past this to the core's unresolved-tag guard and
  // `rejectUnknownTag` below.
  isComponent: (name, ctx) => {
    if (ctx.defines?.has(name) || ctx.imports?.has(name)) return true;
    const taglibId = ctx.lookup?.getTag(name)?.taglibId;
    if (taglibId === undefined) return false;
    return !ELEMENT_TAGLIBS.has(taglibId);
  },
  // Marko's own compile error for a tag nothing resolves (decision 114),
  // reported through the core's unresolved-tag guard rather than this
  // host's old casing-only fallback. The message is core's own constant,
  // shared verbatim with every other Marko-parity host.
  rejectUnknownTag(name, node) {
    rawFail(unknownTagMessage(name), node);
  },
  isDelegatedTag: (name) =>
    name === "try" || name === "html-comment" || name === DYNAMIC_TAG,
  resolveDelegatedTag(
    name,
    node,
    ctx,
  ): TryData | HtmlCommentData | DynamicComponentData {
    if (name === "try") return { kind: "try" };
    if (name === "html-comment") return { kind: "html-comment" };
    if (name === DYNAMIC_TAG) {
      return {
        kind: "dynamic-component",
        expr: {
          code: expr(ctx, node.name),
          shape: "other",
          node: node.name,
          // The span is read off the same node `expr()` sliced — a
          // synthesized node with no position yields undefined and the
          // emitted expression stays unmapped.
          span: spanOf(node.name) ?? undefined,
        },
      };
    }
    rawFail(`unknown Angular host tag ${name}`, node);
  },
  // Only native `class:`, `style:` and `on:` prefixes reach this hook.
  // Other colon names (including `attr:` and `oncapture:`) are ordinary
  // attributes in Marko, not invalid modifier syntax (decision 86 follow-up).
  rejectModifier(attr): void {
    // SAFETY: core passes a raw Marko attribute whose name/modifier are strings.
    const { name, modifier } = attr as unknown as {
      name: string;
      modifier?: string;
    };
    const fullName = `${name}:${modifier ?? ""}`;
    const colon = fullName.indexOf(":");
    const prefix = fullName.slice(0, colon);
    const target = fullName.slice(colon + 1);
    if (prefix === "on") {
      const event = target.charAt(0).toUpperCase() + target.slice(1);
      rawFail(
        `\`on:${target}=fn\` is not MX syntax; write \`on${event}=fn\` for a DOM event or \`on-${target}=fn\` for a custom event name (Marko rejects this form too)`,
        attr,
      );
    }
    const replacement =
      prefix === "class"
        ? "an object/array `class=` value, lowered to `[ngClass]`"
        : "an object `style=` value, lowered to `[ngStyle]`";
    rawFail(
      `attribute modifier \`${fullName}\` is not Marko syntax; use ${replacement} instead`,
      attr,
    );
  },
  resolveAttributeMethod: () => true,
};

// Every `@` immediately before a lowercase-identifier start, with no
// boundary condition (design note A1 "Text escaping", squad-leader ruling
// R-a): probed `(@if a)`, `[@for x]`, `a-@if b`, `>@if<`, `.@let y` all fail
// unescaped, and `me&#64;example.com` parses and renders identically to
// `me@example.com` — so escaping every occurrence, mid-identifier included,
// costs nothing and is the only rule with no missed case.
const AT_LOWER = /@(?=[a-z])/g;

/**
 * `{`/`}` -> a single-character interpolation literal (`{{ '{' }}` /
 * `{{ '}' }}`). Shared by static text and static attribute values; the
 * `@`-before-lowercase rule below is text-only (Angular lexes `@` blocks in
 * text, never in attribute values).
 */
function escapeBraces(value: string): string {
  return value.replace(/[{}]/g, (char) => `{{ '${char}' }}`);
}

/**
 * `{`/`}` -> a single-character interpolation literal; `@` before a lowercase
 * identifier -> `&#64;`.
 *
 * Entity encoding (`&#123;`/`&#125;`) is correct for an *isolated* brace —
 * measured, `a &#123; b` parses. It fails only for an entity-encoded `{{ …
 * }}` **pair** whose body is not a valid Angular expression: Angular decodes
 * entities before delimiter scanning, so `&#123;&#123; not an interpolation
 * &#125;&#125;` still opens an interpolation and fails
 * (`Unexpected token 'an'`). Angular's own error text recommends the
 * interpolation-literal fix used here, which is probed to parse for every
 * brace fixture uniformly, so it is applied to every brace rather than only
 * the pair case — one rule instead of two.
 */
function escapeText(value: string): string {
  return escapeBraces(value).replace(AT_LOWER, "&#64;");
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// Phase B of `dom-events` (decision 101): core lowers an element's
// `on<Name>`/`on-<exact>` to `kind: "event"` carrying the resolved DOM name,
// so this host recomposes `(${attr.event})=` from it and the invented
// `IRREGULAR_EVENTS` table this file used to carry is gone — `onDoubleClick`
// is *not* rewritten to `dblclick` (no aliases, decision 101 (c)); core warns
// and the binding emits `(doubleclick)` exactly as written. A lowercase
// `onclick=fn` never reaches the `event` kind (the core's `/^on[A-Z-]/` gate
// keeps it `dynamic`), so the `dynamic` case below maps it, as decision 101
// requires for this host.
const LOWERCASE_EVENT = /^on[a-z]+$/;
// `once=`/`onto=` are ordinary words, not events — spec §4 names `once`, and
// the element tests pin both as plain property bindings.
const NOT_EVENTS = new Set(["once", "onto"]);

// Marko's own element taglibs: `marko-html`, `marko-svg`, `marko-math` — a
// capitalized name found in any *other* taglib resolved to a component.
// Same set `@mxlang/preact`'s emitter declares, for the same lookup.
const ELEMENT_TAGLIBS = new Set(["marko-html", "marko-svg", "marko-math"]);

/**
 * A dynamic attribute with no Angular DOM property to bind emits
 * `[attr.name]`; every other dynamic attribute stays `[name]` (A1 design note,
 * decision 86).
 *
 * Two families qualify: `data-*`/`aria-*` (Angular has no `.dataFoo`/
 * `.ariaFoo` DOM property for most of these), and a name carrying `:`, which
 * is Marko's `value:<modifier>` attribute (`<div :foo=y/>` is one attribute
 * literally named `value:foo`, rendered as such by Marko). `[value:foo]` would
 * be a property binding to a name no element has — NG8002 at the app's own
 * check. A *static* `value:foo="x"` needs none of this: Angular carries an
 * unknown static attribute through to the DOM verbatim, exactly as Marko does.
 */
const NO_PROPERTY_BINDING = /^(data|aria)-|:/;

/**
 * Marks a warning as "add this symbol to the component's `imports:`".
 *
 * Exported so `.ng.mx` — which performs that edit rather than asking for it
 * — can drop exactly these, without matching on message text.
 */
export const IMPORTS_ADVICE_CODE = "angular.imports-advice";

/**
 * Marks the "add the event invoker members to your component class" warning.
 * `.ng.mx` and tag modules write those members themselves and drop it.
 */
export const EVENT_HELPER_ADVICE_CODE = "angular.event-helper-advice";

// A1:112-113's exact wording, one per directive — "class" takes "object or
// array" (both structured shapes route here) while "style" takes only
// "object" (an array-valued `style=` is not a shape the emitter's own
// structured-value handling recognizes, so this directive never fires for
// an array).
const NGCLASS_NGSTYLE_WARNING: Record<"ngClass" | "ngStyle", string> = {
  ngClass:
    "this template binds `class` to an object or array value, emitted as [ngClass]; add `NgClass` to the component's imports.",
  ngStyle:
    "this template binds `style` to an object value, emitted as [ngStyle]; add `NgStyle` to the component's imports.",
};

// A handler reference is a value, not a call: Marko calls it as
// `handler(event, element)` and types it `(event, target) => unknown`, so a
// 0-arg `onClick=cancel` is valid there. `(cancel)($event)` is TS2554 under
// `strictTemplates` for that handler, and Angular's template grammar has no
// cast (`$any` would drop the check). A call cannot pass fewer arguments than
// its callee takes, but an *assignment* can, so the call goes through a typed
// invoker member on the component: it takes the handler as a parameter typed
// `(event: E, element: EventTarget | null) => R`, so 0-arg, 1-arg, 2-arg and
// inline arrow handlers all check, a handler for the wrong event type still
// fails, and the handler's result is returned to Angular (a `false` still
// calls `preventDefault()`).
//
// The invoker is a member, not an import: a template can only call what its
// component instance has. It is inlined per component rather than imported
// from a runtime module because this package has no runtime, and one would
// make every generated module depend on `@mxlang/angular` at run time for two
// one-liners. `.ng.mx` and tag modules write the members themselves; for a
// page (whose class is the author's) a warning carries the text to paste.
//
// A falsy handler (`onClick=cond && fn`, `null`, `undefined`, `false`) is a
// no-op, as in Marko's `handler?.(event, target)` dispatch: the invoker
// returns `undefined` without calling and its parameter types accept those
// values, while a real function is still checked against the event type.
//
// `this` is the component (Marko: the element), and `element` is
// `$event.currentTarget` typed `EventTarget | null` — Angular gives no
// element type without a template reference (spec divergences).
export const EVENT_HELPER_MARKER = "__mxOn";

/**
 * The subpath that carries the same two members as a base class (`MxHandlers`)
 * and a mixin (`MxHandlersMixin(Base)`), for a component that would rather
 * extend them than paste them (`src/runtime.ts`).
 */
export const RUNTIME_SPECIFIER = "@mxlang/angular/runtime";

/** The invoker members, one class-body line each (2-space indented). */
export const EVENT_HELPER_MEMBERS = [
  "  protected readonly __mxOn = <E, R>(handler: ((event: E, element: EventTarget | null) => R) | null | undefined | false, receiver: unknown, event: E): R | undefined => handler ? handler.call(receiver, event, (event as { currentTarget?: EventTarget | null } | null)?.currentTarget ?? null) : undefined;",
  "  protected readonly __mxOnAt = <K extends PropertyKey, E, R>(object: { [P in K]?: ((event: E, element: EventTarget | null) => R) | null | undefined | false }, key: K, event: E): R | undefined => this.__mxOn(object[key], object, event);",
];

/** The name each `EVENT_HELPER_MEMBERS` line declares, in the same order. */
export const EVENT_HELPER_NAMES = EVENT_HELPER_MEMBERS.map(
  (member) => /readonly (\w+)/.exec(member)?.[1] as string,
);

/** The second option, appended to the advice in the page header and the warning. */
export const EVENT_HELPER_RUNTIME_OPTION = `or extend \`MxHandlers\` (or \`MxHandlersMixin(Base)\` when the class already extends another) from "${RUNTIME_SPECIFIER}"`;

const EVENT_HELPER_ADVICE = `this template binds an event handler; add these members to the component class: ${EVENT_HELPER_MEMBERS.map((m) => `\`${m.trim()}\``).join(" and ")}, ${EVENT_HELPER_RUNTIME_OPTION} (app code importing it needs \`@mxlang/angular\` in \`dependencies\`, not \`devDependencies\`; extend \`MxHandlers\`/\`MxHandlersMixin\` directly: \`.ng.mx\` injects the members into an indirect base, and TypeScript then reports a conflict).`;

interface HandlerNode {
  type: string;
  start: number;
  end: number;
  computed?: boolean;
  optional?: boolean;
  extra?: { parenthesized?: boolean };
  object?: HandlerNode;
  property?: HandlerNode & { name?: string };
}

/**
 * The receiver of a handler expression, read from its parsed AST (never from
 * the text): a bare name is the component (`this`); `a.b` / `a[k]` /
 * `a().b` / `a!.b` is the object `a`, which must be evaluated once, so the
 * member form hands `(a, key)` to `__mxOnAt` rather than `a.b` and `a` to
 * `__mxOn`. Anything else (an arrow, a call result, `a?.b`, which must keep
 * its short-circuit) has no receiver.
 */
function handlerShape(code: string):
  | { form: "bare" }
  | {
      form: "member";
      object: string;
      key: string;
      /** `[start, end)` of the object in `code`; absent when parenthesized. */
      objectRange?: [number, number];
    }
  | { form: "other" } {
  let node: HandlerNode;
  try {
    const babel = require("@marko/compiler/internal/babel") as {
      parseExpression(source: string, options: unknown): HandlerNode;
    };
    node = babel.parseExpression(code, { plugins: [["typescript", {}]] });
  } catch {
    return { form: "other" };
  }
  if (node.type === "Identifier") return { form: "bare" };
  if (node.type === "MemberExpression" && node.object && node.property) {
    const text = (n: HandlerNode) => {
      const slice = code.slice(n.start, n.end);
      return n.extra?.parenthesized ? `(${slice})` : slice;
    };
    const objectRange: [number, number] | undefined = node.object.extra
      ?.parenthesized
      ? undefined
      : [node.object.start, node.object.end];
    if (node.computed) {
      return {
        form: "member",
        object: text(node.object),
        key: text(node.property),
        objectRange,
      };
    }
    if (node.property.type === "Identifier" && node.property.name) {
      return {
        form: "member",
        object: text(node.object),
        key: `'${node.property.name}'`,
        objectRange,
      };
    }
  }
  return { form: "other" };
}

function writeHandlerCall(
  out: TemplateWriter,
  value: Expr,
  source: string,
): void {
  const shape = handlerShape(value.code);
  if (shape.form === "member") {
    out.write(`${EVENT_HELPER_MARKER}At(`);
    // A mapping must slice its own source text, so the object maps to its own
    // sub-span, and only when `code` is still the authored text (no reference
    // rewriting) and the object is not re-parenthesized.
    const { span } = value;
    const authored =
      span && source.slice(span.sourceStart, span.sourceEnd) === value.code;
    if (span && authored && shape.objectRange) {
      out.writeMapped(esc(shape.object), {
        sourceStart: span.sourceStart + shape.objectRange[0],
        sourceEnd: span.sourceStart + shape.objectRange[1],
      });
    } else {
      out.write(esc(shape.object));
    }
    out.write(`, ${esc(shape.key)}, $event)`);
    return;
  }
  out.write(`${EVENT_HELPER_MARKER}(`);
  out.writeMapped(esc(value.code), value.span);
  out.write(`, ${shape.form === "bare" ? "this" : "null"}, $event)`);
}

/**
 * The authored extent of an attribute, name through value, for the node
 * anchors Angular's attribute-level diagnostics resolve through.
 *
 * A default attribute (`<x="post">`, `<switch=title>`) has no spelled name:
 * its name span is zero-width, so the extent starts at the value. `undefined`
 * for an attribute synthesized with no source.
 */
function attrSourceSpan(attr: Attr): SourceSpan | undefined {
  if (attr.kind === "spread") return undefined;
  const name = attr.nameSpan;
  let value: SourceSpan | undefined;
  if (attr.kind === "static") value = attr.valueSpan;
  else if (attr.kind !== "boolean") value = attr.value.span;
  const hasName = name.sourceEnd > name.sourceStart;
  if (!hasName) return value;
  if (!value || value.sourceEnd < name.sourceEnd) return name;
  return { sourceStart: name.sourceStart, sourceEnd: value.sourceEnd };
}

/** Angular diagnoses the directive identifier separately from its structural `*`. */
function writeAttributeName(
  out: TemplateWriter,
  name: string,
  span: SourceSpan | undefined,
): void {
  if (
    name.startsWith("*") &&
    name.length > 1 &&
    span &&
    span.sourceEnd - span.sourceStart === name.length
  ) {
    out.writeMapped("*", {
      sourceStart: span.sourceStart,
      sourceEnd: span.sourceStart + 1,
    });
    out.writeMapped(name.slice(1), {
      sourceStart: span.sourceStart + 1,
      sourceEnd: span.sourceEnd,
    });
  } else {
    out.writeMapped(name, span);
  }
}

/**
 * Writes an attribute list into `out`.
 *
 * Attribute *names* and expression *values* are mapped to the source text
 * they came from; the syntax around them (` [`, `]="`, `"`) is generated
 * punctuation and stays unmapped. Structural `*` prefixes get their own
 * mapped run, so a diagnostic on the directive name lands after the prefix.
 */
/**
 * Marko's primitive attribute values (decision 149) as an Angular template
 * expression over a `@let` that holds the authored expression (`$any`, since a
 * strict template rejects `=== false` on a `string`), so it is
 * evaluated and type-checked once, at its authored position.
 *
 * - `attr`: `[attr.name]` removes the attribute on null/undefined only, so
 *   `false` (Marko omits) and `true` (Marko prints bare) are folded in.
 * - `present`: presence only, for a property that mirrors a boolean attribute.
 * - `text`: the value text a property prints, for `value`.
 * - `list`: `class`/`style`, where Marko also omits 0, "" and NaN and prints
 *   `true` as "true".
 */
type PrimitiveForm = "attr" | "present" | "text" | "list";

/** How a dynamic attribute on a native element renders, or null to keep the legacy binding. */
function primitiveForm(
  attr: Attr,
  tagName: string | undefined,
): PrimitiveForm | null {
  if (attr.kind !== "dynamic") return null;
  const name = attr.name;
  if (name.includes(":") && name.toLowerCase().startsWith("on")) return null;
  if (LOWERCASE_EVENT.test(name) && !NOT_EVENTS.has(name)) return null;
  if (name === "class" || name === "style") {
    const shape = attr.value.shape;
    return shape === "object" || shape === "array" ? null : "list";
  }
  if (name === "value") return "text";
  if (name === "checked") return tagName === "input" ? "present" : "attr";
  // A name starting `on` is never bound as an attribute (Angular refuses
  // `[attr.on*]` for security), so `once`/`onto` keep the property binding.
  return /[A-Z]/.test(name) || /^on/i.test(name) ? null : "attr";
}

function primitiveExpression(variable: string, form: PrimitiveForm): string {
  switch (form) {
    case "attr":
      return `${variable} == null || ${variable} === false ? null : ${variable} === true ? '' : ${variable}`;
    case "present":
      return `${variable} != null && ${variable} !== false`;
    case "text":
      return `${variable} == null || ${variable} === false || ${variable} === true ? '' : ${variable}`;
    case "list":
      return `${variable} ? (${variable} === true ? 'true' : ${variable}) : null`;
  }
}

function emitAttrs(
  out: TemplateWriter,
  attrs: Attr[],
  onceWarn: (kind: "ngClass" | "ngStyle") => void,
  // The lowercase `onclick=fn` mapping is a native-element rule: on a
  // component call the same attribute is the callee's own `[onclick]` input
  // (components have props; elements have events), so the distinction is
  // threaded in exactly like the core's `isElement` gate.
  isElement = false,
  onHandler?: () => string,
  tagName?: string,
  lets?: Map<Attr, string>,
): void {
  for (const attr of attrs) {
    // Marko accepts `value:`, but Angular's literal-attribute tokenizer does
    // not accept an empty namespace suffix. Never emit an unparseable tag.
    if (attr.kind !== "spread" && attr.name.endsWith(":")) {
      fail(
        `attribute \`${attr.name}\` has an empty namespace suffix that Angular templates cannot express`,
        attr,
      );
    }
    // Every case but `spread` (which fails) opens with one space, so the
    // attribute's generated extent starts one past `before`.
    const before = out.length;
    switch (attr.kind) {
      case "static": {
        // HTML attribute names are case-insensitive: an authored `CLASS=`
        // hits the class pipeline exactly like `class=`, so the styled
        // check lowercases, and the binding is emitted lowercase (rev2 L1).
        const styledName = attr.name.toLowerCase();
        const styled =
          (styledName === "class" || styledName === "style") &&
          /[{}]/.test(attr.value);
        out.write(" ");
        if (styled) out.write("[attr.");
        if (styled) {
          out.writeMapped(styledName, attr.nameSpan);
        } else {
          writeAttributeName(out, attr.name, attr.nameSpan);
        }
        if (styled) {
          // Angular's class/style pipelines do not tolerate braces: a static
          // class re-tokenizes evaluated interpolation literals
          // (`class="{{ x }}"` renders `x {{ }}`), and a static style trips
          // Angular's style parser. A property binding bypasses both
          // pipelines, and — probed — Angular parses a binding value as one
          // expression with no interpolation splitting, so the raw braces go
          // in verbatim inside a string literal and render exactly. Inside
          // the literal, `\` and `'` are expression-escaped, then `esc`
          // handles the HTML `&`/`"` layer.
          out.write(`]="`);
          out.write(
            esc(`'${attr.value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`),
          );
          out.write('"');
        } else {
          // The value is a plain string literal in the IR with no span of
          // its own, so only the name is mapped here. Angular evaluates
          // `{{ … }}` inside an attribute value, so a static value gets the
          // brace escaping from `escapeText` — the `@`-before-lowercase rule
          // is text-only (Angular lexes `@` blocks in text, never in
          // attribute values) and must not run here: its `&#64;` entity
          // would be double-escaped by `esc` and render as the literal text
          // `&#64;` (rev F1).
          out.write(`="${esc(escapeBraces(attr.value))}"`);
        }
        break;
      }
      case "boolean":
        out.write(" ");
        writeAttributeName(out, attr.name, attr.nameSpan);
        break;
      // Phase B of `dom-events` (decision 101): Angular's `(x)` binds a real
      // DOM event name, and core resolved it — `on<Name>` lowercased,
      // `on-<exact>` verbatim — so both forms emit `(${attr.event})=` from
      // the one source of truth: `onClick` and `on-click` both give
      // `(click)`, `on-my-event` gives `(my-event)`, and `onDoubleClick`
      // gives `(doubleclick)` with core's warning, never a rewrite.
      case "event":
        // The emitted DOM event name is derived from the author's
        // attribute name (`onClick` -> `click`), so it maps back to that
        // name even though the two spellings differ.
        out.write(" (");
        out.writeMapped(attr.event, attr.nameSpan, "event");
        out.write(')="');
        writeHandlerCall(out, attr.value, onHandler?.() ?? "");
        out.write('"');
        break;
      case "dynamic": {
        const name = attr.name;
        if (name.includes(":") && name.toLowerCase().startsWith("on")) {
          // This is an ordinary Marko name, but Angular's security validator
          // forbids [attr.on*] bindings. Static strings remain expressible.
          fail(
            `Angular forbids dynamically binding the ordinary attribute \`${name}\` for security reasons`,
            attr,
          );
        }
        if (isElement && LOWERCASE_EVENT.test(name) && !NOT_EVENTS.has(name)) {
          // `onclick=fn` (lowercase, expression) on a native element: not
          // event-shaped for the core kind, but decision 101 maps it on this
          // host — Angular's `(click)` is the binding an inline handler
          // string would have driven, so a function value routes there
          // instead of a dead `[onclick]` property binding. On a component
          // call the same attribute stays the callee's `[onclick]` input.
          out.write(" (");
          out.writeMapped(name.slice(2), attr.nameSpan, "event");
          out.write(')="');
          writeHandlerCall(out, attr.value, onHandler?.() ?? "");
          out.write('"');
        } else if (name === "class" || name === "style") {
          const shape = attr.value.shape;
          if (shape === "object" || shape === "array") {
            const directive = name === "class" ? "ngClass" : "ngStyle";
            onceWarn(directive);
            out.write(" [");
            out.writeMapped(directive, attr.nameSpan, "directive");
            out.write(']="');
            out.writeMapped(esc(attr.value.code), attr.value.span);
            out.write('"');
          } else if (isElement && lets?.has(attr)) {
            // `class=expr` / `style=expr` on a native element: Marko omits a
            // falsy primitive and prints `true` as "true".
            out.write(" [");
            out.writeMapped(name, attr.nameSpan);
            out.write(']="');
            out.write(primitiveExpression(lets.get(attr) as string, "list"));
            out.write('"');
          } else {
            out.write(" [");
            out.writeMapped(name, attr.nameSpan);
            out.write(']="');
            out.writeMapped(esc(attr.value.code), attr.value.span);
            out.write('"');
          }
        } else if (isElement && lets?.has(attr)) {
          // Marko prints an attribute, never a property. `[attr.name]` is the
          // attribute binding; `value`/`checked` on an `<input>` bind the live
          // property so a typed value is not fought by a stale attribute; a
          // camelCase name (`innerHTML`, `textContent`) is a DOM property and
          // keeps the property binding below.
          const form = primitiveForm(attr, tagName) as PrimitiveForm;
          out.write(form === "attr" ? " [attr." : " [");
          out.writeMapped(name, attr.nameSpan);
          out.write(']="');
          out.write(primitiveExpression(lets.get(attr) as string, form));
          out.write('"');
        } else if (NO_PROPERTY_BINDING.test(name)) {
          // A1 (design note), decision 86: Angular property vs attribute
          // binding is the emitter's own call, not an author-written
          // modifier — native `class:`/`style:` are reserved, but `attr:`
          // and other non-reserved colon names are ordinary complete names.
          // A dynamic `data-*`/`aria-*` attribute has no property to bind
          // (Angular has no `.dataFoo`/`.ariaFoo` DOM property for most of
          // these), and neither has an ordinary colon name, so both emit
          // `[attr.name]`; every other dynamic attribute stays `[name]`.
          out.write(" [attr.");
          out.writeMapped(name, attr.nameSpan);
          out.write(']="');
          out.writeMapped(esc(attr.value.code), attr.value.span);
          out.write('"');
        } else {
          out.write(" [");
          out.writeMapped(name, attr.nameSpan);
          out.write(']="');
          out.writeMapped(esc(attr.value.code), attr.value.span);
          out.write('"');
        }
        break;
      }
      case "bound":
        out.write(" [(");
        out.writeMapped(attr.name, attr.nameSpan);
        out.write(')]="');
        out.writeMapped(esc(attr.value.code), attr.value.span);
        out.write('"');
        break;
      case "spread":
        fail(
          "a spread attribute cannot be emitted into an Angular template, because Angular binds statically named inputs only. Name the attributes, or pass the object to a single input.",
          attr,
        );
    }
    out.anchor(before + 1, out.length, attrSourceSpan(attr));
  }
}

// A real HTML comment cannot contain `--` (a nested `--` or a trailing `-`
// before the closer is invalid per the HTML comment grammar, even though
// Angular's own parser tolerates it — probed).
function checkCommentText(text: string, node: { loc: Position }): void {
  if (text.includes("--") || text.endsWith("-")) {
    fail(
      "a comment's content cannot contain `--` or end with `-`; an HTML comment's own grammar forbids it.",
      node,
    );
  }
}

/** `UserCard` / `user-card` -> `user-card`; the tag's filename, kebab-cased. */
export function kebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase();
}

/** `.../tags/user-card.mx` -> `user-card`; the tag's basename, extension dropped. */
export function tagBasename(resolvedPath: string): string {
  const base = resolvedPath.split(/[/\\]/).pop() ?? resolvedPath;
  return base.replace(/\.mx$/, "");
}

/**
 * The default tag selector prefix (design note O9, RULED 2026-09-16):
 * `mx-` plus the kebab-cased file basename.
 *
 * A fixed prefix guarantees the hyphen Angular requires in a custom element
 * name, so a single-word tag (`tags/icon.mx`) is `mx-icon` rather than the
 * invalid bare `icon`, and it keeps MX tags from colliding with the app's own
 * `app-*` components. A tag file overrides it wholesale with
 * `export const selector`.
 */
const TAG_SELECTOR_PREFIX = "mx-";

/**
 * What one hoisted top-level statement says about the tag's selector.
 *
 * `undefined`: it is not `export const selector`. `literal`: a plain string
 * (`"x-y"`, `'x-y'`, a template literal without substitutions, each
 * optionally followed by `as const`). `unreadable`: it declares `selector`
 * but by a form no static read can resolve (typed declaration, identifier,
 * substitution) — the caller reports it rather than guessing.
 *
 * The one rule both sides share: `compileTagModule` applies it to each of
 * its own hoisted statements, and a call site applies it to the callee's
 * (carried in core's `TemplateMetadata.hoistedExports`), so an `export`
 * inside a comment or a string — never a statement — can not disagree.
 */
export function selectorDeclarationOf(
  statement: string,
): { kind: "literal"; value: string } | { kind: "unreadable" } | undefined {
  if (!/^export\s+const\s+selector\b/.test(statement)) return undefined;
  const literal = statement.match(
    /^export\s+const\s+selector\s*=\s*(?:(["'])([^"']+)\1|`([^`$\\]+)`)(?:\s+as\s+const)?\s*;?\s*$/,
  );
  const value = literal?.[2] ?? literal?.[3];
  return value === undefined
    ? { kind: "unreadable" }
    : { kind: "literal", value };
}

/**
 * The warning both sides emit for an `export const selector` that is not a
 * literal. Identical text on both, so the tag module and its caller say the
 * same thing about the same declaration.
 */
export function unreadableSelectorMessage(fallback: string): string {
  return `\`export const selector\` must be a plain string literal (\`"x-y"\`, \`'x-y'\`, or a template literal without substitutions, optionally \`as const\`); this declaration is ignored and the selector stays \`${fallback}\`.`;
}

/**
 * The module specifier of an authored `import` statement, or undefined.
 *
 * A synthesized import carries `specifier` structurally; an authored one
 * carries only its source text, so it is parsed — through
 * `@marko/compiler/internal/babel`, the instance the core already uses —
 * rather than scraped with a regex, which would trip over a specifier
 * containing an escape or a quote of the other kind.
 */
function authoredImportSpecifier(code: string): string | undefined {
  try {
    const babel = require("@marko/compiler/internal/babel") as {
      parse(
        source: string,
        options: unknown,
      ): {
        program: {
          body: Array<{ type?: string; source?: { value?: unknown } }>;
        };
      };
    };
    const ast = babel.parse(code, {
      sourceType: "module",
      plugins: ["typescript"],
    });
    for (const statement of ast.program.body) {
      if (statement.type !== "ImportDeclaration") continue;
      const value = statement.source?.value;
      if (typeof value === "string") return value;
    }
  } catch {
    // Not parseable as an import here means it is not one this host can
    // resolve to a tag module; the core reports a genuine syntax error at
    // its own position.
  }
  return undefined;
}

/**
 * Whether an `Import` node binds a `.mx` tag module.
 *
 * Both halves of this host ask the same question and must agree: the emitter
 * resolves such an import to a component reference, and the tag-unit compiler
 * drops the author's own line for one, because the emitted module re-emits it
 * under the component class's name. A disagreement here emits the import
 * twice (a duplicate identifier) or not at all.
 */
export function isTagModuleImport(
  specifierOrCode: string,
  resolvedPath?: string,
): boolean {
  if (resolvedPath) return resolvedPath.endsWith(".mx");
  const specifier = specifierOrCode.endsWith(".mx")
    ? specifierOrCode
    : authoredImportSpecifier(specifierOrCode);
  return specifier?.endsWith(".mx") === true;
}

/** One MX tag a template called, as the caller's TypeScript must name it. */
export interface UsedTag {
  /**
   * The tag as the author wrote it (`icon`), for a consumer that resolves it
   * against the tag scan — the watcher's dependency map does.
   *
   * Not the binding the IR carried: a discovered tag's is a gensym
   * (`$mx_Icon1`) that `scan.tags.get()` will never find.
   */
  name: string;
  /** The class the emitted module exports, e.g. `UserCard`. */
  className: string;
  /** The import path of the emitted `.ts`, e.g. `./tags/user-card`. */
  specifier: string;
  /**
   * The author's own local binding, set by `.ng.mx` when the tag was called
   * through an authored `import X from "./x.mx"`. `imports:` then names
   * `local`, not `className`.
   */
  local?: string;
}

/** How a call site references one tag module. */
interface TagModuleRef {
  /** The element name the call site emits, e.g. `mx-user-card`. */
  selector: string;
  /** The class the emitted module exports, e.g. `UserCard`. */
  className: string;
  /** The import path of the emitted `.ts`, e.g. `./tags/user-card`. */
  specifier: string;
  /** The tag file this module was compiled from, when it is known. */
  resolvedPath?: string;
}

/** The only AST shape for which the hint offers a concrete rename. */
interface TrackingMember {
  type: string;
  name?: string;
  computed?: boolean;
  object?: TrackingMember;
  property?: { type: string; name?: string };
  loc?: { start: { index: number }; end: { index: number } };
}

/**
 * Rename only the leading reference in a simple parameter member chain.
 * Calls, binders, object literals and computed expressions get no code hint:
 * this is intentionally not a general-purpose alpha-renamer.
 */
function renamedMemberChain(
  arrow: { loc?: { start: { index: number } }; body: TrackingMember },
  paramName: string,
  row: string,
  code: string,
): string | null {
  let reference = arrow.body;
  if (
    reference.type !== "MemberExpression" &&
    reference.type !== "OptionalMemberExpression"
  )
    return null;
  while (
    reference.type === "MemberExpression" ||
    reference.type === "OptionalMemberExpression"
  ) {
    if (!reference.object || !reference.property) return null;
    if (reference.computed) {
      if (reference.property.type !== "StringLiteral") return null;
    } else {
      if (reference.property.type !== "Identifier") return null;
      // Be conservative for the reviewed `y?.y` shape: give an instruction,
      // not code, when an optional member repeats the parameter's spelling.
      if (
        reference.type === "OptionalMemberExpression" &&
        reference.property.name === paramName
      )
        return null;
    }
    reference = reference.object;
  }
  if (
    reference.type !== "Identifier" ||
    reference.name !== paramName ||
    !reference.loc ||
    !arrow.loc ||
    !arrow.body.loc
  )
    return null;
  const bodyStart = arrow.body.loc.start.index - arrow.loc.start.index;
  const bodyEnd = arrow.body.loc.end.index - arrow.loc.start.index;
  const start = reference.loc.start.index - arrow.loc.start.index;
  const end = reference.loc.end.index - arrow.loc.start.index;
  if (
    bodyStart < 0 ||
    bodyEnd > code.length ||
    start < bodyStart ||
    end > bodyEnd ||
    code.slice(start, end) !== paramName
  )
    return null;
  return code.slice(bodyStart, start) + row + code.slice(end, bodyEnd);
}

/** Find control-flow cases through IR wrappers, never through a component. */
function hasCaseDescendant(nodes: IrNode[]): boolean {
  return nodes.some((node) => {
    switch (node.kind) {
      case "Element":
        return node.name === "case" || hasCaseDescendant(node.children);
      case "For":
      case "Define":
        return hasCaseDescendant(node.children);
      case "IfChain":
        return node.branches.some((branch) =>
          hasCaseDescendant(branch.children),
        );
      case "DelegatedTag":
        return hasCaseDescendant(node.tag.children);
      default:
        // In particular, resolved Component nodes are opaque, not <case>.
        return false;
    }
  });
}

/**
 * Derives Angular's `track` expression from `by=`, per the design note's
 * shape table (mirrors `packages/hosts/solid/src/emitter.ts:679-686`).
 * `null` means `by=` was omitted — the caller supplies `$index` and warns.
 */
function deriveTrack(
  key: Expr | null,
  row: string,
  node: { loc: Position },
): string | null {
  if (!key) return null;
  if (key.shape === "string") {
    if (key.node?.type === "StringLiteral") {
      // SAFETY: a Babel StringLiteral has a string value; the discriminant is checked above.
      return `${row}.${(key.node as unknown as { value: string }).value}`;
    }
    if (key.node?.type === "TemplateLiteral") {
      // SAFETY: Babel TemplateLiteral nodes have quasis and expressions arrays.
      const template = key.node as unknown as {
        quasis: Array<{ value: { cooked: string | null } }>;
        expressions: unknown[];
      };
      // A template literal with no `${...}` (core still classifies it
      // `shape: "string"`, e.g. by=`id`) reduces to its one static chunk;
      // one with an interpolation has no fixed field name to extract, so it
      // falls through to the non-unwrappable rejection below rather than
      // being sliced with the backticks left in (which previously produced
      // `track p.\`id\``, a parse error).
      if (
        template.expressions.length === 0 &&
        template.quasis[0]?.value.cooked !== null &&
        template.quasis[0]?.value.cooked !== undefined
      ) {
        return `${row}.${template.quasis[0].value.cooked}`;
      }
    } else {
      // A bare, unquoted `by=id` reprints as plain text with no quote
      // marks to strip — this branch is dead for a real MX parse (`by=` of
      // a plain identifier that isn't `identity` is an `Identifier` node,
      // never `shape: "string"`), kept only as the fallback for any other
      // string-shaped node this classification hasn't been probed for.
      return `${row}.${key.code.replace(/^['"]|['"]$/g, "")}`;
    }
  }
  if (key.code.trim() === "identity") return row;
  if (key.node?.type === "ArrowFunctionExpression") {
    // SAFETY: the Babel arrow discriminant guarantees params/body; source positions remain optional.
    const arrow = key.node as unknown as {
      params: Array<{
        type: string;
        name?: string;
        loc?: { start?: Position };
      }>;
      body: TrackingMember;
      loc?: { start: { index: number } };
    };
    const parameter = arrow.params[0];
    if (
      arrow.params.length === 1 &&
      parameter?.type === "Identifier" &&
      typeof parameter.name === "string" &&
      parameter.name !== row
    ) {
      // Keyed tracking is not object identity. Only a simple member chain
      // gets concrete code; everything else gets a plain rename instruction.
      // The emitter has no row types, so identity is a different strategy for
      // rows without the suggested field, never a replacement for the key.
      const tracksRowItself =
        arrow.body.type === "Identifier" && arrow.body.name === parameter.name;
      const renamed = tracksRowItself
        ? null
        : renamedMemberChain(arrow, parameter.name, row, key.code);
      const field =
        arrow.body.type === "MemberExpression" &&
        arrow.body.computed === false &&
        arrow.body.property?.type === "Identifier"
          ? arrow.body.property.name
          : undefined;
      const prefix = `The \`by=\` arrow parameter \`${parameter.name}\` must match the \`<for>\` row \`${row}\`; `;
      const instruction = `rename the parameter \`${parameter.name}\` to \`${row}\` to keep the key expression.`;
      const message = tracksRowItself
        ? `${prefix}${instruction} Use \`by=identity\` to track the row itself.`
        : renamed === null
          ? `${prefix}${instruction}`
          : `${prefix}rename it to keep the key expression: \`by=(${row} => ${renamed})\`. If the row has no ${field ? `\`${field}\` field` : "such field (primitive rows)"}, \`by=identity\` is a different strategy that tracks the row itself.`;
      if (parameter.loc?.start) rawFail(message, parameter);
      fail(message, node);
    }
    // A block-bodied arrow (`p => { return p.id }`) has no single expression
    // to slice out — Angular's `track` must be one expression, not a
    // statement list — so it falls through to the same rejection as any
    // other non-unwrappable form.
    if (
      arrow.params.length === 1 &&
      arrow.params[0]?.name === row &&
      arrow.body.type !== "BlockStatement" &&
      arrow.body.loc &&
      arrow.loc
    ) {
      // `key.code` is the printed slice starting at `arrow.loc.start.index`,
      // so the body's own offsets translate directly into it — this reads
      // the exact expression text rather than trusting `=>` to appear only
      // once (a body containing its own arrow, `p => x => p.id`, would
      // otherwise match the wrong `=>`).
      const start = arrow.body.loc.start.index - arrow.loc.start.index;
      const end = arrow.body.loc.end.index - arrow.loc.start.index;
      return key.code.slice(start, end);
    }
  }
  fail(
    'a `<for by=…>` on Angular must be a field name (`by="id"`), `identity`, or an inline arrow over the row (`by=(p => p.id)`), because Angular\'s `track` is an expression, not a function.',
    node,
  );
}

// A baked range is a literal array in the emitted template source — an
// unbounded one would make the `.html` file itself huge for what is really
// runtime data. 1000 is generous for a literal loop bound and catches the
// case that is almost always a mistake (a `to=`/`step=` combination meant
// to compute a small fixed set, not enumerate a large range).
const RANGE_CAP = 1000;

/** Bakes a `<for>` range into a literal array, per the A1 combinations table. */
function bakeRange(
  source: Extract<ForSource, { kind: "range" }>,
  node: { loc: Position },
): number[] {
  const literalNumber = (expr: Expr | null, fallback: number): number => {
    if (!expr) return fallback;
    if (expr.node?.type === "NumericLiteral") {
      // SAFETY: Babel's NumericLiteral discriminant guarantees a numeric value.
      return (expr.node as unknown as { value: number }).value;
    }
    // A unary minus over a numeric literal (`step=-1`) parses as a
    // UnaryExpression, not a NumericLiteral — Babel's own shape for a
    // negative literal.
    if (expr.node?.type === "UnaryExpression") {
      // SAFETY: Babel UnaryExpression has operator/argument; value is read only after the NumericLiteral guard.
      const unary = expr.node as unknown as {
        operator: string;
        argument: { type: string; value: number };
      };
      if (unary.operator === "-" && unary.argument.type === "NumericLiteral") {
        return -unary.argument.value;
      }
    }
    fail(
      "a `<for>` range with a non-literal bound cannot be emitted into an Angular template, because Angular has no range loop and MX ships no runtime (decision 79). Compute the array in the component and iterate it with `of=`.",
      node,
    );
  };

  const from = literalNumber(source.from, 0);
  const bound = literalNumber(source.bound, 0);
  const step = literalNumber(source.step, 1);

  if (step === 0) {
    fail("a `<for>` range with `step=0` never terminates.", node);
  }

  // A true exclusive comparison (`i < bound`/`i > bound`), not `bound ± 1`:
  // the `± 1` form assumes an integer step of exactly 1 and silently drops
  // or keeps the wrong values for any other step — `from=0 until=2.2
  // step=0.5` needs `i < 2.2`, not `i <= 1.2`, to produce `[0, 0.5, 1, 1.5,
  // 2]` rather than dropping the last two.
  const result: number[] = [];
  if (step > 0) {
    for (let i = from; source.inclusive ? i <= bound : i < bound; i += step) {
      result.push(i);
      if (result.length > RANGE_CAP) {
        fail(
          `a \`<for>\` range from=${from} to=${bound} would bake ${result.length}+ elements; bind an array instead.`,
          node,
        );
      }
    }
  } else {
    for (let i = from; source.inclusive ? i >= bound : i > bound; i += step) {
      result.push(i);
      if (result.length > RANGE_CAP) {
        fail(
          `a \`<for>\` range from=${from} to=${bound} would bake ${result.length}+ elements; bind an array instead.`,
          node,
        );
      }
    }
  }
  return result;
}

class AngularEmitter implements Emitter<string> {
  private readonly out = new TemplateWriter();
  private readonly ctx: Ctx;
  private readonly tsFilename: string;
  private readonly warnedOnce = new Set<string>();
  private sourceIdentifiers: Set<string> | undefined;
  // Collected during the walk, each flushed as one warning per file in
  // `done()` — design note A1's step-1 import problem asks for one warning
  // naming every MX tag the template calls, not one warning per tag; and the
  // trackless-`<for>` warning needs the real loop count, not a literal
  // placeholder.
  private readonly usedTags = new Map<string, Position>();
  private tracklessForCount = 0;
  private firstLoc: Position | undefined;
  /**
   * Local binding -> the tag module the call site must reference, for every
   * import that binds a `.mx` tag file.
   *
   * A *discovered* tag does not reach the emitter under its written name: the
   * core mints a gensym'd binding for it (`<icon/>` lowers to
   * `Component.target.name === "$mx_Icon1"`, `template-tag.ts`'s
   * `bindingForTemplate`), so deriving the selector from `target.name` would
   * emit the invalid `<mx-$mx-icon1>`. The synthesized `Import` carries
   * `specifier` and `resolvedPath` structurally (tag-unit phase 2a), so the
   * binding is resolved back to the file it came from and the RULED selector
   * rule — `mx-` plus the kebab-cased *file basename* — is applied to that.
   *
   * An explicitly imported `import UserCard from "./tags/user-card.mx"` lands
   * here too, so both spellings of a call produce one selector.
   */
  private readonly tagModules = new Map<string, TagModuleRef>();
  /** Slot names each called tag file projects, by path; see `calleeProjects`. */
  private readonly calleeSlots = new Map<string, Set<string>>();
  /** `mx-` by default; `mx.angular.tagSelectorPrefix` overrides it. */
  private readonly selectorPrefix: string;

  constructor(
    ctx: Ctx,
    filename: string,
    imports: Ir["imports"] = [],
    selectorPrefix: string = TAG_SELECTOR_PREFIX,
  ) {
    this.ctx = ctx;
    this.selectorPrefix = selectorPrefix;
    // `x.component.mx` -> `x.component.ts`, the emitted sibling the step-1
    // import warning tells the author to edit. Falls back to the bare
    // filename with a `.ts` extension when it has none of MX's own.
    // Both extension segments, not just `.mx`: a `.ng.mx` otherwise names
    // `x.component.ng.ts`, a file that never exists.
    this.tsFilename =
      hostModuleSegment(basename(filename), this.ctx.targets) === "ng"
        ? filename.replace(/\.ng\.mx$/, ".ts")
        : filename.replace(/\.mx$/, ".ts");
    // The callee's own selector, once per tag file: two bindings of one path
    // (or a re-spelled import) must not read — or warn about — it twice. Kept
    // per emitter, so every compile re-reads through core's mtime/source-keyed
    // metadata cache and a watch rebuild sees an edited override.
    const calleeSelectors = new Map<string, string | undefined>();
    for (const node of imports) {
      // A *synthesized* import carries `specifier`/`resolvedPath`
      // structurally (tag-unit phase 2a). An **authored** one carries
      // neither — only `code` and `bindings` — so its specifier is read back
      // out of the statement text. Without this an authored
      // `import Child from "./child.mx"` fell through the `.mx` test below,
      // so the call site never resolved it: it kept the author's binding as
      // the class name and guessed `./tags/<name>` as the path, which is
      // wrong from inside a `tags/` directory, and the tag module emitted
      // the author's line *and* its own — a duplicate identifier.
      const specifierSource =
        node.specifier ?? authoredImportSpecifier(node.code);
      // Only a `.mx` import names a tag module. An ordinary TypeScript import
      // the author wrote is not a component this host emits a selector for.
      if (!specifierSource?.endsWith(".mx")) continue;
      // `resolvedPath` is the reliable basename when present (two spellings
      // of one path collapse to one tag); an authored import has only what
      // the author wrote, which names the same file.
      const basename = tagBasename(node.resolvedPath ?? specifierSource);
      // The emitted module sits beside the tag file with a `.ts` extension,
      // so the call site's import path is the specifier minus `.mx`.
      const specifier = specifierSource.replace(/\.mx$/, "");
      const derived = `${selectorPrefix}${kebabCase(basename)}`;
      // The callee's own `export const selector` wins over the derived
      // default, exactly as it does for the component it declares. Resolved
      // by core's resolver when the import carries no path (an authored one),
      // and an unresolvable or unreadable callee is an error, never a silent
      // fall back to the derived name.
      const calleePath =
        node.resolvedPath ??
        resolveSpecifier(specifierSource, {
          importer: filename,
          targets: this.ctx.targets,
        });
      if (!calleePath) {
        throw new TranslateError(
          `cannot resolve \`${specifierSource}\` to read its \`export const selector\`; check the import path.`,
          node.loc.line,
          node.loc.column,
          filename,
        );
      }
      if (!calleeSelectors.has(calleePath)) {
        calleeSelectors.set(
          calleePath,
          this.readCalleeSelector(calleePath, derived, node.loc, filename),
        );
      }
      const selector = calleeSelectors.get(calleePath) ?? derived;
      for (const binding of node.bindings) {
        this.tagModules.set(binding, {
          selector,
          // The same derivation the called tag's own module used to name its
          // exported class, so the import this warning tells the author to
          // write binds the name that module actually exports.
          className: exportNameFor(node.resolvedPath ?? specifierSource),
          specifier,
          resolvedPath: node.resolvedPath,
        });
      }
    }
  }

  /**
   * The selector the tag file at `path` exports, or undefined when it has
   * none. Read from core's parsed metadata for that file (its hoisted
   * `export` statements), through the same `selectorDeclarationOf` rule
   * `compileTagModule` applies to its own statements.
   */
  private readCalleeSelector(
    path: string,
    derived: string,
    loc: Position,
    filename: string,
  ): string | undefined {
    let metadata: TemplateMetadata;
    try {
      metadata = metadataForTemplate(this.ctx, {
        filename: path,
        source: readFileSync(path, "utf8"),
        mtimeMs: statSync(path).mtimeMs,
      });
    } catch (error) {
      if (isTranslateError(error)) throw error;
      throw new TranslateError(
        `cannot read \`${path}\` to find its \`export const selector\`: ${(error as Error).message}`,
        loc.line,
        loc.column,
        filename,
      );
    }
    let selector: string | undefined;
    for (const statement of metadata.hoistedExports ?? []) {
      const declaration = selectorDeclarationOf(statement);
      if (declaration?.kind === "literal") selector = declaration.value;
      else if (declaration) {
        warn(this.ctx, {
          message: unreadableSelectorMessage(derived),
          ...loc,
        } as MxWarning);
      }
    }
    return selector;
  }

  /**
   * Does the tag at `resolvedPath` project `name` as content?
   *
   * Answered from the callee's own source, by the same rule its module
   * emission uses — a zero-argument `input.<name>()` read. Not from core's
   * `tagMetadata.attributeTags`, which matches a bare `input.x` too
   * (`template-tag.ts`'s `inputMember`) and would therefore flag an ordinary
   * string input passed through as an attribute, which is legal.
   *
   * Deliberately a source-level scan rather than a nested compile: this runs
   * per attribute inside the emit walk, and compiling the callee here would
   * recurse into its own call sites. The read is cached per file.
   */
  private calleeProjects(
    resolvedPath: string | undefined,
    name: string,
  ): boolean {
    if (!resolvedPath) return false;
    let slots = this.calleeSlots.get(resolvedPath);
    if (!slots) {
      slots = new Set<string>();
      try {
        const source = readFileSync(resolvedPath, "utf8");
        // `${input.x()}` with no arguments, the slot spelling. A bare
        // `${input.x}` deliberately does not match.
        for (const match of source.matchAll(
          /\$\{\s*input\s*\.\s*([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\}/g,
        )) {
          slots.add(match[1] as string);
        }
      } catch {
        // Unreadable here means the call site cannot prove a misuse; the
        // callee's own compile reports anything genuinely wrong with it.
      }
      this.calleeSlots.set(resolvedPath, slots);
    }
    return slots.has(name);
  }

  /**
   * A once-per-file warning telling the author to add a symbol to their
   * component's `imports:`.
   *
   * Every such warning is stamped with `code: IMPORTS_ADVICE_CODE`, because
   * a consumer that *makes* that edit itself has to drop the advice, and
   * matching the prose to do it would silently start leaking (or swallowing)
   * the day anyone rewords a message. `.ng.mx` is that consumer — see
   * `ng-mx.ts`. `MxWarning` has no `code` field of its own (it is core's
   * type, owned by the tag-unit squad), so the marker rides as an extra
   * property; a reader that does not know it simply ignores it.
   */
  private warnOnce(
    key: string,
    message: string,
    loc: Position,
    code = IMPORTS_ADVICE_CODE,
  ): void {
    if (this.warnedOnce.has(key)) return;
    this.warnedOnce.add(key);
    warn(this.ctx, { message, ...loc, code } as MxWarning);
  }

  /** Nesting depth inside `<style>`/`<script>` (and `<html-style>`/`<html-script>`), whose text the literal-syntax lint skips. */
  private codeDepth = 0;
  /**
   * Depth of open `<svg>` elements. Marko's taglib resolves `<switch>` to
   * the SVG element regardless of context, but Angular's HTML template has
   * no `<switch>` outside `<svg>` — `element()` uses this to tell a real
   * SVG switch from an attempted control-flow one.
   */
  private svgDepth = 0;
  /** Names the `@let` that holds each primitive-normalized attribute expression. */
  private attrLetSerial = 0;

  /**
   * A name guaranteed not to collide with any identifier the compiled
   * template's own source text uses, *or* with any name this emitter has
   * already handed out — core exposes no gensym helper for hosts (only an
   * internal counter for custom-tag import injection, unrelated to this), so
   * this scans `ctx.source` once per file (a conservative token scan over
   * every run of identifier characters, not a real parse — a synthetic name
   * is never emitted as a JS identifier position, only as a loop variable,
   * so a false-positive collision from a string or comment containing the
   * token is the safe failure mode, not a false negative) and picks the
   * lowest numeric suffix of `base` absent from that set.
   *
   * Every call returns a *fresh* name and adds it to the same set — not
   * memoized per base — so two nested destructured `<for>`s (each calling
   * `gensym("mxRow")` independently) get `mxRow`/`mxRow1`, not the same name
   * twice; a name that only avoided the source text but not a sibling
   * loop's own synthetic row would let the inner loop's `@for` shadow the
   * outer one, an easy miss since Angular's block scoping makes the shadow
   * itself parse cleanly.
   */
  private gensym(base: string): string {
    if (!this.sourceIdentifiers) {
      this.sourceIdentifiers = new Set(
        this.ctx.source.match(/[A-Za-z_$][\w$]*/g) ?? [],
      );
    }
    let candidate = base;
    let n = 0;
    while (this.sourceIdentifiers.has(candidate)) {
      n += 1;
      candidate = `${base}${n}`;
    }
    this.sourceIdentifiers.add(candidate);
    return candidate;
  }

  text(node: Extract<IrNode, { kind: "Text" }>): void {
    // A `Text` node the tag-unit compiler substituted for a slot read carries
    // template markup, not author text, so it is emitted verbatim. Flagged
    // explicitly rather than relying on `escapeText` happening to leave `<`
    // alone: that function's job is Angular's own delimiters (`{`/`}`/`@`),
    // and a future addition of HTML escaping there would otherwise turn every
    // `<ng-content>` into visible `&lt;ng-content&gt;` text.
    if ((node as { rawTemplate?: boolean }).rawTemplate) {
      this.out.write(node.value);
      return;
    }
    if (this.codeDepth === 0) {
      for (const w of literalSyntaxWarnings(
        node.value,
        node.loc,
        this.ctx.source,
      )) {
        warn(this.ctx, w);
      }
    }
    // Text runs are deliberately unmapped: a diagnostic never points at
    // literal text, and mapping it would shadow the expressions inside the
    // same element with a coarser span.
    // Decision 141: Marko already normalized this retained space. Angular's
    // default whitespace pass would erase it again; `&ngsp;` keeps one actual
    // space without changing the consumer's global preserveWhitespaces policy.
    this.out.write(
      this.codeDepth === 0 && node.value === " "
        ? "&ngsp;"
        : escapeText(node.value),
    );
  }

  interpolation(node: Extract<IrNode, { kind: "Interpolation" }>): void {
    if (node.escaped) {
      this.out.write("{{ ");
      this.out.writeMapped(node.expr.code, node.expr.span);
      this.out.write(" }}");
    } else {
      warn(this.ctx, {
        message:
          "$!{…} has no exact Angular equivalent; emitted as [innerHTML] wrapped in a <span>, which Angular sanitizes. The wrapper is invalid inside <tbody>/<select>/<ul>, where only certain child elements are allowed — restructure those cases.",
        ...node.loc,
      } as MxWarning);
      this.out.write(`<span [innerHTML]="${esc(node.expr.code)}"></span>`);
    }
  }

  element(node: Extract<IrNode, { kind: "Element" }>): void {
    // Marko recognizes SVG <switch>, not a control-flow switch. Angular's
    // HTML template has no <switch> at all, so outside an `<svg>` context the
    // name can only be an attempted control-flow switch — reject it here,
    // before traversing descendants, as one MX error instead of Angular's
    // NG8001/NG8002 cascade. The same applies to a <switch> carrying a
    // default attribute (<switch=expr>, the attempted form even inside
    // `<svg>`) or `<case>` descendants through structural IR wrappers (the
    // control-flow tell inside `<svg>`,
    // which has no case element either). A real `<svg><switch>` of graphics
    // elements stays untouched, as do resolved custom tags — those lower to
    // `component()`, never to this method.
    if (
      node.name === "switch" &&
      (this.svgDepth === 0 ||
        node.attrs.some(
          (attr) =>
            attr.kind !== "spread" &&
            attr.nameSpan.sourceStart === attr.nameSpan.sourceEnd,
        ) ||
        hasCaseDescendant(node.children))
    ) {
      const loc = node.nameSpan
        ? {
            ...node.loc,
            ...lineColumnAt(this.ctx.source, node.nameSpan.sourceStart),
          }
        : node.loc;
      fail(unknownTagMessage(node.name), { loc });
    }
    // The tag name stays unmapped (its generated text is the source name
    // verbatim, but a diagnostic lands on the `<`, not the name), so the
    // whole start tag is anchored to the authored name instead.
    // Each primitive-normalized attribute binds its authored expression once.
    const lets = new Map<Attr, string>();
    for (const attr of node.attrs) {
      if (attr.kind !== "dynamic" || !primitiveForm(attr, node.name)) continue;
      const variable = `__mxAttr${this.attrLetSerial++}`;
      lets.set(attr, variable);
      this.out.write(`@let ${variable} = $any(`);
      this.out.writeMapped(esc(attr.value.code), attr.value.span);
      this.out.write(");");
    }
    const tagStart = this.out.length;
    this.out.write(`<${node.name}`);
    emitAttrs(
      this.out,
      node.attrs,
      (directive) => {
        this.warnOnce(directive, NGCLASS_NGSTYLE_WARNING[directive], node.loc);
      },
      true,
      // Also hands back the source text, which the handler's sub-mapping is
      // checked against.
      () => {
        this.warnOnce(
          "eventHelper",
          EVENT_HELPER_ADVICE,
          node.loc,
          EVENT_HELPER_ADVICE_CODE,
        );
        return this.ctx.source;
      },
      node.name,
      lets,
    );
    this.out.write(">");
    this.out.anchor(tagStart, this.out.length, node.nameSpan);
    if (node.void) return;
    // `<style>`/`<script>` bodies are code, not template text: braces and
    // `@` there are CSS/JS, so the literal-syntax lint skips them.
    const code =
      node.name === "style" ||
      node.name === "script" ||
      node.name === "html-style" ||
      node.name === "html-script";
    if (code) this.codeDepth++;
    if (node.name === "svg") this.svgDepth++;
    for (const child of node.children) this.emitNode(child);
    if (node.name === "svg") this.svgDepth--;
    if (code) this.codeDepth--;
    this.out.write(`</${node.name}>`);
  }

  component(node: Extract<IrNode, { kind: "Component" }>): void {
    switch (node.target.kind) {
      case "name":
        this.emitNamedComponent(node, node.target);
        return;
      case "define":
        this.emitDefineCall(node, node.target);
        return;
      case "dynamic":
        // Decision 116's routing lands here: a capitalized tag bound to a
        // value import that is not a `.mx` default import, or to a local
        // whose value the core could not statically prove (a `<for>` tag
        // param, a `lazy(...)` const). The callee is a runtime value, so
        // the call emits the same `ngComponentOutlet` an authored
        // `<${expr}/>` does — `valueImportBinding` has no use on this
        // host, which has no type surface to spend it on. An authored
        // `<${expr}/>` itself still arrives through `DelegatedTag` (the
        // `DYNAMIC_TAG` sentinel), never through this branch.
        this.emitDynamicComponent(
          node.target.expr.code,
          // The synthesized `Expr` carries no span (its `node` is null), so
          // the emitted expression maps to the tag name the author wrote.
          node.target.expr.span ?? node.nameSpan,
          node.attrs,
          node.content !== null || node.attrTagProps.length > 0,
          node.args,
          node,
        );
        return;
    }
  }

  private emitNamedComponent(
    node: Extract<IrNode, { kind: "Component" }>,
    target: Extract<ComponentTarget, { kind: "name" }>,
  ): void {
    if (node.content?.hasParams) {
      // `authoredName`: a discovered tag's `target.name` is the gensym'd
      // binding (`$mx_Card1`), which appears nowhere the author wrote —
      // the message names the tag they typed.
      fail(
        `\`<${node.authoredName ?? target.name}|…|>\` passes parameters to its content, which Angular's content projection cannot express. Declare the block as a \`<define>\` and pass it as an input the component renders with \`ngTemplateOutlet\`.`,
        node,
      );
    }
    // A tag bound by an import (discovered or explicit) resolves to the file
    // it came from; anything else reaching here is a *bound* local with no
    // tag module behind it (a `<const>`/param the core proved callable),
    // and the bare-name rule is all this host can apply. An *unbound*
    // capitalized name never reaches this method at all: decision 114's
    // core guard rejects it first.
    const tagModule = this.tagModules.get(target.name);
    const selector =
      tagModule?.selector ?? `${this.selectorPrefix}${kebabCase(target.name)}`;
    // Passing a value for a name the callee projects as content is an error,
    // not a binding: `<ng-content select="[header]">` places nodes the caller
    // *nested*, and there is no way to hand it a value from an attribute. The
    // emitted `[header]="…"` would bind an input the component never declares
    // and render nothing — the same silent blank an unprojected slot gives.
    if (tagModule) {
      for (const attr of node.attrs) {
        if (attr.kind === "spread") continue;
        if (this.calleeProjects(tagModule.resolvedPath, attr.name)) {
          // Named by the tag's *file*, not `target.name`: a discovered tag's
          // binding is a gensym (`$mx_Badge1`) the author never wrote and
          // cannot find in their source.
          const tagName = tagModule.resolvedPath
            ? tagBasename(tagModule.resolvedPath)
            : target.name;
          fail(
            `\`${attr.name}\` is content on \`<${tagName}>\`, which projects it with \`<ng-content select="[${attr.name}]">\` — Angular cannot fill a projection from an attribute. Pass it as a nested \`<@${attr.name}>\` block instead.`,
            node,
          );
        }
      }
    }
    if (!this.usedTags.has(target.name)) {
      this.usedTags.set(target.name, node.loc);
    }
    // The selector is derived from the tag name (`UserCard` becomes
    // `mx-user-card`), so it maps whole-to-whole back to the name the author
    // wrote — the spellings differ, which is exactly what the mapping is for.
    const tagStart = this.out.length;
    this.out.write("<");
    // A resolved tag module's selector is exact: its own `export const
    // selector`, else prefix + kebab(file basename). Either way it is a fact
    // the emitter holds, so it rides as `deriveContext` for an exact check.
    if (tagModule) {
      this.out.writeMapped(
        selector,
        node.nameSpan,
        "resolved-selector",
        tagModule.selector,
      );
    } else {
      this.out.writeMapped(
        selector,
        node.nameSpan,
        "selector",
        this.selectorPrefix,
      );
    }
    emitAttrs(this.out, node.attrs, (directive) => {
      this.warnOnce(directive, NGCLASS_NGSTYLE_WARNING[directive], node.loc);
    });
    this.out.write(">");
    this.out.anchor(tagStart, this.out.length, node.nameSpan);
    for (const prop of node.attrTagProps) {
      this.validateAttributeTagProp(prop, node);
      this.emitAttributeTagNodes(prop.source);
    }
    if (node.content) {
      for (const child of node.content.children) this.emitNode(child);
    }
    this.out.write(`</${selector}>`);
  }

  private validateAttributeTagProp(
    prop: AttrTagProp,
    owner: { loc: Position },
  ): void {
    if (prop.cardinality === "array") {
      const tags: AttributeTag[] = [];
      let loopTag: AttributeTag | undefined;
      const collect = (nodes: AttributeTagNode[], inLoop = false): void => {
        for (const node of nodes) {
          if (node.kind === "AttributeTag") {
            tags.push(node.tag);
            if (inLoop && !loopTag) loopTag = node.tag;
          } else if (node.kind === "AttributeTagFor") {
            collect(node.nodes, true);
          } else {
            for (const branch of node.branches) collect(branch.nodes, inLoop);
          }
        }
      };
      collect(prop.source);
      fail(
        `array attribute tag \`<@${prop.name}>\` isn't supported by @mxlang/angular: a projection is keyed by name`,
        loopTag ?? tags[1] ?? tags[0] ?? owner,
      );
    }
    this.visitAttributeTags(prop.source, (tag) => {
      if (tag.attrs.length > 0) {
        fail(
          `attributes on \`<@${tag.name}>\` aren't supported by @mxlang/angular: a projection carries nodes, not data`,
          tag.attrs[0] as Attr,
        );
      }
      if (tag.block.hasParams) {
        fail(
          `params on \`<@${tag.name}>\` aren't supported by @mxlang/angular: content projection cannot pass values back into projected nodes`,
          tag,
        );
      }
      if (tag.attrTagProps.length > 0) {
        fail(
          `nested attribute tags inside \`<@${tag.name}>\` aren't supported by @mxlang/angular: a projection has no nested data shape`,
          tag.attributeTagTree[0] ?? tag,
        );
      }
      if (!tag.hasBody) {
        fail(
          `<@${tag.name}/> has no body; @mxlang/angular projects attribute-tag bodies by name`,
          tag,
        );
      }
    });
  }

  private visitAttributeTags(
    nodes: AttributeTagNode[],
    visit: (tag: AttributeTag) => void,
  ): void {
    for (const node of nodes) {
      if (node.kind === "AttributeTag") {
        visit(node.tag);
      } else if (node.kind === "AttributeTagFor") {
        this.visitAttributeTags(node.nodes, visit);
      } else {
        for (const branch of node.branches) {
          this.visitAttributeTags(branch.nodes, visit);
        }
      }
    }
  }

  private emitAttributeTag(tag: AttributeTag): void {
    this.out.write(`<ng-container ngProjectAs="[${tag.name}]">`);
    for (const child of tag.block.children) this.emitNode(child);
    this.out.write("</ng-container>");
  }

  private emitAttributeTagNodes(nodes: AttributeTagNode[]): void {
    for (const node of nodes) {
      if (node.kind === "AttributeTag") {
        this.emitAttributeTag(node.tag);
        continue;
      }
      if (node.kind === "AttributeTagFor") {
        fail(
          "attribute tags inside `<for>` aren't supported by @mxlang/angular: repeated projections cannot share one name",
          node,
        );
      }
      node.branches.forEach((branch, index) => {
        if (branch.test) {
          this.out.write(`${index === 0 ? "@if" : " @else if"} (`);
          this.out.writeMapped(branch.test.code, branch.test.span);
          this.out.write(") { ");
        } else {
          this.out.write(" @else { ");
        }
        this.emitAttributeTagNodes(branch.nodes);
        this.out.write(" }");
      });
    }
  }

  private emitDefineCall(
    node: Extract<IrNode, { kind: "Component" }>,
    target: Extract<ComponentTarget, { kind: "define" }>,
  ): void {
    if (node.attrTagProps.length > 0) {
      fail(
        `attribute tags on \`<${target.name}>\` aren't supported by @mxlang/angular: a \`<define>\` call is projected with \`ngTemplateOutletContext\`, a positional argument object, not content projection — call it with \`<${target.name}(...)/>\` instead`,
        node,
      );
    }
    if (node.args.length !== target.params.length) {
      fail(
        `\`<${target.name}>\` expects ${target.params.length} argument(s), got ${node.args.length}`,
        node,
      );
    }
    // The context object is built into the writer piece by piece so each
    // argument expression keeps its own mapping. `esc()` is applied per
    // fragment rather than to the joined string: it escapes `&` and `"`
    // independently of position, so escaping the parts and concatenating
    // gives the same bytes as escaping the whole.
    this.out.write(`<ng-container [ngTemplateOutlet]="${target.name}" `);
    this.out.write('[ngTemplateOutletContext]="');
    if (target.params.length === 0) {
      this.out.write(esc("{}"));
    } else {
      this.out.write(esc("{ "));
      target.params.forEach((param, i) => {
        if (i > 0) this.out.write(esc(", "));
        this.out.write(esc(i === 0 ? "$implicit: " : `${param}: `));
        const arg = node.args[i];
        if (arg) this.out.writeMapped(esc(arg.code), arg.span);
      });
      this.out.write(esc(" }"));
    }
    this.out.write('"></ng-container>');
  }

  private emitDynamicComponent(
    exprCode: string,
    exprSpan: SourceSpan | null | undefined,
    attrs: Attr[],
    hasContent: boolean,
    args: Expr[],
    node: { loc: Position },
  ): void {
    if (hasContent) {
      fail(
        "`<${…}>` with content isn't supported by @mxlang/angular: `ngComponentOutlet` projects content only through `ngComponentOutletContent`, which takes prepared nodes rather than a template body. Use a static component tag, or render the content into a `<define>` and pass it as an input.",
        node,
      );
    }
    if (args.length > 0) {
      fail(
        "`<${…}(…)>` tag arguments aren't supported by @mxlang/angular: `ngComponentOutlet` binds a component's `@Input()`s, not positional constructor arguments. Pass the values as attributes instead.",
        node,
      );
    }
    this.warnOnce(
      "ngComponentOutlet",
      "this template uses [ngComponentOutlet]; add NgComponentOutlet to the component's imports.",
      node.loc,
    );
    // Rejected up front, before anything is written: `fail` throws, and a
    // half-written element would otherwise be left in the output. The
    // narrowed list is what the emit loop below walks, so the two cannot
    // disagree about which kinds are allowed.
    const inputs: Array<
      Extract<Attr, { kind: "dynamic" } | { kind: "static" }>
    > = [];
    for (const attr of attrs) {
      if (attr.kind !== "dynamic" && attr.kind !== "static") {
        fail(
          `attribute kind \`${attr.kind}\` cannot be passed to a dynamic component outlet`,
          attr,
        );
      }
      inputs.push(attr);
    }
    this.out.write('<ng-container [ngComponentOutlet]="');
    this.out.writeMapped(esc(exprCode), exprSpan);
    this.out.write('"');
    if (inputs.length > 0) {
      // Written piece by piece so each input's name and value keeps its own
      // mapping, the same shape `emitDefineCall` uses for the outlet
      // context. `esc()` escapes `&` and `"` independently of position, so
      // escaping the parts and concatenating gives the same bytes as
      // escaping the whole.
      this.out.write(' [ngComponentOutletInputs]="');
      this.out.write(esc("{ "));
      inputs.forEach((attr, i) => {
        if (i > 0) this.out.write(esc(", "));
        this.out.writeMapped(esc(attr.name), attr.nameSpan);
        this.out.write(esc(": "));
        if (attr.kind === "dynamic") {
          this.out.writeMapped(esc(attr.value.code), attr.value.span);
        } else {
          // JSON.stringify for the JS-literal layer (a `"` or `\` in the
          // attribute value must be escaped as JS, e.g. `\"`), then `esc()`
          // for the surrounding HTML attribute layer — two passes for two
          // nesting layers. Building this with a plain `"${attr.value}"`
          // corrupted the output on a value containing `"`. The literal's
          // text is not the author's own bytes (it gains quotes), so it is
          // written unmapped; its name above carries the position.
          this.out.write(esc(JSON.stringify(attr.value)));
        }
      });
      this.out.write(esc(" }"));
      this.out.write('"');
    }
    this.out.write("></ng-container>");
  }

  ifChain(node: Extract<IrNode, { kind: "IfChain" }>): void {
    node.branches.forEach((branch, i) => {
      const close = i === 0 ? "" : "} ";
      if (branch.condition === null) {
        this.out.write(`${close}@else { `);
      } else if (i === 0) {
        this.out.write("@if (");
        this.out.writeMapped(branch.condition.code, branch.condition.span);
        this.out.write(") { ");
      } else {
        this.out.write(`${close}@else if (`);
        this.out.writeMapped(branch.condition.code, branch.condition.span);
        this.out.write(") { ");
      }
      for (const child of branch.children) this.emitNode(child);
      this.out.write(" ");
    });
    this.out.write("}");
  }

  /**
   * A destructured tag param (`{id, name}`) needs a row identifier of its
   * own, since Angular's `@for` loop variable must be a single identifier
   * (probed: a destructure there fails "must match the pattern `<identifier>
   * of <expression>`"). Detected off the Babel param node itself
   * (`For.paramNodes`, `ir.ts`), not a regex over the printed text, so a
   * renamed or nested destructure — which has no obvious single-line `@let`
   * expansion — is told apart from the plain, non-renamed case precisely.
   */
  private loopVar(
    paramNode: {
      type: string;
      name?: string;
      loc?: { start?: Position };
      properties?: Array<{
        type: string;
        computed: boolean;
        shorthand: boolean;
        key: { type: string; name?: string };
        value: { type: string; name?: string };
      }>;
    },
    fallbackNode: { loc: Position },
  ): { row: string; destructure: string[] } {
    if (paramNode.type === "Identifier" && paramNode.name) {
      return { row: paramNode.name, destructure: [] };
    }
    if (paramNode.type === "ObjectPattern") {
      const fields: string[] = [];
      for (const prop of paramNode.properties ?? []) {
        if (
          prop.type === "ObjectProperty" &&
          !prop.computed &&
          prop.shorthand &&
          prop.key.type === "Identifier" &&
          prop.value.type === "Identifier" &&
          prop.key.name
        ) {
          fields.push(prop.key.name);
          continue;
        }
        rawFail(
          "a `<for>` param can be a plain name or a non-renamed object destructure (`{a, b}`) on Angular, because `@for`'s loop variable is a single identifier. A renamed or nested field has no single-line `@let` expansion — bind the row to a name and read its fields in the body.",
          paramNode,
        );
      }
      return { row: this.gensym("__mxRow"), destructure: fields };
    }
    fail(
      "a `<for>` param can be a plain name or a non-renamed object destructure (`{a, b}`) on Angular, because `@for`'s loop variable is a single identifier. Bind the row to a name and read its fields in the body.",
      fallbackNode,
    );
  }

  /** A `<for>` alias param (index, second `in=` binding) must be a plain identifier. */
  private aliasName(
    paramNode:
      | { type: string; name?: string; loc?: { start?: Position } }
      | undefined,
    fallback: string,
  ): string {
    if (!paramNode) return fallback;
    if (paramNode.type === "Identifier" && paramNode.name)
      return paramNode.name;
    rawFail(
      "a `<for>`'s second (alias) param must be a plain name on Angular, because `@for`'s `let` binding takes a single identifier. Destructure it in the body instead.",
      paramNode,
    );
  }

  forLoop(node: Extract<IrNode, { kind: "For" }>): void {
    const source = node.source;
    if (source.kind === "of") {
      const firstNode = node.paramNodes[0];
      if (!firstNode) fail("a `<for of=>` needs at least one param", node);
      const { row, destructure } = this.loopVar(firstNode, node);
      let track = deriveTrack(node.key, row, node);
      if (track === null) {
        this.firstLoc ??= node.loc;
        this.tracklessForCount += 1;
        track = "$index";
      }
      const second = this.aliasName(node.paramNodes[1], "");
      const aliasLets = second ? `; let ${second} = $index` : "";
      // `track` is derived text (`by="id"` becomes `row.id`), so it maps to
      // the whole `by=` expression; with `by=` omitted it is the synthesized
      // `$index` and maps to nothing.
      this.out.write(`@for (${row} of `);
      this.out.writeMapped(source.list.code, source.list.span);
      this.out.write("; track ");
      this.out.writeMapped(track, node.key?.span, "track", row);
      this.out.write(`${aliasLets}) { `);
      for (const field of destructure) {
        this.out.write(`@let ${field} = ${row}.${field}; `);
      }
      for (const child of node.children) this.emitNode(child);
      this.out.write(" }");
      return;
    }
    if (source.kind === "in") {
      this.warnOnce(
        "keyvalue-pipe",
        "this template uses `<for in=>`, emitted with Angular's `keyvalue` pipe; add `KeyValuePipe` to the component's imports.",
        node.loc,
      );
      const k = this.aliasName(node.paramNodes[0], "$key");
      const v = this.aliasName(node.paramNodes[1], "$value");
      const entry = this.gensym("__mxEntry");
      this.out.write(`@for (${entry} of (`);
      this.out.writeMapped(source.object.code, source.object.span);
      this.out.write(
        ` | keyvalue: null); track ${entry}.key) { @let ${k} = ${entry}.key; @let ${v} = ${entry}.value; `,
      );
      for (const child of node.children) this.emitNode(child);
      this.out.write(" }");
      return;
    }
    // range
    const values = bakeRange(source, node);
    const rowNode = node.paramNodes[0];
    const row = this.aliasName(rowNode, "$item");
    this.out.write(`@for (${row} of [${values.join(", ")}]; track $index) { `);
    for (const child of node.children) this.emitNode(child);
    this.out.write(" }");
  }

  define(node: Extract<IrNode, { kind: "Define" }>): void {
    // A bare `let-x` binds `$implicit`, so emitting one per param gives every
    // param the *first* outlet argument — `${v}` reads the key, silently, with
    // `ng build` green because a `let-` variable is implicitly `any`. The
    // outlet context is `{ $implicit: first, rest: rest }` (see
    // `ngTemplateOutlet`'s context below), so only the first param rides
    // `$implicit`; every later one names its own context key.
    this.out.write(`<ng-template #`);
    this.out.writeMapped(node.name, node.nameSpan);
    node.params.forEach((param, i) => {
      this.out.write(" ");
      // The `let-` prefix is generated, so the whole `let-x` token maps
      // whole-to-whole onto the param the author wrote.
      this.out.writeMapped(
        `let-${param}`,
        node.paramSpans?.[i],
        "define-param",
      );
      if (i > 0) this.out.write(`="${param}"`);
    });
    this.out.write("> ");
    for (const child of node.children) this.emitNode(child);
    this.out.write(" </ng-template>");
  }

  constant(node: Extract<IrNode, { kind: "Const" }>): void {
    this.out.write(`@let ${node.name} = `);
    this.out.writeMapped(node.init.code, node.init.span);
    this.out.write(";");
  }

  hoisted(node: Extract<IrNode, { kind: "Hoisted" }>): void {
    fail(`a \`<Hoisted>\` ${MODULE_LEVEL_MESSAGE}`, node);
  }

  delegatedTag(node: Extract<IrNode, { kind: "DelegatedTag" }>): void {
    const tag = node.tag;
    const data = tag.data as TryData | HtmlCommentData | DynamicComponentData;
    if (data.kind === "try") {
      fail(TRY_MESSAGE, node);
    }
    if (data.kind === "dynamic-component") {
      // core PR #103 (main 50877ea8, decision "bare placeholder is a dynamic
      // tag"): a bare `${expr}` placeholder and `<${expr}/>` are the same
      // construct on every host now, not a text/component split this host
      // used to draw for itself. Both shapes lower through this branch and
      // both emit `ngComponentOutlet`.
      this.emitDynamicComponent(
        data.expr.code,
        data.expr.span,
        tag.attrs,
        tag.children.length > 0 || tag.attrTagProps.length > 0,
        tag.args ?? [],
        node,
      );
      return;
    }
    // html-comment: text-only. `@mxlang/html`'s own emitter accepts an
    // `Interpolation` child too (`packages/targets/html/src/emitter.ts:604-606`)
    // because that host evaluates it server-side into static comment text —
    // Angular has no such evaluation inside a comment (probed: `<!-- {{ x
    // }} -->` renders the literal text `{{ x }}`, never `x`'s value), so an
    // `Interpolation` child is a hard error on this host rather than the
    // silently-wrong render the html precedent would produce here.
    let text = "";
    for (const child of tag.children) {
      if (child.kind === "Interpolation") {
        fail(
          "`<html-comment>` cannot contain `${…}` on Angular: comments are not interpolated; move the value out of the comment.",
          child,
        );
      }
      if (child.kind !== "Text") {
        fail(
          "`<html-comment>` only accepts text content; move the tag out of the comment body.",
          child,
        );
      }
      text += child.value;
    }
    checkCommentText(text, node);
    this.out.write(`<!-- ${text} -->`);
  }

  documentType(node: Extract<IrNode, { kind: "DocumentType" }>): void {
    warn(this.ctx, {
      message:
        "`<!doctype>` parses in an Angular template, but a component template is a fragment.",
      ...node.loc,
    } as MxWarning);
    this.out.write(`<!${node.value}>`);
  }

  comment(node: Extract<IrNode, { kind: "Comment" }>): void {
    if (!node.html) return;
    checkCommentText(node.value, node);
    this.out.write(`<!--${node.value}-->`);
  }

  done(): string {
    if (this.tracklessForCount > 0 && this.firstLoc) {
      warn(this.ctx, {
        message: `this template has ${this.tracklessForCount} \`<for>\` loop(s) with no \`by=\`; Angular requires a \`track\`, so MX emitted \`track $index\`. Reordering such a list re-renders instead of moving DOM nodes — add \`by=(p => p.id)\` to track by identity.`,
        ...this.firstLoc,
      } as MxWarning);
    }
    if (this.usedTags.size > 0) {
      const names = [...this.usedTags.keys()];
      const loc = this.usedTags.values().next().value as Position;
      // The author never sees the gensym'd binding a discovered tag lowers
      // to, so the warning names the class its emitted module exports and the
      // real relative path of that module — the two things they must paste.
      const refs = names.map(
        (name) =>
          this.tagModules.get(name) ?? {
            className: name,
            specifier: `./tags/${kebabCase(name)}`,
          },
      );
      const lines = refs
        .map(
          (ref) =>
            `\`import ${ref.className} from "${ref.specifier}";\` and \`imports: [${ref.className}]\``,
        )
        .join(", ");
      warn(this.ctx, {
        message: `this template calls ${names.length} MX tag(s): ${refs.map((r) => `\`${r.className}\``).join(", ")}. In step 1, MX cannot edit your component's TypeScript. Add to ${this.tsFilename}: ${lines}.`,
        ...loc,
        // Import advice like every `warnOnce` one, and stamped the same way:
        // a `.ng.mx` writes these imports itself, so it drops them by this
        // code. Left unstamped, it told those authors to add an import MX
        // had already written — naming a file that does not exist.
        code: IMPORTS_ADVICE_CODE,
      } as MxWarning);
    }
    return this.out.code;
  }

  /**
   * The mappings recorded during the walk, generated-relative to `done()`'s
   * own return value.
   *
   * Kept beside `done()` rather than folded into it because `Emitter<Out>`'s
   * single return value is the template text every caller already consumes;
   * a caller that wants positions asks for them.
   */
  mappings(): AngularMapping[] {
    return [...this.out.mappings];
  }

  /** The node anchors recorded during the walk; see {@link NodeAnchor}. */
  anchors(): NodeAnchor[] {
    return [...this.out.anchors];
  }

  /**
   * Every MX tag this template called, in source order, as the call site must
   * reference it: the class its emitted module exports and that module's
   * relative path.
   *
   * Not the binding the IR carried — a discovered tag's is a gensym
   * (`$mx_Icon1`) that appears nowhere the author can see.
   */
  usedTagRefs(): UsedTag[] {
    return [...this.usedTags.keys()].map((binding) => {
      const ref = this.tagModules.get(binding);
      // A discovered tag's binding is a gensym, so its written name is
      // recovered from the file it resolved to; an unresolved name is one the
      // author wrote literally and is already its own name.
      const name = ref?.resolvedPath ? tagBasename(ref.resolvedPath) : binding;
      return {
        name,
        className: ref?.className ?? binding,
        specifier: ref?.specifier ?? `./tags/${kebabCase(binding)}`,
      };
    });
  }

  emitNode(node: IrNode): void {
    switch (node.kind) {
      case "Text":
        this.text(node);
        return;
      case "Interpolation":
        this.interpolation(node);
        return;
      case "Element":
        this.element(node);
        return;
      case "Component":
        this.component(node);
        return;
      case "IfChain":
        this.ifChain(node);
        return;
      case "For":
        this.forLoop(node);
        return;
      case "Define":
        this.define(node);
        return;
      case "Const":
        this.constant(node);
        return;
      case "Hoisted":
        this.hoisted(node);
        return;
      case "DelegatedTag":
        this.delegatedTag(node);
        return;
      case "DocumentType":
        this.documentType(node);
        return;
      case "Comment":
        this.comment(node);
        return;
      case "Import":
      case "Static":
      case "Export":
      case "InputInterface":
        fail(`a \`<${node.kind}>\` ${MODULE_LEVEL_MESSAGE}`, node);
    }
  }
}

/**
 * Emits an Angular template string from the resolved IR.
 *
 * `usedTagsOut`, when given, is filled with the names of every MX tag the
 * template called (source order) — the same list `done()`'s own step-1
 * import warning describes in prose, exposed structurally for a caller
 * (`mx-angular build`'s header second line) that needs the names without
 * parsing a warning message.
 */
export function emitTemplate(
  ir: Ir,
  ctx: Ctx,
  filename: string,
  usedTagsOut?: UsedTag[],
  selectorPrefix: string = TAG_SELECTOR_PREFIX,
  /**
   * True when the caller owns a real module around this template (the
   * tag-unit compiler), so an authored import of a *tag module* is a
   * component reference it will emit rather than a module-level error.
   * A page template has no module scope, so it leaves this false.
   */
  ownsModule = false,
  /**
   * Filled, when given, with the mappings from the emitted template back to
   * the `.mx` source — generated offsets relative to the returned string.
   *
   * An out-parameter for the same reason `usedTagsOut` is one: `emitIr`'s
   * core signature returns the module text alone, so a second result has no
   * return channel of its own.
   */
  mappingsOut?: AngularMapping[],
  /**
   * Filled, when given, with the node anchors (start tags and attributes),
   * generated offsets relative to the returned string.
   */
  anchorsOut?: NodeAnchor[],
): string {
  // A *synthesized* import is not a module-level statement the author wrote:
  // the core minted it for a discovered tag the template calls, and there is
  // no other place it could live (`template-tag.ts`'s `bindingForTemplate`).
  // Rejecting it would make calling a discovered tag an error on this host
  // while every other host emits it, so it is resolved to a component
  // reference instead — the emitter reads these to derive each selector, and
  // the once-per-file warning names the `imports:` entry the author must add.
  //
  // An import the author wrote by hand still has a real TypeScript module to
  // go in, so it stays the module-level error, as do `static`/`export` and
  // `export interface Input`.
  const moduleLevel = [
    ...ir.imports.filter(
      (node) =>
        !node.synthesized &&
        !(ownsModule && isTagModuleImport(node.code, node.resolvedPath)),
    ),
    ...ir.hoisted,
    ...(ir.inputInterface ? [ir.inputInterface] : []),
  ];
  for (const node of moduleLevel) {
    fail(`a \`<${node.kind}>\` ${MODULE_LEVEL_MESSAGE}`, node);
  }

  const emitter = new AngularEmitter(ctx, filename, ir.imports, selectorPrefix);
  for (const node of ir.body) emitter.emitNode(node);
  const code = emitter.done();
  if (usedTagsOut) usedTagsOut.push(...emitter.usedTagRefs());
  if (mappingsOut) mappingsOut.push(...emitter.mappings());
  if (anchorsOut) anchorsOut.push(...emitter.anchors());
  return code;
}

export { TranslateError };
