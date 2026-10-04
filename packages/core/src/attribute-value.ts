/**
 * Host-neutral native-attribute value validation, inlined by emitters rather
 * than introducing a runtime dependency. Components' props do not use it.
 *
 * Marko 6.3.51 tests coercion, not prototypes: a null-prototype object (or a
 * failed coercion) is unrenderable, but Dates and meaningful toString values
 * are attributes. Class/style have their separate structured-value writers.
 */
export const ATTRIBUTE_VALUE_BODY = `
  const controlled = (tag === "input" && (name === "checked" || name === "checkedValue"))
    || ((tag === "details" || tag === "dialog") && name === "open")
    || ((tag === "select" || tag === "textarea") && name === "value");
  if (!controlled && name !== "class" && name !== "style" && value !== null && typeof value === "object") {
    let text;
    try { text = \`\${value}\`; } catch { text = "[object Object]"; }
    if (/^\\[object \\w+\\]$/.test(text)) {
      const description = text === "[object Object]"
        ? "a plain object (it would render as \`[object Object]\`)"
        : text === "[object Promise]"
          ? "a promise (use the \`<await>\` tag to render its resolved value)"
          : "a value that renders as \`" + text + "\`";
      throw new Error("The \`" + name + "\` attribute cannot be " + description + ".");
    }
  }
  return value;
`;

/** A type-preserving wrapper; authored expressions remain independently mapped. */
export const ATTRIBUTE_VALUE_EXPRESSION = `(<T,>(name: string, value: T, tag = ""): T => {${ATTRIBUTE_VALUE_BODY}})`;

/** Validate the final merged native attributes, never the overwritten values. */
export const ATTRIBUTE_SPREAD_EXPRESSION = `(<T extends object | null | undefined,>(attrs: T, tag = "", props: readonly string[] = []): T => {
  const values = { ...attrs } as Record<string, unknown>;
  for (const name of Object.keys(values)) {
    if (!props.includes(name)) ${ATTRIBUTE_VALUE_EXPRESSION}(name, values[name], tag);
  }
  return values as T;
})`;
