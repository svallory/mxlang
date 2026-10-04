/**
 * Where a value sits in a JSON text, found by walking its tokens at an exact
 * key path. No key is ever turned into a pattern, so an escaped key
 * (`"d\u0061ta"`), a decoy at another path and a key full of regex
 * metacharacters all behave. Duplicate keys resolve like `JSON.parse`: the
 * last one wins.
 */

export interface JsonLocation {
  /** 1-based. */
  line: number;
  /** 0-based. */
  column: number;
  /** Characters the value covers, quotes included. */
  length: number;
}

const TOKEN =
  /"(?:\\.|[^"\\])*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g;

/**
 * The value at `path`, or the deepest enclosing value that exists (so a
 * missing key is reported at its parent), or `undefined` when even the first
 * step is absent or the text does not tokenize into an object.
 */
export function locateJsonPath(
  text: string,
  path: readonly string[],
): JsonLocation | undefined {
  const tokens = [...text.matchAll(TOKEN)];
  let cursor = 0;
  /** The last span seen at each depth along `path`. */
  const spans: ({ start: number; end: number } | undefined)[] = [];

  const value = (depth: number, onPath: boolean): void => {
    const first = tokens[cursor];
    if (!first) return;
    const start = first.index;
    cursor++;
    // A later duplicate replaces the earlier value whole: what the earlier
    // one had below it is gone.
    if (onPath) spans.length = Math.min(spans.length, depth);
    if (first[0] === "{") {
      while (tokens[cursor] && tokens[cursor]?.[0] !== "}") {
        const keyToken = tokens[cursor++];
        let key: string | undefined;
        try {
          key = JSON.parse(keyToken?.[0] ?? "") as string;
        } catch {
          return;
        }
        cursor++; // colon
        value(depth + 1, onPath && key === path[depth]);
        if (tokens[cursor]?.[0] === ",") cursor++;
      }
      cursor++; // closing brace
    } else if (first[0] === "[") {
      while (tokens[cursor] && tokens[cursor]?.[0] !== "]") {
        value(depth + 1, false);
        if (tokens[cursor]?.[0] === ",") cursor++;
      }
      cursor++;
    }
    if (onPath && depth <= path.length) {
      const last = tokens[cursor - 1];
      spans[depth] = {
        start,
        end: (last?.index ?? start) + (last?.[0].length ?? 0),
      };
    }
  };
  value(0, true);

  // A deeper path replaces a shallower one only when it was seen after it,
  // and a later duplicate overwrites an earlier one: `spans` keeps the last
  // value seen at each depth, which is `JSON.parse`'s answer.
  let found: { start: number; end: number } | undefined;
  for (let depth = 1; depth <= path.length; depth++) {
    const span = spans[depth];
    if (!span) break;
    found = span;
  }
  if (!found) return undefined;
  const before = text.slice(0, found.start).split("\n");
  return {
    line: before.length,
    column: (before.at(-1) ?? "").length,
    length: found.end - found.start,
  };
}
