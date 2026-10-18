/**
 * Primitive attribute values on native elements, normalized to what Marko
 * 6.4.4's html output renders. One source shared by the three JSX hosts;
 * hoisted into the emitted module like core's validation helpers, never a
 * runtime dependency. Component props do not pass through it.
 *
 * Marko's rules, measured by real render:
 *  - generic/data/aria/value: `null`/`undefined`/`false` omit, `true` is a
 *    bare attribute, everything else is kept (`0` -> `"0"`, `""` -> bare).
 *  - `class`/`style`: `null`/`undefined`/`false`/`0`/`""` omit, `true` -> "true".
 *  - `input.checked` written directly is presence-only; through a spread or a
 *    merged object it keeps its value like any other attribute.
 *
 * The JSX renderers disagree with that in small ways (Preact/Hono print
 * `data-x="true"`/`"false"`, Hono prints `class="false"`, React drops `true`
 * on non-boolean props), so the value is rewritten before the renderer sees it.
 * React cannot print a boolean property's value text at all (`disabled="0"`):
 * for its boolean properties presence is the contract.
 */
import { ATTRIBUTE_VALUE_EXPRESSION } from "@mxlang/core";

/** HTML boolean attributes: `true` must stay `true`, the renderers print them bare. */
const BOOLEAN_ATTRIBUTES = [
  "allowfullscreen",
  "async",
  "autofocus",
  "autoplay",
  "checked",
  "controls",
  "default",
  "defer",
  "disabled",
  "disableremoteplayback",
  "formnovalidate",
  "hidden",
  "inert",
  "ismap",
  "itemscope",
  "loop",
  "multiple",
  "muted",
  "nomodule",
  "novalidate",
  "open",
  "playsinline",
  "readonly",
  "required",
  "reversed",
  "selected",
];

/**
 * The names React itself renders as boolean presence under the lowercase
 * spelling MX emits (react-dom 19.3 server property table, measured by render:
 * truthy prints the bare attribute, falsy omits). Every other HTML boolean
 * attribute is spelled camelCase in React (`autoFocus`, `readOnly`, ...) or is
 * element-specific (`selected`): under the lowercase name React takes its
 * unknown-attribute path, which prints a string/number and drops a boolean, so
 * those names pass through raw. `checked` is boolean on `<input>` only.
 */
const REACT_BOOLEAN_ATTRIBUTES = [
  "async",
  "controls",
  "credentialless",
  "default",
  "defer",
  "disabled",
  "hidden",
  "inert",
  "loop",
  "multiple",
  "muted",
  "open",
  "required",
  "reversed",
  "scoped",
  "seamless",
];

/** The normalizer body, shared by the direct and the object paths. */
const NORMALIZE_BODY = `
  const lower = name.toLowerCase();
  if ((tag === "select" || tag === "textarea") && name === "value") return value;
  if (name === "class" || name === "className") {
    if (value === null || value === undefined || value === false || value === 0 || value === "") return undefined;
    return value === true ? "true" : value;
  }
  if (name === "style") {
    if (value === null || value === undefined || value === false || value === 0 || value === "") return undefined;
    return value === true ? "true" : value;
  }
  if (value === null || value === undefined || value === false) return undefined;
  if (direct && tag === "input" && name === "checked") return true;
  const boolean = ${JSON.stringify(BOOLEAN_ATTRIBUTES)}.includes(lower);
  if (boolean && !reactBooleans) return value;
  if (reactBooleans && (${JSON.stringify(REACT_BOOLEAN_ATTRIBUTES)}.includes(lower) || (tag === "input" && lower === "checked"))) return true;
  return value === true ? "" : value;
`;

/** Validation as core does it, then normalization; typed as the input so authored types still check. */
export function jsxAttrValueExpression(reactBooleans: boolean): string {
  return `((validate: (name: string, value: unknown, tag?: string) => unknown) => <T,>(name: string, value: T, tag = "", direct = true, skipValidation = false): T => {
  if (!skipValidation) validate(name, value, tag);
  const reactBooleans = ${reactBooleans};
  const normalized = (): unknown => {${NORMALIZE_BODY}  };
  return normalized() as T;})(${ATTRIBUTE_VALUE_EXPRESSION})`;
}

/**
 * The spread/merged-object writer: validates (skipping `props`/events, as
 * core's does) and normalizes every key. Needs `__mxAttrValue` hoisted first.
 * `class`/`className` are normalized even when they skip validation.
 *
 * A key that would write raw markup (`dangerouslySetInnerHTML`, `innerHTML`,
 * `outerHTML`) is validated like any other and then written under its
 * lowercase name. Marko prints these keys of a spread as ordinary attributes,
 * with an escaped value; as props every JSX renderer reads them as raw HTML
 * (or, on the client, as a DOM property write). A lowercase name is no such
 * prop, so every renderer writes it as the plain attribute Marko does, and an
 * HTML parser reads the same attribute name.
 */
export const JSX_ATTRIBUTE_SPREAD_EXPRESSION = `(<T extends object | null | undefined,>(attrs: T, tag = "", props: readonly string[] = [], events = false): T => {
  const values = { ...attrs } as Record<string, unknown>;
  for (const name of Object.keys(values)) {
    const skip = props.includes(name) || (events && /^on[A-Z]/.test(name));
    if (skip && name !== "class" && name !== "className") continue;
    if (name === "key" || name === "ref") continue;
    const raw = name === "dangerouslySetInnerHTML" || name === "innerHTML" || name === "outerHTML";
    let next: unknown;
    try { next = __mxAttrValue(name, values[name], tag, false, skip); } catch (error) {
      if (raw && error instanceof Error) error.message += " To write raw HTML, make \`$!{html}\` the element's only child.";
      throw error;
    }
    if (raw) {
      delete values[name];
      if (next !== undefined) values[name.toLowerCase()] = next;
    } else if (next === undefined) delete values[name]; else values[name] = next;
  }
  return values as T;
})`;

/**
 * The body of `<html-script>`, as the text of a `<script>` element.
 *
 * Marko's html output stringifies each `${…}` placeholder as it does anywhere
 * in text (`_to_text`: a truthy value as its string, `0` as `0`, every other
 * falsy value as nothing) and then escapes the *joined* body for script
 * context (`_escape_script`): `<script`, `</script` (any case) and `<!--`
 * become `\u003C…`, so the body cannot close its element or open a comment. A
 * JSX text child cannot carry it: every renderer HTML-escapes text, which turns
 * `&&` and `<` in script source into entities the browser never decodes. The
 * result is therefore handed over as raw HTML, through the dialect's
 * raw-HTML prop, after this escape.
 */
export const JSX_SCRIPT_TEXT_EXPRESSION = `(...parts: unknown[]): string =>
  parts
    .map((part) => (part || part === 0 ? part + "" : ""))
    .join("")
    .replace(/<(\\/?script|!--)/gi, "\\\\u003C$1")`;

/**
 * How `hono/jsx/dom` objects are told from JSON (see {@link JSX_TEXT_VALUE_EXPRESSION}),
 * as source text over `item` and an `own(name)` test, shared by the text
 * placeholder and the dynamic-tag value so the two cannot drift.
 */
const HONO_PORTAL_CHECK = `item.p === 1 && typeof Node !== "undefined" && item.e instanceof Node`;
const HONO_DOM_NODE_CHECK = `own("key") && own("ref") && item.props !== null && typeof item.props === "object" && item.ref === item.props.ref && (item.ref === undefined || typeof item.ref === "function" || (item.ref !== null && typeof item.ref === "object") || (item.ref === null && item.key === undefined))`;

/**
 * What a `${expr}` placeholder hands the renderer (`textObjectGuard` dialects,
 * Hono). Stock Marko prints a plain object in text as `[object Object]`
 * (`value + ""`, so an own `toString`/`valueOf` is honoured); `hono/jsx/dom`
 * instead reads a plain `{ tag, props }` object as an element, with its event
 * handlers and `dangerouslySetInnerHTML`, so JSON from a request could become
 * markup. A plain-prototype object is stringified as Marko does; a
 * null-prototype one, which Marko fails on, prints `[object Object]`, unless
 * Hono's own runtime made it. A prototype that is itself data
 * (`Object.assign({}, JSON.parse('{"__proto__":{…}}'))` sets the copy's
 * prototype to the parsed object, or to an array) does not make an object a class instance: only
 * a prototype whose `constructor` is a function other than `Object` or `Array` does. `hono/jsx` elements are class
 * instances, so they pass. `hono/jsx/dom` (its jsx runtime, `createElement`,
 * `cloneElement`, `Fragment`) builds plain `{ tag, type, props, key, ref }`
 * objects, and `createPortal` a plain `{ tag, props, key, e, p: 1 }`; both are
 * recognised by what JSON cannot carry:
 * - a dom node has an own `key` and an own `ref` with `ref === props.ref`, where
 *   `ref` is `undefined`, a function or a shared object (JSON has no `undefined`,
 *   no function, and no shared reference), or `null` together with a `key` that
 *   is `undefined`; a node with `ref={null}` and a real key is not recognised;
 * - a portal has `p === 1` and `e` a DOM node.
 * Limit: a decoder that keeps `undefined` (`devalue`, `superjson`,
 * `structuredClone`) can build a node-shaped object; data decoded that way
 * must not reach a text placeholder. An array is mapped when it holds an
 * object. A body is rendered as `<${input.content}/>`, never as text.
 */
export const JSX_TEXT_VALUE_EXPRESSION = `(value: any): any => {
  const text = (item: any): any => {
    if (item === null || typeof item !== "object") return item;
    if (Array.isArray(item)) return item.some((entry: any) => entry !== null && typeof entry === "object") ? item.map(text) : item;
    const proto = Object.getPrototypeOf(item);
    if (proto !== Object.prototype && proto !== null && typeof proto.constructor === "function" && proto.constructor !== Object && proto.constructor !== Array) return item;
    const own = (name: string): boolean => Object.prototype.hasOwnProperty.call(item, name);
    if (${HONO_PORTAL_CHECK}) return item;
    if (${HONO_DOM_NODE_CHECK}) return item;
    try { return item + ""; } catch { return "[object Object]"; }
  };
  return text(value);
}`;

/** Which renderer's node shape {@link jsxRenderableExpression} recognises. */
export type JsxNodeShape = "preact" | "react" | "hono";

/**
 * What a dynamic tag hands the renderer when its value is neither a tag name
 * nor a component: an already-rendered node (`<${input.content}/>`), an array
 * of them, or, wrongly, data. Stock Marko 6.4.4 renders nothing for a plain
 * object (and for an array of them); a JSX renderer reads one as an element
 * (`hono/jsx/dom` renders `{ tag, props }` with its `onerror`), throws on it
 * (React) or trips on a null-prototype one (Preact). A plain-prototype or
 * null-prototype object (or one whose prototype is data, see
 * {@link JSX_TEXT_VALUE_EXPRESSION}) is therefore dropped (`null`) unless it is what the
 * renderer itself builds, recognised by something JSON cannot carry:
 * - React: a symbol `$$typeof` (`"react.element"` as a string is data);
 * - Preact: an own `constructor` that is `undefined` (`createVNode`'s marker;
 *   Preact itself rejects a vnode that has any other `constructor`, and a
 *   null-prototype object has no own one);
 * - Hono: the `hono/jsx/dom` node and portal checks of
 *   {@link JSX_TEXT_VALUE_EXPRESSION}. `hono/jsx` elements are class instances.
 * Class instances (DOM nodes, `HtmlEscapedString`, Hono elements) pass. An
 * array is checked item by item and rebuilt only when an item was dropped.
 * Limit: a decoder that keeps `undefined` (`devalue`, `superjson`,
 * `structuredClone`) can build a node-shaped object on Preact and Hono; data
 * decoded that way must not reach a dynamic tag.
 *
 * A `textDataGuard` dialect (Preact) also passes every non-literal text
 * placeholder through this check, so data renders nothing there instead of
 * being read as a node by the server renderer; a plain object already rendered
 * nothing on Preact, so only a null-prototype vnode-shaped object changes.
 */
export function jsxRenderableExpression(shape: JsxNodeShape): string {
  const check =
    shape === "react"
      ? 'typeof item.$$typeof === "symbol"'
      : shape === "preact"
        ? 'own("constructor") && item.constructor === undefined'
        : `(${HONO_PORTAL_CHECK}) || (${HONO_DOM_NODE_CHECK})`;
  return `(value: any): any => {
  const render = (item: any): any => {
    if (item === null || typeof item !== "object") return item;
    if (Array.isArray(item)) {
      const next = item.map(render);
      return next.some((entry: any, index: number) => entry !== item[index]) ? next : item;
    }
    const proto = Object.getPrototypeOf(item);
    if (proto !== Object.prototype && proto !== null && typeof proto.constructor === "function" && proto.constructor !== Object && proto.constructor !== Array) return item;
    const own = (name: string): boolean => Object.prototype.hasOwnProperty.call(item, name);
    return ${check} ? item : null;
  };
  return render(value);
}`;
}

/**
 * `<textarea value=x>` renders `x` as the textarea's content, as Marko 6.4.4
 * does: `null`/`undefined`/`false`/`true` as nothing, everything else as text,
 * and a leading newline doubled because the HTML parser drops a textarea's
 * first one. `newline` says where the doubling applies (`JsxDialect`).
 *
 * Preact's "ssr" mode keys on `typeof document`: preact-render-to-string
 * exposes no public renderer signal (only the mangled internal `options.__s`),
 * and its client renderer writes the text through the DOM, where a doubled
 * newline would show as a second one. Environment-dependent by construction;
 * recorded in docs/divergences.md.
 */
export function jsxTextareaContentExpression(
  newline: "ssr" | "always" | "never",
): string {
  const double =
    newline === "never"
      ? "false"
      : newline === "always"
        ? "true"
        : 'typeof document === "undefined"';
  return `((value: unknown): string => {
  const text = value === null || value === undefined || value === false || value === true ? "" : \`\${value}\`;
  return ${double} && text[0] === "\\n" ? "\\n" + text : text;
})`;
}

/**
 * The spread/merged-object path of a native `<textarea>`: the merged `value`
 * is the content unless the element has a body, in which case the spread's
 * `value` is dropped (Marko: a body wins over a spread). Needs
 * `__mxTextareaContent` hoisted first.
 */
export function jsxTextareaPropsExpression(prop: "children" | "value"): string {
  return `(<T extends object | null | undefined,>(attrs: T, body = false): T => {
  const { value, ...rest } = { ...attrs } as Record<string, unknown>;
  if (!body) rest[${JSON.stringify(prop)}] = __mxTextareaContent(value);
  return rest as T;
})`;
}
