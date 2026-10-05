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
  if (boolean) return reactBooleans ? true : value;
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
