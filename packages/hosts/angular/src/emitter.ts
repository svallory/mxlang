/**
 * `@mxlang/angular`'s emitter — the structural half (design note A1, task 1.2).
 *
 * Emits an Angular template string from the core IR. `For`, `Define`,
 * `Component`, `HostTag` (other than `html-comment`) and `AttributeTag` are
 * task 1.3: every one of them throws a `TranslateError` naming itself, so a
 * fixture using them fails loudly rather than silently.
 */

import {
  type Attr,
  type Ctx,
  type Emitter,
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
  claimsTag: (name) => name === "try" || name === "html-comment",
  resolveHostTag(name, node): TryData | HtmlCommentData {
    if (name === "try") return { kind: "try" };
    if (name === "html-comment") return { kind: "html-comment" };
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

const MODIFIER_PREFIXES = new Set(["attr", "class", "style"]);

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
          const event = name.slice(2).toLowerCase();
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

function notImplemented(kind: string, node: { loc: Position }): never {
  fail(`angular: <${kind}> not implemented yet`, node);
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

class AngularEmitter implements Emitter<string> {
  private out = "";
  private readonly ctx: Ctx;
  private readonly warnedOnce = new Set<string>();

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  private warnOnce(key: string, message: string, loc: Position): void {
    if (this.warnedOnce.has(key)) return;
    this.warnedOnce.add(key);
    warn(this.ctx, { message, ...loc } as MxWarning);
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
          "$!{…} has no exact Angular equivalent; emitted as [innerHTML], which Angular sanitizes, wrapped in a <span>; invalid inside <tbody>/<select>/<ul>.",
        ...node.loc,
      } as MxWarning);
      this.out += `<span [innerHTML]="${esc(node.expr.code)}"></span>`;
    }
  }

  element(node: Extract<IrNode, { kind: "Element" }>): void {
    const attrs = emitAttrs(node.attrs, (directive) => {
      this.warnOnce(
        directive,
        `this template uses [${directive}]; add ${directive === "ngClass" ? "NgClass" : "NgStyle"} to the component's imports.`,
        node.loc,
      );
    });
    this.out += `<${node.name}${attrs}>`;
    if (node.void) return;
    for (const child of node.children) this.emitNode(child);
    this.out += `</${node.name}>`;
  }

  component(node: Extract<IrNode, { kind: "Component" }>): void {
    notImplemented("Component", node);
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

  forLoop(node: Extract<IrNode, { kind: "For" }>): void {
    notImplemented("For", node);
  }

  define(node: Extract<IrNode, { kind: "Define" }>): void {
    notImplemented("Define", node);
  }

  constant(node: Extract<IrNode, { kind: "Const" }>): void {
    this.out += `@let ${node.name} = ${node.init.code};`;
  }

  hoisted(node: Extract<IrNode, { kind: "Hoisted" }>): void {
    fail(`a \`<Hoisted>\` ${MODULE_LEVEL_MESSAGE}`, node);
  }

  hostTag(node: Extract<IrNode, { kind: "HostTag" }>): void {
    const tag = node.tag;
    const data = tag.data as TryData | HtmlCommentData;
    if (data.kind === "try") {
      fail(TRY_MESSAGE, node);
    }
    // html-comment: text-only, matching packages/hosts/html/src/emitter.ts's
    // own restriction.
    let text = "";
    for (const child of tag.children) {
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
export function emitTemplate(ir: Ir, ctx: Ctx): string {
  const moduleLevel = [
    ...ir.imports,
    ...ir.hoisted,
    ...(ir.inputInterface ? [ir.inputInterface] : []),
  ];
  for (const node of moduleLevel) {
    fail(`a \`<${node.kind}>\` ${MODULE_LEVEL_MESSAGE}`, node);
  }

  const emitter = new AngularEmitter(ctx);
  for (const node of ir.body) emitter.emitNode(node);
  return emitter.done();
}

export { TranslateError };
