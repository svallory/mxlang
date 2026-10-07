/**
 * `@mxlang/html`'s dialect policy: stock `.marko`, expressions-only.
 *
 * Decision 66. The lowering core is shared with `@mxlang/html`
 * (`@mxlang/html`'s `core.ts`); this file supplies only what differs, and
 * every difference is a property of *stock Marko's conventions* rather than a
 * preference:
 *
 * - **Attribute tags are renderables, not callable props.** Marko's own
 *   convention is that `<@header>` reaches the component as `input.header`,
 *   rendered with `<${input.header}/>`, and that a *repeated* attribute tag
 *   arrives as an array. Both verified against Marko 5.42.5's own server
 *   render, not assumed. `@mxlang/html` passes callable function props
 *   instead (S3); a translator that confused the two would compile happily
 *   and render the wrong markup.
 * - **Components are discovered**, through Marko's taglib lookup: an
 *   `import`, or a `tags/` directory beside the template. No explicit import
 *   is required, because requiring one is MX's convention and not Marko's.
 * - **Elements come from Marko's registry**, so a tag Marko adds or removes
 *   reaches this translator on a pin bump rather than through a hand-edited
 *   set — ADR 0001's entire point.
 *
 * The disposition table (decision 65) below is the interesting part. The test
 * for each construct is not "can this code lower it" but "does this target
 * emit bytes for it": a construct that only configures behaviour after the
 * first render is *inert* — accepted, with no output — and only a construct a
 * synchronous string render genuinely cannot express is an error.
 */

import {
  ATTRIBUTE_VALUE_EXPRESSION,
  attrByName,
  type Ctx,
  concatMapped,
  contractDefaultTag,
  type Disposition,
  DYNAMIC_TAG,
  type Expr,
  expr,
  expressionShape,
  fail,
  type MappedCode,
  type Node,
  type Policy,
  rejectUnsupportedFields,
  replaceMapped,
  sliceLoc,
  unresolvedCustomTagMessage,
} from "@mxlang/core";
import { isKnownElement } from "./element-table.ts";

export { TranslateError } from "@mxlang/core";

/**
 * The policy table of decision 65, as implemented.
 *
 * Inert entries were each verified against Marko's own server render: with
 * and without the construct, the emitted HTML is byte-identical. Error
 * entries are the two things a *synchronous* string function cannot express.
 */
const TAGS: Record<string, Disposition> = {
  // ---- inert: configures post-render behaviour, emits nothing ----
  //
  // Each row declares the shape the tag is inert *in*, taken from its own
  // Marko tag definition. Inert means the construct emits nothing; it never
  // means a body or an extra attribute may be discarded. Marko itself rejects
  // both (`<effect>` with a body is "does not support body content" there),
  // and the shapes below reproduce that.
  effect: {
    kind: "inert",
    reason:
      "`<effect>` runs after render, on the client; a server render emits nothing for it (verified against Marko's own html output)",
    body: "none",
    // Marko: `<effect foo="bar"/>` is "does not support the `foo` attribute",
    // and a spread is refused too. Only the `effect() { … }` call is its own.
    attributes: "none",
  },
  lifecycle: {
    kind: "inert",
    reason:
      "`<lifecycle>` is a client-side lifecycle hook; a server render emits nothing for it",
    // `openTagOnly` in Marko's definition, so a body is a parse error there
    // before a translator ever sees the node; rejected here too for the case
    // where a taglib does not carry that parse option.
    body: "none",
    // Marko accepts arbitrary attributes here (`<lifecycle foo="bar"/>`
    // compiles): a lifecycle tag's attributes *are* its configuration.
    attributes: "any",
  },
  script: {
    kind: "inert",
    reason:
      "`<script>` as a Marko tag is client-only behaviour, not markup; use `<html-script>` for a literal script element",
    // Marko declares `text: true`: the body is raw client-side script source,
    // genuinely consumed and genuinely emitting nothing. Verified: Marko's own
    // server render of `<script>console.log(1)</script>` emits no bytes.
    body: "text",
    attributes: "any",
  },
  id: {
    kind: "inert",
    reason:
      "`<id>` allocates a unique identifier for the reactive runtime; nothing is emitted for it here",
    body: "none",
    attributes: "none",
  },
  log: {
    kind: "inert",
    reason: "`<log>` writes to the console; it emits no markup",
    // `openTagOnly` in Marko, so a body is a parse error there first.
    body: "none",
    // Marko: `<log=1 foo="bar"/>` is refused; only the logged value is its own.
    attributes: "none",
  },
  debug: {
    kind: "inert",
    reason: "`<debug>` is a debugger hook; it emits no markup",
    body: "none",
    attributes: "none",
  },
  client: {
    kind: "inert",
    reason:
      "a `client` block is evaluated only on the client; a server render emits nothing for it",
    // A statement tag: its "attributes" are the statement's own words.
    body: "none",
    attributes: "any",
  },

  // ---- error: this target genuinely cannot express it ----
  await: {
    kind: "error",
    reason:
      "`<await>` suspends on a promise; this target is a synchronous `(input) => string` and cannot await. Marko itself refuses to render one to a string (\"Cannot consume asynchronous render with 'toString'\")",
  },
  // `<return>` is **not** listed here. It was, and the reason it gave — "a
  // module compiled to `(input) => string` has no parent to return to" — was
  // true only while a tag template was expanded into its caller. Under the
  // unit model (decision 95) a tag is its own module and its caller invokes
  // it, so there is a caller to return to: the unit's `render(input, out)`
  // writes into the caller's sink and returns the value (decision 155). The
  // core owns the grammar, in the tag's own compilation.
};

/**
 * Rejects a binding that would shadow the render function's `input` parameter.
 *
 * The emitted module is `function (input: Input)`, so `<let/input=1/>` lowers
 * to `const input = 1` inside it — every later `${input.x}` then reads the
 * local, and the template's actual input becomes unreachable with no
 * diagnostic. Marko rejects the same thing outright ("Duplicate declaration of
 * `input`"), so this matches its outcome rather than inventing a rule.
 */
function rejectInputShadowing(target: Node, what: string): void {
  if (!bindingNames(target).includes("input")) return;
  fail(
    `\`input\` on ${what} collides with the template input parameter: the emitted render function takes \`input\`, so this binding would shadow it and make the template's own input unreachable`,
    target,
  );
}

/** Every identifier a binding pattern introduces. */
function bindingNames(pattern: Node): string[] {
  if (!pattern || typeof pattern !== "object") return [];
  switch (pattern.type) {
    case "Identifier":
      return [pattern.name];
    case "ObjectPattern":
      return (pattern.properties ?? []).flatMap((p: Node) =>
        bindingNames(p.value ?? p.argument),
      );
    case "ArrayPattern":
      return (pattern.elements ?? []).flatMap((e: Node) => bindingNames(e));
    case "AssignmentPattern":
      return bindingNames(pattern.left);
    case "RestElement":
      return bindingNames(pattern.argument);
    default:
      return [];
  }
}

/**
 * Marko's own comment escaping, as `_escape_comment` implements it.
 *
 * Only `>` is escaped. `<`, `&` and quotes pass through raw — verified against
 * Marko's own render, both for static text and for an interpolated value. This
 * is not `escape()`: a comment is not markup, and over-escaping it would put
 * literal `&amp;` in the reader's comment.
 */
export function escapeComment(text: string): string {
  return text.replace(/>/g, "&gt;");
}

/**
 * Whether a tag name is an element, per this package's own element table
 * (`element-table.ts`: the HTML, SVG and MathML elements Marko's `marko-html`,
 * `marko-svg` and `marko-math` taglibs define, pinned equal by
 * `element-table.test.ts`).
 *
 * A hyphenated name is only a *custom* element when Marko's own taglib lookup
 * actually resolves it — real Marko errors on an unresolved one ("Unable to
 * find entry point for custom tag `<my-widget>`", verified against
 * `@marko/compiler` 5.42.5 / `marko@6.3.51`; see fixture `unknown-element`),
 * it does not render it as literal HTML. Treating every hyphenated name as
 * automatically legal (the previous behaviour here) was strictly more
 * permissive than Marko, which is exactly the class of divergence decision
 * 67 closes. The table has no hyphenated name, so such a tag is neither an
 * element nor (unless discovered) a component.
 */
function isElement(name: string, _ctx: Ctx): boolean {
  return isKnownElement(name);
}

/**
 * Whether a tag name resolves to a component.
 *
 * An `import` binding or a `<define>` is one, as in `@mxlang/html`. So is a
 * tag Marko *discovered* — a `.marko` file in a `tags/` directory beside the
 * template — which is the convention this dialect exists to support and the
 * one MX's own dialect deliberately does not have.
 *
 * A *lowercase* local binding (`import layout from "./layout.marko"` then
 * `<layout>`) is not called directly: real Marko rejects it ("Local
 * variables must be in a dynamic tag unless they are PascalCase. Use
 * `<${layout}/>` or rename to `Layout`.", verified against `@marko/compiler`
 * 5.42.5 / `marko@6.3.51`; see fixture `lowercase-component`) because a
 * lowercase tag name is only ever resolved through taglib/`tags/`
 * discovery, never through a local variable — that ambiguity is what the
 * dynamic-tag syntax exists to remove. A taglib-discovered tag has no such
 * ambiguity (it is never a local variable), so it is unaffected by this
 * check regardless of case. `isComponent` only decides routing (it has no
 * `node` to report a location with); the rejection itself is raised in
 * `emitComponent`, the first place downstream that has one.
 */
function isComponent(name: string, ctx: Ctx): boolean {
  if (ctx.defines.has(name) || ctx.imports.has(name)) return true;
  if (isKnownElement(name)) return false;
  const taglibId = ctx.lookup?.getTag(name)?.taglibId;
  if (taglibId === undefined) return false;
  return taglibId !== "mx-translator-core";
}

/**
 * The `.marko` template Marko's taglib lookup resolved a tag to, so the
 * emitted module can import it the way Marko's own translator does.
 *
 * Only a taglib-discovered tag (`tags/badge.marko`, a package's `marko.json`)
 * has one: a `<define>` or an import is already in scope, and the element
 * and host taglibs carry no template. A tag the taglib declares with no
 * template (a Marko 5 `renderer`) gets `undefined` and keeps its bare call.
 */
function resolveDiscoveredTagModule(
  name: string,
  ctx: Ctx,
): string | undefined {
  if (ctx.defines.has(name) || ctx.imports.has(name)) return undefined;
  const tag = ctx.lookup?.getTag(name);
  if (tag?.taglibId === undefined) return undefined;
  if (isKnownElement(name) || tag.taglibId === "mx-translator-core") {
    return undefined;
  }
  return tag.template;
}

/**
 * `class:foo` / `style:foo` — rejected, with this dialect's own message.
 *
 * The brief asked for these to lower to Marko's semantics. Marko 5.42.5 /
 * `marko@6.3.51` has no such semantics to lower: its own parser rejects every
 * form of them outright —
 *
 *     `class:active` is not a valid attribute, did you mean
 *     `class={ active: condition }`?
 *
 * — for a static value, a dynamic value, alone, and combined with a plain
 * `class`. Verified against Marko's own compiler for `class:active`,
 * `class:big`, `style:color` (static and dynamic) and `class="base"
 * class:active=…`. Matching Marko therefore means *rejecting* them, and
 * inventing a lowering would be inventing markup the target does not have —
 * exactly what decision 65's table forbids. Recorded as a divergence from the
 * brief's expectation, not from Marko.
 *
 * A fixture is impossible for the same reason: no `.marko` file using this
 * syntax compiles through Marko, so there is nothing to compare against.
 *
 * The hook exists so the message is *this* dialect's. Without it the shared
 * core falls back to `@mxlang/html`'s wording ("not supported in a standalone
 * template"), which is `.mx`'s vocabulary leaking into a Marko-parity target.
 */
function rejectModifier(
  attr: Node,
  on: "element" | "component" = "element",
): void {
  // A modifier on a *component* call is a different diagnostic from one on an
  // element: Marko's `class={ active: cond }` fix-it is about markup, and a
  // component takes props rather than attributes, so suggesting it there
  // would point the author at markup they did not write. The pre-IR walk drew
  // the same line, and this keeps its wording.
  if (on === "component") {
    fail(
      `attribute modifier \`${attr.name}:${attr.modifier}\` on a component call is not supported`,
      attr,
    );
  }
  // The parser splits at the last colon; Marko's native reservation and
  // fix-it use the first head and the entire remainder instead.
  const name = `${attr.name}:${attr.modifier}`;
  const colon = name.indexOf(":");
  const head = name.slice(0, colon);
  const remainder = name.slice(colon + 1);
  const suggestion =
    head === "on"
      ? `on${remainder.charAt(0).toUpperCase()}${remainder.slice(1)}`
      : `${head}={ ${remainder}: ${head === "style" ? "value" : "condition"} }`;
  fail(
    `\`${name}\` is not a valid attribute, did you mean \`${suggestion}\`?`,
    attr,
  );
}

/**
 * Marko's own rule: a lowercase tag name is never resolved through a local
 * variable.
 *
 * `import layout from "./layout.marko"` then `<layout>` is refused outright
 * ("Local variables must be in a dynamic tag unless they are PascalCase…",
 * verified against `@marko/compiler` 5.42.5 / `marko@6.3.51`; fixture
 * `lowercase-component`), because a lowercase tag is only ever resolved
 * through taglib/`tags/` discovery — that ambiguity is what the dynamic-tag
 * syntax exists to remove. A taglib-discovered tag is unaffected whatever its
 * case, since it is never a local variable.
 *
 * This runs at *resolve* time. Before the IR, it lived in `emitComponent`,
 * "the first place downstream that has a node"; with the emitter no longer
 * seeing Marko nodes, resolve is that place.
 */
function rejectComponentTag(name: string, node: Node, ctx: Ctx): void {
  if (!(ctx.defines.has(name) || ctx.imports.has(name))) return;
  if (/^[A-Z]/.test(name)) return;
  fail(
    `Local variables must be in a dynamic tag unless they are PascalCase. Use \`<\${${name}}/>\` or rename to \`${name[0]?.toUpperCase()}${name.slice(1)}\`.`,
    node,
  );
}

/**
 * Marko's own failure for a tag name nothing resolves.
 *
 * A hyphenated name with no taglib entry is Marko's failed custom-element
 * lookup ("Unable to find entry point for custom tag `<my-widget>`", verified
 * against `@marko/compiler` 5.42.5 / `marko@6.3.51`; fixture
 * `unknown-element`), not literal HTML. Reported in Marko's words rather than
 * the core's generic "unknown tag", which is a dialect's vocabulary leaking
 * into a parity target.
 */
function rejectUnknownTag(name: string, node: Node, ctx: Ctx): void {
  fail(
    unresolvedCustomTagMessage(name, {
      candidates: [...ctx.imports, ...ctx.defines.keys()],
      hint: `Import it (\`import ${name} from "./${name}.mx"\`) or add \`tags/${name}.mx\`.`,
    }),
    node,
  );
}

/**
 * The sentinel `isDelegatedTag`/`resolveDelegatedTag` see for `<${expr}/>`.
 *
 * Re-exported under this package's own name so the emitter matches the same
 * value the core passes, rather than retyping a sentinel — two hand-typed
 * copies is exactly the drift that makes one side silently stop matching.
 */
export const DYNAMIC = DYNAMIC_TAG;

/**
 * What `resolveDelegatedTag` decides about a tag this host claims, for its emitter.
 *
 * Recorded while the Marko node is still in hand (decision 79's `data` slot),
 * so the emitter never re-inspects one to recover a decision the resolver
 * already made.
 */
export type DelegatedTagData =
  /** `<let>`/`<const>`: bind the initial value at render scope. */
  | { kind: "binding"; init: string }
  /** A `server` block: hoists and runs, exactly as `static` does. */
  | { kind: "statement"; code: string }
  | { kind: "html-comment" }
  /** `<html-script>`/`<html-style>`: a literal element with a raw-text body. */
  | { kind: "raw-element"; tag: string }
  | { kind: "style" }
  | { kind: "try" }
  /**
   * `<${expr}/>`: the target expression only.
   *
   * The children live on the `DelegatedTag`'s own `children`, already resolved by
   * the core — this carries no `content` block, so nothing re-resolves them.
   */
  | { kind: "dynamic"; expr: Expr };

/** Tag names this host lowers itself, rather than as a component or element. */
const CLAIMED = new Set([
  // `<const>` is deliberately absent: the core's own switch dispatches it to
  // `lowerConst` before `isDelegatedTag` is ever consulted, so an entry here
  // would be dead code that reads as though this host owned the tag.
  "let",
  "server",
  "html-comment",
  "html-script",
  "html-style",
  "style",
  "try",
  DYNAMIC_TAG,
]);

function isDelegatedTag(name: string): boolean {
  return CLAIMED.has(name);
}

/**
 * Resolves a claimed tag to the decision its emitter needs.
 *
 * Every rejection this host makes for its own tags happens here, during
 * resolve, so a construct the target cannot express fails with a position
 * rather than reaching an emitter that would have to re-derive why.
 */
function resolveDelegatedTag(
  name: string,
  node: Node,
  ctx: Ctx,
): DelegatedTagData {
  if (name === DYNAMIC_TAG) {
    // Only the target expression is decided here. The children are *not*
    // resolved again: the core has already resolved them into the
    // `DelegatedTag`'s own `children`, and walking the same Marko nodes a second
    // time replays every resolver side effect (hoists, binding
    // registrations) and makes nested dynamic tags resolve exponentially.
    // The emitter builds the `content` block from `tag.children`.
    return {
      kind: "dynamic",
      expr: {
        code: expr(ctx, node.name),
        shape: expressionShape(node.name),
        node: node.name,
      },
    };
  }

  if (name === "let" || name === "const") {
    if (!node.var) {
      fail(
        `\`<${name}>\` without a variable name (write \`<${name}/x=1/>\`)`,
        node,
      );
    }
    rejectUnsupportedFields(ctx, node, `\`<${name}>\``, { var: true });
    rejectInputShadowing(node.var, `\`<${name}>\``);
    const value = attrByName(node, "value") ?? node.attributes?.[0];
    // `<let/x/>` with no value is a declared-but-unset binding, which Marko
    // renders as the empty string.
    return {
      kind: "binding",
      init: value?.value ? expr(ctx, value.value) : "undefined",
    };
  }

  if (name === "server") {
    return {
      kind: "statement",
      code: sliceLoc(ctx, node.loc)
        .trim()
        .replace(/^server\s+/, ""),
    };
  }

  if (name === "html-comment") {
    rejectUnsupportedFields(ctx, node, "`<html-comment>`");
    return { kind: "html-comment" };
  }

  if (name === "html-script" || name === "html-style") {
    rejectUnsupportedFields(ctx, node, `\`<${name}>\``);
    return { kind: "raw-element", tag: name.slice("html-".length) };
  }

  if (name === "style") {
    rejectUnsupportedFields(ctx, node, "`<style>`");
    return { kind: "style" };
  }

  // `<try>` itself is a core-owned custom tag
  // (`packages/core/src/builtin-tags.ts`): every other shape check — no
  // params, no `/var`, one `<@catch>`, one `<@placeholder>` with no params of
  // its own — already ran before this host is asked to render the primitive.
  // Only this target's own limit remains here: a `<@placeholder>` needs a
  // second render pass over suspended content, which this target has no way
  // to schedule.
  const placeholder = (node.attributeTags ?? []).find(
    (t: Node) => String(t.name?.value) === "@placeholder",
  );
  if (placeholder) {
    fail(
      "`<try>` with a `<@placeholder>` needs a second render pass over suspended content; a synchronous string render has nowhere to schedule it",
      placeholder,
    );
  }
  return { kind: "try" };
}

/** The html target's built-in `defaultTag`: the descriptor's field and the ladder's last rung. */
export const DEFAULT_TAG = "div";

export const policy: Policy = {
  name: "@mxlang/html",
  attrTags: 2,
  defineCallPassesAttrs: true,
  // The ladder (decision 145): the parent's contract `defaultTag`, then
  // `mx.<target>.defaultTag`, then the target's built-in (the registry folds
  // the host override into `configured`). This host permits the contract rung:
  // it sets no `allowContractDefaultTag: false`.
  resolveDefaultTag: (_node, parents, context) =>
    contractDefaultTag(parents, context, [DEFAULT_TAG]) ??
    context.configured ??
    DEFAULT_TAG,
  tags: TAGS,
  scriptletReplacement: (name, keyword) =>
    keyword === "const"
      ? `declare a value with \`<const/${name}=…/>\``
      : `declare a value with \`<let/${name}=…/>\` (initial value only on this target)`,
  isElement,
  isComponent,
  resolveDiscoveredTagModule,
  checkBinding: rejectInputShadowing,
  isDelegatedTag,
  isBuiltinTag: (name) => name === "let" || name === "id",
  resolveDelegatedTag,
  // The resolver offers the host first refusal on each of these so the
  // diagnostic quotes Marko's own wording rather than the core's generic
  // fallback, which is `.mx` dialect vocabulary leaking into a Marko-parity
  // target.
  rejectModifier,
  rejectComponentTag,
  rejectUnknownTag,
  rejectElementAttributeTags: (name, node) => {
    const first = node.attributeTags?.[0];
    const slot = String(first?.name?.value ?? "").replace(/^@/, "");
    fail(
      `attribute tag \`@${slot}\` on \`<${name}>\`; attribute tags are props of components, so they are only valid directly inside a component call`,
      first ?? node,
    );
  },
};

/** Runtime import used by this host's emitted modules. */
export const escapeFrom = "@mxlang/html";

/**
 * Reactive and debug-only constructs, rejected by name instead of rendering
 * their initial value or being treated as inert.
 *
 * Kept from `.mx`'s dialect (decision 68's policy fold) as an opt-in stance,
 * not the default: `policy.tags` renders `<let>`'s initial value and treats
 * `<effect>`/`<lifecycle>`/`<script>`/`<client>`/`<id>` as inert, matching
 * what Marko's own server render emits (decision 65). A `strict` author may
 * instead want a construct that only makes sense with a reactive runtime to
 * be a compile error, naming the construct, rather than silently accepted.
 * `<log>`/`<debug>` join this set for the same reason (decision 111): both
 * are debug-only tooling with no place in output a strict author expects to
 * be exhaustively accounted for, so they are rejected by name rather than
 * compiled away as inert.
 * `<await>`/`<try>`-with-placeholder are errors in both policies already —
 * the target genuinely cannot express them — so only the inert/initial-value
 * rows change here. `<return>` has no row: it is not this target's business,
 * since a returning tag is its own compiled module (see the `<return>`
 * comment above).
 */
const STRICT_TAGS: Record<string, Disposition> = {
  ...TAGS,
  let: {
    kind: "error",
    reason:
      "`<let>` is reactive state and requires a runtime; this strict policy has no reactive target",
  },
  effect: {
    kind: "error",
    reason:
      "`<effect>` is a reactive effect and requires a runtime; this strict policy has no reactive target",
  },
  lifecycle: {
    kind: "error",
    reason:
      "`<lifecycle>` is a reactive lifecycle hook and requires a runtime; this strict policy has no reactive target",
  },
  script: {
    kind: "error",
    reason:
      "`<script>` as a Marko tag runs client code and requires a runtime; this strict policy has no reactive target",
  },
  client: {
    kind: "error",
    reason:
      "a `client` block is client-only and requires a runtime; this strict policy has no reactive target",
  },
  id: {
    kind: "error",
    reason:
      "`<id>` allocates an identifier for the reactive runtime; this strict policy has no reactive target",
  },
  log: {
    kind: "error",
    reason:
      "`<log>` writes to the console; this strict policy rejects debug-only constructs by name rather than silently compiling them away",
  },
  debug: {
    kind: "error",
    reason:
      "`<debug>` is a debugger hook; this strict policy rejects debug-only constructs by name rather than silently compiling them away",
  },
};

/**
 * The `strict` policy: stock Marko syntax, reactive constructs rejected by
 * name instead of rendered as inert or as their initial value.
 */
export const strictPolicy: Policy = {
  ...policy,
  tags: STRICT_TAGS,
  scriptletReplacement: (name, keyword) =>
    keyword === "const" ? `declare a value with \`<const/${name}=…/>\`` : "",
};

/**
 * The one helper beyond `escape` the emitted module may need, inlined rather
 * than imported so the runtime surface stays a single import.
 *
 * A dynamic tag's target is whatever the expression evaluated to: a component
 * function, a renderable block (`() => string`), or a tag name as a string.
 */
const CLASS_VALUE = `function __mxClassValue(__mxValue: unknown): string {
  if (!__mxValue) return "";
  if (typeof __mxValue === "string") return __mxEscape(__mxValue);
  if (Array.isArray(__mxValue)) {
    return __mxValue.map(__mxClassValue).filter(Boolean).join(" ");
  }
  if (typeof __mxValue === "object") {
    return Object.entries(__mxValue).filter(([, __mxEnabled]) => __mxEnabled).map(([__mxKey]) => __mxEscape(__mxKey)).join(" ");
  }
  return __mxEscape(__mxValue);
}`;

const STYLE_VALUE = `function __mxStyleValue(__mxValue: unknown): string {
  if (!__mxValue) return "";
  if (typeof __mxValue === "string") return __mxEscape(__mxValue);
  if (Array.isArray(__mxValue)) {
    return __mxValue.map(__mxStyleValue).filter(Boolean).join(";");
  }
  if (typeof __mxValue === "object") {
    return Object.entries(__mxValue)
      .filter(([, __mxEntryValue]) => __mxEntryValue !== false && __mxEntryValue !== null && __mxEntryValue !== undefined && __mxEntryValue !== "")
      .map(([__mxKey, __mxEntryValue]) => __mxEscape(__mxKey) + ":" + __mxEscape(__mxEntryValue))
      .join(";");
  }
  return __mxEscape(__mxValue);
}`;

// Capture the authored expression once, then decide presence before coercion.
// `checked` is presence-only on a direct <input>, but generic on spread and
// dynamic native paths, matching Marko 6.3.51's controlled-input writer.
const RENDER_ATTR = `function __mxRenderAttr(__mxName: string, __mxValue: unknown, __mxTag = "", __mxChecked = false): string {
  if (__mxValue === false || __mxValue === null || __mxValue === undefined) return "";
  if (__mxChecked || __mxValue === true) return " " + __mxName;
  return " " + __mxName + '="' + __mxEscape(__mxAttrValue(__mxName, __mxValue, __mxTag)) + '"';
}`;

// Marko 6.3.51's html `_textarea_value`: `normalizeStrAttrValue` (nothing for
// null/undefined/false/true), escaped as text, and a leading newline doubled
// because the HTML parser drops the first one.
const TEXTAREA_CONTENT = `function __mxTextareaContent(__mxValue: unknown): string {
  const __mxText = __mxEscape(__mxValue === null || __mxValue === undefined || __mxValue === false || __mxValue === true ? "" : __mxValue + "");
  return __mxText[0] === "\\n" ? "\\n" + __mxText : __mxText;
}`;

// Marko 6.3.51's `_escape_comment` / `_unescaped`: falsy renders nothing except
// `0`, only `>` is escaped (not at all for `$!{}`), and a value that renders
// as `[object X]` throws, as Marko's debug build does.
const ESCAPE_COMMENT = `function __mxEscapeComment(__mxValue, __mxEscaped) {
  if (typeof __mxValue === "object" && __mxValue !== null) {
    let __mxCoerced;
    try { __mxCoerced = \`\${__mxValue}\`; } catch { __mxCoerced = "[object Object]"; }
    if (/^\\[object \\w+\\]$/.test(__mxCoerced)) {
      throw new Error("Text content cannot be " + (__mxCoerced === "[object Object]" ? "a plain object (it would render as \`[object Object]\`)" : "a value that renders as \`" + __mxCoerced + "\`") + ".");
    }
  }
  const __mxText = __mxValue ? String(__mxValue) : __mxValue === 0 ? "0" : "";
  return __mxEscaped ? __mxText.replace(/>/g, "&gt;") : __mxText;
}`;

// Decision 155: writes into the caller's sink and returns what the callee's
// \`render\` returns, which is what a \`/var\` on the dynamic tag binds. A
// compiled template is told apart by its \`.render\` entry, never by the shape
// of what it returns; any other function returns a string that is written.
// The overload types the binding \`undefined\` only when the type proves the
// callee has no \`render\` (a string, null, undefined, false, 0 or a plain function);
// \`unknown\`, \`object\`, \`{}\` and \`Function\` might be a unit at run time, so
// they bind \`unknown\`, and \`any\` stays \`any\`.
const RENDER_DYNAMIC = `function __mxRenderDynamic<T>(__mxSink: __MxOut, __mxTarget: T, __mxProps: __MxDynamicProps<T>, __mxArgs?: any[]): 0 extends 1 & T ? any : T extends { render: (input: never, out: never) => infer R } ? R : T extends string | null | undefined | false | 0 | ((...__mxA: any) => any) ? undefined : unknown;
function __mxRenderDynamic(__mxSink: __MxOut, __mxTarget: any, __mxProps: Record<string, any>, __mxArgs?: any[]): any {
  if (!__mxTarget) {
    // Decision 116 + Marko parity: a falsy renderer (null, undefined, false,
    // 0, "") renders no tag of its own; content renders independently.
    if (__mxProps.content) __mxSink.write(__mxProps.content());
    return;
  }
  if (typeof __mxTarget === "string") {
    // decision 112: args[0] provides native attributes; content stays separate.
    const __mxAttrs = __mxArgs ? __mxArgs[0] || {} : __mxProps;
    let __mxOut = "<" + __mxTarget;
    for (const [__mxKey, __mxValue] of Object.entries(__mxAttrs)) {
      if (__mxKey === "content") continue;
      if (__mxTarget === "textarea" && __mxKey === "value") continue;
      if (__mxValue === false || __mxValue === null || __mxValue === undefined) continue;
      if (__mxKey === "class" || __mxKey === "style") {
        const __mxText = __mxKey === "class" ? __mxClassValue(__mxValue) : __mxStyleValue(__mxValue);
        if (__mxText !== "") __mxOut += " " + __mxKey + "=\\"" + __mxText + "\\"";
      } else __mxOut += __mxRenderAttr(__mxKey, __mxValue, __mxTarget);
    }
    __mxOut += ">";
    if (__mxTarget === "textarea") {
      // Marko: a dynamic <textarea> takes \`value\`, never content.
      if (__mxProps.content) throw new Error("A dynamic tag rendering a \`<textarea>\` cannot have \`content\` and must use the \`value\` attribute instead.");
      __mxOut += __mxTextareaContent(__mxAttrs.value);
    } else if (__mxProps.content) __mxOut += __mxProps.content();
    // Marko 6.3.51's html/dynamic-tag.ts voidElementsReg, case-sensitive.
    __mxSink.write(/^(?:area|b(?:ase|r)|col|embed|hr|i(?:mg|nput)|link|meta|param|source|track|wbr)$/.test(__mxTarget) ? __mxOut : __mxOut + "</" + __mxTarget + ">");
    return;
  }
  if (typeof __mxTarget === "object") {
    throw new TypeError("MX: this value is a data attribute tag ({ ...attrs, content }); render its body with <\${x.content}/>");
  }
  if (__mxArgs) {
    // Marko 6.3.51 calls a template with its args, so args[0] is its input.
    if (typeof __mxTarget.render === "function") return __mxTarget.render(__mxArgs[0], __mxSink);
    __mxSink.write("" + (Object.keys(__mxProps).length > 0 ? __mxTarget(...__mxArgs, __mxProps) : __mxTarget(...__mxArgs)));
    return;
  }
  if (typeof __mxTarget.render === "function") return __mxTarget.render(__mxProps, __mxSink);
  __mxSink.write("" + __mxTarget(__mxProps));
}`;

// What a dynamic call's props are checked against: a callee with `render` or a
// plain function (a `.ts` module tag, decision 116's value-import routing) takes
// its input's type, so a wrong or missing prop is a TypeScript error at the
// call; a string, block, `any`, a zero-parameter function or an overloaded
// one (its last three signatures' inputs differ) stays loose.
const DYNAMIC_PROPS = `type __MxDynamicProps<T> = 0 extends 1 & T ? Record<string, any> : [NonNullable<T>] extends [{ render: (input: infer I, out: never) => unknown }] ? I : [NonNullable<T>] extends [{ (input: infer A, ...__mxA: any): unknown; (input: infer B, ...__mxA: any): unknown; (input: infer C, ...__mxA: any): unknown }] ? [unknown] extends [B] ? C : [B] extends [C] ? [C] extends [B] ? [unknown] extends [A] ? C : [A] extends [C] ? [C] extends [A] ? C : Record<string, any> : Record<string, any> : Record<string, any> : Record<string, any> : Record<string, any>;`;

// Decision 155: a statically named tag that is not known to be a compiled
// template (a hand-written function, or a \`.ts\` barrel re-export of one).
// Typed the way the call is made: through \`render\` when the callee has one
// (a compiled template, whose default export a host may present differently:
// Astro's type surface gives it Astro's props), else as the callee itself, so
// the call site's props are checked as a plain \`Callee(props)\` call,
// generics included.
const RENDER_TAG = `function __mxRenderTag<F extends (input: never) => unknown>(__mxSink: __MxOut, __mxTag: F): __MxRenderCall<F> {
  const __mxCallee = __mxTag as unknown as ((input: unknown) => unknown) & { render?: (input: unknown, out: __MxOut) => unknown };
  return ((__mxInput: unknown) => {
    if (typeof __mxCallee.render === "function") return __mxCallee.render(__mxInput, __mxSink);
    __mxSink.write("" + __mxCallee(__mxInput));
  }) as unknown as __MxRenderCall<F>;
}`;

/** What `__mxRenderTag` returns: `render`'s input when the callee has one. */
const RENDER_CALL = `type __MxRenderCall<F> = [F] extends [{ render: (input: infer I, out: never) => unknown }] ? (input: I) => void : F;`;

/**
 * The input an MX call to `F` passes, the way the call is made: `render`'s
 * input when the callee has one, else its first parameter (`Parameters<F>[0]`).
 * An attribute tag's value is checked against it.
 */
const INPUT_OF = `type __MxInputOf<F> = [F] extends [{ render: (input: infer I, out: never) => unknown }] ? I : F extends (...args: infer P) => unknown ? P[0] : never;`;

/**
 * The core's emitted default export, as text, for the two rewrites below.
 *
 * Both `finalizeModule`'s helper injection and `brandRender` key off this exact
 * line, so it is written once rather than twice.
 */
// Always `: string` since decision 155: a unit that declares `<return>`
// returns its value from `render`, not from the default export.
const DEFAULT_EXPORT =
  /\nexport default function ([A-Za-z_$][\w$]*)\(input: (Input(?: & \{ content\?: \(\) => string \})?)\): string \{/;

/**
 * The core's emitted default-export line, and the name it declares.
 *
 * The name is the file's, not a fixed `render` (`icon.mx` -> `Icon`), so this
 * matches the shape and reads the name back rather than pinning a literal.
 * Both `finalizeModule`'s helper injection and `brandRender` key off it.
 */
function defaultExportIn(
  code: string,
): { line: string; name: string; inputType: string } | null {
  const match = code.match(DEFAULT_EXPORT);
  return match?.[1] && match[2]
    ? { line: match[0], name: match[1], inputType: match[2] }
    : null;
}

/**
 * The module's branded tail: the brand, then the default export typed as what
 * it is to a consumer.
 *
 * The `as` names the signature rather than leaving TypeScript to infer
 * `typeof Name` from the declaration plus its `Name.render = …` expando, which
 * diagnostics print as `typeof Name` and so hide the call signature an agent
 * needs to read ("not assignable to type 'typeof Comp'"). It is a pure
 * restatement of the declaration's own type, so it widens nothing, and it is
 * erased with the rest of the types: the emitted JavaScript still ends in
 * `export default Name;`, which is what `@mxlang/astro`'s page wrapper
 * matches after the bundler strips types.
 */
function brandedTail(name: string, inputType: string): string {
  return `Object.defineProperty(${name}, Symbol.for("mx.component"), { value: true });

export default ${name} as ((input: ${inputType}) => string) & { render: typeof __mxRender };
`;
}

/**
 * The same signature line, rebound to a plain named declaration.
 *
 * `export default function Icon(…)` becomes `function Icon(…)`, so the brand
 * below has a binding to hang a property off and the module exports it at the
 * end instead.
 */
function namedRenderFrom(defaultExport: string): string {
  return defaultExport.replace("export default function ", "function ");
}

/**
 * The brand a host's `check()` tests for.
 *
 * `Symbol.for`, not a unique symbol: the property is written by the compiled
 * module and read by a *different* package (`@mxlang/astro`'s renderer), quite
 * possibly from a different copy of this one on disk, so the two sides must
 * agree on the symbol by name through the global registry rather than by
 * identity through a shared import.
 */
export const MX_COMPONENT = Symbol.for("mx.component");

/**
 * Marks the compiled module's default export as an MX component.
 *
 * A framework host that receives a component as an opaque value — Astro's
 * renderer contract hands `check(Component, props, slots)` the function and
 * nothing else — has no other way to tell an MX template apart from any other
 * function. Astro's own docs suggest sniffing `Component.name`, which a
 * minifier is free to rewrite and which any function could collide with; an
 * explicit brand is exact.
 *
 * The core emits `export default function <Name>(input) {}`, named after the
 * file. That statement still has no binding to hang a property off, so this
 * rewrites it to a plain `function <Name>(input) {}` declaration, brands that,
 * and exports it at the end — keeping the author's own name rather than
 * imposing one, since a tag's self-recursive call resolves to it.
 *
 * `Object.defineProperty` rather than `render[Symbol.for(…)] = true`: the
 * emitted module is TypeScript, and a consumer runs `tsc` over it. Assigning
 * through a computed symbol key is `TS7053` ("expression of type 'symbol'
 * can't be used to index type 'typeof render'") under `strict`, which would
 * make every compiled template a type error in the user's own build. The
 * defineProperty form needs no index signature, and leaves the brand
 * non-enumerable besides, so it never shows up in a spread of the function's
 * own properties.
 *
 * **Throws if the core's export line is not found.** Recognising the emitted
 * module by matching a literal is brittle by construction: if the core's
 * emitter ever changes that line, a silent `return code` would hand back an
 * unbranded module, and every `check()` in the Astro host would answer false
 * with nothing anywhere reporting why — a whole host quietly failing to claim
 * its own components. Decision 61: fail loud at the seam that broke.
 *
 * A plain `Error`, not a `TranslateError`: this runs over emitted text, not
 * over a Marko node, so there is no source line or column to carry and
 * inventing one would point the reader at innocent template code.
 *
 * The real fix is to stop matching text at all — load the emitted module and
 * brand the function object — which is the `oracle-shape` follow-up task,
 * where `packages/oracle/src/translator-render.ts` has the same brittleness.
 */
export function brandRender(code: string): string {
  const defaultExport = defaultExportIn(code);
  if (!defaultExport) {
    throw new Error(
      "@mxlang/html: cannot brand the compiled module — the emitted " +
        `code does not match the expected default export shape ${String(
          DEFAULT_EXPORT,
        )}. The core's emitter has changed shape; update DEFAULT_EXPORT in ` +
        "translate.ts to match, or an Astro host's `check()` will silently " +
        "stop recognising MX components.",
    );
  }

  const { line, name, inputType } = defaultExport;
  return `${code.replace(line, namedRenderFrom(line))}
${brandedTail(name, inputType)}`;
}

/**
 * This host's post-emit pass: appends the helpers the module actually calls,
 * and brands the default export.
 *
 * Runs over the core's emitted module text (`HostOptions.postEmit`) rather
 * than inside the core's emitter, because *which* helpers exist — and that
 * they are inlined rather than imported, to keep the runtime surface at one
 * `escape` — is a property of this host's target, not of the core.
 */
function moduleHelpers(code: string): string[] {
  const dynamic = code.includes("__mxRenderDynamic(");
  const candidates: [boolean, string][] = [
    [code.includes("__mxRenderAttr(") || dynamic, RENDER_ATTR],
    [code.includes("__mxClassValue(") || dynamic, CLASS_VALUE],
    [code.includes("__mxStyleValue(") || dynamic, STYLE_VALUE],
    [code.includes("__mxTextareaContent(") || dynamic, TEXTAREA_CONTENT],
    [code.includes("__mxEscapeComment("), ESCAPE_COMMENT],
    [dynamic, DYNAMIC_PROPS],
    [dynamic, RENDER_DYNAMIC],
    [code.includes("__mxRenderTag("), RENDER_CALL],
    [code.includes("__mxRenderTag("), RENDER_TAG],
    [code.includes("__MxInputOf<"), INPUT_OF],
  ];
  const helpers = candidates.flatMap(([used, source]) =>
    used ? [source] : [],
  );
  if (
    code.includes("__mxAttrValue(") ||
    helpers.some((helper) => helper.includes("__mxAttrValue("))
  ) {
    helpers.unshift(`const __mxAttrValue = ${ATTRIBUTE_VALUE_EXPRESSION};`);
  }
  return helpers;
}

export function finalizeModule(code: string): string {
  const helpers = moduleHelpers(code);
  if (helpers.length === 0) return brandRender(code);
  const defaultExport = defaultExportIn(code);
  if (!defaultExport) return brandRender(code);

  // Placed after the author's own hoisted module scope so it cannot shadow a
  // binding they declared.
  return brandRender(
    code.replace(
      defaultExport.line,
      `\n${helpers.join("\n\n")}\n${defaultExport.line}`,
    ),
  );
}

/** `finalizeModule`, preserving emitter-recorded generated offsets. */
export function finalizeModuleWithMappings(emitted: MappedCode): MappedCode {
  const helpers = moduleHelpers(emitted.code);
  const defaultExport = defaultExportIn(emitted.code);
  if (!defaultExport) {
    // Reuse the detailed seam failure from the string-only path.
    brandRender(emitted.code);
    throw new Error("@mxlang/html: unreachable missing default export");
  }
  const { line, name, inputType } = defaultExport;
  const withHelpers =
    helpers.length === 0
      ? emitted
      : replaceMapped(emitted, line, `\n${helpers.join("\n\n")}\n${line}`);
  const branded = replaceMapped(withHelpers, line, namedRenderFrom(line));
  return concatMapped(branded, brandedTail(name, inputType));
}
