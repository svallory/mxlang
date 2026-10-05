/**
 * The MX → Preact emitter, over `@mxlang/core`'s IR (decisions 79, 81, 82).
 *
 * The fourth emitter on the shared IR, and the one whose target has no
 * control-flow components at all: where Solid has `<Show>`/`<For>` and Astro
 * has its own template syntax, Preact has plain JSX plus JavaScript. So every
 * structural kind lowers to an *expression* — a ternary chain for `<if>`, a
 * `.map` call for `<for>` — exactly as a Preact author would write by hand.
 *
 * Nothing here walks a Marko node: `lower()` already decided every
 * host-specific question through `preactDeclarations` below, and what arrives
 * is IR kinds, printed expressions and positions.
 *
 * ## Why the dialect is a parameter
 *
 * React's lowering is this lowering. The two differ in a handful of *names*
 * (`preact` vs `react` as the JSX import source, `class` vs `className`, which
 * module the error boundary comes from), so those live in `JsxDialect` and a React
 * package can reuse this file rather than fork it. See `dialect.ts` for what
 * belongs in that object and what does not.
 */

import {
  type Attr,
  type AttributeTag,
  type AttributeTagNode,
  type AttrTagProp,
  concatMapped,
  contractDefaultTag,
  drive,
  type Emitter,
  type Expr,
  type ForHead,
  type HostDeclarations,
  type Ir,
  type IrNode,
  type MappedCode,
  mapped,
  mappedExpr,
  type Position,
  TranslateError,
  unresolvedCustomTagMessage,
} from "@mxlang/core";
import { decodeHTML } from "entities";
import { type JsxDialect, preactDialect } from "./dialect.ts";

/**
 * The Marko tags this host refuses, each naming what to write instead.
 *
 * Same shape as `@mxlang/solid`'s table, and for the same reason: these are
 * Marko's *own* reactivity, and this target has its own. Decision 65's rule
 * holds — the message says what this target cannot express and where the
 * equivalent lives, never "not implemented".
 */
function statefulErrors(
  dialectName: string,
  region: boolean,
): HostDeclarations["tags"] {
  // A region (`.react.mx`) rejects `<const>`, so the whole-file hint
  // `<const/x=useState(0)/>` would recommend something the region refuses.
  // There the hook lives in the component around the region, and only that is
  // named.
  const inComponent = " in the surrounding component";
  return {
    let: {
      kind: "error",
      reason: region
        ? `\`<let>\` is Marko reactive state; use ${dialectName}'s \`useState\`${inComponent}`
        : `\`<let>\` is Marko reactive state; use ${dialectName}'s \`useState\` via \`<const/x=useState(0)/>\` or in the surrounding module`,
    },
    effect: {
      kind: "error",
      reason: region
        ? `\`<effect>\` is a Marko reactive effect; use ${dialectName}'s \`useEffect\`${inComponent}`
        : `\`<effect>\` is a Marko reactive effect; use ${dialectName}'s \`useEffect\` via \`<const/_=useEffect(...)/>\` or in the surrounding module`,
    },
    lifecycle: {
      kind: "error",
      reason: region
        ? `\`<lifecycle>\` is a Marko lifecycle hook; use ${dialectName}'s \`useEffect\`/\`useLayoutEffect\`${inComponent}`
        : `\`<lifecycle>\` is a Marko lifecycle hook; use ${dialectName}'s \`useEffect\`/\`useLayoutEffect\` instead`,
    },
    script: {
      kind: "error",
      reason:
        "`<script>` is a Marko client-runtime tag; write client code in a module the component imports",
    },
    client: {
      kind: "error",
      reason: `a \`client\` block is Marko's client-runtime split; a ${dialectName} component is already client code`,
    },
    id: {
      kind: "error",
      reason: `\`<id>\` allocates an identifier for Marko's reactive runtime; use ${dialectName}'s \`useId\`${region ? inComponent : ""}`,
    },
    await: {
      kind: "error",
      reason:
        "`<await>` needs Marko's suspense; use `<try>` with a `<@placeholder>`, whose body may suspend",
    },
    // `<return>` is **not** an error here. It was, on the grounds that "a
    // component returns its own markup" — true while a tag template was
    // expanded into its caller, but under the unit model (decision 95) the
    // tag is its own module and the caller invokes it, so it has a caller to
    // return to. A returning unit's component returns `{ value, output }`
    // and the call site unwraps it; the core owns the grammar.
    else: { kind: "error", reason: "`<else>` must follow an `<if>`" },
    "else-if": { kind: "error", reason: "`<else-if>` must follow an `<if>`" },
  };
}

/** What `resolveDelegatedTag` records for a claimed tag. */
type DelegatedTagData = { kind: "try" };

function fail(message: string, node: { loc: Position }): never {
  throw new TranslateError(message, node.loc.line, node.loc.column);
}

function rawFail(message: string, node: { loc?: { start?: Position } }): never {
  const { line, column } = node.loc?.start ?? { line: 0, column: 0 };
  throw new TranslateError(message, line, column);
}

/**
 * The taglibs Marko loads for real HTML, SVG and MathML elements.
 *
 * Anything they define is an element; anything else Marko's lookup resolves
 * is a component. Same set, and same rule, as `@mxlang/html` uses.
 */
const ELEMENT_TAGLIBS = new Set(["marko-html", "marko-svg", "marko-math"]);

/**
 * A JSX-safe name for a component whose tag name JSX would read as an element.
 *
 * JSX decides element-vs-component by *case*: `<badge/>` is the DOM element
 * "badge" no matter what `badge` is bound to in scope. Marko decides by
 * binding, so a `tags/`-discovered `badge.marko` is a component called
 * `<badge/>` — and emitted verbatim it rendered a literal `<badge>` element
 * with the props as attributes, which is a silent wrong render rather than an
 * error. The emitted module imports or aliases the component under this name
 * instead.
 */
export function componentAlias(name: string): string {
  return /^[a-z]/.test(name) || name.includes("-")
    ? `__mx${name.replace(/(?:^|-)([a-z])/g, (_m, ch: string) => ch.toUpperCase())}`
    : name;
}

function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

/** Resolve-time questions for a Preact/React JSX dialect. */
const ATTRIBUTE_VALUE_EXPRESSION = "__mxAttrValue";
const ATTRIBUTE_SPREAD_EXPRESSION = "__mxAttrSpread";

/** The JSX hosts' built-in `defaultTag`: their descriptors' field and the ladder's last rung. */
export const DEFAULT_TAG = "div";

/** Options for {@link createJsxDeclarations}. */
export interface JsxDeclarationsOptions {
  /**
   * Declarations for an MX region inside a `.<segment>.mx` TypeScript module
   * rather than a whole-file `.mx`: the reactive-tag errors and the scriptlet
   * fix point at the hook in the surrounding component, never at `<const>`,
   * which a region rejects.
   */
  region?: boolean;
}

export function createJsxDeclarations(
  dialectName: string,
  options: JsxDeclarationsOptions = {},
): HostDeclarations {
  const region = options.region === true;
  const declarationName =
    dialectName === "Preact"
      ? "@mxlang/preact"
      : dialectName === "React"
        ? "@mxlang/react"
        : dialectName === "Hono"
          ? "@mxlang/hono"
          : dialectName;
  return {
    name: declarationName,
    attrTags: 2,
    tags: statefulErrors(dialectName, region),
    // The ladder (decision 145): the parent's contract `defaultTag`, then
    // `mx.<target>.defaultTag`, then the target's built-in (the registry folds
    // the host override into `configured`). This host permits the contract rung:
    // it sets no `allowContractDefaultTag: false`.
    resolveDefaultTag: (_node, parents, context) =>
      contractDefaultTag(parents, context, [DEFAULT_TAG]) ??
      context.configured ??
      DEFAULT_TAG,
    // `<let>` is not this host's state model. Never turn a mutable JS
    // declaration into an immutable `<const>` just to offer a fix.
    scriptletReplacement: (name, keyword) =>
      keyword !== "const"
        ? ""
        : region
          ? "declare it in the surrounding component"
          : `declare a value with \`<const/${name}=…/>\``,
    // Element-vs-component follows Marko's own rule — what the taglib lookup
    // and the template's own bindings resolve the name to — not JSX's casing
    // rule, so a `tags/`-discovered `<badge/>` is the component it is in Marko.
    // The casing difference is handled at emit time by `componentAlias`.
    isElement: (name, ctx) => {
      const taglibId = ctx.lookup?.getTag(name)?.taglibId;
      if (taglibId !== undefined) return ELEMENT_TAGLIBS.has(taglibId);
      return !isComponentName(name);
    },
    // Resolves a capitalized tag only when it genuinely resolves (decision
    // 114): a scope binding (checked here for a direct caller of this
    // function; `lower.ts`'s own `fileLocalBinding` already covers the
    // whole-file `.mx` precedence path before `isComponent` is ever asked)
    // or a taglib entry. A name matching neither used to fall through to a
    // bare `isComponentName` (casing-only) check, so `<TotallyUndefined/>`
    // — no import, binding, or taglib entry — silently emitted a JSX
    // reference to nothing: a runtime `ReferenceError` on this target
    // rather than the Marko-parity compile error `rejectUnknownTag` (below)
    // now reports through `lower.ts`'s unresolved-tag guard.
    isComponent: (name, ctx) => {
      if (ctx.defines?.has(name) || ctx.imports?.has(name)) return true;
      const taglibId = ctx.lookup?.getTag(name)?.taglibId;
      if (taglibId !== undefined) return !ELEMENT_TAGLIBS.has(taglibId);
      return false;
    },
    rejectUnknownTag(name, node, ctx) {
      rawFail(
        unresolvedCustomTagMessage(name, {
          candidates: [...ctx.imports, ...ctx.defines.keys()],
          hint: `Import it (\`import ${name} from "./${name}.mx"\`) or add \`tags/${name}.mx\`.`,
        }),
        node,
      );
    },
    isDelegatedTag: (name) => name === "try" || name === "html-comment",
    // `<try>` is a core-owned custom tag (`packages/core/src/builtin-tags.ts`):
    // the shape checks that used to live here — no params, no `/var`, one
    // `<@catch>`, one `<@placeholder>` with no params of its own — are the
    // core's `attributeTags` declaration and the tag's own `transform`. This
    // host only decides how the claimed primitive renders.
    //
    // `<html-comment>` is claimed to be *rejected*, not rendered: JSX has no
    // comment node, so the unclaimed tag fell through to the native-element
    // path and silently rendered a literal `<html-comment>` element where
    // Marko renders `<!--…-->` (jsx-text-entities review, 2026-10-04). A
    // positioned refusal matches the `<!doctype>` policy below.
    resolveDelegatedTag(name, node): DelegatedTagData {
      if (name === "html-comment") {
        rawFail(
          `an HTML comment (<html-comment>) cannot appear in a ${dialectName} component: JSX has no comment node, so it cannot render Marko's <!--…-->; write the comment in the HTML shell that mounts the app`,
          node,
        );
      }
      if (name !== "try")
        rawFail(`unknown ${dialectName} host tag ${name}`, node);
      return { kind: "try" };
    },
    rejectModifier(attr) {
      // Reserved `on:` gets the event fix-it rather than the class-shaped
      // default. Ordinary names such as `oncapture:` never reach this hook.
      const fullName = `${attr.name}:${attr.modifier}`;
      const colon = fullName.indexOf(":");
      const prefix = fullName.slice(0, colon);
      const remainder = fullName.slice(colon + 1);
      const event = remainder.charAt(0).toUpperCase() + remainder.slice(1);
      const fixIts: Record<string, string> = {
        on: `\`${fullName}=fn\` is not MX syntax; write \`on${event}=fn\` for a DOM event or \`on-${remainder}=fn\` for a custom event name (Marko rejects this form too)`,
        style: `attribute modifier \`${fullName}\` is not ${dialectName} syntax; write the prop directly (\`style={{ color: value }}\` rather than \`style:color\`)`,
      };
      rawFail(
        fixIts[prefix] ??
          `attribute modifier \`${fullName}\` is not ${dialectName} syntax; write the prop directly (\`class={{ active: cond }}\` rather than \`class:active\`)`,
        attr,
      );
    },
    // An attribute method (`<button onClick() { … }>`) is an ordinary callable
    // prop in JSX, so this target carries it rather than rejecting it.
    resolveAttributeMethod: () => true,
  };
}

export const preactDeclarations = createJsxDeclarations("Preact");

/**
 * HTML raw-text elements: the tokenizer reads these bodies without emitting
 * character references, so the browser shows authored `&…` literally and
 * entity decoding must be skipped inside them (the `style` body is the only
 * reachable one — core rejects `<script>` as a client-runtime tag).
 */
const RAW_TEXT_ELEMENTS = new Set(["script", "style"]);

/**
 * Escapes text for a JSX child position, decoding authored HTML entities
 * first so the JSX render equals Marko's browser-decoded text.
 *
 * Marko passes authored `&…` through verbatim and the browser decodes it
 * with the HTML5 rules — legacy no-semicolon names (`&copy 2026`),
 * HTML5-only names (`&check;`), and unterminated numeric refs (`&#123`) —
 * while the JSX transform decodes only `;`-terminated numeric refs and the
 * HTML4 named set. Decoding with `entities`' spec-exact `decodeHTML` (the
 * tokenizer's "character reference in data" state) and re-emitting every
 * JSX-significant or non-ASCII character as a numeric reference makes the
 * two agree for every input: JSX's decoder always honours a `;`-terminated
 * numeric reference, and the serializer then writes exactly the decoded
 * characters back out.
 *
 * `&` is always re-emitted as `&#38;`: a decoded literal ampersand followed
 * by letters (`&amp;copy;` decodes to the text `&copy;`) would otherwise be
 * read by the JSX transform as a fresh entity. Every C0 control character
 * (code < 0x20, including LF, TAB, FF and CR) also becomes a
 * numeric reference: a decoded newline emitted literally would be trimmed
 * and collapsed by JSX's whitespace rules, where `&#10;` is decoded after
 * them and survives (`a&#10;b` renders `a\nb`, not `a b`). A decoded carriage
 * return specifically would also be normalized to `\n` by the HTML parser
 * if written raw. Astral characters and multi-code-point entities are
 * escaped per code point (`&#128512;`, `&#8810;&#824;`).
 *
 * In a raw-text element (`<style>`) entity decoding is skipped entirely:
 * the browser applies no character references there, so the text keeps
 * today's verbatim passthrough with only the JSX-significant characters
 * (`{`, `}`, `<`, `>`) escaped.
 */
function escapeText(value: string, decodeEntities = true): string {
  if (!decodeEntities) {
    return value.replace(/[{}<>]/g, (char) => `&#${char.charCodeAt(0)};`);
  }
  let out = "";
  for (const char of decodeHTML(value)) {
    const code = char.codePointAt(0) ?? 0;
    out +=
      code < 0x20 || code > 0x7f || "&<>{}".includes(char)
        ? `&#${code};`
        : char;
  }
  return out;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * The source text of a `FunctionExpression` attribute value, as an arrow.
 *
 * Marko's attribute-method shorthand (`onClick() { … }`) parses as a function
 * expression. Emitted verbatim into JSX it is still valid, but an arrow keeps
 * `this` lexical, which is what a Preact author writing the same handler by
 * hand would get.
 */
/** A tag name the host's `JSX.IntrinsicElements` could declare. */
const NATIVE_TAG = /^[a-z][a-z0-9]*$/;

function methodExpression(expr: Expr): string | null {
  if (expr.node?.type !== "FunctionExpression") return null;
  const match = expr.code.match(
    /^(async\s+)?function\s*\(([\s\S]*)\)\s*(\{[\s\S]*\})$/,
  );
  if (!match) return expr.code;
  return `${match[1] ?? ""}(${match[2] ?? ""}) => ${match[3] ?? "{}"}`;
}

/** The text of a template literal with no dynamic parts, or null. */
function staticTemplateValue(expr: Expr): string | null {
  const node = expr.node;
  if (node?.type !== "TemplateLiteral") return null;
  const expressions = node.expressions ?? [];
  if (
    expressions.some(
      (item: { type?: string }) => item?.type !== "StringLiteral",
    )
  ) {
    return null;
  }
  let value = "";
  for (let index = 0; index < (node.quasis ?? []).length; index++) {
    value += node.quasis[index]?.value?.cooked ?? "";
    value += expressions[index]?.value ?? "";
  }
  return value;
}

function meaningful(nodes: IrNode[]): IrNode[] {
  return nodes.filter(
    (node) =>
      node.kind !== "Comment" && !(node.kind === "Text" && node.value === ""),
  );
}

/** The sole `$!{expr}` child of a node, when that is all it has. */
function rawChild(
  nodes: IrNode[],
): Extract<IrNode, { kind: "Interpolation" }> | null {
  const content = meaningful(nodes);
  if (content.length !== 1) return null;
  const only = content[0];
  return only?.kind === "Interpolation" && !only.escaped ? only : null;
}

/**
 * Rejects `$!{expr}` beside other children.
 *
 * Raw HTML is set through a *prop* on both targets, which replaces the whole
 * subtree — so a raw placeholder with siblings would silently drop them.
 * Refusing is decision 65's rule: the target genuinely cannot express it.
 */
function rejectMixedRaw(nodes: IrNode[]): void {
  const content = meaningful(nodes);
  const raw = content.find(
    (node): node is Extract<IrNode, { kind: "Interpolation" }> =>
      node.kind === "Interpolation" && !node.escaped,
  );
  if (raw && content.length !== 1) {
    fail("raw placeholder (`$!{…}`) must be the only child", raw);
  }
}

function hasNamedAttr(attrs: Attr[], name: string): boolean {
  return attrs.some((attr) => attr.kind !== "spread" && attr.name === name);
}

function identifierNames(text: string): Set<string> {
  return new Set(text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []);
}

/** A loop-counter name that cannot shadow anything the body already uses. */
function hygienicName(base: string, params: string[], body: string): string {
  const used = identifierNames(`${params.join(" ")} ${body}`);
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base}${index}`)) index++;
  return `${base}${index}`;
}

/**
 * The two bindings an `<for from/to>` mapper names in its own parameter list.
 *
 * `Array.from`'s mapper takes `(value, index)`, and both are in scope for the
 * whole callback body — which is also where the author's own `from`/`to`/
 * `step` expressions are written, because the row value has to be derived
 * from the index. A generated `_` or `mxIndex` there therefore *shadowed* an
 * authored binding of the same name, silently: `<const/_=5/>` with
 * `<for|i| from=_ to=_+2>` rendered `NaN` three times, and
 * `<const/mxIndex=10/>` with `<for|i| from=mxIndex to=mxIndex+1>` rendered
 * `0, 2`. `__mx` is reserved by `checkReservedBindings`, so no authored
 * binding can take either of these names. (The html host had no version of
 * this bug: it binds its own `__mxForN` temporaries *before* the loop opens,
 * which is the other fix.)
 */
const RANGE_MAPPER_UNUSED = "__mxUnused";
const rangeCounter = (params: string[], body: string): string =>
  hygienicName("__mxIndex", params, body);

/** Preact JSX text emitter over the shared core IR. */
export class PreactEmitter implements Emitter<string> {
  readonly #out: MappedCode[] = [];
  readonly #dialect: JsxDialect;
  /**
   * Runtime names this emitter's output needs an import for.
   *
   * Collected while emitting rather than scanned for afterwards, so a template
   * that never writes `<try>` emits no import at all and the emitted module's
   * dependency list is exactly what it uses.
   */
  readonly #runtimeImports: Set<string>;
  /**
   * Component names Marko resolved that JSX would read as DOM elements.
   *
   * Collected the same way and for the same reason as `#runtimeImports`: the
   * module has to bind a capitalized alias for each, and only the emitter
   * knows which names were actually called.
   */
  readonly #aliases: Set<string>;
  /**
   * Statements a `/var` call site needs above the component's `return`.
   *
   * A `/var` binds what a unit returns with `<return>`, so the call has to be
   * *evaluated* and its result destructured — and JSX has no statement
   * position. The call is emitted as an ordinary function call here, not as a
   * JSX element: a JSX element is a description of a call the runtime makes
   * later, so `<Counter/>` in expression position never hands the
   * `{ value, output }` pair back to the caller at all.
   *
   * Shared by reference through `#child()`, like the two sets above, so a
   * call inside an `<if>` branch or a `<for>` body still reaches the one
   * function body that can hold a statement.
   */
  readonly #varStatements: string[];
  /** Serial for the temps those statements bind, per emitted module. */
  #varSerial: { n: number };
  /**
   * This emitter is filling a JSX **callback**, not the component body.
   *
   * Every structural kind on this target lowers to an expression — a `<for>`
   * to `.map((item) => …)`, an `<if>` to a ternary, an attribute tag to a
   * prop — so the statements a `/var` needs have nowhere to go inside one.
   * Hoisting them to the component body is what round 1 caught: the call
   * escapes the scope it was written in, so it reads loop variables that do
   * not exist there and runs once for a body that renders N times.
   *
   * Invariant §7.5-8 says the escape is rejected, never hoisted, so a `/var`
   * here is a positioned error rather than a silent miscompile. Lifting the
   * restriction means giving each callback its own statement position (an
   * IIFE), which is filed as MX 2 work.
   */
  readonly #callbackScope: boolean;
  /**
   * The text being emitted is a child of an HTML raw-text element
   * (`<style>`), whose authored entities the browser does not decode.
   * Threaded through `#child` so a nested element resets it from its own
   * name.
   */
  readonly #decodeText: boolean;

  /**
   * Tooling-only (decision 140): the name of the preamble's handler-type
   * alias. When set, every native element's event handler becomes
   * `(fn) satisfies Alias<"tag", "event">`, so TypeScript checks it against
   * the host's own handler type; `satisfies` is erased on emit, so the
   * wrapper never reaches emitted JavaScript. Never set for a runtime compile.
   */
  readonly #typeCheck: string | undefined;

  /**
   * Region compiles only (`region.ts`): where a `<define>` nested in markup
   * goes instead of being refused. A region has a single root element, so
   * its `<define>`s are never at the template's top level; outside a callback
   * they are still in the component body's own JavaScript scope (JSX opens
   * none), so declaring them above the region's markup changes nothing they
   * close over. `undefined` for a whole-file compile, which keeps refusing.
   */
  readonly #region: { segment: string; defines: MappedCode[] } | undefined;

  constructor(
    dialect: JsxDialect = preactDialect,
    runtimeImports?: Set<string>,
    aliases?: Set<string>,
    varStatements?: string[],
    varSerial?: { n: number },
    callbackScope = false,
    typeCheck?: string,
    decodeText = true,
    region?: { segment: string; defines: MappedCode[] },
  ) {
    this.#dialect = dialect;
    this.#region = region;
    this.#typeCheck = typeCheck;
    this.#runtimeImports = runtimeImports ?? new Set();
    this.#aliases = aliases ?? new Set();
    this.#varStatements = varStatements ?? [];
    this.#varSerial = varSerial ?? { n: 0 };
    this.#callbackScope = callbackScope;
    this.#decodeText = decodeText;
  }

  /** Statements a `/var` call site needs above the component's `return`. */
  get varStatements(): string[] {
    return this.#varStatements;
  }

  /** `<define>` statements lifted out of a region's markup, in source order. */
  get liftedDefines(): MappedCode[] {
    return this.#region?.defines ?? [];
  }

  /** Component names that need a capitalized alias in the emitted module. */
  get aliases(): Set<string> {
    return this.#aliases;
  }

  /** The runtime helper names this emitter's output references. */
  get runtimeImports(): Set<string> {
    return this.#runtimeImports;
  }

  /** A child emitter sharing this one's dialect and import collection. */
  #child(
    callbackScope = this.#callbackScope,
    decodeText = true,
  ): PreactEmitter {
    return new PreactEmitter(
      this.#dialect,
      this.#runtimeImports,
      this.#aliases,
      this.#varStatements,
      this.#varSerial,
      callbackScope,
      this.#typeCheck,
      decodeText,
      this.#region,
    );
  }

  #render(
    nodes: IrNode[],
    callbackScope?: boolean,
    decodeText = true,
  ): MappedCode {
    const child = this.#child(callbackScope, decodeText);
    drive(child, nodes);
    return child.result();
  }

  /**
   * A child list as a single JSX *expression*.
   *
   * One element stays itself; anything else is wrapped in a fragment, because
   * a ternary branch and a `.map` callback each have exactly one expression
   * slot to fill. A lone escaped placeholder becomes its bare expression,
   * which keeps `<if=c>${x}</if>` from emitting `<>{x}</>`.
   */
  #expression(nodes: IrNode[], callbackScope?: boolean): MappedCode {
    const content = meaningful(nodes);
    if (content.length === 0) return concatMapped("null");
    if (content.length === 1) {
      const only = content[0] as IrNode;
      if (only.kind === "Interpolation" && only.escaped) {
        return concatMapped(only.expr.code);
      }
      if (
        only.kind === "Element" ||
        only.kind === "Component" ||
        only.kind === "IfChain" ||
        only.kind === "For" ||
        only.kind === "DelegatedTag"
      ) {
        return this.#render(content, callbackScope);
      }
    }
    return concatMapped("<>", this.#render(content, callbackScope), "</>");
  }

  /**
   * One attribute's *value*, as a JS expression, for object syntax.
   *
   * The counterpart of `#attr` for a unit that is called rather than
   * described (see `#propsObject`). It repeats `#attr`'s per-kind decisions
   * — the structured `class` helper, the `style` object rule, `:=`'s
   * rejection, a method attribute's function expression — because those are
   * decisions about the *value*, while `#attr`'s remaining work is the
   * attribute-name syntax an object literal does not use.
   */
  #attrValue(attr: Attr): string {
    switch (attr.kind) {
      case "spread":
        // Handled by the caller: a spread has no name to pair a value with.
        return attr.value.code;
      case "boolean":
        return "true";
      case "static":
        return JSON.stringify(attr.value);
      case "bound":
        return fail(
          `\`:=\` is Marko's two-way binding; ${this.#dialect.name} has no equivalent — pass the value and an explicit \`onInput\` handler`,
          attr,
        );
      // Phase B of `dom-events` (decision 101): recompose the prop from the
      // DOM event name core resolved — `on` + capitalized (`click` →
      // `onClick`, `dblclick` → `onDblclick`), with the React dialect's own
      // irregular spellings (`onDoubleClick`, `onFocus`, `onBlur`) through
      // `JsxDialect.eventPropNames`. A custom DOM event name JSX cannot spell
      // errors uniformly on all three shared targets.
      case "event": {
        // Only the value lands here; the paired `#attr` emits the recomposed
        // prop name. Validate the name on both paths so a custom-event name
        // errors whether the unit is described (`#attr`) or called
        // (`#attrValue`).
        this.#eventPropName(attr);
        return methodExpression(attr.value) ?? attr.value.code;
      }
      case "dynamic": {
        if (attr.name === "class") {
          const fixed = staticTemplateValue(attr.value);
          if (fixed !== null) return JSON.stringify(fixed);
          if (attr.value.shape === "object" || attr.value.shape === "array") {
            this.#runtimeImports.add("__mxClass");
            return `__mxClass(${attr.value.code})`;
          }
        }
        if (attr.name === "style" && attr.value.shape !== "object") {
          return fail(
            "`style=` takes an object literal (`style={color: c}`); a non-object value is not supported",
            attr,
          );
        }
        return methodExpression(attr.value) ?? attr.value.code;
      }
    }
  }

  /**
   * React cannot render a string `style` (its renderer throws), and Marko
   * accepts one. Where the spread is an object literal the compiler can see
   * the value, so a string/`true` `style` is refused here with the fix instead
   * of at render time; a value known only at run time keeps React's own error.
   */
  #rejectStringStyle(attr: Attr): void {
    if (!this.#dialect.reactBooleanAttributes || attr.kind !== "spread") return;
    const node = attr.value.node as unknown as {
      type?: string;
      properties?: {
        type: string;
        computed?: boolean;
        key?: { type: string; name?: string; value?: unknown };
        value?: { type: string; value?: unknown };
      }[];
    };
    if (node?.type !== "ObjectExpression") return;
    for (const prop of node.properties ?? []) {
      if (prop.type !== "ObjectProperty" || prop.computed) continue;
      const key =
        prop.key?.type === "Identifier" ? prop.key.name : prop.key?.value;
      if (key !== "style") continue;
      const type = prop.value?.type;
      if (
        type === "StringLiteral" ||
        type === "TemplateLiteral" ||
        (type === "BooleanLiteral" && prop.value?.value === true)
      )
        fail(
          "`style` in a spread must be an object on React (`...{style: {color: c}}`); React cannot render a string style",
          attr,
        );
    }
  }

  #attr(
    attr: Attr,
    mapName: boolean,
    isComponent: boolean,
    tag?: string,
  ): MappedCode {
    if (!isComponent && attr.kind !== "spread") {
      // Decision 140 (b): native non-event prop errors land on the name.
      // Event-shaped names stay unmapped even for static/boolean values;
      // recomposed handlers use their separate type-check projection. A
      // default attribute has no authored name (zero-width span at `=`).
      mapName =
        mapName &&
        !/^on[A-Z-]/.test(attr.name) &&
        attr.nameSpan !== null &&
        attr.nameSpan.sourceEnd > attr.nameSpan.sourceStart;
    }
    // A JSXNamespacedName has exactly two nonempty pieces. Marko also
    // accepts `value:` and `value:foo:bar`; a string-keyed spread carries the
    // exact prop through every JSX frontend without emitting invalid JSX.
    if (
      attr.kind !== "spread" &&
      attr.kind !== "bound" &&
      attr.kind !== "event" &&
      attr.name.includes(":") &&
      !/^[^:]+:[^:]+$/.test(attr.name)
    ) {
      const valueSpan =
        attr.kind === "static"
          ? attr.valueSpan
          : attr.kind === "dynamic"
            ? attr.value.span
            : undefined;
      return concatMapped(
        " {...{",
        mapped(JSON.stringify(attr.name), mapName ? attr.nameSpan : null),
        ": (",
        !isComponent && attr.kind === "dynamic"
          ? concatMapped(
              ATTRIBUTE_VALUE_EXPRESSION,
              "(",
              JSON.stringify(attr.name),
              ", ",
              mapped(this.#attrValue(attr), valueSpan ?? null),
              ", ",
              JSON.stringify(tag ?? ""),
              ")",
            )
          : mapped(this.#attrValue(attr), valueSpan ?? null),
        ")}}",
      );
    }
    switch (attr.kind) {
      case "spread":
        // A native element's spread is merged by `#attrs` (which also runs
        // `#rejectStringStyle`); only a component call reaches this writer.
        return concatMapped(` {...${attr.value.code}}`);
      case "boolean":
        return concatMapped(
          " ",
          mapped(
            this.#attrName(attr.name, isComponent),
            mapName ? attr.nameSpan : null,
          ),
          "={true}",
        );
      case "static": {
        const name = this.#attrName(attr.name, isComponent);
        return concatMapped(
          " ",
          mapped(name, mapName ? attr.nameSpan : null),
          `="${escapeAttribute(attr.value)}"`,
        );
      }
      case "bound":
        // `value:=x` binds two ways in Marko: the value renders *and* edits
        // write back. Preact has no two-way binding — a controlled input is a
        // value prop plus an explicit handler — so emitting only the value
        // would produce an input the user cannot type into.
        return fail(
          `\`:=\` is Marko's two-way binding; ${this.#dialect.name} has no equivalent — pass the value and an explicit \`onInput\` handler`,
          attr,
        );
      // Phase B of `dom-events` (decision 101): the prop is recomposed from
      // the DOM event name core resolved (`#eventPropName`) — never the
      // authored spelling, so `onDblClick` and `on-dblclick` both emit
      // `onDblclick`. The recomposed name is deliberately not span-mapped:
      // it is generated text, not source text, and a mapping whose texts
      // differ is worse than none.
      //
      // Under `typeCheck` (tooling only, decision 140) a native element's
      // handler is wrapped as `(fn) satisfies Handler<"tag", "event">`:
      // TypeScript then checks the value against the host's own handler type
      // (and contextually types its parameters), and the diagnostic lands on
      // the value — which is mapped — instead of on the unmapped prop name.
      // `satisfies` is erased on emit, so `mx-tsc` output stays runnable. A shorthand handler has no source span, so its
      // generated function maps to the attribute name.
      case "event": {
        const name = this.#eventPropName(attr);
        const method = methodExpression(attr.value);
        if (this.#typeCheck && tag !== undefined && NATIVE_TAG.test(tag)) {
          // TypeScript reports a mismatch on the `satisfies` keyword, so that
          // keyword maps to the handler's source span; the generated
          // parentheses stay unmapped, and a source-backed value keeps the
          // exact text mapping it has without the wrapper (a coarse mapping
          // over `(fn)` would shift every position inside the body by the
          // length of the `(`). A shorthand handler has no span of its own and
          // maps to the attribute name.
          const shorthand =
            method !== null && attr.value.node?.start === undefined;
          const span = shorthand ? attr.nameSpan : (attr.value.span ?? null);
          return concatMapped(
            " ",
            mapped(name, null),
            "={(",
            shorthand
              ? mapped(method, attr.nameSpan)
              : concatMapped(method ?? attr.value.code),
            ") ",
            mapped("satisfies", span),
            ` ${this.#typeCheck}<"${tag}", "${name.slice(2).toLowerCase()}">}`,
          );
        }
        return concatMapped(
          " ",
          mapped(name, null),
          `={${method ?? attr.value.code}}`,
        );
      }
      case "dynamic": {
        const name = this.#attrName(attr.name, isComponent);
        // A `class` written as a template literal with no dynamic parts is a
        // constant, and reads better as one in the emitted JSX.
        if (attr.name === "class") {
          const fixed = staticTemplateValue(attr.value);
          if (fixed !== null) {
            return concatMapped(
              " ",
              mapped(name, mapName ? attr.nameSpan : null),
              `="${escapeAttribute(fixed)}"`,
            );
          }
          if (attr.value.shape === "object" || attr.value.shape === "array") {
            // Marko's structured class value; Preact's `class` takes a string,
            // so the object/array form is joined by the emitted helper.
            this.#runtimeImports.add("__mxClass");
            return concatMapped(
              " ",
              mapped(name, mapName ? attr.nameSpan : null),
              `={__mxClass(${attr.value.code})}`,
            );
          }
        }
        if (attr.name === "style" && attr.value.shape !== "object") {
          // Preact's `style` prop takes an object or a string; anything else
          // (an identifier, a call) could be either at run time and Marko's own
          // rule is object-only, so the mismatch is refused rather than guessed.
          return fail(
            "`style=` takes an object literal (`style={color: c}`); a non-object value is not supported",
            attr,
          );
        }
        return concatMapped(
          " ",
          mapped(name, mapName ? attr.nameSpan : null),
          "={",
          !isComponent &&
            !["style", "ref", "key", this.#dialect.rawHtmlProp].includes(
              attr.name,
            )
            ? concatMapped(
                ATTRIBUTE_VALUE_EXPRESSION,
                "(",
                JSON.stringify(attr.name),
                ", ",
                mappedExpr(attr.value),
                ", ",
                JSON.stringify(tag ?? ""),
                ")",
              )
            : concatMapped(methodExpression(attr.value) ?? attr.value.code),
          "}",
        );
      }
    }
  }

  /**
   * An attribute name in this target's spelling.
   *
   * The `class`/`for` renames are **DOM** attribute spellings, so they apply to
   * elements only. A component's attributes are its author's `Input` contract:
   * a tag whose template reads `input.class` must receive `class`, whatever
   * this target calls the DOM property. Renaming on a component call silently
   * dropped the value — the callee read `input.class` and got `undefined` —
   * which only became reachable once a template tag became a real component
   * call (decision 95) rather than being expanded inline.
   */
  #attrName(name: string, isComponent: boolean): string {
    // `isComponent` is required, not defaulted: a new call site that forgot it
    // would silently reinstate the component renaming this guard exists to
    // prevent, and a dropped prop is invisible in the output.
    if (isComponent) return name;
    if (name === "class") return this.#dialect.classAttr;
    if (name === "for") return this.#dialect.forAttr;
    return name;
  }

  /**
   * The JSX prop name for an `event` attribute, recomposed from the DOM
   * event name core resolved (decision 101, design note §7): `on` plus the
   * capitalized DOM name — `click` → `onClick`, `dblclick` → `onDblclick`.
   * The React dialect passes its own irregular spellings through
   * `JsxDialect.eventPropNames` (`dblclick` → `onDoubleClick`, `focusin` →
   * `onFocus`, `focusout` → `onBlur`), React's own registration table in
   * `react-dom`, not an MX invention.
   *
   * A name JSX cannot spell as one identifier — a custom DOM event such as
   * `my-event` from `on-my-event` — is a uniform error on all three shared
   * targets (decision 101 (d)): even where a runtime could bind it, the same
   * MX source must not silently do nothing on another. The `ref` route the
   * error names works identically on Preact, React and hono.
   */
  #eventPropName(attr: Attr & { kind: "event" }): string {
    if (!/^[A-Za-z0-9]+$/.test(attr.event)) {
      fail(
        `\`${attr.name}\` names a custom DOM event (\`${attr.event}\`) a JSX prop cannot spell; use a \`ref\` to add a custom event listener (\`ref={el => el?.addEventListener("${attr.event}", fn)}\`)`,
        attr,
      );
    }
    const irregular = this.#dialect.eventPropNames?.[attr.event];
    const middle =
      irregular ?? attr.event.charAt(0).toUpperCase() + attr.event.slice(1);
    return `on${middle}`;
  }

  /**
   * Every attribute of one tag.
   *
   * No merging or duplicate checking happens here, and that is deliberate:
   * Marko folds `.card class=value` into one synthetic array attribute before
   * the lowerer ever sees it (the helper joins that array), and it rejects
   * `#id` beside an explicit `id=` in its own parser — *"Cannot have shorthand
   * id and id attribute"* — so a check here would be unreachable code
   * pretending to be a guard.
   */
  #attrs(
    attrs: Attr[],
    mapNames: boolean,
    isComponent: boolean,
    tag?: string,
    textareaBody = false,
  ): MappedCode {
    if (!isComponent && attrs.some((attr) => attr.kind === "spread")) {
      // Validate after the authored merge: an overwritten object is never
      // serialized by Marko and must not throw just because it appeared first.
      const entries = attrs.flatMap((attr, index) => {
        if (attr.kind === "spread") {
          this.#rejectStringStyle(attr);
          return [index ? ", " : "", "...", mappedExpr(attr.value)];
        }
        const name =
          attr.kind === "event"
            ? this.#eventPropName(attr)
            : this.#attrName(attr.name, false);
        const value = this.#attrValue(attr);
        const span =
          attr.kind === "dynamic" || attr.kind === "event"
            ? attr.value.span
            : attr.kind === "static"
              ? attr.valueSpan
              : null;
        const typedEvent =
          attr.kind === "event" &&
          this.#typeCheck &&
          tag !== undefined &&
          NATIVE_TAG.test(tag);
        const shorthand =
          attr.kind === "event" &&
          methodExpression(attr.value) !== null &&
          attr.value.node?.start === undefined;
        const renderedValue = typedEvent
          ? concatMapped(
              "(",
              shorthand ? mapped(value, attr.nameSpan) : value,
              ") ",
              mapped("satisfies", shorthand ? attr.nameSpan : (span ?? null)),
              ` ${this.#typeCheck}<"${tag}", "${name.slice(2).toLowerCase()}">`,
            )
          : (attr.kind === "dynamic" || attr.kind === "event") &&
              value === attr.value.code
            ? mappedExpr(attr.value)
            : mapped(value, span ?? null);
        const nameSpan =
          mapNames &&
          attr.kind !== "event" &&
          !/^on[A-Z-]/.test(attr.name) &&
          attr.nameSpan &&
          attr.nameSpan.sourceEnd > attr.nameSpan.sourceStart
            ? attr.nameSpan
            : null;
        return [
          index ? ", " : "",
          mapped(JSON.stringify(name), nameSpan),
          ": ",
          renderedValue,
        ];
      });
      // A textarea's merged `value` is its content (Marko), or dropped when the
      // element has a body.
      const textarea = tag === "textarea";
      return concatMapped(
        textarea ? " {...__mxTextarea(" : " {...",
        ATTRIBUTE_SPREAD_EXPRESSION,
        "({ ",
        ...entries,
        " }, ",
        JSON.stringify(tag ?? ""),
        ", ",
        JSON.stringify([
          "ref",
          "key",
          this.#dialect.rawHtmlProp,
          ...(this.#dialect.classAttr === "class"
            ? []
            : [this.#dialect.classAttr]),
        ]),
        textarea ? `, true), ${textareaBody})}` : ", true)}",
      );
    }
    return concatMapped(
      ...attrs.map((attr) => this.#attr(attr, mapNames, isComponent, tag)),
    );
  }

  /** `__mxTextareaContent(<value>)` for a textarea's explicit `value`. */
  #textareaContent(attr: Attr): MappedCode {
    const span =
      attr.kind === "dynamic"
        ? attr.value.span
        : attr.kind === "static"
          ? attr.valueSpan
          : null;
    const value = this.#attrValue(attr);
    return concatMapped(
      "__mxTextareaContent(",
      attr.kind === "dynamic" && value === attr.value.code
        ? mappedExpr(attr.value)
        : mapped(value, span ?? null),
      ")",
    );
  }

  /** An attribute tag's body in this host's renderable shape. */
  #attributeTagRenderable(tag: AttributeTag, key?: string): MappedCode {
    // `hasBody` distinguishes `<@x/>` from a body whose rendered expression
    // happens to be empty. Decision 106 makes the former `undefined`, not a
    // null JSX child or an empty fragment.
    if (!tag.hasBody) return concatMapped("undefined");
    const children = meaningful(tag.block.children);
    // Attribute-tag bodies cross a component boundary as host renderables.
    // In particular, a lone placeholder must not become a bare string: a
    // callee following the `<${x.content}/>` fix-it would then reinterpret
    // that string as a dynamic tag name. A JSX element is already a host
    // renderable; every other body shape is protected by a fragment. The
    // trailing null makes that fragment a two-child fragment: Hono's Fragment
    // drops a sole falsy child (including the renderable number `0`), while a
    // null sibling is invisible on every JSX host and preserves the ordinary
    // child semantics for strings, elements, arrays, false and null.
    const only = children.length === 1 ? children[0] : undefined;
    let value =
      only?.kind === "Element" ||
      only?.kind === "Component" ||
      only?.kind === "DelegatedTag"
        ? this.#render(children, true)
        : concatMapped("<>", this.#render(children, true), "{null}</>");
    // The renderable nested inside every array entry needs a key even when
    // the outer entry is data-shaped: consumers commonly render
    // `items.map((item) => item.content)`. Put the key inside parameterized
    // callbacks too, so their returned nodes are safe to collect in an array.
    if (key !== undefined) {
      this.#runtimeImports.add("__mxFragment");
      value = concatMapped(
        "<__mxFragment key={",
        key,
        "}>",
        value,
        "</__mxFragment>",
      );
    }
    if (!tag.block.hasParams) return value;
    return concatMapped(`(${tag.block.params.join(", ")}) => `, value);
  }

  /**
   * One concrete attribute-tag value checked against the callee's declared
   * type.
   *
   * The value is parenthesized before `satisfies` is applied, because
   * `satisfies` binds tighter than an arrow function: `(p) => x satisfies T`
   * checks the returned `x`, not the render function. It is applied to each
   * concrete occurrence rather than to a whole singular plan for the same
   * reason, since `test ? a : undefined satisfies T` checks only `undefined`.
   */
  #satisfying(value: MappedCode, valueType: string | undefined): MappedCode {
    return valueType
      ? concatMapped("((", value, `) satisfies ${valueType})`)
      : value;
  }

  /**
   * Same check for a data value, an object literal that needs no inner
   * parenthesization guard: `{ ... } satisfies T` has no arrow function or
   * ternary to disambiguate, so one wrapping pair is enough (matching
   * `@mxlang/html`'s `attrTagValue`).
   */
  #satisfyingData(
    value: MappedCode,
    valueType: string | undefined,
  ): MappedCode {
    return valueType
      ? concatMapped("(", value, ` satisfies ${valueType})`)
      : value;
  }

  /** One occurrence, shaped from the callee's resolved declaration. */
  #attributeTagValue(
    tag: AttributeTag,
    as: AttrTagProp["as"],
    key?: string,
    valueType?: string,
  ): MappedCode {
    const content = this.#attributeTagRenderable(tag, key);
    // A bodiless renderable is `undefined`, which is the absence of a value
    // rather than a value of the declared type.
    if (as === "renderable") {
      return tag.hasBody ? this.#satisfying(content, valueType) : content;
    }

    const parts: Array<string | MappedCode> = [];
    for (const attr of tag.attrs) {
      if (parts.length > 0) parts.push(", ");
      if (attr.kind === "spread") {
        parts.push(`...${attr.value.code}`);
      } else {
        parts.push(
          mapped(JSON.stringify(attr.name), attr.nameSpan),
          ": ",
          mapped(
            this.#attrValue(attr),
            "value" in attr && typeof attr.value === "object"
              ? (attr.value.span ?? attr.nameSpan)
              : attr.nameSpan,
          ),
        );
      }
    }
    for (const prop of tag.attrTagProps) {
      if (parts.length > 0) parts.push(", ");
      parts.push(
        `${JSON.stringify(prop.name)}: `,
        this.#attributeTagProp(prop),
      );
    }
    if (parts.length > 0) parts.push(", ");
    parts.push("content: ", content);
    return this.#satisfyingData(
      concatMapped(mapped("{", tag.nameSpan), " ", ...parts, " }"),
      valueType,
    );
  }

  /** First concrete occurrence, used only to map the emitted prop name. */
  #firstAttributeTag(nodes: AttributeTagNode[]): AttributeTag | undefined {
    for (const node of nodes) {
      if (node.kind === "AttributeTag") return node.tag;
      if (node.kind === "AttributeTagFor") {
        const found = this.#firstAttributeTag(node.nodes);
        if (found) return found;
      } else {
        for (const branch of node.branches) {
          const found = this.#firstAttributeTag(branch.nodes);
          if (found) return found;
        }
      }
    }
    return undefined;
  }

  /** A singular plan as one JavaScript expression evaluated during render. */
  #attributeTagSingle(
    nodes: AttributeTagNode[],
    as: AttrTagProp["as"],
    valueType?: string,
  ): MappedCode {
    if (nodes.length === 0) return concatMapped("undefined");
    const node = nodes[0] as AttributeTagNode;
    if (node.kind === "AttributeTag") {
      return this.#attributeTagValue(node.tag, as, undefined, valueType);
    }
    if (node.kind === "AttributeTagFor") {
      // Core rejects declared singular tags in a loop and promotes fallback
      // loop shapes to arrays. Keep this total for transformed IR without
      // inventing a second loop semantics.
      return this.#satisfying(
        concatMapped(
          "(",
          this.#attributeTagFor(node.loop, node.nodes, as),
          ")[0]",
        ),
        valueType,
      );
    }

    const parts: Array<string | MappedCode> = [];
    for (const branch of node.branches) {
      if (branch.test) {
        parts.push(
          branch.test.code,
          " ? ",
          this.#attributeTagSingle(branch.nodes, as, valueType),
          " : ",
        );
      } else {
        parts.push(this.#attributeTagSingle(branch.nodes, as, valueType));
      }
    }
    if (node.branches.at(-1)?.test) parts.push("undefined");
    return concatMapped(...parts);
  }

  /** One tree node as an array expression, preserving authored order. */
  #attributeTagArrayNode(
    node: AttributeTagNode,
    as: AttrTagProp["as"],
    arrayType?: string,
    key = JSON.stringify("0"),
  ): MappedCode {
    if (node.kind === "AttributeTag") {
      return concatMapped("[", this.#attributeTagValue(node.tag, as, key), "]");
    }
    if (node.kind === "AttributeTagFor") {
      return this.#attributeTagFor(node.loop, node.nodes, as, arrayType, key);
    }

    const parts: Array<string | MappedCode> = [];
    for (const branch of node.branches) {
      if (branch.test) {
        parts.push(
          branch.test.code,
          " ? ",
          this.#attributeTagArray(branch.nodes, as, arrayType, `${key} + ":"`),
          " : ",
        );
      } else {
        parts.push(
          this.#attributeTagArray(branch.nodes, as, arrayType, `${key} + ":"`),
        );
      }
    }
    if (node.branches.at(-1)?.test) parts.push("[]");
    return concatMapped(...parts);
  }

  /** Several source nodes merged into one real array. */
  #attributeTagArray(
    nodes: AttributeTagNode[],
    as: AttrTagProp["as"],
    arrayType?: string,
    keyPrefix?: string,
  ): MappedCode {
    if (nodes.length === 0) return concatMapped("[]");
    return concatMapped(
      "[",
      ...nodes.flatMap((node, index) => {
        const prefix = index === 0 ? "" : ", ";
        const key = keyPrefix
          ? `${keyPrefix} + ${JSON.stringify(String(index))}`
          : JSON.stringify(String(index));
        return node.kind === "AttributeTag"
          ? [prefix, this.#attributeTagValue(node.tag, as, key)]
          : [
              prefix,
              "...",
              this.#attributeTagArrayNode(node, as, arrayType, key),
            ];
      }),
      "]",
    );
  }

  /** Attribute-tag `<for>` as an array-producing `.flatMap`. */
  #attributeTagFor(
    loop: ForHead,
    nodes: AttributeTagNode[],
    as: AttrTagProp["as"],
    arrayType?: string,
    key = JSON.stringify("0"),
  ): MappedCode {
    const bodyText = nodes.map((node) => JSON.stringify(node)).join(" ");
    const [first = "item", second] = loop.params;
    const source = loop.source;
    const itemIndex =
      source.kind === "of" && second
        ? second
        : hygienicName("mxAttrIndex", loop.params, bodyText);
    const body = this.#attributeTagArray(
      nodes,
      as,
      arrayType,
      `${key} + ":" + ${itemIndex} + ":"`,
    );
    const result = (iterable: string, params: string): MappedCode => {
      if (!arrayType) {
        return concatMapped(`${iterable}.flatMap((${params}) => `, body, ")");
      }
      const accumulator = hygienicName(
        "mxAttrTags",
        [...loop.params, itemIndex],
        body.code,
      );
      // The explicit accumulator type contextually types object literals in
      // the body, including `(n) =>` content callbacks nested under a loop.
      return concatMapped(
        `${iterable}.reduce<${arrayType}>((${accumulator}, ${params}) => ${accumulator}.concat((`,
        body,
        `) satisfies ${arrayType}), [])`,
      );
    };
    if (source.kind === "of") {
      const params = `${first}, ${itemIndex}`;
      const listVar = hygienicName("mxList", loop.params, source.list.code);
      return result(
        `((${listVar}) => ${listVar} ? [...${listVar}] : [])(${source.list.code})`,
        params,
      );
    }
    if (source.kind === "in") {
      const value =
        second ??
        hygienicName(
          "value",
          loop.params,
          `${body.code} ${source.object.code}`,
        );
      return result(
        `Object.entries(${source.object.code} ?? {})`,
        `[${first}, ${value}], ${itemIndex}`,
      );
    }

    const from = source.from?.code ?? "0";
    const bound = source.bound.code;
    const step = source.step;
    const counter = rangeCounter(loop.params, body.code);
    const span = step
      ? `${source.inclusive ? "Math.floor" : "Math.ceil"}(((${bound}) - (${from})) / (${step.code}))${source.inclusive ? " + 1" : ""}`
      : `(${bound}) - (${from})${source.inclusive ? " + 1" : ""}`;
    const value = step
      ? `(${from}) + ${counter} * (${step.code})`
      : `(${from}) + ${counter}`;
    return result(
      `Array.from({ length: Math.max(0, ${span}) }, (${RANGE_MAPPER_UNUSED}, ${counter}) => ${value})`,
      `${first}, ${itemIndex}`,
    );
  }

  /** The resolved value for one callee-declared attribute-tag prop. */
  #attributeTagProp(prop: AttrTagProp, owner?: string): MappedCode {
    if (prop.cardinality !== "array") {
      const valueType =
        owner && prop.declared
          ? `NonNullable<Parameters<typeof ${owner}>[0][${JSON.stringify(prop.name)}]>`
          : undefined;
      return this.#attributeTagSingle(prop.source, prop.as, valueType);
    }
    const arrayType =
      owner && prop.declared
        ? `NonNullable<Parameters<typeof ${owner}>[0][${JSON.stringify(prop.name)}]>`
        : undefined;
    const value = this.#attributeTagArray(prop.source, prop.as, arrayType);
    return arrayType
      ? concatMapped("(", value, ` satisfies ${arrayType})`)
      : value;
  }

  /** A component's resolved attribute-tag plan in JSX attribute syntax. */
  #attributeTagProps(props: AttrTagProp[], owner: string): MappedCode {
    return concatMapped(
      ...props.map((prop) => {
        const first = this.#firstAttributeTag(prop.source);
        return concatMapped(
          " ",
          mapped(prop.name, first?.nameSpan ?? null),
          "={",
          this.#attributeTagProp(prop, owner),
          "}",
        );
      }),
    );
  }

  /**
   * One call's props as an object literal, for a call that is *invoked*.
   *
   * A unit declaring `<return>` has to be called rather than described as a
   * JSX element, so its props need object syntax instead of attribute
   * syntax. Built from the IR rather than by re-parsing the JSX `#attrs`
   * produced: the two syntaxes differ per attribute kind (a spread is
   * `{...x}` in JSX and `...x` in an object; a static value is a quoted
   * attribute and a string literal), and text surgery over emitted JSX
   * would have to re-derive exactly the cases `#attr` already decided.
   *
   * The value expressions themselves are shared with `#attr` through
   * `#attrValue`, so a structured `class`, a rejected `:=`, and the `style`
   * object rule cannot drift between a called unit and a described one.
   */
  #propsObject(node: Extract<IrNode, { kind: "Component" }>): string {
    const parts: string[] = [];
    // A decision-116-routed dynamic target (`valueImportBinding` set) still
    // names a real, in-scope import — the emitted call is
    // `mxDynamic(Row, ...)`, with `Row` imported verbatim — so `owner` can
    // still reference it for `Parameters<typeof Row>[0][...]` typing,
    // exactly as a `kind: "name"` target does. An author's own `<${expr}/>`
    // (no `valueImportBinding`) has no such name and stays untyped.
    const owner =
      node.target.kind === "dynamic"
        ? node.target.valueImportBinding
          ? componentAlias(node.target.valueImportBinding)
          : undefined
        : componentAlias(node.target.name);
    for (const attr of node.attrs) {
      if (attr.kind === "spread") {
        parts.push(`...${attr.value.code}`);
        continue;
      }
      // A component's props are its author's `Input` contract, so names are
      // never renamed here — the same rule `#attrName(name, true)` applies.
      parts.push(`${JSON.stringify(attr.name)}: ${this.#attrValue(attr)}`);
    }

    for (const prop of node.attrTagProps) {
      parts.push(
        `${JSON.stringify(prop.name)}: ${this.#attributeTagProp(prop, owner).code}`,
      );
    }

    const content = node.content?.children ?? [];
    if (content.length > 0) {
      // Marko's `content` and JSX's `children` are the same slot; a called
      // unit reads `input.content`, so it is passed under that name.
      const rendered = this.#expression(content);
      parts.push(`content: () => <>${rendered.code}</>`);
    }

    return `{ ${parts.join(", ")} }`;
  }

  text(node: Extract<IrNode, { kind: "Text" }>): void {
    this.#out.push(concatMapped(escapeText(node.value, this.#decodeText)));
  }

  interpolation(node: Extract<IrNode, { kind: "Interpolation" }>): void {
    if (!node.escaped) {
      fail("raw placeholder (`$!{…}`) must be the only child", node);
    }
    this.#out.push(concatMapped(`{${node.expr.code}}`));
  }

  element(node: Extract<IrNode, { kind: "Element" }>): void {
    rejectMixedRaw(node.children);
    const raw = rawChild(node.children);
    if (raw && hasNamedAttr(node.attrs, this.#dialect.rawHtmlProp)) {
      fail(
        `\`$!{…}\` sole child combined with an explicit \`${this.#dialect.rawHtmlProp}=\` attribute`,
        raw,
      );
    }
    // `<textarea value=x/>` renders the value as content, as Marko does.
    let explicitValue: Attr | undefined;
    if (node.name === "textarea") {
      explicitValue = node.attrs.find(
        (attr) =>
          attr.kind !== "spread" &&
          attr.kind !== "bound" &&
          attr.name === "value",
      );
      if (explicitValue && node.children.length > 0) {
        fail(
          "A textarea cannot have both a value attribute and body content.",
          explicitValue,
        );
      }
    }
    // With a spread the explicit `value` stays in the merged object, so the
    // later of the two wins (as Marko); `__mxTextarea` turns the winner into
    // the content. Lifted into the content only when nothing can override it.
    const lifted = node.attrs.some((attr) => attr.kind === "spread")
      ? undefined
      : explicitValue;
    const content = lifted ? this.#textareaContent(lifted) : null;
    // IR elements include hyphenated custom elements, whose arbitrary
    // props are not native contracts. CamelCase SVG tags are native too.
    let attrs = this.#attrs(
      lifted ? node.attrs.filter((attr) => attr !== lifted) : node.attrs,
      !node.name.includes("-"),
      false,
      node.name,
      node.children.length > 0,
    );
    if (content && this.#dialect.textareaContent === "value") {
      attrs = concatMapped(attrs, " value={", content, "}");
    }
    const rawHtml = raw
      ? ` ${this.#dialect.rawHtmlProp}={${this.#dialect.rawHtmlValue(raw.expr.code)}}`
      : "";
    if (node.void) {
      this.#out.push(concatMapped(`<${node.name}`, attrs, `${rawHtml} />`));
      return;
    }
    // Raw-text elements (`<style>`) keep authored `&…` literal: the browser
    // applies no character references inside them, unlike the JSX decoder.
    const children = raw
      ? concatMapped()
      : content && this.#dialect.textareaContent === "children"
        ? concatMapped("{", content, "}")
        : this.#render(
            node.children,
            undefined,
            !RAW_TEXT_ELEMENTS.has(node.name),
          );
    if (children.code === "") {
      this.#out.push(concatMapped(`<${node.name}`, attrs, `${rawHtml} />`));
      return;
    }
    this.#out.push(
      concatMapped(
        `<${node.name}`,
        attrs,
        `${rawHtml}>`,
        children,
        `</${node.name}>`,
      ),
    );
  }

  component(node: Extract<IrNode, { kind: "Component" }>): void {
    if (node.target.kind === "dynamic") {
      // Marko's own dynamic tag is polymorphic at run time: the target can
      // be a tag-name string, a render function, or already-rendered content
      // (a caller's `input.content`/`children`, passed straight through
      // rather than called again — see the `nested-layout` oracle fixture,
      // where `<${input.content}/>` passes an already-rendered JSX tree, not
      // a callable). JSX's tag position is static, so this host inlines a
      // small `mxDynamic` helper into the module (mirroring `@mxlang/html`'s
      // `renderDynamic`) instead of writing the expression there directly.
      this.#runtimeImports.add("__mxDynamic");
      // Decision 109, Marko parity: args now combine with a body/attribute
      // tag (`assertAttributesOrArgs`, `@marko/compiler/babel-utils`) — only
      // a plain attribute alongside args is still rejected
      // (`rejectArgsWithProps`, core), so `node.attrs` here holds no named
      // attribute when args are present. With content/attribute tags to
      // carry, the trailing props object rides alongside the args array,
      // matching `renderer(...args, { content, <attribute tags> })`.
      const hasContent = (node.content?.children.length ?? 0) > 0;
      const hasTrailingProps = node.attrTagProps.length > 0 || hasContent;
      const payload =
        node.args.length > 0
          ? concatMapped(
              "[",
              ...node.args.flatMap((arg, index) => [
                index === 0 ? "" : ", ",
                arg.code,
              ]),
              hasTrailingProps
                ? concatMapped(", ", this.#propsObject(node))
                : "",
              "]",
            )
          : this.#propsObject(node);
      // decision 112, Marko parity: for a string target with arguments,
      // args[0] (not the trailing props object) becomes the input, matching
      // `runtime-tags/src/html/dynamic-tag.ts`'s `_dynamic_tag`. Content
      // still renders, since Marko threads it independently of `input` — the
      // same reason `@mxlang/html`'s `renderDynamic` takes it as a separate
      // parameter rather than reading it off the (possibly dropped) trailing
      // props object.
      // Only the args-array payload form is ambiguous about a trailing
      // props object being real content: the no-args form's plain props
      // object already carries `content` under that key, read inside
      // `mxDynamic` itself.
      const content =
        node.args.length > 0 && hasContent
          ? concatMapped(
              ", () => <>",
              this.#expression(node.content!.children),
              "</>",
            )
          : "";
      this.#out.push(
        concatMapped(
          "{__mxDynamic(",
          node.target.expr.code,
          ", ",
          payload,
          content,
          ")}",
        ),
      );
      return;
    }
    if (node.target.kind === "define") {
      // A `<define>` is a local block; this host lowers one to a local
      // function (see `define` below), so calling it is an ordinary call.
      //
      // Decision 109, Marko parity: args now combine with a body/attribute
      // tag. A `<define>` has no declared `Input` to destructure a single
      // trailing props object against — measured against real Marko 6.3.51:
      // its own codegen for this shape binds the object itself to whichever
      // param follows the args, not the attribute tag's value, and silently
      // drops the content. MX instead extends its own existing positional
      // named-lookup scheme (`#defineProps`, unaffected below for the
      // no-args case): params beyond the args are filled from the same named
      // lookup, one value per param.
      const args =
        node.args.length > 0
          ? [
              ...node.args.map((arg: Expr) => arg.code),
              ...this.#defineTrailingParams(node),
            ].join(", ")
          : this.#defineProps(node);
      this.#out.push(
        concatMapped(
          "{",
          mapped(node.target.name, node.nameSpan),
          `(${args})}`,
        ),
      );
      return;
    }

    // JSX reads a lowercase or hyphenated tag name as a DOM element whatever
    // it is bound to, so a component Marko resolved under such a name is
    // emitted under a capitalized alias the module binds instead.
    const name = componentAlias(node.target.name);
    if (name !== node.target.name) this.#aliases.add(node.target.name);
    const contentNodes = node.content?.children ?? [];
    rejectMixedRaw(contentNodes);
    const raw = node.content ? rawChild(contentNodes) : null;
    if (raw && hasNamedAttr(node.attrs, this.#dialect.rawHtmlProp)) {
      fail(
        `\`$!{…}\` sole child combined with an explicit \`${this.#dialect.rawHtmlProp}=\` attribute`,
        raw,
      );
    }

    const attrs = this.#attrs(node.attrs, true, true);
    const tags = this.#attributeTagProps(node.attrTagProps, name);

    // A unit that declares `<return>` hands back `{ value, output }`, so the
    // call is evaluated rather than described. With a `/var` it becomes two
    // statements above the `return` and renders its output half here; without
    // one only the output is wanted, and the call can stay an expression.
    if (node.returnsValue) {
      const props = this.#propsObject(node);
      if (node.var) {
        // Every structural kind on this target is an *expression*, so a
        // callback scope has no statement position of its own. Hoisting the
        // call to the component body would take it out of the scope it was
        // written in: inside a `<for>` it would read a row binding that does
        // not exist there and run once for a body that renders N times.
        // Invariant §7.5-8 rejects the escape rather than emitting it.
        if (this.#callbackScope) {
          fail(
            `\`/var\` on \`<${node.authoredName ?? name}>\` inside \`<for>\`/\`<if>\` is not supported on ${this.#dialect.name} yet; bind it at the top level of the template`,
            node,
          );
        }
        const temp = `__mxRet${this.#varSerial.n++}`;
        this.#varStatements.push(`const ${temp} = ${name}(${props});`);
        this.#varStatements.push(`const ${node.var} = ${temp}.value;`);
        this.#out.push(concatMapped(`{${temp}.output}`));
        return;
      }
      this.#out.push(concatMapped("{", `${name}(${props})`, ".output}"));
      return;
    }
    const rawHtml = raw
      ? ` ${this.#dialect.rawHtmlProp}={${this.#dialect.rawHtmlValue(raw.expr.code)}}`
      : "";
    if (!node.content || raw) {
      this.#out.push(
        concatMapped(
          "<",
          mapped(name, node.nameSpan),
          attrs,
          tags,
          `${rawHtml} />`,
        ),
      );
      return;
    }

    // Tag params make the children a render prop — `<For|item| each=…>` is
    // the shape that lets a Preact component taking a function child be
    // called from MX. Without params the children are ordinary JSX children.
    const children = node.content.hasParams
      ? concatMapped(
          `{(${node.content.params.join(", ")}) => `,
          this.#expression(contentNodes, true),
          "}",
        )
      : this.#render(contentNodes, true);
    if (children.code === "") {
      this.#out.push(
        concatMapped("<", mapped(name, node.nameSpan), attrs, tags, " />"),
      );
      return;
    }
    this.#out.push(
      concatMapped(
        "<",
        mapped(name, node.nameSpan),
        attrs,
        tags,
        ">",
        children,
        `</${name}>`,
      ),
    );
  }

  /**
   * The named values a `<define>` call supplies, keyed by name — attributes,
   * attribute tags and (when the body has content) `content`, matching the
   * prop name Marko's own `<${input.content}/>` reads. Shared by
   * `#defineProps` (the no-args call shape) and `#defineTrailingParams` (the
   * args-plus-content/attribute-tag shape, decision 109).
   */
  #defineNamed(
    node: Extract<IrNode, { kind: "Component" }>,
  ): Map<string, string> {
    const named = new Map<string, string>();
    for (const attr of node.attrs) {
      if (attr.kind === "spread") continue;
      named.set(
        attr.name,
        attr.kind === "boolean"
          ? "true"
          : attr.kind === "static"
            ? JSON.stringify(attr.value)
            : attr.value.code,
      );
    }
    // A `<define>` has no exported binding to type an attribute tag's value
    // against (`owner` stays `undefined`, same as a dynamic target); its
    // params are ordinary local shadows, not a declared `Input`.
    for (const prop of node.attrTagProps) {
      named.set(prop.name, this.#attributeTagProp(prop).code);
    }
    const content = node.content?.children ?? [];
    if (content.length > 0) {
      const rendered = this.#expression(content);
      named.set("content", `() => <>${rendered.code}</>`);
    }
    return named;
  }

  /** The props object for a `<define>` called by name rather than positionally. */
  #defineProps(node: Extract<IrNode, { kind: "Component" }>): string {
    if (node.target.kind !== "define") return "";
    const named = this.#defineNamed(node);
    return node.target.params
      .map((param) => named.get(param) ?? "undefined")
      .join(", ");
  }

  /**
   * The positional values for the `<define>` params beyond the tag args
   * (decision 109): a body or attribute tag rides alongside args as
   * additional positional values, one per remaining param, by the same
   * named lookup `#defineProps` uses for the no-args shape.
   */
  #defineTrailingParams(
    node: Extract<IrNode, { kind: "Component" }>,
  ): string[] {
    if (node.target.kind !== "define") return [];
    const named = this.#defineNamed(node);
    return node.target.params
      .slice(node.args.length)
      .map((param) => named.get(param) ?? "undefined");
  }

  /**
   * `<if>`/`<else-if>`/`<else>` as a ternary chain.
   *
   * Preact has no conditional component, so this is what an author writes by
   * hand. A chain with no `<else>` ends in `null`, which renders nothing —
   * the same result Marko gives for an unmatched `<if>`.
   */
  ifChain(node: Extract<IrNode, { kind: "IfChain" }>): void {
    const parts: Array<string | MappedCode> = [];
    for (const branch of node.branches) {
      if (branch.condition) {
        parts.push(
          branch.condition.code,
          " ? ",
          // A branch is a ternary arm: an expression, evaluated lazily.
          this.#expression(branch.children, true),
          " : ",
        );
      } else {
        parts.push(this.#expression(branch.children, true));
      }
    }
    if (node.branches.at(-1)?.condition) parts.push("null");
    this.#out.push(concatMapped("{", ...parts, "}"));
  }

  /**
   * Every `<for>` form as `.map`, with a `key` on each row.
   *
   * `key` is what lets Preact reconcile a list across renders, and a list
   * without one re-creates its rows. MX's `by=` is that key when the author
   * gives one; when they do not, the key is the row's own identity — the item
   * for `of`, the property name for `in`, the index for a range — which is
   * documented in the README as this host's rule rather than left implicit.
   */
  forLoop(node: Extract<IrNode, { kind: "For" }>): void {
    // `.map((item) => …)`: the body is a callback, so a statement written
    // here would have to be hoisted out of the loop to reach the component
    // body — losing both the row binding and the per-row evaluation.
    const body = this.#expression(node.children, true);
    const [first = "item", second] = node.params;
    const source = node.source;

    /** `by=` as a key expression over the row's own binding names. */
    const keyFrom = (fallback: string): string => {
      if (!node.key) return fallback;
      if (node.key.shape === "string") {
        // `by="id"` names a field of the row, exactly as Marko reads it.
        const field =
          node.key.node?.type === "StringLiteral"
            ? node.key.node.value
            : node.key.code.replace(/^['"]|['"]$/g, "");
        return `${first}.${field}`;
      }
      // Any other `by=` is a function of the row, Marko's own contract.
      return `(${node.key.code})(${[first, second].filter(Boolean).join(", ")})`;
    };

    if (source.kind === "of") {
      // The index parameter is emitted only when the author declared one or
      // the key needs it, so an ordinary `<for|item| of=…>` does not leave an
      // unused binding in the callback.
      const params = second ? `${first}, ${second}` : first;
      const key = keyFrom(first);
      const listVar = hygienicName("mxList", node.params, source.list.code);
      this.#out.push(
        concatMapped(
          `{((${listVar}) => ${listVar} ? [...${listVar}] : [])(${source.list.code}).map((${params}) => <__mxFragment key={${key}}>`,
          body,
          "</__mxFragment>)}",
        ),
      );
      this.#runtimeImports.add("__mxFragment");
      return;
    }

    if (source.kind === "in") {
      const value =
        second ??
        hygienicName(
          "value",
          node.params,
          `${body.code} ${source.object.code}`,
        );
      const key = keyFrom(first);
      this.#out.push(
        concatMapped(
          `{Object.entries(${source.object.code} ?? {}).map(([${first}, ${value}]) => <__mxFragment key={${key}}>`,
          body,
          "</__mxFragment>)}",
        ),
      );
      this.#runtimeImports.add("__mxFragment");
      return;
    }

    const from = source.from?.code ?? "0";
    const bound = source.bound.code;
    const step = source.step;
    const counter = rangeCounter(node.params, body.code);
    // The row count, computed the same way for both bound forms: `to=` is
    // inclusive, `until=` is not. `Math.max(0, …)` is what makes a backwards
    // or empty range render nothing rather than throwing on a negative length.
    const span = step
      ? `${source.inclusive ? "Math.floor" : "Math.ceil"}(((${bound}) - (${from})) / (${step.code}))${source.inclusive ? " + 1" : ""}`
      : `(${bound}) - (${from})${source.inclusive ? " + 1" : ""}`;
    const value = step
      ? `(${from}) + ${counter} * (${step.code})`
      : `(${from}) + ${counter}`;
    // One `.map` over the index array, binding the loop value inside the
    // callback rather than in a first pass. Building the values first and
    // mapping them second (the shape this replaced) put the counter out of
    // scope in the callback, so the default `key` referenced an undefined
    // name — a range loop's rows are keyed by their own value, which the
    // author's param already names.
    const key = keyFrom(first);
    this.#out.push(
      concatMapped(
        `{Array.from({ length: Math.max(0, ${span}) }, (${RANGE_MAPPER_UNUSED}, ${counter}) => ${value}).map((${first}) => <__mxFragment key={${key}}>`,
        body,
        "</__mxFragment>)}",
      ),
    );
    this.#runtimeImports.add("__mxFragment");
  }

  /**
   * `<define>` as a local function returning JSX.
   *
   * Unlike Solid's and Astro's hosts, which refuse it because their output is
   * a single expression, a Preact component *is* a function body — so a local
   * block is an ordinary local function and lowers directly. It is emitted
   * into the component's prelude by `emitModule`, not inline, since a function
   * declaration is a statement.
   */
  define(node: Extract<IrNode, { kind: "Define" }>): void {
    if (this.#region && !this.#callbackScope) {
      // The whole-file statement text (`emitModuleWithMappings`). The body is
      // a function of its own, so it renders as a callback: a `/var` inside
      // it has no statement position and is refused, as in any callback.
      this.#region.defines.push(
        concatMapped(
          `const ${node.name} = (${node.params.join(", ")}) => (<>`,
          this.#render(node.children, true),
          "</>);",
        ),
      );
      return;
    }
    fail(
      "`<define>` must appear at the top level of the template; a block declared inside markup cannot be lifted without changing its scope",
      node,
    );
  }

  constant(node: Extract<IrNode, { kind: "Const" }>): void {
    if (this.#region) {
      // A hook in `<const>` would run inside the region, which may itself sit
      // in a conditional: the surrounding component is where it belongs.
      fail(
        `\`<const>\` cannot declare a binding inside a \`.${this.#region.segment}.mx\` expression; declare it in the surrounding component`,
        node,
      );
    }
    fail(
      "`<const>` must appear at the top level of the template; a binding declared inside markup cannot be lifted without changing its scope",
      node,
    );
  }

  hoisted(node: Extract<IrNode, { kind: "Hoisted" }>): void {
    fail("a hoisted statement cannot be emitted inside a JSX expression", node);
  }

  delegatedTag(node: Extract<IrNode, { kind: "DelegatedTag" }>): void {
    const data = node.tag.data as DelegatedTagData;
    if (data.kind !== "try") fail("unknown Preact host-tag lowering", node);

    const catchTag = node.tag.attributeTags.find((tag) => tag.name === "catch");
    const placeholder = node.tag.attributeTags.find(
      (tag) => tag.name === "placeholder",
    );

    let inner = this.#render(node.tag.children);
    if (placeholder) {
      // `<@placeholder>` is what renders while the body is suspended, which on
      // this target means the body threw a promise (a `lazy()` child). Preact
      // gives that through `Suspense`; the package re-exports it under one
      // name so the emitted text is dialect-independent.
      this.#runtimeImports.add(this.#dialect.suspenseName);
      const fallback = this.#expression(placeholder.block.children);
      inner = concatMapped(
        "<__mxSuspense fallback={",
        fallback,
        `}>`,
        inner,
        "</__mxSuspense>",
      );
    }
    if (!catchTag) {
      this.#out.push(inner);
      return;
    }

    // `<@catch|error|>` renders instead of the body when it throws. Preact has
    // no built-in boundary component, only the `componentDidCatch` hook, so
    // the package ships the class that wraps it.
    this.#runtimeImports.add(this.#dialect.errorBoundaryName);
    const params = catchTag.block.params.join(", ");
    const caught = this.#expression(catchTag.block.children);
    const fallback = catchTag.block.hasParams
      ? concatMapped(`(${params}) => `, caught)
      : this.#dialect.errorBoundaryFallbackAlwaysFunction
        ? concatMapped("() => ", caught)
        : caught;
    const fallbackProp = this.#dialect.errorBoundaryFallbackProp ?? "fallback";
    this.#out.push(
      concatMapped(
        `<__mxErrorBoundary ${fallbackProp}={`,
        fallback,
        "}>",
        inner,
        "</__mxErrorBoundary>",
      ),
    );
  }

  documentType(node: Extract<IrNode, { kind: "DocumentType" }>): void {
    fail(
      `a document type (\`<!doctype html>\`) cannot appear in a ${this.#dialect.name} component; write it in the HTML shell that mounts the app`,
      node,
    );
  }

  comment(_node: Extract<IrNode, { kind: "Comment" }>): void {
    // JSX has no comment node that survives to the DOM, and an author-only
    // `//` comment is not output on any host. Dropping both matches the other
    // hosts' treatment.
  }

  done(): string {
    return this.result().code;
  }

  result(): MappedCode {
    return concatMapped(...this.#out);
  }
}

/**
 * An emitter for a region of a `.<segment>.mx` module: a `<define>` outside a
 * callback is lifted (see `liftedDefines`) and `<const>` is refused naming
 * the file kind.
 */
export function createRegionEmitter(
  dialect: JsxDialect,
  segment: string,
): PreactEmitter {
  return new PreactEmitter(
    dialect,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    true,
    { segment, defines: [] },
  );
}

export function createEmitter(
  dialect: JsxDialect = preactDialect,
  typeCheck?: string,
): PreactEmitter {
  return new PreactEmitter(
    dialect,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    typeCheck,
  );
}

/** Emits the template body of a resolved IR as one JSX expression. */
export function emitPreact(
  ir: Ir,
  dialect: JsxDialect = preactDialect,
): string {
  const emitter = createEmitter(dialect);
  drive(emitter, ir.body);
  return emitter.done();
}

export type { DelegatedTagData };
