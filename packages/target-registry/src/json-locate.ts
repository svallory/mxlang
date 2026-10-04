/**
 * Where a value sits in a JSON text, found by walking its tokens at an exact
 * key path. No key is ever turned into a pattern, so an escaped key
 * (`"d\u0061ta"`), a decoy at another path and a key full of regex
 * metacharacters all behave. Duplicate keys resolve like `JSON.parse`: the
 * last one wins. The walk keeps its own stack, so valid JSON of any depth
 * cannot overflow the call stack.
 */

export interface JsonLocation {
  /** UTF-16 offset of the value's first character. */
  offset: number;
  /** 1-based, by TypeScript's own line-break rules. */
  line: number;
  /** 0-based, by TypeScript's own line-break rules. */
  column: number;
  /** Characters the value covers, quotes included. */
  length: number;
}

const TOKEN =
  /"(?:\\.|[^"\\])*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g;

/**
 * Line and column of `offset` by the rules `ts.createSourceFile` uses to
 * print a position: a line ends at LF, CR, CRLF, U+2028 or U+2029 (a line
 * break in a JSON *string* counts too, since the printer does not know it is
 * inside one). Line 1-based, column 0-based.
 */
export function lineAndColumn(
  text: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 0x0d && text.charCodeAt(i + 1) === 0x0a) {
      i++;
      if (i >= end) {
        // The offset falls between CR and LF: the CRLF is not a break yet.
        return { line, column: end - lineStart };
      }
    }
    if (ch === 0x0a || ch === 0x0d || ch === 0x2028 || ch === 0x2029) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: end - lineStart };
}

interface Frame {
  object: boolean;
  start: number;
  depth: number;
  onPath: boolean;
  /** An object frame is waiting for its next key. */
  expectKey: boolean;
  key: string | undefined;
}

/**
 * The value at `path`, or the deepest enclosing value that exists (so a
 * missing key is reported at its parent), or `undefined` when even the first
 * step is absent or the text does not tokenize into an object.
 */
export function locateJsonPath(
  text: string,
  path: readonly string[],
): JsonLocation | undefined {
  /** The last span seen at each depth along `path`. */
  const spans: ({ start: number; end: number } | undefined)[] = [];
  const stack: Frame[] = [];

  const begin = (
    token: RegExpMatchArray,
    depth: number,
    onPath: boolean,
  ): void => {
    const start = token.index ?? 0;
    // A later duplicate replaces the earlier value whole: what the earlier
    // one had below it is gone.
    if (onPath) spans.length = Math.min(spans.length, depth);
    const open = token[0];
    if (open === "{" || open === "[") {
      stack.push({
        object: open === "{",
        start,
        depth,
        onPath,
        expectKey: open === "{",
        key: undefined,
      });
    } else if (onPath && depth <= path.length) {
      spans[depth] = { start, end: start + open.length };
    }
  };
  const valueDone = (): void => {
    const top = stack.at(-1);
    if (top?.object) top.expectKey = true;
  };

  let started = false;
  for (const token of text.matchAll(TOKEN)) {
    const top = stack.at(-1);
    if (!started) {
      started = true;
      begin(token, 0, true);
      if (stack.length === 0) break;
      continue;
    }
    if (!top) break;
    const t = token[0];
    if (t === "}" || t === "]") {
      stack.pop();
      if (top.onPath && top.depth <= path.length) {
        spans[top.depth] = { start: top.start, end: (token.index ?? 0) + 1 };
      }
      valueDone();
      if (stack.length === 0) break;
    } else if (t === "," || t === ":") {
      // separators carry no state of their own
    } else if (top.object && top.expectKey) {
      try {
        top.key = JSON.parse(t) as string;
      } catch {
        break;
      }
      top.expectKey = false;
    } else {
      const onPath = top.onPath && top.object && top.key === path[top.depth];
      begin(token, top.depth + 1, onPath);
      if (!(t === "{" || t === "[")) valueDone();
    }
  }

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
  return {
    offset: found.start,
    ...lineAndColumn(text, found.start),
    length: found.end - found.start,
  };
}
