/**
 * The mapping rules of the tree differential (brief §1.2 D): one per
 * accommodation of ast §2 ("Accommodations removed") that changes what the
 * neutral form sees. They turn today's Marko tree into what the MX AST
 * records instead, and they are the only allowed differences. Each is a pure
 * function with a unit test (`rules.test.ts`); `RULES` lists them for the
 * report.
 */

export interface Rule {
  readonly id: string;
  /** The ast §2 row the rule implements. */
  readonly row: string;
  readonly what: string;
}

export const RULES: readonly Rule[] = [
  {
    id: "rejoin-attribute-name",
    row: "A2",
    what: "Marko's `name` + `modifier` (split at the last `:`) are compared field by field against MX's `name`, `modifier` and `modifierSpan` (decision 170); a sugar chain still rejoins (A6)",
  },
  {
    id: "default-attribute",
    row: "A3",
    what: "an attribute Marko names `value` with `default: true` is the default value (`name: null`); with a modifier it is the attribute-position `:` sugar",
  },
  {
    id: "unmerge-shorthands",
    row: "A4",
    what: "the loc-less `class`/`id` attributes Marko merged from tag-adjacent shorthands are the tag-position `.`/`#` sugar, in Marko's order",
  },
  {
    id: "unnamed-tag",
    row: "A5",
    what: "a tag Marko named `div` over an empty name span is the unnamed tag",
  },
  {
    id: "split-name-sugar",
    row: "A6",
    what: "a static tag name, a tag shorthand value and an attribute-position sugar chain split at the first `:` (and a chain at `.`/`#`) into their sugar parts",
  },
  {
    id: "attribute-tags-in-place",
    row: "A7",
    what: "children Marko moved into `attributeTags` (attribute tags, their comments, a control-flow tag holding them) return to the body, in source order",
  },
  {
    id: "statement-node",
    row: "A8 (A18)",
    what: "a tag Marko parsed as a statement (`rawValue`) is a module statement with its keyword and range",
  },
  {
    id: "head-on-tag",
    row: "A11",
    what: "tag params and type parameters Marko stores on the body are head parts of the tag",
  },
  {
    id: "positions-from-loc",
    row: "A12",
    what: "Marko's `loc` (line, column) becomes a file offset; Babel nodes keep their own `start`/`end`",
  },
  {
    id: "text-runs",
    row: "A13",
    what: "a Marko text's (trimmed) range lies inside exactly one MX text run; an MX run with no Marko text is whitespace only",
  },
  {
    id: "open-tag-comments",
    row: "A14",
    what: "Babel comments Marko attached to attributes or the tag are comment items of the attribute list, in source order",
  },
  {
    id: "dynamic-name",
    row: "A17",
    what: "a dynamic name is compared by its authored text",
  },
  {
    id: "sugar-arguments",
    row: "A6 (decision 163 addendum 11)",
    what: "arguments Marko keeps on an attribute named `.c`, `#x` or `:x` are the `args` of that chain's last sugar part",
  },
  {
    id: "template-error",
    row: "A10",
    what: "Marko throws the template parser's error with a code frame; its message and range are the MX template error's",
  },
];

/**
 * What the differential does not compare, because today's tree does not
 * carry it (one line each; the front end's own tests assert these):
 */
export const NOT_COMPARED: readonly string[] = [
  "tag-position shorthand spans: Marko merges `#id`/`.class` into loc-less `class`/`id` attributes (A4), so only their text and order within a sigil are compared",
  "the order of tag-position sugar across sigils: the merge loses it; both sides list ids, then classes, then `:`",
  "a dynamic tag name's span and container: Marko's whole-template name keeps no position through the clone (A17); compared by text",
  "a dynamic shorthand's spans: merged without loc (A4); compared by text",
  "atoms inside an expression Babel could not parse: today's tree holds the raw text (`MarkoParseError`), not the atom",
  "open and close tag spans, `bodyMode`, `concise`, `selfClosed`: not in today's tree; asserted by `checkInvariants`",
  "statement `code` spans: today's statement is a raw string (A8)",
];

/** A2: Marko splits at the last `:`; the authored name is both halves. */
export function rejoinAttributeName(
  name: string,
  modifier: string | null | undefined,
): string {
  return modifier == null ? name : `${name}:${modifier}`;
}

/**
 * A6 and ast §3.6 rule 1: a static sugar value splits at its first `:`
 * (outside `${…}`); returns the value and the `:` part, if any.
 */
export function splitAtFirstColon(value: string): [string, string | undefined] {
  let depth = 0;
  for (let at = 0; at < value.length; at++) {
    const char = value[at];
    if (char === "$" && value[at + 1] === "{") {
      depth++;
      at++;
    } else if (depth > 0 && char === "{") depth++;
    else if (depth > 0 && char === "}") depth--;
    else if (depth === 0 && char === ":")
      return [value.slice(0, at), value.slice(at + 1)];
  }
  return [value, undefined];
}

/** A6: an attribute-position chain `.c#m.d` into its `.`/`#` parts, outside `${…}`. */
export function splitChain(name: string): { sigil: string; word: string }[] {
  const parts: { sigil: string; word: string }[] = [];
  let depth = 0;
  for (let at = 0; at < name.length; at++) {
    const char = name[at] as string;
    if (depth === 0 && (char === "." || char === "#")) {
      parts.push({ sigil: char, word: "" });
      continue;
    }
    if (char === "$" && name[at + 1] === "{") depth++;
    else if (depth > 0 && char === "{") depth++;
    else if (depth > 0 && char === "}") depth--;
    const current = parts[parts.length - 1];
    if (current) current.word += char;
  }
  return parts;
}

/** A12: a Marko `{ line, column }` (1-based line) to a file offset. */
export function offsetOf(
  lineStarts: readonly number[],
  position: { line: number; column: number },
): number {
  return (lineStarts[position.line - 1] ?? 0) + position.column;
}

export function lineStartsOf(source: string): number[] {
  const starts = [0];
  for (
    let at = source.indexOf("\n");
    at !== -1;
    at = source.indexOf("\n", at + 1)
  )
    starts.push(at + 1);
  return starts;
}

/**
 * A13: compares text runs. `marko` are Marko's (trimmed) text ranges, `mx` the
 * MX runs. Returns the violations: a Marko range not inside exactly one MX
 * run, or an MX run with non-whitespace text and no Marko range inside.
 */
export function compareTextRuns(
  source: string,
  marko: readonly (readonly [number, number])[],
  mx: readonly (readonly [number, number])[],
): string[] {
  const problems: string[] = [];
  const used = new Set<number>();
  for (const [s, e] of marko) {
    const holders = mx.filter(([ms, me]) => ms <= s && e <= me);
    if (holders.length !== 1)
      problems.push(
        `Marko text [${s},${e}) is inside ${holders.length} MX runs`,
      );
    else used.add(mx.indexOf(holders[0] as readonly [number, number]));
  }
  mx.forEach(([s, e], i) => {
    if (!used.has(i) && source.slice(s, e).trim() !== "") {
      problems.push(
        `MX text [${s},${e}) ${JSON.stringify(source.slice(s, e))} has no Marko text`,
      );
    }
  });
  return problems;
}

/**
 * A10: the message and range of the template parser's error, out of the
 * error Marko throws (`buildCodeFrameError`: a code frame whose last line
 * carries the message after the `^` markers).
 */
export function thrownTemplateError(
  error: {
    message?: string;
    loc?: {
      start: { line: number; column: number };
      end: { line: number; column: number };
    };
  },
  lineStarts: readonly number[],
): { message: string; start: number; end: number } | undefined {
  if (!error?.loc || typeof error.message !== "string") return undefined;
  // The frame is ANSI-coloured wherever colour is on (CI, the gate); this
  // shell's NO_COLOR hides that, so strip it rather than assume plain text.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matches ANSI escapes
  const plain = error.message.replace(/\u001b\[[0-9;]*m/g, "");
  const match = /\^+ ([^\n]*)/.exec(plain);
  if (!match) return undefined;
  return {
    message: (match[1] as string).trim(),
    start: offsetOf(lineStarts, error.loc.start),
    end: offsetOf(lineStarts, error.loc.end),
  };
}
