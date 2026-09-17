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
 * ## Why the target is a parameter
 *
 * React's lowering is this lowering. The two differ in a handful of *names*
 * (`preact` vs `react` as the JSX import source, `class` vs `className`, which
 * module the error boundary comes from), so those live in `Target` and a React
 * package can reuse this file rather than fork it. See `target.ts` for what
 * belongs in that object and what does not.
 */

import {
  type Attr,
  type AttributeTag,
  concatMapped,
  drive,
  type Emitter,
  type Expr,
  type HostDeclarations,
  type Ir,
  type IrNode,
  type MappedCode,
  mapped,
  type Position,
  TranslateError,
} from "@mxlang/core";
import { preactTarget, type Target } from "./target.ts";

/**
 * The Marko tags this host refuses, each naming what to write instead.
 *
 * Same shape as `@mxlang/solid`'s table, and for the same reason: these are
 * Marko's *own* reactivity, and this target has its own. Decision 65's rule
 * holds — the message says what this target cannot express and where the
 * equivalent lives, never "not implemented".
 */
function statefulErrors(targetName: string): HostDeclarations["tags"] {
  return {
    let: {
      kind: "error",
      reason: `\`<let>\` is Marko reactive state; use ${targetName}'s \`useState\` via \`<const/x=useState(0)/>\` or in the surrounding module`,
    },
    effect: {
      kind: "error",
      reason: `\`<effect>\` is a Marko reactive effect; use ${targetName}'s \`useEffect\` via \`<const/_=useEffect(...)/>\` or in the surrounding module`,
    },
    lifecycle: {
      kind: "error",
      reason: `\`<lifecycle>\` is a Marko lifecycle hook; use ${targetName}'s \`useEffect\`/\`useLayoutEffect\` instead`,
    },
    script: {
      kind: "error",
      reason:
        "`<script>` is a Marko client-runtime tag; write client code in a module the component imports",
    },
    client: {
      kind: "error",
      reason: `a \`client\` block is Marko's client-runtime split; a ${targetName} component is already client code`,
    },
    id: {
      kind: "error",
      reason: `\`<id>\` allocates an identifier for Marko's reactive runtime; use ${targetName}'s \`useId\``,
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

/** What `resolveHostTag` records for a claimed tag. */
type HostTagData = { kind: "try" };

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
    ? `Mx${name.replace(/(?:^|-)([a-z])/g, (_m, ch: string) => ch.toUpperCase())}`
    : name;
}

function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

/** Resolve-time questions for a Preact/React JSX target. */
export function createJsxDeclarations(targetName: string): HostDeclarations {
  return {
    tags: statefulErrors(targetName),
    // Element-vs-component follows Marko's own rule — what the taglib lookup
    // and the template's own bindings resolve the name to — not JSX's casing
    // rule, so a `tags/`-discovered `<badge/>` is the component it is in Marko.
    // The casing difference is handled at emit time by `componentAlias`.
    isElement: (name, ctx) => {
      const taglibId = ctx.lookup?.getTag(name)?.taglibId;
      if (taglibId !== undefined) return ELEMENT_TAGLIBS.has(taglibId);
      return !isComponentName(name);
    },
    isComponent: (name, ctx) => {
      if (ctx.defines?.has(name) || ctx.imports?.has(name)) return true;
      const taglibId = ctx.lookup?.getTag(name)?.taglibId;
      if (taglibId !== undefined) return !ELEMENT_TAGLIBS.has(taglibId);
      return isComponentName(name);
    },
    claimsTag: (name) => name === "try",
    // `<try>` is a core-owned custom tag (`packages/core/src/builtin-tags.ts`):
    // the shape checks that used to live here — no params, no `/var`, one
    // `<@catch>`, one `<@placeholder>` with no params of its own — are the
    // core's `attributeTags` declaration and the tag's own `transform`. This
    // host only decides how the claimed primitive renders.
    resolveHostTag(name, node): HostTagData {
      if (name !== "try")
        rawFail(`unknown ${targetName} host tag ${name}`, node);
      return { kind: "try" };
    },
    rejectModifier(attr) {
      rawFail(
        `attribute modifier \`${attr.name}:${attr.modifier}\` is not ${targetName} syntax; write the prop directly (\`class={{ active: cond }}\` rather than \`class:active\`)`,
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
 * Escapes text for a JSX child position.
 *
 * `{` and `}` open and close an expression container in JSX, so literal
 * braces in template text become entities; left raw they would be parsed as
 * an expression and either fail to compile or silently swallow the text.
 */
function escapeText(value: string): string {
  return value.replace(/[{}]/g, (char) => `&#${char.charCodeAt(0)};`);
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

/** Preact JSX text emitter over the shared core IR. */
export class PreactEmitter implements Emitter<string> {
  readonly #out: MappedCode[] = [];
  readonly #target: Target;
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

  constructor(
    target: Target = preactTarget,
    runtimeImports?: Set<string>,
    aliases?: Set<string>,
    varStatements?: string[],
    varSerial?: { n: number },
    callbackScope = false,
  ) {
    this.#target = target;
    this.#runtimeImports = runtimeImports ?? new Set();
    this.#aliases = aliases ?? new Set();
    this.#varStatements = varStatements ?? [];
    this.#varSerial = varSerial ?? { n: 0 };
    this.#callbackScope = callbackScope;
  }

  /** Statements a `/var` call site needs above the component's `return`. */
  get varStatements(): string[] {
    return this.#varStatements;
  }

  /** Component names that need a capitalized alias in the emitted module. */
  get aliases(): Set<string> {
    return this.#aliases;
  }

  /** The runtime helper names this emitter's output references. */
  get runtimeImports(): Set<string> {
    return this.#runtimeImports;
  }

  /** A child emitter sharing this one's target and import collection. */
  #child(callbackScope = this.#callbackScope): PreactEmitter {
    return new PreactEmitter(
      this.#target,
      this.#runtimeImports,
      this.#aliases,
      this.#varStatements,
      this.#varSerial,
      callbackScope,
    );
  }

  #render(nodes: IrNode[], callbackScope?: boolean): MappedCode {
    const child = this.#child(callbackScope);
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
        only.kind === "HostTag"
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
          `\`:=\` is Marko's two-way binding; ${this.#target.name} has no equivalent — pass the value and an explicit \`onInput\` handler`,
          attr,
        );
      // Phase A of `dom-events` (decision 101): core now lowers an element's
      // `on<Name>`/`on-<exact>` to `kind: "event"`. TEMPORARY passthrough
      // reproducing exactly what the `dynamic` case produced for the same
      // attribute before the kind existed, so this PR is output-neutral;
      // phase B replaces it with the shared JSX hosts' ruled emission
      // (camelCase recomposed from `attr.event`, React's inverse rename map,
      // and a uniform error for a custom DOM event).
      case "event":
        return methodExpression(attr.value) ?? attr.value.code;
      case "dynamic": {
        if (attr.name === "class") {
          const fixed = staticTemplateValue(attr.value);
          if (fixed !== null) return JSON.stringify(fixed);
          if (attr.value.shape === "object" || attr.value.shape === "array") {
            this.#runtimeImports.add("mxClass");
            return `mxClass(${attr.value.code})`;
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

  #attr(attr: Attr, mapName: boolean, isComponent: boolean): MappedCode {
    switch (attr.kind) {
      case "spread":
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
          `\`:=\` is Marko's two-way binding; ${this.#target.name} has no equivalent — pass the value and an explicit \`onInput\` handler`,
          attr,
        );
      // Phase A of `dom-events` (decision 101): core now lowers an element's
      // `on<Name>`/`on-<exact>` to `kind: "event"`. TEMPORARY passthrough
      // reproducing exactly what the `dynamic` case produced for the same
      // attribute before the kind existed, so this PR is output-neutral;
      // phase B replaces it with the shared JSX hosts' ruled emission
      // (camelCase recomposed from `attr.event`, React's inverse rename map,
      // and a uniform error for a custom DOM event).
      case "event": {
        const name = this.#attrName(attr.name, isComponent);
        return concatMapped(
          " ",
          mapped(name, mapName ? attr.nameSpan : null),
          `={${methodExpression(attr.value) ?? attr.value.code}}`,
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
            this.#runtimeImports.add("mxClass");
            return concatMapped(
              " ",
              mapped(name, mapName ? attr.nameSpan : null),
              `={mxClass(${attr.value.code})}`,
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
          `={${methodExpression(attr.value) ?? attr.value.code}}`,
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
    if (name === "class") return this.#target.classAttr;
    if (name === "for") return this.#target.forAttr;
    return name;
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
  #attrs(attrs: Attr[], mapNames: boolean, isComponent: boolean): MappedCode {
    return concatMapped(
      ...attrs.map((attr) => this.#attr(attr, mapNames, isComponent)),
    );
  }

  /** One attribute tag's body, as the value its prop takes. */
  #attributeTagValue(tag: AttributeTag): MappedCode {
    // An attribute tag's body becomes a prop value, and with params a
    // function — either way a scope the component body's statements cannot
    // reach.
    const value = this.#expression(tag.block.children, true);
    if (!tag.block.hasParams) return value;
    return concatMapped(`(${tag.block.params.join(", ")}) => `, value);
  }

  /**
   * A component's attribute tags, as props.
   *
   * A name given more than once becomes an **array**, exactly as Marko does
   * it — which is what lets the callee write
   * `<for|it| of=input.item><${it}/></for>` over `<@item>` repeated. Emitting
   * the prop twice instead (the shape this replaced) let the last one win, so
   * the callee's loop iterated a single node and threw on the spread.
   */
  #attributeTags(tags: AttributeTag[]): MappedCode {
    const byName = new Map<
      string,
      Array<{ tag: AttributeTag; value: MappedCode }>
    >();
    for (const tag of tags) {
      const values = byName.get(tag.name);
      const value = { tag, value: this.#attributeTagValue(tag) };
      if (values) values.push(value);
      else byName.set(tag.name, [value]);
    }
    return concatMapped(
      ...[...byName].map(([name, values]) => {
        const nameCode = mapped(name, values[0]?.tag.nameSpan ?? null);
        if (values.length === 1) {
          return concatMapped(" ", nameCode, "={", values[0]?.value ?? "", "}");
        }
        const joined = values.flatMap(({ value }, index) =>
          index === 0 ? [value] : [", ", value],
        );
        // Only the first occurrence's name has a real position in the
        // generated text (the emitted prop name, `name={[...`); a repeated
        // `<@name>` contributes another array entry with no name string of
        // its own to map to, so it gets no mapping at all rather than a
        // fabricated one pointing at the first occurrence's position.
        return concatMapped(" ", nameCode, "={[", ...joined, "]}");
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
    for (const attr of node.attrs) {
      if (attr.kind === "spread") {
        parts.push(`...${attr.value.code}`);
        continue;
      }
      // A component's props are its author's `Input` contract, so names are
      // never renamed here — the same rule `#attrName(name, true)` applies.
      parts.push(`${JSON.stringify(attr.name)}: ${this.#attrValue(attr)}`);
    }

    // Repeated `<@name>` becomes an array, exactly as in attribute syntax.
    const byName = new Map<string, MappedCode[]>();
    for (const tag of node.attributeTags) {
      const values = byName.get(tag.name);
      const value = this.#attributeTagValue(tag);
      if (values) values.push(value);
      else byName.set(tag.name, [value]);
    }
    for (const [name, values] of byName) {
      const codes = values.map((value) => value.code);
      parts.push(
        `${JSON.stringify(name)}: ${
          codes.length === 1 ? codes[0] : `[${codes.join(", ")}]`
        }`,
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
    this.#out.push(concatMapped(escapeText(node.value)));
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
    if (raw && hasNamedAttr(node.attrs, this.#target.rawHtmlProp)) {
      fail(
        `\`$!{…}\` sole child combined with an explicit \`${this.#target.rawHtmlProp}=\` attribute`,
        raw,
      );
    }
    const attrs = this.#attrs(node.attrs, false, false);
    const rawHtml = raw
      ? ` ${this.#target.rawHtmlProp}={${this.#target.rawHtmlValue(raw.expr.code)}}`
      : "";
    if (node.void) {
      this.#out.push(concatMapped(`<${node.name}`, attrs, `${rawHtml} />`));
      return;
    }
    const children = raw ? concatMapped() : this.#render(node.children);
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
      this.#runtimeImports.add("mxDynamic");
      const props = this.#propsObject(node);
      this.#out.push(
        concatMapped("{mxDynamic(", node.target.expr.code, ", ", props, ")}"),
      );
      return;
    }
    if (node.target.kind === "define") {
      // A `<define>` is a local block; this host lowers one to a local
      // function (see `define` below), so calling it is an ordinary call.
      const args =
        node.args.length > 0
          ? node.args.map((arg: Expr) => arg.code).join(", ")
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
    if (raw && hasNamedAttr(node.attrs, this.#target.rawHtmlProp)) {
      fail(
        `\`$!{…}\` sole child combined with an explicit \`${this.#target.rawHtmlProp}=\` attribute`,
        raw,
      );
    }

    const attrs = this.#attrs(node.attrs, true, true);
    const tags = this.#attributeTags(node.attributeTags);

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
            `\`/var\` on \`<${node.authoredName ?? name}>\` inside \`<for>\`/\`<if>\` is not supported on ${this.#target.name} yet; bind it at the top level of the template`,
            node,
          );
        }
        const temp = `$mx_ret${this.#varSerial.n++}`;
        this.#varStatements.push(`const ${temp} = ${name}(${props});`);
        this.#varStatements.push(`const ${node.var} = ${temp}.value;`);
        this.#out.push(concatMapped(`{${temp}.output}`));
        return;
      }
      this.#out.push(concatMapped("{", `${name}(${props})`, ".output}"));
      return;
    }
    const rawHtml = raw
      ? ` ${this.#target.rawHtmlProp}={${this.#target.rawHtmlValue(raw.expr.code)}}`
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

  /** The props object for a `<define>` called by name rather than positionally. */
  #defineProps(node: Extract<IrNode, { kind: "Component" }>): string {
    if (node.target.kind !== "define") return "";
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
    return node.target.params
      .map((param) => named.get(param) ?? "undefined")
      .join(", ");
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
      this.#out.push(
        concatMapped(
          `{[...${source.list.code}].map((${params}) => <Fragment key={${key}}>`,
          body,
          "</Fragment>)}",
        ),
      );
      this.#runtimeImports.add("Fragment");
      return;
    }

    if (source.kind === "in") {
      const value = second ?? "value";
      const key = keyFrom(first);
      this.#out.push(
        concatMapped(
          `{Object.entries(${source.object.code}).map(([${first}, ${value}]) => <Fragment key={${key}}>`,
          body,
          "</Fragment>)}",
        ),
      );
      this.#runtimeImports.add("Fragment");
      return;
    }

    const from = source.from?.code ?? "0";
    const bound = source.bound.code;
    const step = source.step;
    const counter = hygienicName("mxIndex", node.params, body.code);
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
        `{Array.from({ length: Math.max(0, ${span}) }, (_, ${counter}) => ${value}).map((${first}) => <Fragment key={${key}}>`,
        body,
        "</Fragment>)}",
      ),
    );
    this.#runtimeImports.add("Fragment");
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
    fail(
      "`<define>` must appear at the top level of the template; a block declared inside markup cannot be lifted without changing its scope",
      node,
    );
  }

  constant(node: Extract<IrNode, { kind: "Const" }>): void {
    fail(
      "`<const>` must appear at the top level of the template; a binding declared inside markup cannot be lifted without changing its scope",
      node,
    );
  }

  hoisted(node: Extract<IrNode, { kind: "Hoisted" }>): void {
    fail("a hoisted statement cannot be emitted inside a JSX expression", node);
  }

  hostTag(node: Extract<IrNode, { kind: "HostTag" }>): void {
    const data = node.tag.data as HostTagData;
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
      // name so the emitted text is target-independent.
      this.#runtimeImports.add(this.#target.suspenseName);
      const fallback = this.#expression(placeholder.block.children);
      inner = concatMapped(
        `<${this.#target.suspenseName} fallback={`,
        fallback,
        `}>`,
        inner,
        `</${this.#target.suspenseName}>`,
      );
    }
    if (!catchTag) {
      this.#out.push(inner);
      return;
    }

    // `<@catch|error|>` renders instead of the body when it throws. Preact has
    // no built-in boundary component, only the `componentDidCatch` hook, so
    // the package ships the class that wraps it.
    this.#runtimeImports.add(this.#target.errorBoundaryName);
    const params = catchTag.block.params.join(", ");
    const caught = this.#expression(catchTag.block.children);
    const fallback = catchTag.block.hasParams
      ? concatMapped(`(${params}) => `, caught)
      : this.#target.errorBoundaryFallbackAlwaysFunction
        ? concatMapped("() => ", caught)
        : caught;
    const fallbackProp = this.#target.errorBoundaryFallbackProp ?? "fallback";
    this.#out.push(
      concatMapped(
        `<${this.#target.errorBoundaryName} ${fallbackProp}={`,
        fallback,
        "}>",
        inner,
        `</${this.#target.errorBoundaryName}>`,
      ),
    );
  }

  documentType(node: Extract<IrNode, { kind: "DocumentType" }>): void {
    fail(
      `a document type (\`<!doctype html>\`) cannot appear in a ${this.#target.name} component; write it in the HTML shell that mounts the app`,
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

export function createEmitter(target: Target = preactTarget): PreactEmitter {
  return new PreactEmitter(target);
}

/** Emits the template body of a resolved IR as one JSX expression. */
export function emitPreact(ir: Ir, target: Target = preactTarget): string {
  const emitter = createEmitter(target);
  drive(emitter, ir.body);
  return emitter.done();
}

export type { HostTagData };
