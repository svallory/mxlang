/**
 * The MX → Astro-template emitter (decisions 76c, 78 and 79).
 *
 * An `.astro.mx` file keeps Astro's TypeScript frontmatter byte-for-byte and uses
 * MX for the template that follows it. The core parses that template,
 * resolves Marko nodes into its host-independent IR, and drives the emitter in
 * this file. No emission path here inspects a Marko node.
 */

import {
  ATTRIBUTE_SPREAD_EXPRESSION as ATTRIBUTE_SPREAD_SOURCE,
  ATTRIBUTE_VALUE_EXPRESSION as ATTRIBUTE_VALUE_SOURCE,
  type Attr,
  type AttributeTag,
  type AttributeTagNode,
  type AttrTagProp,
  type Ctx,
  type CustomTag,
  checkReservedSource,
  contractDefaultTag,
  createTargetLookup,
  DYNAMIC_TAG,
  drive,
  type Emitter,
  type Expr,
  emit,
  firstAttributeTag,
  type HostDeclarations,
  type Ir,
  type IrNode,
  isTranslateError,
  lower,
  type MxWarning,
  type Node,
  newCtx,
  parseFragment,
  rejectUnsupportedFields,
  type TargetLookup,
  unresolvedCustomTagMessage,
} from "@mxlang/core";
import {
  type SourceBindingsError,
  sourceBindings,
  unknownSourceBindings,
} from "@mxlang/tsx-bridge";
import { WEB_ELEMENTS } from "@mxlang/web-elements";
import descriptor from "./descriptor.ts";

/**
 * This package's own target table (decisions 129 and 132): the one descriptor
 * it exports, defaulting for a direct entry that names no lookup of its own
 * (`mxTemplates()`; design note §5.1, rule (c)). A tool compiling several
 * targets passes the built-in registry's lookup through `options.targets`.
 */
const ownTargets: TargetLookup = createTargetLookup([descriptor]);
const ATTRIBUTE_VALUE_EXPRESSION = "__mxAttrValue";
const ATTRIBUTE_SPREAD_EXPRESSION = "__mxAttrSpread";
const ATTRIBUTE_OUT_EXPRESSION = "__mxAttrOut";

/**
 * Marko's primitive attribute values on top of `addAttribute` (decision 149).
 * Astro's own rules: null/undefined omit, `false`/`true` print as text, a name
 * on its boolean-attribute list prints by truthiness only, `class`/`style`
 * print any non-nullish primitive. Marko omits `false`, prints `true` bare, omits
 * a falsy `class`/`style` and prints `true` there as "true". `""` is bare only
 * outside Astro's boolean list, where `""` is falsy and omitted, so those names
 * get `true`: presence is equal to Marko's, but the value text (`disabled="0"`)
 * cannot be printed by `addAttribute`.
 */
export const ATTRIBUTE_OUT_SOURCE = `((name: string, value: unknown): unknown => {
  if (value == null) return null;
  if (name === "class" || name === "style") return value === true ? "true" : value === false || value === 0 || value === "" || value !== value ? null : value;
  if (/^(?:allowfullscreen|async|autofocus|autoplay|checked|controls|default|defer|disabled|disablepictureinpicture|disableremoteplayback|formnovalidate|inert|loop|muted|nomodule|novalidate|open|playsinline|readonly|required|reversed|scoped|seamless|selected|itemscope)$/i.test(name)) return value === false ? null : true;
  return value === false ? null : value === true ? "" : value;
})`;

/** `__mxAttrSpread` plus the primitive normalization of every merged key. */
const ATTRIBUTE_SPREAD_OUT_SOURCE = `((guard: (attrs: any, tag?: string) => any) => (attrs: any, tag?: string): any => {
  const values: Record<string, unknown> | null | undefined = guard(attrs, tag);
  if (values === null || values === undefined) return values;
  for (const name of Object.keys(values)) values[name] = ${ATTRIBUTE_OUT_EXPRESSION}(name, values[name]);
  return values;
})(${ATTRIBUTE_SPREAD_SOURCE})`;
const COMMENT_VALUE_EXPRESSION = "__mxCommentValue";
const TEXTAREA_CONTENT_EXPRESSION = "__mxTextareaContent";
/** Marko's `_textarea_value`: nullish/boolean render nothing, and a leading newline is doubled (a parser drops the first). */
const TEXTAREA_CONTENT_SOURCE = String.raw`(v: unknown): string => {
  const text = v === null || v === undefined || v === false || v === true ? "" : v + "";
  return text[0] === "\n" ? "\n" + text : text;
}`;
/** Marko's `_escape_comment` / `_unescaped`: falsy renders nothing except `0`; unrenderable values throw Marko's debug text. */
const COMMENT_VALUE_SOURCE = String.raw`(v: any, escaped: boolean) => {
  if (typeof v === "symbol") throw new Error("Text content cannot be a symbol.");
  if (typeof v === "object" && v !== null) {
    let text;
    try { text = "" + v; } catch { text = "[object Object]"; }
    if (/^\[object \w+\]$/.test(text)) {
      throw new Error("Text content cannot be " + (text === "[object Promise]" ? "a promise (use the \u0060<await>\u0060 tag to render its resolved value)" : text === "[object Object]" ? "a plain object (it would render as \u0060[object Object]\u0060)" : "a value that renders as \u0060" + text + "\u0060") + ".");
    }
  }
  const text = v ? v + "" : v === 0 ? "0" : "";
  return escaped ? text.replace(/>/g, "&gt;") : text;
}`;

/**
 * This package's own target lookup, for a direct entry that needs one and has
 * no registry to hand (`mxTemplates()`; design note §5.1, rule (c)). Exported
 * so those entry points share one instance rather than one per call.
 */
export const astroTargets = ownTargets;

/**
 * A lowering failure positioned in the enclosing `.astro.mx` file, or — when
 * `file` is set — in a tag template it called (spec §2's third position
 * rule, carried through from a `TranslateError`).
 */
export class AstroTemplateError extends Error {
  line: number;
  column: number;
  file?: string;

  constructor(message: string, line: number, column: number, file?: string) {
    super(message);
    this.name = "AstroTemplateError";
    this.line = line;
    this.column = column;
    this.file = file;
  }
}

type Positioned = { loc: { line: number; column: number } };

function fail(message: string, node: Positioned | Node): never {
  const start = node?.loc?.start ?? node?.loc ?? { line: 0, column: 0 };
  throw new AstroTemplateError(message, start.line ?? 0, start.column ?? 0);
}

const TAGS: HostDeclarations["tags"] = {
  let: {
    kind: "error",
    reason:
      "`<let>` is reactive state and requires a runtime; `.astro.mx` renders static markup at build time",
  },
  effect: {
    kind: "error",
    reason:
      "`<effect>` is a reactive effect and requires a runtime; `.astro.mx` renders static markup at build time",
  },
  lifecycle: {
    kind: "error",
    reason:
      "`<lifecycle>` is a reactive lifecycle hook and requires a runtime; `.astro.mx` renders static markup at build time",
  },
  script: {
    kind: "error",
    reason:
      "`<script>` as a Marko tag runs client code and requires a runtime; `.astro.mx` renders static markup at build time",
  },
  client: {
    kind: "error",
    reason:
      "a `client` block is client-only and requires a runtime; `.astro.mx` renders static markup at build time",
  },
  server: {
    kind: "error",
    reason:
      "a `server` block runs a statement per render and `.astro.mx` has no render-time statement position; write it in the `---` fence instead",
  },
  id: {
    kind: "error",
    reason:
      "`<id>` allocates an identifier for the reactive runtime; `.astro.mx` renders static markup at build time",
  },
  await: {
    kind: "error",
    reason:
      "`<await>` needs a suspense-capable renderer; `.astro.mx` renders static markup at build time",
  },
  // `<return>` is **not** listed. A `.astro.mx` file cannot declare one — it is an
  // Astro component, whose output is its markup — but this table is consulted
  // while compiling whichever file contains the tag, so an entry here also
  // refused a `.astro.mx` file that merely *called* a returning `.mx` tag. That
  // call is legal: the unit is a separate module, and `component()` below
  // calls its default export, which returns the markup alone; the value stays
  // with `render` (decision 155).
  const: {
    kind: "error",
    reason:
      "`<const>` declares a binding, which an Astro template expression cannot do; declare it in the `---` fence instead",
  },
  define: {
    kind: "error",
    reason:
      "`<define>` declares a reusable template block; an Astro template has no local component form — extract it into its own `.astro.mx` file and import it",
  },
  try: {
    kind: "error",
    reason:
      "`<try>` needs an error boundary; Astro renders components statically at build time and has no equivalent",
  },
  else: { kind: "error", reason: "`<else>` must follow an `<if>`" },
  "else-if": { kind: "error", reason: "`<else-if>` must follow an `<if>`" },
};

function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

/**
 * Astro's own built-in capitalized components: resolve with no author
 * import, because Astro's compiler itself injects one.
 *
 * Measured against `@astrojs/compiler-rs` (astro@7.3.2): `<Fragment/>`
 * compiles to `import { Fragment, ... } from "astro/runtime/server/index.js"`
 * prepended automatically — the *only* capitalized name the compiler
 * auto-imports. Every other candidate tried (`Markdown`, `Debug`, `Prism`,
 * `Code` — Astro v1's old built-ins, since removed — and an arbitrary
 * unbound name) compiles to a **bare reference with no import at all**: the
 * Astro compiler runs no resolvability check of its own (0 diagnostics for
 * every one of them), so an unbound name there is a silent `ReferenceError`
 * at runtime, not a compile error — exactly the failure class this file's
 * `rejectUnknownTag` exists to catch at the MX level instead.
 */
const ASTRO_BUILTIN_TAG_NAMES = new Set(["Fragment"]);

/**
 * Whether a capitalized tag resolves (decision 114, extended to `.astro.mx`'s
 * larger scope like `.solid.mx`'s own extension): the `---` fence's own
 * value bindings (`ctx.imports`, fed from `sourceBindings` in
 * `lowerAstroMx`), or one of Astro's own built-ins (above). There is no
 * MX-level `import`/`<define>`/`<const>` inside an `.astro.mx` template body the
 * way there is for a whole-file `.mx` — Astro's local-component form *is* a
 * fence import. A name reaching this function has already failed every
 * MX-level route `lower.ts`'s precedence order checks first (structural
 * tags, `<try>`, `ctx.tagVarShadowed`, a registered custom tag), so anything
 * still unresolved here is genuinely unbound: `isComponentName`'s bare
 * casing test alone used to make `<TotallyUndefined/>` a silent component
 * reference to nothing — `rejectUnknownTag` below now reports Marko's own
 * wording instead.
 */
function isComponent(name: string, ctx: { imports?: Set<string> }): boolean {
  return (ctx.imports?.has(name) ?? false) || ASTRO_BUILTIN_TAG_NAMES.has(name);
}

function rejectUnknownTag(name: string, node: Node, ctx: Ctx): void {
  fail(
    unresolvedCustomTagMessage(name, {
      candidates: [...ctx.imports, ...ctx.defines.keys()],
      hint: `Import it in the \`---\` fence (\`import ${name} from "./${name}.astro"\`) or add \`tags/${name}.mx\`.`,
    }),
    node,
  );
}

type DelegatedTagData =
  | { kind: "interpolation"; expr: Expr }
  | { kind: "html-comment" };

/** Questions the Astro host answers while Marko nodes are still available. */
/** Astro's built-in `defaultTag`: the descriptor's field and the ladder's last rung. */
export const DEFAULT_TAG = "div";

export const astroTemplateDeclarations: HostDeclarations = {
  name: "@mxlang/host-astro",
  nativeTags: WEB_ELEMENTS,
  attrTags: 2,
  // The ladder (decision 145): the parent's contract `defaultTag`, then
  // `mx.<target>.defaultTag`, then the target's built-in (the registry folds
  // the host override into `configured`). This host permits the contract rung:
  // it sets no `allowContractDefaultTag: false`.
  resolveDefaultTag: (_node, parents, context) =>
    // The template shares `mx.astro-html.defaultTag` with the page target,
    // where an unresolved dashed name is a Marko error: a contract's dashed
    // name is refused here too, so registration and compile agree.
    contractDefaultTag(
      parents,
      {
        ...context,
        scope: { ...context.scope, isNativeElement: () => false },
      },
      [DEFAULT_TAG],
    ) ??
    context.configured ??
    DEFAULT_TAG,
  tags: TAGS,
  isElement: (name) => !isComponentName(name),
  isComponent,
  rejectUnknownTag,
  scriptletReplacement: (name, keyword) =>
    `declare it in the \`---\` fence (\`${keyword} ${name} = …;\`)`,
  keepComments: true,
  isDelegatedTag: (name) => name === DYNAMIC_TAG || name === "html-comment",
  resolveDelegatedTag: (name, node, ctx): DelegatedTagData => {
    // `<html-comment>` lowers to a real `<!-- -->`, as Marko and the html
    // target do, rather than falling through to a literal element.
    if (name === "html-comment") {
      rejectUnsupportedFields(ctx, node, "`<html-comment>`");
      return { kind: "html-comment" };
    }
    if (name !== DYNAMIC_TAG) {
      fail(`unknown Astro host tag ${JSON.stringify(name)}`, node);
    }

    // A bare top-level `${expr}` line and a tagged `<${expr} .../>` both
    // parse to Marko's expression-named tag shape, and both are the
    // dynamic-tag construct (see the "four Marko facts" in AGENTS.md, and
    // `@mxlang/core`'s `lowerTag`) — Astro resolves component names
    // statically and cannot express either, so both are the same
    // host-specific error rather than the bare shape silently becoming an
    // interpolation.
    fail(
      "a dynamic tag name (`<${expr}>`) isn't supported by @mxlang/host-astro: Astro resolves component names statically",
      node,
    );
  },
  rejectModifier: (attr) => {
    // Reserved `on:` gets an event fix-it. `oncapture:` is an ordinary name,
    // not a capture alias or invalid Marko syntax.
    if (attr.name === "on") {
      const event =
        attr.modifier.charAt(0).toUpperCase() + attr.modifier.slice(1);
      fail(
        `\`${attr.name}:${attr.modifier}=fn\` is not MX syntax; write \`on${event}=fn\` for a DOM event or \`on-${attr.modifier}=fn\` for a custom event name (Marko rejects this form too)`,
        attr,
      );
    }
    fail(
      `attribute modifier \`${attr.name}:${attr.modifier}\` is not supported in an \`.astro.mx\` template`,
      attr,
    );
  },
  rejectAttributeMethod: (attr) => {
    fail(
      `attribute method \`${attr.name}(...)\` is an event handler and requires a runtime; \`.astro.mx\` renders static markup at build time`,
      attr,
    );
  },
  rejectElementAttributeTags: (name, node) => {
    const first = firstAttributeTag(node);
    const slot = String(first?.name?.value ?? "").replace(/^@/, "");
    fail(
      `attribute tags (\`<@${slot}>\`) lower to Astro named slots, which only a component accepts; \`<${name}>\` is an HTML element`,
      first ?? node,
    );
  },
  rejectComponentTag: (name, node) => {
    if ((node.body?.params ?? []).length === 0) return;
    fail(
      `tag params (\`<${name}|…|>\`) lower to a render prop, which Astro has no equivalent for — Astro passes markup through slots, not functions`,
      node,
    );
  },
};

/** Renders a structured `class` value (object, array, string) as `class:list` does. */
const CLASS_LIST =
  '(v) => { const out = []; const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === "object") { for (const k in x) if (x[k]) out.push(k); } else if (x) out.push(String(x)); }; walk(v); return out.join(" "); }';

function escapeText(text: string): string {
  return text.replace(/[{}]/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Static textarea content as the parser reads it: `&`, `<` escaped and a leading newline doubled. */
function escapeTextareaStatic(value: string): string {
  const text = value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return text[0] === "\n" ? `\n${text}` : text;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

type MappedWrite = (code: string, node: Node, generatedStart: number) => void;

/** Names Astro consumes rather than emitting as ordinary authored attributes. */
function isAstroDirectiveName(name: string): boolean {
  return (
    /^(?:set|define|is|transition|client|server):/.test(name) ||
    name === "class:list" ||
    name === "slot"
  );
}

// Marko writes `true` as an empty plain attribute and omits `false`. Astro
// stringifies both. The IIFE evaluates the authored expression once.
const PLAIN_ATTR_VALUE =
  '(($value) => typeof $value === "boolean" ? ($value ? "" : null) : $value)';

/** String-typed keys also avoid Astro's directive-specific intrinsic JSX types. */
function plainNativeKey(name: string): string {
  const key = JSON.stringify(name);
  return isAstroDirectiveName(name) ? `[${key} + ""]` : key;
}

/** A computed native spread escapes compiler directives, but not runtime filters. */
function validatePlainAstroAttrs(attrs: Attr[], nativeName?: string): void {
  for (const attr of attrs) {
    if (
      (attr.kind === "boolean" ||
        attr.kind === "static" ||
        attr.kind === "dynamic") &&
      isAstroDirectiveName(attr.name) &&
      (!nativeName ||
        ["style", "script", "slot"].includes(nativeName) ||
        attr.name === "set:html" ||
        attr.name === "set:text" ||
        attr.name === "class:list")
    ) {
      fail(
        `attribute \`${attr.name}\` cannot be preserved as a plain Marko attribute in \`.astro.mx\`: Astro interprets it as a directive`,
        attr,
      );
    }
  }
}

/**
 * One element's attributes.
 *
 * Astro renders the attributes of a plain element one after another, and a
 * `{...x}` beside `a={2}` is rendered as its own run, so `<div a=1 {...x}
 * a=2>` printed `a` three times and a browser kept the first (x's). Marko
 * merges them as one object, where the later write wins (decision 135). When
 * the element has a spread, its attributes are therefore folded into ONE spread
 * object in authored order, `{...{ "a": 1, ...x, "a": 2 }}`: a JS object merge
 * gives Marko's precedence, and Astro renders the merged object's keys, one
 * each. A component's props are already such an object, so components, and an
 * element with no spread, keep the plain form.
 *
 * `<input>` writes `value` first (a browser may reset a value when `type`
 * changes after it, as Marko's output orders it). That is applied here on the
 * plain form only, replacing the host's former `orderAttrs` hook, which
 * reordered the IR and so moved `value` across a spread it was written after.
 */
function emitElementAttrs(
  name: string,
  attrs: Attr[],
  write: (code: string) => void,
  writeMapped: (code: string, node: Node) => void,
): void {
  // Validate before folding explicit attributes into an authored spread too.
  validatePlainAstroAttrs(attrs, name);
  if (!attrs.some((attr) => attr.kind === "spread")) {
    const value =
      name === "input"
        ? attrs.findIndex((attr) =>
            attr.kind === "static" || attr.kind === "dynamic"
              ? attr.name === "value"
              : false,
          )
        : -1;
    emitAttrs(
      value > 0
        ? [attrs[value] as Attr, ...attrs.filter((_, i) => i !== value)]
        : attrs,
      write,
      writeMapped,
      name,
    );
    return;
  }
  if (attrs.length === 1) {
    emitAttrs(attrs, write, writeMapped, name);
    return;
  }
  write(` {...${ATTRIBUTE_SPREAD_EXPRESSION}(`);
  emitFoldedAttrObject(attrs, write, writeMapped);
  write(`, ${JSON.stringify(name)})}`);
}

/** The element's attributes folded into one object literal, authored order, later writes winning. */
function emitFoldedAttrObject(
  attrs: Attr[],
  write: (code: string) => void,
  writeMapped: (code: string, node: Node) => void,
): void {
  write("{ ");
  attrs.forEach((attr, index) => {
    if (index > 0) write(", ");
    switch (attr.kind) {
      case "spread":
        write("...");
        writeMapped(attr.value.code, attr.value.node);
        return;
      case "boolean":
        write(
          `${plainNativeKey(attr.name)}: ${attr.name === "slot" ? '""' : "true"}`,
        );
        return;
      case "static":
        write(`${plainNativeKey(attr.name)}: ${JSON.stringify(attr.value)}`);
        return;
      case "bound":
      case "event":
        // Rejected with the same messages as the plain form.
        emitAttrs(
          [attr],
          () => {},
          () => {},
        );
        return;
      case "dynamic": {
        const structuredClass =
          attr.name === "class" &&
          (attr.value.shape === "object" || attr.value.shape === "array");
        // A structured class folds into the plain `class` key as the string
        // `class:list` would render, so a spread's `class` and this one are the
        // same key and the merge is real (as in Marko). `class:list` stays for
        // an element with no spread.
        const plain = isAstroDirectiveName(attr.name);
        write(
          `${plainNativeKey(attr.name)}: ${structuredClass ? `(${CLASS_LIST})(` : plain ? `${PLAIN_ATTR_VALUE}((` : "("}`,
        );
        writeMapped(attr.value.code, attr.value.node);
        write(plain ? "))" : ")");
        return;
      }
    }
  });
  write(" }");
}
function emitAttrs(
  attrs: Attr[],
  write: (code: string) => void,
  writeMapped: (code: string, node: Node) => void,
  nativeName?: string,
): void {
  validatePlainAstroAttrs(attrs, nativeName);
  const writeName = (attr: Exclude<Attr, { kind: "spread" }>): void => {
    writeMapped(attr.name, {
      loc: {
        start: attr.loc,
        end: {
          line: attr.loc.line,
          column: attr.loc.column + attr.name.length,
        },
      },
    });
  };
  for (const attr of attrs) {
    if (
      (attr.kind === "boolean" ||
        attr.kind === "static" ||
        attr.kind === "dynamic") &&
      isAstroDirectiveName(attr.name)
    ) {
      // A computed key prevents Astro's parser/compiler from treating the
      // name as a directive (including implicit slot projection). The native
      // runtime then renders an ordinary escaped attribute. Component props,
      // set:html/set:text and special style/script/slot contexts were refused above.
      write(" {...{ [");
      writeMapped(JSON.stringify(attr.name), {
        loc: {
          start: attr.loc,
          end: {
            line: attr.loc.line,
            column: attr.loc.column + attr.name.length,
          },
        },
      });
      // Concatenating the empty string retains the exact runtime key while
      // making it `string`-typed, not an Astro directive's literal JSX prop.
      write(' + ""]: ');
      if (attr.kind === "dynamic") {
        write(
          `${PLAIN_ATTR_VALUE}(${ATTRIBUTE_VALUE_EXPRESSION}(${JSON.stringify(attr.name)}, (`,
        );
        writeMapped(attr.value.code, attr.value.node);
        write(`), ${JSON.stringify(nativeName ?? "")}))`);
      } else {
        // `slot` is not a boolean HTML attribute. Its bare form, like every
        // valueless colon name, means the empty string rather than "true".
        write(JSON.stringify(attr.kind === "static" ? attr.value : ""));
      }
      write(" }}");
      continue;
    }
    switch (attr.kind) {
      case "spread":
        write(nativeName ? ` {...${ATTRIBUTE_SPREAD_EXPRESSION}(` : " {...");
        writeMapped(attr.value.code, attr.value.node);
        write(nativeName ? `, ${JSON.stringify(nativeName)})}` : "}");
        break;
      case "boolean":
        write(" ");
        writeName(attr);
        break;
      case "static":
        write(" ");
        writeName(attr);
        write(`="${escapeAttr(attr.value)}"`);
        break;
      case "bound":
        fail(
          "`:=` is a two-way binding and requires a reactive runtime; `.astro.mx` renders static markup at build time",
          attr,
        );
        break;
      // Phase B of `dom-events` (decision 101, design note §8): an
      // expression-valued event handler needs a runtime, and `.astro.mx` renders
      // static markup at build time — so it is rejected rather than emitted
      // as dead markup. A *string*-valued handler (`onclick="…"`) is an
      // ordinary static attribute and passes through verbatim above.
      case "event":
        fail(
          `\`${attr.name}\` is an event handler and requires a runtime; .astro.mx renders static markup at build time`,
          attr,
        );
        break;
      case "dynamic": {
        const structuredClass =
          attr.name === "class" &&
          (attr.value.shape === "object" || attr.value.shape === "array");
        write(" ");
        writeMapped(structuredClass ? "class:list" : attr.name, {
          loc: {
            start: attr.loc,
            end: {
              line: attr.loc.line,
              column: attr.loc.column + attr.name.length,
            },
          },
        });
        const checked =
          nativeName !== undefined &&
          attr.name !== "class" &&
          attr.name !== "style";
        // A structured class is rendered by `class:list`; every other native
        // value goes through the primitive normalization.
        const normalized = nativeName !== undefined && !structuredClass;
        if (normalized)
          write(`={${ATTRIBUTE_OUT_EXPRESSION}(${JSON.stringify(attr.name)}, `);
        else write("={");
        if (checked)
          write(
            `${ATTRIBUTE_VALUE_EXPRESSION}(${JSON.stringify(attr.name)}, (`,
          );
        writeMapped(attr.value.code, attr.value.node);
        if (checked) write(`), ${JSON.stringify(nativeName)})`);
        write(normalized ? ")}" : "}");
        break;
      }
    }
  }
}

/** Creates one Astro-template emitter over core's IR. */
export function createEmitter(
  onMappedWrite?: MappedWrite,
  componentNames: ReadonlyMap<string, string> = new Map(),
): Emitter<string> {
  const out: string[] = [];
  let length = 0;
  const write = (code: string): void => {
    out.push(code);
    length += code.length;
  };
  const writeMapped = (code: string, node: Node): void => {
    onMappedWrite?.(code, node, length);
    write(code);
  };
  const writeExpr = (expr: Expr): void => writeMapped(expr.code, expr.node);
  const writeFragment = (nodes: IrNode[]): void => {
    write("<Fragment>");
    drive(emitter, nodes);
    write("</Fragment>");
  };
  const validateAttributeTag = (tag: AttributeTag): void => {
    if (tag.attrs.length > 0) {
      fail(
        `attributes on \`<@${tag.name}>\` aren't supported by @mxlang/host-astro: a slot carries markup, not data`,
        tag.attrs[0] as Attr,
      );
    }
    if (tag.block.hasParams) {
      fail(
        `params on \`<@${tag.name}>\` aren't supported by @mxlang/host-astro: a slot carries rendered markup, not a function`,
        tag,
      );
    }
    if (tag.attrTagProps.length > 0) {
      fail(
        `nested attribute tags inside \`<@${tag.name}>\` aren't supported by @mxlang/host-astro: a slot is keyed by one name and has no nested data shape`,
        tag.attributeTagTree[0] ?? tag,
      );
    }
    if (!tag.hasBody) {
      fail(
        `<@${tag.name}/> has no body; @mxlang/host-astro projects attribute-tag bodies by name`,
        tag,
      );
    }
  };
  const visitAttributeTags = (
    nodes: AttributeTagNode[],
    visit: (tag: AttributeTag) => void,
  ): void => {
    for (const node of nodes) {
      if (node.kind === "AttributeTag") {
        visit(node.tag);
      } else if (node.kind === "AttributeTagFor") {
        visitAttributeTags(node.nodes, visit);
      } else {
        for (const branch of node.branches) {
          visitAttributeTags(branch.nodes, visit);
        }
      }
    }
  };
  const validateAttributeTagProp = (
    prop: AttrTagProp,
    owner: Positioned,
  ): void => {
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
        `array attribute tag \`<@${prop.name}>\` isn't supported by @mxlang/host-astro: a slot is keyed by name`,
        loopTag ?? tags[1] ?? tags[0] ?? owner,
      );
    }
    visitAttributeTags(prop.source, validateAttributeTag);
  };
  const emitAttributeTag = (tag: AttributeTag): void => {
    write(`<Fragment slot="${escapeAttr(tag.name)}">`);
    drive(emitter, tag.block.children);
    write("</Fragment>");
  };
  const emitAttributeTagExpression = (nodes: AttributeTagNode[]): void => {
    if (nodes.length === 0) {
      write("null");
      return;
    }
    const node = nodes[0] as AttributeTagNode;
    if (node.kind === "AttributeTag") {
      write("(");
      emitAttributeTag(node.tag);
      write(")");
      return;
    }
    if (node.kind === "AttributeTagFor") {
      fail(
        "attribute tags inside `<for>` aren't supported by @mxlang/host-astro: repeated slots cannot share one name",
        node,
      );
    }
    write("(");
    node.branches.forEach((branch, index) => {
      if (index > 0) write(" : ");
      if (branch.test) {
        writeExpr(branch.test);
        write(" ? ");
        emitAttributeTagExpression(branch.nodes);
      } else {
        emitAttributeTagExpression(branch.nodes);
      }
    });
    if (node.branches.at(-1)?.test) write(" : null");
    write(")");
  };

  /**
   * `<html-comment>`: Marko's `<!--…-->`, escaping only `>` (as `_escape_comment`).
   *
   * Astro never interpolates inside a comment, so a placeholder makes the whole
   * comment one `set:html` string; a static one stays a literal comment.
   */
  const emitHtmlComment = (children: IrNode[]): void => {
    const parts: Array<{ text: string } | { expr: Expr; escaped: boolean }> =
      [];
    for (const child of children) {
      if (child.kind === "Text") parts.push({ text: child.value });
      else if (child.kind === "Interpolation") {
        parts.push({ expr: child.expr, escaped: child.escaped });
      } else if (child.kind === "Comment") {
        // Marko keeps a nested `<!-- -->` as text, so its `>` is escaped too.
        if (child.html) parts.push({ text: `<!--${child.value}-->` });
      } else {
        fail(
          "`<html-comment>` takes only text and placeholders; a comment cannot contain markup",
          child,
        );
      }
    }
    if (parts.every((part) => "text" in part)) {
      const text = parts
        .map((part) => ("text" in part ? part.text : ""))
        .join("");
      write(`<!--${text.replace(/>/g, "&gt;")}-->`);
      return;
    }
    // Marko writes a lone-placeholder comment that renders nothing as `<!-- -->`.
    const onlyPlaceholders = parts.every((part) => "expr" in part);
    write('<Fragment set:html={"<!--" + ');
    if (onlyPlaceholders) write("(");
    parts.forEach((part, index) => {
      if (index > 0) write(" + ");
      if ("text" in part) {
        write(JSON.stringify(part.text.replace(/>/g, "&gt;")));
        return;
      }
      write(`${COMMENT_VALUE_EXPRESSION}(`);
      writeExpr(part.expr);
      write(`, ${part.escaped})`);
    });
    if (onlyPlaceholders) write(' || " ")');
    write(' + "-->"} />');
  };

  /**
   * `<textarea value=x>`: Marko renders the value as escaped content, never as
   * a `value` attribute. An authored `value` and a spread (which may carry one)
   * are handled, and a body's text is escaped as raw text.
   *
   * With no spread the value is lifted at compile time. With one, the merged
   * attribute object is split at render time: `value` becomes the content (or
   * is dropped when a body is written, as Marko's body wins over a spread value).
   */
  const emitTextarea = (node: Extract<IrNode, { kind: "Element" }>): void => {
    const attrs = node.attrs;
    // As `emitElementAttrs` does, before any attribute folds into a spread.
    validatePlainAstroAttrs(attrs, "textarea");
    const hasSpread = attrs.some((attr) => attr.kind === "spread");
    const isValue = (attr: Attr): boolean =>
      (attr.kind === "static" ||
        attr.kind === "dynamic" ||
        attr.kind === "boolean") &&
      attr.name === "value";
    const value = attrs.find(isValue);
    const hasBody = node.children.length > 0;
    if (value && hasBody) {
      fail(
        "A textarea cannot have both a value attribute and body content.",
        value,
      );
    }
    // A textarea body is raw text in Marko, so a literal `<` is text; Astro
    // would otherwise open an element at it.
    const writeBody = (): void => {
      for (const child of node.children) {
        if (child.kind === "Text") {
          write(escapeText(child.value.replace(/</g, "&lt;")));
        } else {
          drive(emitter, [child]);
        }
      }
    };
    if (!hasSpread) {
      write("<textarea");
      emitElementAttrs(
        node.name,
        attrs.filter((attr) => attr !== value),
        write,
        writeMapped,
      );
      write(">");
      if (hasBody) writeBody();
      else if (value?.kind === "static") {
        write(escapeText(escapeTextareaStatic(value.value)));
      } else if (value?.kind === "dynamic") {
        write(`{${TEXTAREA_CONTENT_EXPRESSION}(`);
        writeExpr(value.value);
        write(")}");
      }
      write("</textarea>");
      return;
    }
    write("{(($mxTa: Record<string, any>) => (<textarea");
    write(
      ` {...${ATTRIBUTE_SPREAD_EXPRESSION}((({ value: __mxValue, ...$mxRest }) => $mxRest)($mxTa), "textarea")}>`,
    );
    if (hasBody) writeBody();
    else write(`{${TEXTAREA_CONTENT_EXPRESSION}($mxTa.value)}`);
    write("</textarea>))(");
    emitFoldedAttrObject(attrs, write, writeMapped);
    write(")}");
    return;
  };

  const emitter: Emitter<string> = {
    text(node) {
      write(escapeText(node.value));
    },

    interpolation(node) {
      write(node.escaped ? "{" : "<Fragment set:html={");
      writeExpr(node.expr);
      write(node.escaped ? "}" : "} />");
    },

    element(node) {
      if (node.name === "textarea") {
        emitTextarea(node);
        return;
      }
      write(`<${node.name}`);
      emitElementAttrs(node.name, node.attrs, write, writeMapped);
      if (node.void) {
        write(" />");
        return;
      }
      write(">");
      drive(emitter, node.children);
      write(`</${node.name}>`);
    },

    component(node) {
      if (node.target.kind !== "name") {
        if (node.target.kind === "define") {
          fail(
            "`<define>` declares a reusable template block; an Astro template has no local component form — extract it into its own `.astro.mx` file and import it",
            node,
          );
        }
        // `valueImportBinding` is set only by decision 116's own classified
        // routing (an import, or the local extension's fence-binding
        // classification) — never by an authored `<${expr}/>`, which has no
        // tag name to name in the error. Give this case its own wording
        // (lead's ruling): the author wrote `<Tag/>`, not `<${expr}>`, and
        // the generic dynamic-tag message would misdescribe what they wrote.
        if (node.target.valueImportBinding) {
          fail(
            `\`<${node.target.valueImportBinding}>\` is bound in the frontmatter to a value MX can't prove is a component, and @mxlang/host-astro can't render a tag name decided at runtime. Bind it to a component (an import, function or class), or use a lowercase element.`,
            node,
          );
        }
        fail(
          "a dynamic tag name (`<${expr}>`) isn't supported by @mxlang/host-astro: Astro resolves component names statically",
          node,
        );
      }

      const name = componentNames.get(node.target.name) ?? node.target.name;
      if (node.var) {
        // Structural, not a missing feature (decision 65-style host-cannot,
        // ruled 2026-09-28 on TODO amx-tag-var): Astro runs the `---` fence
        // to completion before this template's tags are ever lowered or
        // called, so there is no statement position left, in either the
        // fence or the template, to receive a value into. A plain (no-`/var`)
        // call is rendered later still, inside Astro's own render pass in
        // `server.ts`, through the unit's default export, which returns only
        // the markup string — not a place any binding could land. Refused
        // rather than dropped.
        fail(
          `\`/var\` on \`<${node.authoredName ?? name}>\` can't bind in \`.astro.mx\`: Astro runs the \`---\` fence before the template renders, so no statement can receive the value here. Call the unit directly from the fence instead, e.g. \`import ${name} from "./${node.authoredName ?? name}.mx"; import { createOut } from "@mxlang/host-astro/runtime"; const value = ${name}.render({ ... }, createOut());\`, and use \`value\` in the template.`,
          node,
        );
      }
      if (node.content?.params.length) {
        fail(
          `tag params (\`<${name}|…|>\`) lower to a render prop, which Astro has no equivalent for — Astro passes markup through slots, not functions`,
          node,
        );
      }
      const hasChildren = Boolean(node.content) || node.attrTagProps.length > 0;
      write(`<${name}`);
      emitAttrs(node.attrs, write, writeMapped);
      if (!hasChildren) {
        write(" />");
        return;
      }

      write(">");
      if (node.content) drive(emitter, node.content.children);
      for (const prop of node.attrTagProps) {
        validateAttributeTagProp(prop, node);
        if (prop.source.length === 0) continue;
        const only = prop.source[0];
        if (prop.source.length === 1 && only?.kind === "AttributeTag") {
          emitAttributeTag(only.tag);
        } else {
          write("{");
          emitAttributeTagExpression(prop.source);
          write("}");
        }
      }
      write(`</${name}>`);
    },

    ifChain(node) {
      write("{");
      node.branches.forEach((branch, index) => {
        if (index > 0) write(" : ");
        if (branch.condition) {
          writeExpr(branch.condition);
          write(" ? (");
          writeFragment(branch.children);
          write(")");
        } else {
          write("(");
          writeFragment(branch.children);
          write(")");
        }
      });
      if (node.branches.at(-1)?.condition) write(" : null");
      write("}");
    },

    forLoop(node) {
      if (node.source.kind === "range" && node.source.step) {
        fail(
          "`<for step=...>`: step is not supported; use a computed array",
          node,
        );
      }
      const [, second] = node.params;
      const writeParam = (index: number, fallback?: string): void => {
        const code = node.params[index] ?? fallback;
        if (code === undefined) return;
        const param = node.paramNodes[index];
        if (param) writeMapped(code, param);
        else write(code);
      };
      const writeBranch = (): void => {
        write("(");
        writeFragment(node.children);
        write(")");
      };
      if (node.source.kind === "of") {
        // The spread operand is where TypeScript reports a value that is not
        // iterable (TS2488); mapping it onto the authored `of` value puts the
        // error on that value instead of in the wrapper.
        write("{((mxList) => mxList ? [...");
        writeMapped("mxList", node.source.list.node);
        write("] : [])(");
        writeExpr(node.source.list);
        write(").map((");
        writeParam(0);
        if (second) {
          write(", ");
          writeParam(1);
        }
        write(") => ");
        writeBranch();
        write(")}");
        return;
      }
      if (node.source.kind === "in") {
        write("{Object.entries(");
        writeExpr(node.source.object);
        write(" ?? {}).map(([");
        writeParam(0);
        write(", ");
        writeParam(1, "value");
        write("]) => ");
        writeBranch();
        write(")}");
        return;
      }

      const writeStart = (): void => {
        if (node.source.kind === "range" && node.source.from) {
          writeExpr(node.source.from);
        } else {
          write("0");
        }
      };
      // `__mxUnused`/`__mxIndex` rather than `_`/`$i`: both mapper parameters
      // are in scope for the whole callback body, and the author's own
      // `from`/`bound` expressions are written inside it. A generated `_`
      // shadowed an authored `_` and the loop rendered `NaN` once per row.
      // `__mx` is reserved by `checkReservedBindings`.
      write("{Array.from({ length: Math.max(0, (");
      writeExpr(node.source.bound);
      write(") - (");
      writeStart();
      write(node.source.inclusive ? ") + 1)" : "))");
      write(" }, (__mxUnused, __mxIndex) => (");
      writeStart();
      write(") + __mxIndex).map((");
      writeParam(0);
      write(") => ");
      writeBranch();
      write(")}");
    },

    define(node) {
      fail(
        "`<define>` declares a reusable template block; an Astro template has no local component form — extract it into its own `.astro.mx` file and import it",
        node,
      );
    },

    constant(node) {
      fail(
        "`<const>` declares a binding, which an Astro template expression cannot do; declare it in the `---` fence instead",
        node,
      );
    },

    hoisted(node) {
      fail(
        "a statement hoisted inside an Astro template block cannot be represented in frontmatter without changing its scope",
        node,
      );
    },

    delegatedTag(node) {
      const data = node.tag.data as DelegatedTagData;
      if (data.kind === "html-comment") {
        emitHtmlComment(node.tag.children);
        return;
      }
      if (data.kind !== "interpolation") {
        fail("unknown Astro host-tag lowering", node);
      }
      write("{");
      writeExpr(data.expr);
      write("}");
    },

    documentType(node) {
      write(`<!${node.value}>`);
    },

    comment(node) {
      // A `//` comment is author-only on every host; only `<!-- -->` is output.
      if (!node.html) return;
      write(`<!--${node.value}-->`);
    },

    done() {
      return out.join("");
    },
  };

  return emitter;
}

/** Emits the template half of a resolved `.astro.mx` file. */
export function emitTemplate(ir: Ir): string {
  return emit(createEmitter(), ir);
}

export interface LowerResult {
  code: string;
  mappings: AstroTemplateMapping[];
  dependencies: string[];
}

export interface AstroTemplateMapping {
  sourceStart: number;
  sourceEnd: number;
  generatedStart: number;
  generatedEnd: number;
}

type HoistedStatement = Extract<
  IrNode,
  { kind: "Import" | "Static" | "Export" | "InputInterface" | "Hoisted" }
>;

function offsetAtPosition(
  source: string,
  position: { line: number; column: number },
): number {
  let offset = 0;
  for (let line = 1; line < position.line; line++) {
    const newline = source.indexOf("\n", offset);
    if (newline < 0) return source.length;
    offset = newline + 1;
  }
  return Math.min(source.length, offset + position.column);
}

function rangeOfNode(source: string, node: Node): [number, number] | null {
  const start = node?.loc?.start;
  const end = node?.loc?.end;
  if (!start || !end) return null;
  return [
    typeof start.index === "number"
      ? start.index
      : offsetAtPosition(source, start),
    typeof end.index === "number" ? end.index : offsetAtPosition(source, end),
  ];
}

function emitFence(
  source: string,
  fence: string,
  statements: HoistedStatement[],
  needsAttrTagImport: boolean,
  helpers: string[] = [],
): { code: string; mappings: AstroTemplateMapping[] } {
  if (statements.length === 0 && !needsAttrTagImport && helpers.length === 0) {
    return {
      code: fence,
      mappings: fence
        ? [
            {
              sourceStart: 0,
              sourceEnd: fence.length,
              generatedStart: 0,
              generatedEnd: fence.length,
            },
          ]
        : [],
    };
  }
  const newline = fence.includes("\r\n") ? "\r\n" : "\n";
  const mappings: AstroTemplateMapping[] = [];
  let code: string;
  if (fence === "") {
    code = `---${newline}`;
  } else {
    const close = fence.lastIndexOf(`${newline}---`);
    if (close < 0) return { code: fence, mappings: [] };
    code = `${fence.slice(0, close)}${newline}`;
    mappings.push({
      sourceStart: 0,
      sourceEnd: close,
      generatedStart: 0,
      generatedEnd: close,
    });
  }

  if (needsAttrTagImport) {
    code += 'import type { AttrTag } from "@mxlang/host-astro";';
  }

  for (const statement of statements) {
    if (!code.endsWith(newline)) code += newline;
    const generatedStart = code.length;
    code += statement.code;
    mappings.push({
      sourceStart: offsetAtPosition(source, statement.loc),
      sourceEnd: offsetAtPosition(source, statement.end),
      generatedStart,
      generatedEnd: code.length,
    });
  }

  for (const helper of helpers) code += `${newline}${helper}`;

  code +=
    fence === ""
      ? `${newline}---${newline}`
      : fence.slice(fence.lastIndexOf(`${newline}---`));
  return { code, mappings };
}

/**
 * Babel stamps its own fence-relative `(line:col)` onto the parse error's
 * message text, so a fence error reported verbatim showed `(1:33)` where the
 * real file line is 2 — the position `errorFor` prints pointed the author at
 * the opening `---` instead of their own code. Drop Babel's suffix and print
 * the file-relative position instead: line +1 for the opening fence line
 * (the captured fence text starts on file line 2), and column 1-based in the
 * text (#227) while `errorFor` keeps the structured 0-based column.
 */
function fenceSyntaxErrorMessage(error: SourceBindingsError): string {
  const text = error.message.replace(/\s*\(\d+:\d+\)\s*$/, "").trim();
  return `syntax error in the \`---\` fence: ${text} (${error.line + 1}:${error.column + 1})`;
}

/**
 * The Astro-visible name for each import core synthesized for a discovered
 * tag.
 *
 * Astro decides element-vs-component from the tag name's first letter, and
 * core's binding (`$mx_Badge1`) is `$`-led: Astro's compiler then ships
 * `<$mx_Badge1 />` as a literal HTML element with no diagnostic, and
 * `convertToTSX` rewrites its `/>` into a syntax error. The spelling is this
 * host's concern, so the host renames its own bindings (`Mx_Badge1`), here and
 * at every call site, rather than core changing a name every host emits.
 *
 * Core's collision check ran against the `$`-led name, so the new name is
 * checked again: against every binding core knows and every identifier the
 * author wrote, retrying with a trailing `_` until nothing matches.
 */
function astroComponentNames(
  ctx: Ctx,
  source: string,
  imports: readonly IrNode[],
): Map<string, string> {
  const names = new Map<string, string>();
  const taken = (candidate: string): boolean =>
    ctx.imports.has(candidate) ||
    ctx.defines.has(candidate) ||
    [...names.values()].includes(candidate) ||
    new RegExp(
      `(^|[^\\w$])${candidate.replaceAll("$", "\\$")}([^\\w$]|$)`,
    ).test(source);
  for (const statement of imports) {
    if (statement.kind !== "Import" || !statement.synthesized) continue;
    for (const binding of statement.bindings) {
      let name = `Mx${binding.replace(/^\$mx(?=_)/, "")}`;
      if (!/^[A-Z]/.test(name)) name = `Mx_${name}`;
      while (taken(name)) name += "_";
      names.set(binding, name);
    }
  }
  return names;
}

/** Re-emits a synthesized import under its Astro-visible binding name. */
function renameSynthesizedImport(
  statement: HoistedStatement,
  names: ReadonlyMap<string, string>,
): HoistedStatement {
  if (statement.kind !== "Import" || !statement.synthesized) return statement;
  let code = statement.code;
  for (const binding of statement.bindings) {
    const name = names.get(binding);
    if (name === undefined) continue;
    code = code.replace(
      new RegExp(`^(import\\s+)${binding.replaceAll("$", "\\$")}\\b`),
      `$1${name}`,
    );
  }
  return { ...statement, code };
}

/** Where an `.astro.mx` file's template starts: just after its `---` fence, or 0 without one. */
export function astroMxTemplateOffset(source: string): number {
  return (
    source.match(/^---\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*\r?\n?/)?.[0].length ?? 0
  );
}

/** Splits an `.astro.mx` file, resolves its MX template, and emits Astro syntax. */
export function lowerAstroMx(
  source: string,
  filename: string,
  options: {
    /** Custom tags already discovered and loaded by the calling integration. */
    customTags?: Record<string, CustomTag>;
    /** `package.json#mx.astro-html.defaultTag`, already validated (decision 145). */
    defaultTag?: string;
    /** Positioned non-fatal diagnostics collected by editor/build tooling. */
    warnings?: MxWarning[];
    /**
     * The registered targets this lowering runs under (decisions 129 and
     * 132). Defaults to this package's own descriptor (right for a direct
     * entry); a tool compiling several targets passes the built-in registry's
     * lookup.
     */
    targets?: TargetLookup;
  } = {},
): LowerResult {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*\r?\n?/);
  const originalFence = match ? match[0] : "";
  const template = match ? source.slice(originalFence.length) : source;
  const baseOffset = originalFence.length;
  const baseLine = originalFence ? originalFence.split("\n").length - 1 : 0;

  const { body } = parseFragment(template, {
    filename,
    baseOffset,
    baseLine,
    baseColumn: 0,
    customTags: options.customTags,
    nativeTags: astroTemplateDeclarations.nativeTags,
    targets: options.targets ?? ownTargets,
  });

  try {
    const ctx = newCtx(
      source,
      (node) => sourceOf(source, node),
      astroTemplateDeclarations,
      undefined,
      filename,
      options.targets ?? ownTargets,
    );
    ctx.customTags = options.customTags;
    ctx.defaultTag = options.defaultTag;
    ctx.warnings = options.warnings;
    // An `.astro.mx` file is an Astro component module, so it has a declaration to
    // name and a tag may call itself without importing itself.
    ctx.emitsModule = true;
    // The `---` fence is the author's own TypeScript module scope: a
    // capitalized tag routes to a component only when the fence actually
    // binds it as a value (an import, or a top-level const/function/class —
    // the same operator-ruling extension decision 114 already gave
    // `.solid.mx`'s surrounding module, since Marko has no `.astro.mx` concept to
    // measure against). Fed into `ctx.imports` before lowering, the same set
    // `isComponent` (below) and the file-local-binding check in `lower.ts`
    // already consult for an ordinary MX-level `import`.
    //
    // A fence that fails to parse reports its own real syntax error here,
    // rather than silently treating the fence as binding nothing (which used
    // to make every capitalized tag misreport `rejectUnknownTag`'s "Unable
    // to find entry point" instead of the actual problem,
    // `source-bindings-silent-parse-failure`). No downstream layer has
    // reported it yet at this point: `lowerAstroMx` never runs Astro's own
    // compiler itself — that happens later, in Vite (`vite-templates.ts`) or
    // the TypeScript plugin — so there is no risk of a duplicate diagnostic
    // for the exact same syntax error from this call.
    // Astro compiles the `---` fence into the body of the component's render
    // function (or its redirect handler), so a top-level `return` is legal
    // Astro source -- `return Astro.redirect("/")` in a plain `.astro` file
    // is the documented way to redirect. Every parser that reads this fence
    // therefore has to allow it, or a valid Astro page is rejected as
    // "'return' outside of function". The relaxation is scoped to the fence
    // only: template expressions and every other host's source are a plain
    // module and keep the default (off).
    const FENCE_SOURCE = { allowReturnOutsideFunction: true } as const;
    const fenceBindings = sourceBindings(match?.[1] ?? "", FENCE_SOURCE);
    if (fenceBindings.error) {
      // The fence's own text starts on the file's second line (the first is
      // the opening `---`), so its 1-based `line` needs +1 to land on the
      // right line of `source`.
      throw new AstroTemplateError(
        fenceSyntaxErrorMessage(fenceBindings.error),
        fenceBindings.error.line + 1,
        fenceBindings.error.column,
      );
    }
    checkReservedSource(match?.[1] ?? "", 2, 0, FENCE_SOURCE);
    for (const name of fenceBindings.bindings) ctx.imports.add(name);
    // Local extension of decision 116 (firstmate's ruling): a fence
    // binding's own non-import value — a top-level `const`/`function`/
    // `class` the `---` fence declares — is classified the same way
    // `.solid.mx`'s `moduleBindings` is (`unknownModuleBindings`), so
    // `const Tag = "div"` used as `<Tag/>` routes dynamic instead of a
    // direct call that throws `"Tag is not a function"` at build time.
    // Skipped when the fence itself already failed to parse above —
    // `unknownSourceBindings` would only re-derive the identical failure
    // through its own independent parse.
    for (const name of unknownSourceBindings(match?.[1] ?? "", FENCE_SOURCE)) {
      ctx.unknownLocalValue.add(name);
    }
    const ir = lower(ctx, body);
    // The `.astro.mx` emitter has nowhere to put a returned value — an Astro
    // component's output is its markup, and the `---` fence is the author's,
    // written before any of this runs. The core parses `<return>` for every
    // host, so leaving this unchecked dropped the tag silently: it emitted
    // clean markup with the value gone, which is the failure class (S8) the
    // field guard exists to close. `/var` on a *call* is refused for the
    // same reason, in `component()`.
    if (ir.returnValue) {
      const at = ir.returnValue.node?.loc?.start;
      throw new AstroTemplateError(
        "`<return>` hands a value to whoever called this unit; an `.astro.mx` file is an Astro component, whose output is its markup, so there is nothing to return it to — move the markup into a `.mx` tag file if the value is what you need",
        at?.line ?? 0,
        at?.column ?? 0,
      );
    }
    const componentNames = astroComponentNames(ctx, source, ir.imports);
    const statements: HoistedStatement[] = [
      ...ir.imports.map((statement) =>
        renameSynthesizedImport(statement, componentNames),
      ),
      ...ir.hoisted,
      ...(ir.inputInterface ? [ir.inputInterface] : []),
      ...ir.prelude,
    ];
    const templateMappings: AstroTemplateMapping[] = [];
    const templateEmitter = createEmitter((code, node, generatedStart) => {
      const range = rangeOfNode(source, node);
      if (!range) return;
      templateMappings.push({
        sourceStart: range[0],
        sourceEnd: range[1],
        generatedStart,
        generatedEnd: generatedStart + code.length,
      });
    }, componentNames);
    const templateCode = emit(templateEmitter, ir);
    const helpers: string[] = [];
    if (
      templateCode.includes("__mxAttrValue(") ||
      templateCode.includes("__mxAttrSpread(")
    ) {
      helpers.push(`const __mxAttrValue = ${ATTRIBUTE_VALUE_SOURCE};`);
    }
    if (
      templateCode.includes("__mxAttrOut(") ||
      templateCode.includes("__mxAttrSpread(")
    ) {
      helpers.push(`const __mxAttrOut = ${ATTRIBUTE_OUT_SOURCE};`);
    }
    if (templateCode.includes(`${COMMENT_VALUE_EXPRESSION}(`)) {
      helpers.push(
        `const ${COMMENT_VALUE_EXPRESSION} = ${COMMENT_VALUE_SOURCE};`,
      );
    }
    if (templateCode.includes(`${TEXTAREA_CONTENT_EXPRESSION}(`)) {
      helpers.push(
        `const ${TEXTAREA_CONTENT_EXPRESSION} = ${TEXTAREA_CONTENT_SOURCE};`,
      );
    }
    if (templateCode.includes("__mxAttrSpread("))
      helpers.push(`const __mxAttrSpread = ${ATTRIBUTE_SPREAD_OUT_SOURCE};`);
    const emittedFence = emitFence(
      source,
      originalFence,
      statements,
      ir.needsAttrTagImport,
      helpers,
    );
    const mappings = [
      ...emittedFence.mappings,
      ...templateMappings.map((mapping) => ({
        ...mapping,
        generatedStart: emittedFence.code.length + mapping.generatedStart,
        generatedEnd: emittedFence.code.length + mapping.generatedEnd,
      })),
    ];
    return {
      code: `${emittedFence.code}${templateCode}`,
      mappings,
      dependencies: [...(ctx.dependencies ?? [])],
    };
  } catch (error) {
    if (error instanceof AstroTemplateError) throw error;
    if (isTranslateError(error)) {
      throw new AstroTemplateError(
        error.message,
        error.line,
        error.column,
        error.file,
      );
    }
    throw error;
  }
}

/** Prints an expression by slicing its file-relative source range. */
function sourceOf(source: string, node: Node): string {
  const start = node?.loc?.start?.index;
  const end = node?.loc?.end?.index;
  if (typeof start === "number" && typeof end === "number") {
    return source.slice(start, end);
  }
  fail("expression has no source position", node);
}
