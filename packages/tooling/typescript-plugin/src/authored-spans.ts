import { type CustomTag, type NativeTags, parseFragment } from "@mxlang/core";
import { builtinLookup } from "@mxlang/targets";
import type { AuthoredSpan } from "./unmapped-diagnostics.ts";

/** A UTF-16 range into the parsed source (an MX node, field shape or Babel node). */
interface Range {
  start: number;
  end: number;
}

/** An embedded-code container: its Babel payload, `null` when it did not parse. */
interface MxContainer extends Range {
  node?:
    | (Range & { type?: string; extra?: { mxAtom?: unknown } })
    | Range[]
    | null;
}

/** The fields of the MX AST (`@mxlang/babel`'s `mx-ast`) this walk reads. */
interface MxNode extends Range {
  type: string;
  name?: { kind?: string; expression?: MxContainer } | string | null;
  nameSpan?: Range;
  expression?: MxContainer;
  var?: MxContainer | null;
  args?: MxContainer | null;
  params?: MxContainer | null;
  attributes?: readonly MxNode[];
  value?: MxContainer | null;
  default?: MxContainer | null;
  body?: readonly MxNode[] | null;
}

/** Nodes of a template body that hold no code: text and markup only. */
const NOT_CODE = new Set([
  "MxText",
  "MxComment",
  "MxCDATA",
  "MxDoctype",
  "MxDeclaration",
]);

/**
 * Every tag and attribute of a whole-file `.mx` source, as file-absolute
 * spans: the authored constructs an unmappable diagnostic can be reported on
 * (decision 161). Beside them, every piece of code the author wrote (a
 * placeholder's expression, an attribute value other than a quoted string, a
 * tag's arguments, variable, parameters or dynamic name, a statement): where an
 * identifier or literal counts as spelled by the author. Read from the same
 * MX parse core lowers from, so it agrees with what the compiler saw. A
 * source that does not parse has none, and its diagnostics fall back to the
 * file start. `baseOffset` shifts every span, for a source that is a slice of
 * a larger file.
 *
 * The spans are the ones the Marko-tree walk produced before port PR 5,
 * measured equal over every whole-file `.mx` in the repository: a module
 * statement is a `tag` (Marko parsed it as a statement tag); an attribute tag
 * and its body have none (Marko moved them off the body); an attribute starts
 * at its name (an `async` method's keyword is outside) and a sugar attribute
 * ends after its default value; an atom value is code, a quoted string is not.
 */
/**
 * The native elements the spans parse with: the default target's, which every
 * built-in target shares (`@mxlang/web-elements`), so `<br>` and `<textarea>`
 * shape the tree as the compile did.
 */
function defaultNativeTags(): NativeTags | undefined {
  const lookup = builtinLookup();
  return lookup.target(lookup.defaultTarget())?.declarations?.default
    ?.nativeTags;
}

export function markoAuthoredSpans(
  source: string,
  fileName: string,
  customTags: Record<string, CustomTag> | undefined,
  baseOffset = 0,
): AuthoredSpan[] {
  let body: readonly MxNode[];
  try {
    body = parseFragment(source, {
      filename: fileName,
      customTags,
      nativeTags: defaultNativeTags(),
    }).body as readonly MxNode[];
  } catch {
    return [];
  }
  const spans: AuthoredSpan[] = [];
  const add = (kind: AuthoredSpan["kind"], node: Range | null | undefined) => {
    if (node)
      spans.push({
        kind,
        start: baseOffset + node.start,
        end: baseOffset + node.end,
      });
  };
  // A container's Babel node where it parsed, else the container's own text.
  const code = (container: MxContainer | null | undefined) => {
    const node = container?.node;
    add("code", node && !Array.isArray(node) ? node : container);
  };
  // A list container (arguments, parameters): one span per parsed item.
  const each = (container: MxContainer | null | undefined) => {
    if (Array.isArray(container?.node))
      for (const item of container.node) add("code", item);
    else code(container);
  };
  const walk = (nodes: readonly MxNode[] | null | undefined) => {
    for (const node of nodes ?? []) {
      if (node.type === "MxAttributeTag") continue;
      if (node.type === "MxModuleStatement") {
        add("tag", node);
        continue;
      }
      if (node.type !== "MxTag" && node.type !== "MxReturn") {
        if (node.type === "MxPlaceholder") code(node.expression);
        else if (!NOT_CODE.has(node.type)) add("code", node);
        continue;
      }
      add("tag", node);
      if (typeof node.name === "object" && node.name?.kind === "dynamic")
        code(node.name.expression);
      code(node.var);
      each(node.args);
      each(node.params);
      for (const attribute of node.attributes ?? []) {
        if (attribute.type === "MxComment" || attribute.type === "MxTrigger")
          continue;
        const value =
          attribute.type === "MxShorthand"
            ? attribute.default
            : attribute.value;
        add("attribute", {
          start: attribute.nameSpan?.start ?? attribute.start,
          end: Math.max(attribute.end, value?.end ?? 0),
        });
        const valueNode = value?.node;
        const quoted =
          valueNode &&
          !Array.isArray(valueNode) &&
          valueNode.type === "StringLiteral" &&
          !valueNode.extra?.mxAtom;
        if (value && !quoted) code(value);
      }
      walk(node.body);
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
