import { ATTRIBUTE_VALUE_EXPRESSION } from "@mxlang/core";

/** Module-scope bindings the emitted native-attribute guard calls. */
export const MX_ATTR_VALUE_BINDING = "__mxAttrValue";
export const MX_ATTR_SPREAD_BINDING = "__mxAttrSpread";
export const MX_CLASS_BINDING = "__mxClassProp";

/**
 * Marko drops a falsy primitive `class`/`style` (null, undefined, false, 0, "",
 * NaN), prints `true` as "true" and leaves structured values to its own
 * serializer. Solid's SSR prints `class=""` for any undefined/null/false/""
 * class value, so the attribute has to be absent from the props rather than
 * set to something falsy: a one-key prop object for `class=expr`, and an
 * `ownKeys` filter inside the spread proxy.
 */
export const CLASS_PROP_HELPER = `function ${MX_CLASS_BINDING}<T,>(value: T, tag: string | null = ""): { class?: unknown } {
  if (tag === null || (typeof value === "object" && value !== null)) return { class: value };
  return value ? { class: value === true ? "true" : value } : {};
}`;

/**
 * A `null` tag means "not a native element" (a dynamic tag whose target is a
 * component): the value passes through unvalidated.
 *
 * Hoisted as function declarations (not `const`) so the parser bridge's
 * collision rename, which flips a hoisted declaration's `id.name`, applies.
 * Core's validation expression is reused verbatim, so the message and rules
 * match every other host.
 */
export const ATTR_VALUE_HELPER = `function ${MX_ATTR_VALUE_BINDING}<T,>(name: string, value: T, tag: string | null = ""): T { return tag === null ? value : ${ATTRIBUTE_VALUE_EXPRESSION}(name, value, tag); }`;

/**
 * Solid merges spreads lazily, so the helper must not snapshot the object: a
 * Proxy validates each key as Solid reads it, which keeps reactivity and means
 * a key a later source overwrites is never read, so never validated. Exempt:
 * event handlers (Marko's `/^on[A-Z-]/`, plus Solid's `on:`/`oncapture:`),
 * `prop:` (a real property write) and ref, children, class, style. Everything
 * else, including `attr:`, `bool:`, `use:`, innerHTML, textContent and
 * classList, is a plain attribute write on Solid and validates like Marko.
 * `<T,>` keeps the helper unconstrained so any spread type-checks (covered by mx-tsc `attr-guard-solid.test.ts`).
 */
export const ATTR_SPREAD_HELPER = String.raw`function ${MX_ATTR_SPREAD_BINDING}<T,>(attrs: T, tag: string | null = ""): T {
  if (tag === null || attrs === null || typeof attrs !== "object") return attrs;
  return new Proxy(attrs as object, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof key === "string" && !/^(?:(?:ref|children|class|style|\$mxReturn)$|on[A-Z:-]|oncapture:|prop:)/.test(key)) ${MX_ATTR_VALUE_BINDING}(key, value, tag);
      return (key === "class" || key === "style") && value === true ? "true" : value;
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).filter((key) => (key !== "class" && key !== "style") || Boolean(Reflect.get(target, key)));
    },
  }) as T;
}`;

/** Module-scope bindings the emitted `<textarea>` helpers call. */
export const MX_TEXTAREA_CONTENT_BINDING = "__mxTextareaContent";
export const MX_TEXTAREA_PICK_BINDING = "__mxTextareaPick";
export const MX_TEXTAREA_OMIT_BINDING = "__mxTextareaOmit";
export const MX_IS_SERVER_BINDING = "__mxIsServer";
export const MX_TEXTAREA_DYN_VALUE_BINDING = "__mxTextareaDynValue";
export const MX_TEXTAREA_DYN_SPREAD_BINDING = "__mxTextareaDynSpread";

/**
 * `<textarea value=x>` renders `x` as the textarea's content, as Marko 6.3.51
 * does: `null`/`undefined`/`false`/`true` as nothing, everything else as text,
 * and a leading newline doubled because the HTML parser drops a textarea's
 * first one. Only the server renderer writes markup, so the doubling is keyed
 * on `isServer` (Solid's own build-time constant); a client render sets the
 * text through the DOM, where a doubled newline would show.
 */
export const TEXTAREA_CONTENT_HELPER = String.raw`function ${MX_TEXTAREA_CONTENT_BINDING}(value: unknown): string {
  const text = value === null || value === undefined || value === false || value === true ? "" : String(value);
  return ${MX_IS_SERVER_BINDING} && text[0] === "\n" ? "\n" + text : text;
}`;

/** The `value` a spread contributes in source order: its own, else what came before. */
export const TEXTAREA_PICK_HELPER = `function ${MX_TEXTAREA_PICK_BINDING}(previous: unknown, attrs: unknown): unknown { return attrs !== null && typeof attrs === "object" && "value" in attrs ? (attrs as { value: unknown }).value : previous; }`;

/**
 * A spread's view without `value`: a textarea's value is rendered as content
 * (see above), never as an attribute. A Proxy, not a copy, so Solid's lazy
 * spread keeps reading the live object.
 */
export const TEXTAREA_OMIT_HELPER = `function ${MX_TEXTAREA_OMIT_BINDING}<T,>(attrs: T): T {
  if (attrs === null || typeof attrs !== "object") return attrs;
  return new Proxy(attrs as object, {
    get: (target, key) => (key === "value" ? undefined : Reflect.get(target, key)),
    has: (target, key) => key !== "value" && Reflect.has(target, key),
    ownKeys: (target) => Reflect.ownKeys(target).filter((key) => key !== "value"),
    getOwnPropertyDescriptor: (target, key) => (key === "value" ? undefined : Reflect.getOwnPropertyDescriptor(target, key)),
  }) as T;
}`;

/**
 * A runtime-resolved tag may turn out to be a `<textarea>`: Solid's `ssrElement`
 * then writes its `value` prop as content, so the leading newline the HTML
 * parser drops has to be doubled here, on the server only, as in
 * {@link TEXTAREA_CONTENT_HELPER}. Any other target passes through untouched.
 */
export const TEXTAREA_DYN_VALUE_HELPER = String.raw`function ${MX_TEXTAREA_DYN_VALUE_BINDING}<T,>(value: T, tag: unknown): T {
  return ${MX_IS_SERVER_BINDING} && tag === "textarea" && typeof value === "string" && value[0] === "\n" ? ("\n" + value) as T : value;
}`;

/** The same doubling for the `value` a spread (or the args object) contributes; a Proxy keeps Solid's lazy spread live. */
export const TEXTAREA_DYN_SPREAD_HELPER = `function ${MX_TEXTAREA_DYN_SPREAD_BINDING}<T,>(attrs: T, tag: unknown): T {
  if (tag !== "textarea" || attrs === null || typeof attrs !== "object") return attrs;
  return new Proxy(attrs as object, {
    get: (target, key) => (key === "value" ? ${MX_TEXTAREA_DYN_VALUE_BINDING}(Reflect.get(target, key), tag) : Reflect.get(target, key)),
  }) as T;
}`;
