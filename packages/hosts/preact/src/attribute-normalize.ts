/**
 * Primitive attribute values on native elements, normalized to what Marko
 * 6.3.51's html output renders (decision 149). One source shared by the three
 * JSX hosts; hoisted into the emitted module like core's validation helpers,
 * never a runtime dependency. Component props do not pass through it.
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
 */
export const JSX_ATTRIBUTE_SPREAD_EXPRESSION = `(<T extends object | null | undefined,>(attrs: T, tag = "", props: readonly string[] = [], events = false): T => {
  const values = { ...attrs } as Record<string, unknown>;
  for (const name of Object.keys(values)) {
    const skip = props.includes(name) || (events && /^on[A-Z]/.test(name));
    if (skip && name !== "class" && name !== "className") continue;
    if (name === "key" || name === "ref" || name === "dangerouslySetInnerHTML") continue;
    const next = __mxAttrValue(name, values[name], tag, false, skip);
    if (next === undefined) delete values[name]; else values[name] = next;
  }
  return values as T;
})`;

/**
 * `<textarea value=x>` renders `x` as the textarea's content, as Marko 6.3.51
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
export function jsxTextareaPropsExpression(
  prop: "children" | "defaultValue",
): string {
  return `(<T extends object | null | undefined,>(attrs: T, body = false): T => {
  const { value, ...rest } = { ...attrs } as Record<string, unknown>;
  if (!body) rest[${JSON.stringify(prop)}] = __mxTextareaContent(value);
  return rest as T;
})`;
}
