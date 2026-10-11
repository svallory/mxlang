import type { Attr } from "./ir.ts";

/**
 * An attribute as a diagnostic names it: `name`, or, for one a shorthand or a
 * syntax module's trigger made, the token the author wrote and what it stands
 * for, `.big` (`class`). Shared by the declared-attribute checks and the
 * duplicate-attribute warning.
 */
export function attrLabel(attr: Exclude<Attr, { kind: "spread" }>): string {
  if (attr.sugarValueOf) {
    return `\`${attr.name}\` (set by \`${attr.sugarValueOf}\`)`;
  }
  return attr.sugar
    ? `\`${attr.sugar}\` (\`${attr.name}\`)`
    : `\`${attr.name}\``;
}
