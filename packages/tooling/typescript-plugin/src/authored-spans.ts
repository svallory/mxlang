import { type CustomTag, parseFragment } from "@mxlang/core";
import type { AuthoredSpan } from "./unmapped-diagnostics.ts";

interface MarkoPosition {
  line: number;
  column: number;
}

interface MarkoNode {
  type?: string;
  loc?: { start?: MarkoPosition; end?: MarkoPosition } | null;
  attributes?: MarkoNode[];
  body?: { body?: MarkoNode[] };
}

/**
 * Every tag and attribute of a whole-file `.mx` source, as file-absolute
 * spans: the authored constructs an unmappable diagnostic can be reported on
 * (decision 161). Read from the same Marko parse core lowers from, so it
 * agrees with what the compiler saw. A source that does not parse has none,
 * and its diagnostics fall back to the file start.
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
  const add = (node: MarkoNode) => {
    const { start, end } = node.loc ?? {};
    if (start && end)
      spans.push({ start: offsetOf(start), end: offsetOf(end) });
  };
  const walk = (nodes: readonly MarkoNode[] | undefined) => {
    for (const node of nodes ?? []) {
      if (node.type !== "MarkoTag") continue;
      add(node);
      for (const attribute of node.attributes ?? []) add(attribute);
      walk(node.body?.body);
    }
  };
  walk(body);
  return spans;
}
