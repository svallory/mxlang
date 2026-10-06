import { type CustomTag, parseFragment } from "@mxlang/core";
import type { AuthoredSpan } from "./unmapped-diagnostics.ts";

interface MarkoPosition {
  line: number;
  column: number;
}

interface MarkoNode {
  type?: string;
  loc?: { start?: MarkoPosition; end?: MarkoPosition } | null;
  name?: MarkoNode;
  value?: MarkoNode;
  var?: MarkoNode | null;
  arguments?: MarkoNode[] | null;
  attributes?: MarkoNode[];
  body?: { params?: MarkoNode[]; body?: MarkoNode[] };
}

/** Nodes of a template body that hold no code: text and markup only. */
const NOT_CODE = new Set([
  "MarkoText",
  "MarkoComment",
  "MarkoCDATA",
  "MarkoDocumentType",
  "MarkoDeclaration",
]);

/**
 * Every tag and attribute of a whole-file `.mx` source, as file-absolute
 * spans: the authored constructs an unmappable diagnostic can be reported on
 * (decision 161). Beside them, every piece of code the author wrote (a
 * placeholder's expression, an attribute value other than a quoted string, a
 * tag's arguments, variable, parameters or dynamic name, a statement): where an
 * identifier or literal counts as spelled by the author. Read from the same
 * Marko parse core lowers from, so it agrees with what the compiler saw. A
 * source that does not parse has none, and its diagnostics fall back to the
 * file start.
 */
export function markoAuthoredSpans(
  source: string,
  fileName: string,
  customTags: Record<string, CustomTag> | undefined,
): AuthoredSpan[] {
  let body: MarkoNode[];
  try {
    body = parseFragment(source, { filename: fileName, customTags })
      .body as MarkoNode[];
  } catch {
    return [];
  }
  // Marko counts lines from 1 and columns from 0.
  const lineStarts = [0];
  for (
    let at = source.indexOf("\n");
    at >= 0;
    at = source.indexOf("\n", at + 1)
  ) {
    lineStarts.push(at + 1);
  }
  const offsetOf = (position: MarkoPosition) =>
    (lineStarts[position.line - 1] ?? source.length) + position.column;
  const spans: AuthoredSpan[] = [];
  const add = (
    kind: AuthoredSpan["kind"],
    node: MarkoNode | null | undefined,
  ) => {
    const { start, end } = node?.loc ?? {};
    if (start && end)
      spans.push({ kind, start: offsetOf(start), end: offsetOf(end) });
  };
  const walk = (nodes: readonly MarkoNode[] | undefined) => {
    for (const node of nodes ?? []) {
      if (node.type !== "MarkoTag") {
        if (node.type === "MarkoPlaceholder") add("code", node.value);
        else if (!NOT_CODE.has(node.type ?? "")) add("code", node);
        continue;
      }
      add("tag", node);
      if (node.name?.type !== "StringLiteral") add("code", node.name);
      add("code", node.var);
      for (const argument of node.arguments ?? []) add("code", argument);
      for (const param of node.body?.params ?? []) add("code", param);
      for (const attribute of node.attributes ?? []) {
        add("attribute", attribute);
        if (attribute.value?.type !== "StringLiteral")
          add("code", attribute.value);
      }
      walk(node.body?.body);
    }
  };
  walk(body);
  return spans;
}
