import { ATTRIBUTE_VALUE_EXPRESSION } from "@mxlang/core";

/**
 * What a spread helper returns to the type checker: the object itself, or `{}`
 * for a value that is not an object type (`unknown`, string, number, boolean),
 * which TypeScript cannot spread. The runtime value is unchanged: the helpers
 * pass a non-object through, and the JSX runtime ignores it. An object type
 * stays itself, so a wrongly typed key still reports at the authored attribute.
 */
const SPREADABLE = "T extends object ? T : {}";

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
 * `prop:` (a real property write), ref, class, style and children. Everything
 * else, including `attr:`, `bool:`, `use:` and classList, is a plain attribute
 * write on Solid and validates like Marko.
 * `<T,>` keeps the helper unconstrained so any spread type-checks, and {@link SPREADABLE} keeps its result spreadable (covered by mx-tsc `attr-guard-solid.test.ts`).
 *
 * Four keys are not "a plain attribute write" on Solid, and each can put
 * markup into the page where Marko prints a spread's key as an ordinary
 * attribute with an escaped value:
 *  - `innerHTML`, `outerHTML`, `textContent` and `innerText` are props Solid
 *    assigns as markup (server) or as DOM properties (client; the server also
 *    writes `textContent`/`innerText` raw inside `<script>` and `<style>`).
 *    The view lists them under their lowercase names, which are no such props,
 *    so Solid writes the attribute Marko does (an HTML parser reads the same
 *    attribute name); the camel-case names read as absent.
 *  - `prop:innerHTML` and `prop:outerHTML` assign the DOM property on the
 *    client; they are hidden.
 *  - `children` is exempt for a native element's own content, but the server
 *    treats an object there as an already-rendered node (`{ t: "<b>" }` is
 *    written raw), and writes any value raw inside `<script>` and `<style>`.
 *    It is hidden unless it is a primitive on another element, where Solid
 *    escapes it as text.
 * The view sits over an empty target, so hiding or renaming a key breaks no
 * Proxy invariant, even for a frozen source.
 */
export const ATTR_SPREAD_HELPER = String.raw`function ${MX_ATTR_SPREAD_BINDING}<T,>(attrs: T, tag: string | null = ""): ${SPREADABLE} {
  if (tag === null || attrs === null || typeof attrs !== "object") return attrs as never;
  const source = attrs as object;
  const markup = ["innerHTML", "outerHTML", "textContent", "innerText"];
  const hidden = (key: string | symbol): boolean => {
    if (typeof key !== "string") return false;
    if (markup.includes(key) || key === "prop:innerHTML" || key === "prop:outerHTML") return true;
    if (key !== "children" || !Reflect.has(source, key)) return false;
    const child = Reflect.get(source, key);
    return tag === "script" || tag === "style" || (child !== null && (typeof child === "object" || typeof child === "function"));
  };
  const original = (key: string | symbol): string | symbol => {
    const name = typeof key === "string" ? markup.find((entry) => entry.toLowerCase() === key) : undefined;
    return name !== undefined && Reflect.has(source, name) ? name : key;
  };
  return new Proxy({}, {
    get(_, key) {
      if (hidden(key)) return undefined;
      const name = original(key);
      const value = Reflect.get(source, name);
      if (typeof name === "string" && !/^(?:(?:ref|children|class|style|\$mxReturn)$|on[A-Z:-]|oncapture:|prop:)/.test(name)) {
        try { ${MX_ATTR_VALUE_BINDING}(name, value, tag); } catch (error) {
          if ((name === "innerHTML" || name === "outerHTML") && error instanceof Error) error.message += " To write raw HTML, make \`$!{html}\` the element's only child.";
          throw error;
        }
      }
      return (name === "class" || name === "style") && value === true ? "true" : value;
    },
    has: (_, key) => !hidden(key) && Reflect.has(source, original(key)),
    ownKeys: () => [...new Set(Reflect.ownKeys(source).flatMap((key) => (hidden(key) ? (typeof key === "string" && markup.includes(key) ? [key.toLowerCase()] : []) : (key === "class" || key === "style") && !Reflect.get(source, key) ? [] : [key])))],
    getOwnPropertyDescriptor(_, key) {
      if (hidden(key)) return undefined;
      const descriptor = Reflect.getOwnPropertyDescriptor(source, original(key));
      return descriptor && { ...descriptor, configurable: true };
    },
  }) as never;
}`;

/** Module-scope bindings the emitted `<textarea>` helpers call. */
export const MX_TEXTAREA_CONTENT_BINDING = "__mxTextareaContent";
export const MX_TEXTAREA_PICK_BINDING = "__mxTextareaPick";
export const MX_TEXTAREA_OMIT_BINDING = "__mxTextareaOmit";
export const MX_SCRIPT_TEXT_BINDING = "__mxScriptText";
export const MX_IS_SERVER_BINDING = "__mxIsServer";
export const MX_TEXTAREA_DYN_VALUE_BINDING = "__mxTextareaDynValue";
export const MX_TEXTAREA_DYN_SPREAD_BINDING = "__mxTextareaDynSpread";

/**
 * `<textarea value=x>` renders `x` as the textarea's content, as Marko 6.4.4
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
export const TEXTAREA_OMIT_HELPER = `function ${MX_TEXTAREA_OMIT_BINDING}<T,>(attrs: T): ${SPREADABLE} {
  if (attrs === null || typeof attrs !== "object") return attrs as never;
  return new Proxy(attrs as object, {
    get: (target, key) => (key === "value" ? undefined : Reflect.get(target, key)),
    has: (target, key) => key !== "value" && Reflect.has(target, key),
    ownKeys: (target) => Reflect.ownKeys(target).filter((key) => key !== "value"),
    getOwnPropertyDescriptor: (target, key) => (key === "value" ? undefined : Reflect.getOwnPropertyDescriptor(target, key)),
  }) as never;
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
export const TEXTAREA_DYN_SPREAD_HELPER = `function ${MX_TEXTAREA_DYN_SPREAD_BINDING}<T,>(attrs: T, tag: unknown): ${SPREADABLE} {
  if (tag !== "textarea" || attrs === null || typeof attrs !== "object") return attrs as never;
  return new Proxy(attrs as object, {
    get: (target, key) => (key === "value" ? ${MX_TEXTAREA_DYN_VALUE_BINDING}(Reflect.get(target, key), tag) : Reflect.get(target, key)),
  }) as never;
}`;

/**
 * The body of `<html-script>`, as the text of a `<script>` element: each
 * placeholder stringified as Marko's text rule does (`_to_text`: a truthy value
 * as its string, `0` as `0`, every other falsy value as nothing), then the
 * joined body escaped for script context (`_escape_script`): `<script`,
 * `</script` (any case) and `<!--` become `\u003C…`. Handed to `innerHTML`,
 * because Solid HTML-escapes a text child.
 */
export const SCRIPT_TEXT_HELPER = String.raw`function ${MX_SCRIPT_TEXT_BINDING}(...parts: unknown[]): string {
  return parts.map((part) => (part || part === 0 ? part + "" : "")).join("").replace(/<(\/?script|!--)/gi, "\\u003C$1");
}`;
