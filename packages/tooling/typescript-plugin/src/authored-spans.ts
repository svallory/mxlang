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
 * file start. `baseOffset` shifts every span, for a source that is a slice of
 * a larger file.
 */
export function markoAuthoredSpans(
  source: string,
  fileName: string,
  customTags: Record<string, CustomTag> | undefined,
  baseOffset = 0,
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
      spans.push({
        kind,
        start: baseOffset + offsetOf(start),
        end: baseOffset + offsetOf(end),
      });
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

/** One piece of MX inside a larger file: its text and where it starts in the file. */
export interface MxSourceRegion {
  source: string;
  baseOffset: number;
}

/**
 * The authored spans of every MX region of a file that is not MX throughout
 * (a `.<host>.mx` region file, `.ng.mx`, the template of `.astro.mx`): each
 * region parses on its own, as the compiler parsed it, and its spans are
 * file-absolute. The code around the regions is TypeScript the generated
 * module already maps.
 */
export function regionAuthoredSpans(
  regions: readonly MxSourceRegion[],
  fileName: string,
  customTags: Record<string, CustomTag> | undefined,
): AuthoredSpan[] {
  return regions.flatMap((region) =>
    markoAuthoredSpans(region.source, fileName, customTags, region.baseOffset),
  );
}

/**
 * The MX text of a `.ng.mx` region, from the `[start, end)` span the compile
 * reports: that span includes the `<>` and `</>` of a fragment region, whose
 * children are what the compiler parsed.
 */
export function ngRegionSource(
  source: string,
  region: { start: number; end: number },
): MxSourceRegion {
  const text = source.slice(region.start, region.end);
  return text.startsWith("<>") && text.endsWith("</>")
    ? { source: text.slice(2, -3), baseOffset: region.start + 2 }
    : { source: text, baseOffset: region.start };
}
