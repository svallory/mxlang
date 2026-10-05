import type { CustomTag } from "./custom-tags.ts";

/** The slice of a Marko taglib lookup this check reads. */
export interface DefaultTagLookup {
  /** A tag def; its `parseOptions`, when present, say how the tag parses. */
  getTag(name: string): object | undefined;
}

/** What a `defaultTag` may resolve to in one package. */
export interface DefaultTagScope {
  /** The package's custom tags (scan and `mx.contracts`). */
  customTags?: Readonly<Record<string, CustomTag>>;
  /** Marko's lookup for the target's translator: its built-in tags and their parse shape. */
  lookup?: DefaultTagLookup;
  /** Names the target itself provides without a taglib entry. */
  builtins?: readonly string[];
}

interface ParseShape {
  openTagOnly?: unknown;
  text?: unknown;
  preserveWhitespace?: unknown;
  statement?: unknown;
  controlFlow?: unknown;
}

/**
 * Why `name` cannot be a `defaultTag`, or `undefined` when it can. The text
 * continues "invalid `defaultTag` value: ".
 *
 * A `defaultTag` must be a tag reachable from the package (a custom tag, a
 * tag of the target's Marko lookup, or a name the target lists as built-in)
 * and must parse as a plain tag. Marko resolved the shorthand's parse options
 * for the placeholder name it wrote, so a void, text, whitespace-preserving,
 * statement or control-flow tag would be parsed under the wrong rules.
 *
 * The parse shape is read from the tag's own `parseOptions` in the lookup the
 * package compiles with (Marko 6.3.51's `marko-html` and core taglibs), never
 * from a hand-kept list, so a different target's taglib answers for itself.
 */
export function validateDefaultTag(
  name: string,
  scope: DefaultTagScope,
): string | undefined {
  const custom = Object.hasOwn(scope.customTags ?? {}, name)
    ? (scope.customTags as Readonly<Record<string, CustomTag>>)[name]
    : undefined;
  if (custom) return shapeReason(name, custom.parseOptions);
  const known = Object.hasOwn(Object.prototype, name)
    ? undefined
    : scope.lookup?.getTag(name);
  if (known)
    return shapeReason(
      name,
      (known as { parseOptions?: unknown }).parseOptions,
    );
  if (scope.builtins?.includes(name)) return undefined;
  return `\`<${name}>\` is not a tag reachable from this package`;
}

function shapeReason(name: string, options: unknown): string | undefined {
  if (typeof options !== "object" || options === null) return undefined;
  const shape = options as ParseShape;
  const kind = shape.openTagOnly
    ? "a void tag"
    : shape.text
      ? "a text tag"
      : shape.statement
        ? "a statement tag"
        : shape.controlFlow
          ? "a control-flow tag"
          : shape.preserveWhitespace
            ? "a whitespace-preserving tag"
            : undefined;
  return kind === undefined
    ? undefined
    : `\`<${name}>\` is ${kind}, not a plain tag`;
}
