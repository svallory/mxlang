/**
 * `@mxlang/angular`'s emitter (design note A1/A2, tasks 1.2 and 1.3).
 *
 * Emits an Angular template string from the core IR.
 */

import {
  type Attr,
  type ComponentTarget,
  type Ctx,
  DYNAMIC_TAG,
  type Emitter,
  type Expr,
  expr,
  type ForSource,
  type HostDeclarations,
  type Ir,
  type IrNode,
  type MxWarning,
  type Position,
  TranslateError,
  warn,
} from "@mxlang/core";

type TryData = { kind: "try" };
type HtmlCommentData = { kind: "html-comment" };
type DynamicComponentData = { kind: "dynamic-component"; expr: string };

function positionOf(node: { loc: Position }): Position {
  return node.loc;
}

function fail(message: string, node: { loc: Position }): never {
  const { line, column } = positionOf(node);
  throw new TranslateError(message, line, column);
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
  const { line, column } = rawPosition(node);
  throw new TranslateError(message, line, column);
}

const MODULE_LEVEL_MESSAGE =
  "cannot be emitted into an Angular template: an Angular template has no module scope. Move it into the component's TypeScript file, or use `.ng.mx` (step 2), where MX emits the module for you.";

const TRY_MESSAGE =
  "`<try>` cannot be emitted into an Angular template: Angular has no template-level error boundary. `@defer`'s `@error` block only covers a failed lazy chunk load, not a render error. Handle the error in the component and render the fallback with `<if>`.";

/** Resolve-time questions for Angular's template target. */
export const angularDeclarations: HostDeclarations = {
  tags: {
    try: { kind: "error", reason: TRY_MESSAGE },
  },
  isElement: (name) => !/^[A-Z]/.test(name),
  isComponent: (name) => /^[A-Z]/.test(name),
  claimsTag: (name) =>
    name === "try" || name === "html-comment" || name === DYNAMIC_TAG,
  resolveHostTag(
    name,
    node,
    ctx,
  ): TryData | HtmlCommentData | DynamicComponentData {
    if (name === "try") return { kind: "try" };
    if (name === "html-comment") return { kind: "html-comment" };
    if (name === DYNAMIC_TAG) {
      return { kind: "dynamic-component", expr: expr(ctx, node.name) };
    }
    rawFail(`unknown Angular host tag ${name}`, node);
  },
  // Marko's own node shape: `attr.name` is the modifier prefix
  // (`attr`/`class`/`style`) and `attr.modifier` is the attribute name that
  // follows the colon (measured: `attr:aria-label=l` gives
  // `{ name: "attr", modifier: "aria-label" }`).
  resolveModifier(attr): string | undefined {
    const prefix = (attr as unknown as { name: string }).name;
    const target = (attr as unknown as { modifier?: string }).modifier;
    if (prefix === "attr" || prefix === "class" || prefix === "style") {
      return `${prefix}:${target}`;
    }
    return undefined;
  },
  rejectModifier(attr): void {
    const prefix = (attr as unknown as { name: string }).name;
    const target = (attr as unknown as { modifier?: string }).modifier;
    rawFail(
      `attribute modifier \`${prefix}:${target}\` is not supported by Angular`,
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
 * `{{ '}' }}`); `@` before a lowercase identifier -> `&#64;`.
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
  return value
    .replace(/[{}]/g, (char) => `{{ '${char}' }}`)
    .replace(AT_LOWER, "&#64;");
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// An event handler: `on` followed by an uppercase letter (`onClick`, not
// `once`/`onto`, matching React/Preact's own event-name convention).
const EVENT_NAME = /^on[A-Z]/;

// Irregular DOM event names that don't survive a plain lowercase of the
// camelCase MX attribute name — `onDoubleClick`.toLowerCase().slice(2) would
// give `doubleclick`, not the real DOM event `dblclick`. Preact/React pass
// event names straight through as JSX prop names, so neither host's own
// emitter has a table to reuse; this one is needed because Angular's `(x)`
// binds a real DOM event name, not a framework-level prop. Extend as a real
// gap turns up rather than trying to be exhaustive up front.
const IRREGULAR_EVENTS: Record<string, string> = {
  onDoubleClick: "dblclick",
  onMouseEnter: "mouseenter",
  onMouseLeave: "mouseleave",
  onFocusIn: "focusin",
  onFocusOut: "focusout",
};

function domEventName(attrName: string): string {
  return IRREGULAR_EVENTS[attrName] ?? attrName.slice(2).toLowerCase();
}

const MODIFIER_PREFIXES = new Set(["attr", "class", "style"]);

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

function emitAttrs(
  attrs: Attr[],
  onceWarn: (kind: "ngClass" | "ngStyle") => void,
): string {
  let out = "";
  for (const attr of attrs) {
    switch (attr.kind) {
      case "static":
        out += ` ${attr.name}="${esc(attr.value)}"`;
        break;
      case "boolean":
        out += ` ${attr.name}`;
        break;
      case "dynamic": {
        const name = attr.name;
        if (EVENT_NAME.test(name)) {
          const event = domEventName(name);
          out += ` (${event})="(${esc(attr.value.code)})($event)"`;
        } else if (name === "class" || name === "style") {
          const shape = attr.value.shape;
          if (shape === "object" || shape === "array") {
            const directive = name === "class" ? "ngClass" : "ngStyle";
            onceWarn(directive);
            out += ` [${directive}]="${esc(attr.value.code)}"`;
          } else {
            out += ` [${name}]="${esc(attr.value.code)}"`;
          }
        } else if (name.includes(":")) {
          const [prefix, target] = name.split(":", 2);
          if (!MODIFIER_PREFIXES.has(prefix ?? "")) {
            fail(
              `attribute modifier \`${name}\` is not supported by Angular`,
              attr,
            );
          }
          out += ` [${prefix}.${target}]="${esc(attr.value.code)}"`;
        } else {
          out += ` [${name}]="${esc(attr.value.code)}"`;
        }
        break;
      }
      case "bound":
        out += ` [(${attr.name})]="${esc(attr.value.code)}"`;
        break;
      case "spread":
        fail(
          "a spread attribute cannot be emitted into an Angular template, because Angular binds statically named inputs only. Name the attributes, or pass the object to a single input.",
          attr,
        );
    }
  }
  return out;
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
function kebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase();
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
      return `${row}.${(key.node as unknown as { value: string }).value}`;
    }
    if (key.node?.type === "TemplateLiteral") {
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
    const arrow = key.node as unknown as {
      params: Array<{ type: string; name?: string }>;
      body: {
        type: string;
        loc?: { start: { index: number }; end: { index: number } };
      };
      loc?: { start: { index: number } };
    };
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
      return (expr.node as unknown as { value: number }).value;
    }
    // A unary minus over a numeric literal (`step=-1`) parses as a
    // UnaryExpression, not a NumericLiteral — Babel's own shape for a
    // negative literal.
    if (
      expr.node?.type === "UnaryExpression" &&
      (expr.node as unknown as { operator: string }).operator === "-" &&
      (expr.node as unknown as { argument: { type: string } }).argument.type ===
        "NumericLiteral"
    ) {
      return -(expr.node as unknown as { argument: { value: number } }).argument
        .value;
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
  private out = "";
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

  constructor(ctx: Ctx, filename: string) {
    this.ctx = ctx;
    // `x.component.mx` -> `x.component.ts`, the emitted sibling the step-1
    // import warning tells the author to edit. Falls back to the bare
    // filename with a `.ts` extension when it has none of MX's own.
    this.tsFilename = filename.replace(/\.mx$/, ".ts");
  }

  private warnOnce(key: string, message: string, loc: Position): void {
    if (this.warnedOnce.has(key)) return;
    this.warnedOnce.add(key);
    warn(this.ctx, { message, ...loc } as MxWarning);
  }

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
    this.out += escapeText(node.value);
  }

  interpolation(node: Extract<IrNode, { kind: "Interpolation" }>): void {
    if (node.escaped) {
      this.out += `{{ ${node.expr.code} }}`;
    } else {
      warn(this.ctx, {
        message:
          "$!{…} has no exact Angular equivalent; emitted as [innerHTML] wrapped in a <span>, which Angular sanitizes. The wrapper is invalid inside <tbody>/<select>/<ul>, where only certain child elements are allowed — restructure those cases.",
        ...node.loc,
      } as MxWarning);
      this.out += `<span [innerHTML]="${esc(node.expr.code)}"></span>`;
    }
  }

  element(node: Extract<IrNode, { kind: "Element" }>): void {
    const attrs = emitAttrs(node.attrs, (directive) => {
      this.warnOnce(directive, NGCLASS_NGSTYLE_WARNING[directive], node.loc);
    });
    this.out += `<${node.name}${attrs}>`;
    if (node.void) return;
    for (const child of node.children) this.emitNode(child);
    this.out += `</${node.name}>`;
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
        // Dead per the core's actual lowering: `lower.ts`'s `lowerTag`
        // routes every `<${expr}/>` to `HostTag` (the `DYNAMIC_TAG`
        // sentinel), never to `Component.target.kind === "dynamic"` — see
        // `hostTag()`'s `dynamic-component` branch for the real path.
        // Kept for IR exhaustiveness only.
        fail(
          "`<${…}>` cannot reach `Component`'s dynamic-target path; the core's own lowering routes it through `HostTag` instead — this indicates a lowering change upstream.",
          node,
        );
    }
  }

  private emitNamedComponent(
    node: Extract<IrNode, { kind: "Component" }>,
    target: Extract<ComponentTarget, { kind: "name" }>,
  ): void {
    if (node.content?.hasParams) {
      fail(
        `\`<${target.name}|…|>\` passes parameters to its content, which Angular's content projection cannot express. Declare the block as a \`<define>\` and pass it as an input the component renders with \`ngTemplateOutlet\`.`,
        node,
      );
    }
    const selector = `mx-${kebabCase(target.name)}`;
    const attrs = emitAttrs(node.attrs, (directive) => {
      this.warnOnce(directive, NGCLASS_NGSTYLE_WARNING[directive], node.loc);
    });
    if (!this.usedTags.has(target.name)) {
      this.usedTags.set(target.name, node.loc);
    }
    this.out += `<${selector}${attrs}>`;
    const seenAttributeTags = new Set<string>();
    for (const tag of node.attributeTags) {
      if (tag.block.hasParams) {
        fail(
          `\`<${target.name}><@${tag.name}|…|>\` passes parameters to its content, which Angular's content projection cannot express. Declare the block as a \`<define>\` and pass it as an input the component renders with \`ngTemplateOutlet\`.`,
          tag,
        );
      }
      if (seenAttributeTags.has(tag.name)) {
        fail(
          "a repeated attribute tag cannot be emitted as Angular content projection, which matches each selector once. Take the items as an input array and render them with `<for>`.",
          tag,
        );
      }
      seenAttributeTags.add(tag.name);
      this.out += `<ng-container ngProjectAs="[${tag.name}]">`;
      for (const child of tag.block.children) this.emitNode(child);
      this.out += "</ng-container>";
    }
    if (node.content) {
      for (const child of node.content.children) this.emitNode(child);
    }
    this.out += `</${selector}>`;
  }

  private emitDefineCall(
    node: Extract<IrNode, { kind: "Component" }>,
    target: Extract<ComponentTarget, { kind: "define" }>,
  ): void {
    if (node.args.length !== target.params.length) {
      fail(
        `\`<${target.name}>\` expects ${target.params.length} argument(s), got ${node.args.length}`,
        node,
      );
    }
    const context =
      target.params.length === 0
        ? "{}"
        : `{ ${target.params
            .map((param, i) =>
              i === 0
                ? `$implicit: ${node.args[i]?.code}`
                : `${param}: ${node.args[i]?.code}`,
            )
            .join(", ")} }`;
    this.out += `<ng-container [ngTemplateOutlet]="${target.name}" [ngTemplateOutletContext]="${esc(context)}"></ng-container>`;
  }

  private emitDynamicComponent(
    exprCode: string,
    attrs: Attr[],
    hasContent: boolean,
    node: { loc: Position },
  ): void {
    if (hasContent) {
      fail(
        "`<${…}>` with content cannot be emitted into an Angular template: `ngComponentOutlet` projects content only through `ngComponentOutletContent`, which takes prepared nodes rather than a template body. Use a static component tag, or render the content into a `<define>` and pass it as an input.",
        node,
      );
    }
    this.warnOnce(
      "ngComponentOutlet",
      "this template uses [ngComponentOutlet]; add NgComponentOutlet to the component's imports.",
      node.loc,
    );
    const inputs = attrs
      .map((attr) => {
        if (attr.kind === "dynamic") return `${attr.name}: ${attr.value.code}`;
        // JSON.stringify for the JS-literal layer (a `"` or `\` in the
        // attribute value must be escaped as JS, e.g. `\"`), then `esc()`
        // for the surrounding HTML attribute layer on the whole
        // `[ngComponentOutletInputs]="..."` string below — two passes for
        // two nesting layers. Building this with a plain `"${attr.value}"`
        // corrupted the output on a value containing `"`.
        if (attr.kind === "static")
          return `${attr.name}: ${JSON.stringify(attr.value)}`;
        return fail(
          `attribute kind \`${attr.kind}\` cannot be passed to a dynamic component outlet`,
          attr,
        );
      })
      .join(", ");
    const inputsAttr = inputs
      ? ` [ngComponentOutletInputs]="${esc(`{ ${inputs} }`)}"`
      : "";
    this.out += `<ng-container [ngComponentOutlet]="${esc(exprCode)}"${inputsAttr}></ng-container>`;
  }

  ifChain(node: Extract<IrNode, { kind: "IfChain" }>): void {
    node.branches.forEach((branch, i) => {
      const close = i === 0 ? "" : "} ";
      if (branch.condition === null) {
        this.out += `${close}@else { `;
      } else if (i === 0) {
        this.out += `@if (${branch.condition.code}) { `;
      } else {
        this.out += `${close}@else if (${branch.condition.code}) { `;
      }
      for (const child of branch.children) this.emitNode(child);
      this.out += " ";
    });
    this.out += "}";
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
      return { row: this.gensym("mxRow"), destructure: fields };
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
      this.out += `@for (${row} of ${source.list.code}; track ${track}${aliasLets}) { `;
      for (const field of destructure) {
        this.out += `@let ${field} = ${row}.${field}; `;
      }
      for (const child of node.children) this.emitNode(child);
      this.out += " }";
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
      const entry = this.gensym("mxEntry");
      this.out += `@for (${entry} of (${source.object.code} | keyvalue: null); track ${entry}.key) { @let ${k} = ${entry}.key; @let ${v} = ${entry}.value; `;
      for (const child of node.children) this.emitNode(child);
      this.out += " }";
      return;
    }
    // range
    const values = bakeRange(source, node);
    const rowNode = node.paramNodes[0];
    const row = this.aliasName(rowNode, "$item");
    this.out += `@for (${row} of [${values.join(", ")}]; track $index) { `;
    for (const child of node.children) this.emitNode(child);
    this.out += " }";
  }

  define(node: Extract<IrNode, { kind: "Define" }>): void {
    const params = node.params.map((p) => `let-${p}`).join(" ");
    this.out += `<ng-template #${node.name}${params ? ` ${params}` : ""}> `;
    for (const child of node.children) this.emitNode(child);
    this.out += " </ng-template>";
  }

  constant(node: Extract<IrNode, { kind: "Const" }>): void {
    this.out += `@let ${node.name} = ${node.init.code};`;
  }

  hoisted(node: Extract<IrNode, { kind: "Hoisted" }>): void {
    fail(`a \`<Hoisted>\` ${MODULE_LEVEL_MESSAGE}`, node);
  }

  hostTag(node: Extract<IrNode, { kind: "HostTag" }>): void {
    const tag = node.tag;
    const data = tag.data as TryData | HtmlCommentData | DynamicComponentData;
    if (data.kind === "try") {
      fail(TRY_MESSAGE, node);
    }
    if (data.kind === "dynamic-component") {
      // A bare `${expr}` placeholder (no attributes, no body) parses through
      // this exact same core branch as `<${expr} a=1/>` — claiming
      // `DYNAMIC_TAG` is a single boolean gate covering both shapes
      // (`lower.ts`'s `lowerTag`), so the split has to happen here instead.
      // With neither attrs nor children this is a plain interpolation, not a
      // component call.
      if (tag.attrs.length === 0 && tag.children.length === 0) {
        this.out += `{{ ${data.expr} }}`;
        return;
      }
      this.emitDynamicComponent(
        data.expr,
        tag.attrs,
        tag.children.length > 0,
        node,
      );
      return;
    }
    // html-comment: text-only. `@mxlang/html`'s own emitter accepts an
    // `Interpolation` child too (`packages/hosts/html/src/emitter.ts:604-606`)
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
    this.out += `<!-- ${text} -->`;
  }

  documentType(node: Extract<IrNode, { kind: "DocumentType" }>): void {
    warn(this.ctx, {
      message:
        "`<!doctype>` parses in an Angular template, but a component template is a fragment.",
      ...node.loc,
    } as MxWarning);
    this.out += `<!${node.value}>`;
  }

  comment(node: Extract<IrNode, { kind: "Comment" }>): void {
    if (!node.html) return;
    checkCommentText(node.value, node);
    this.out += `<!--${node.value}-->`;
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
      const lines = names
        .map(
          (name) =>
            `\`import ${name} from "./tags/${kebabCase(name)}";\` and \`imports: [${name}]\``,
        )
        .join(", ");
      warn(this.ctx, {
        message: `this template calls ${names.length} MX tag(s): ${names.map((n) => `\`${n}\``).join(", ")}. In step 1, MX cannot edit your component's TypeScript. Add to ${this.tsFilename}: ${lines}.`,
        ...loc,
      } as MxWarning);
    }
    return this.out;
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
      case "HostTag":
        this.hostTag(node);
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

/** Emits an Angular template string from the resolved IR. */
export function emitTemplate(ir: Ir, ctx: Ctx, filename: string): string {
  const moduleLevel = [
    ...ir.imports,
    ...ir.hoisted,
    ...(ir.inputInterface ? [ir.inputInterface] : []),
  ];
  for (const node of moduleLevel) {
    fail(`a \`<${node.kind}>\` ${MODULE_LEVEL_MESSAGE}`, node);
  }

  const emitter = new AngularEmitter(ctx, filename);
  for (const node of ir.body) emitter.emitNode(node);
  return emitter.done();
}

export { TranslateError };
