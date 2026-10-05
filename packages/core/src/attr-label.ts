import type { Attr } from "./ir.ts";

/**
 * An attribute as a diagnostic names it: `name`, or, for one the name sugar
 * made (decision 146), the token the author wrote and what it stands for,
 * `:email` (`name`). Shared by the declared-attribute checks and the
 * duplicate-attribute warning.
 */
export function attrLabel(attr: Exclude<Attr, { kind: "spread" }>): string {
  return attr.sugar
    ? `\`${attr.sugar}\` (\`${attr.name}\`)`
    : `\`${attr.name}\``;
}
