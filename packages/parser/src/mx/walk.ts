import { createParser, TagType } from "htmljs-parser";

/**
 * Raw MX tree produced by walking htmljs-parser over one MX region. Ranges are
 * absolute offsets into the original file (htmljs-parser's own offsets are
 * relative to the substring it was given; `walkMxRegion` adds the region start
 * back in before anything else sees them).
 *
 * This layer does no lowering and no TypeScript parsing: it only records what
 * htmljs-parser found and where. `lower.ts` turns it into Babel JSX nodes.
 */
export interface MxRange {
  start: number;
  end: number;
}

export interface MxTagName extends MxRange {
  /** Static string parts. A purely static tag name has exactly one. */
  quasis: MxRange[];
  /** `${...}` parts of a dynamic tag name (`<${comp()}/>`). */
  expressions: MxRange[];
}

export type MxAttr =
  | { kind: "static"; name: string; nameRange: MxRange; value: MxRange }
  | { kind: "dynamic"; name: string; nameRange: MxRange; value: MxRange }
  | { kind: "boolean"; name: string; nameRange: MxRange }
  | {
      kind: "method";
      name: string;
      nameRange: MxRange;
      params: MxRange;
      body: MxRange;
      async: boolean;
      range: MxRange;
    }
  | { kind: "spread"; value: MxRange; range: MxRange }
  | { kind: "bound"; name: string; nameRange: MxRange; value: MxRange };

export type MxChild =
  | { kind: "text"; range: MxRange }
  | { kind: "placeholder"; range: MxRange; value: MxRange; escape: boolean }
  | { kind: "element"; element: MxElement }
  | { kind: "comment"; range: MxRange }
  /**
   * `<!doctype html>`. Only reachable in template mode: a `.solid.mx` file is
   * a TypeScript module and has nowhere to put one.
   */
  | { kind: "doctype"; range: MxRange };

export interface MxElement {
  name: MxTagName;
  /** Raw source text of the tag name when it is fully static, else null. */
  staticName: string | null;
  attrs: MxAttr[];
  children: MxChild[];
  selfClosing: boolean;
  /** `.card` / `#main` shorthands, kept so lowering can reject them clearly. */
  shorthandClasses: MxRange[];
  shorthandIds: MxRange[];
  /** `|item, i|` tag params. */
  params: MxRange | null;
  tagArgs: MxRange | null;
  tagVar: MxRange | null;
  range: MxRange;
  /** `</name>` range; null for a self-closing or void tag. */
  closeRange: MxRange | null;
}

export interface MxWalkError {
  message: string;
  start: number;
  end: number;
}

export interface MxWalkResult {
  root: MxElement | null;
  /** Absolute offset just past the root tag's close. */
  end: number;
  errors: MxWalkError[];
}

/**
 * HTML void elements, which have no closing tag and no children. htmljs-parser
 * is markup-agnostic — it reports `<input value=x>` as an open tag and then
 * complains the tag was never closed — so the element set has to live here.
 * Declaring them to htmljs-parser as `TagType.void` (the return value of
 * `onOpenTagName`) is what makes it stop expecting a close tag, so `<br>` no
 * longer swallows its siblings' closing tags. A void tag written with children
 * (`<input>x</input>`) is then rejected by htmljs-parser itself.
 */
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** True for a tag that closes itself, whether written `/>` or not. */
export function isVoidTag(name: string | null): boolean {
  return name !== null && VOID_TAGS.has(name);
}

/**
 * htmljs-parser's own wording for a fragment's synthetic root names a tag the
 * author never wrote (`"${_}"`); say what they did write instead.
 */
function fragmentMessage(message: string): string {
  if (message.startsWith("Missing ending")) {
    return "Unterminated fragment: expected a closing `</>`.";
  }
  return message.replaceAll(`"\${_}"`, '"<>"');
}

/**
 * htmljs-parser's mismatched-close message names both tags but reports only
 * the closer's position. The innermost unclosed element is the "corresponding
 * opening" tag it names, so append where that element's `<` is, as 1-based
 * `line:column` (UTF-16 units). `openerStart` is the offset of that `<` in
 * `source`; the caller supplies it because a fragment's synthetic root sits in
 * the shifted prefix and really starts at the region's `<>`.
 */
function withOpenerPosition(
  message: string,
  source: string,
  openerStart: number | null,
): string {
  if (
    openerStart === null ||
    !/^The closing ".*" tag does not match the corresponding opening ".*" tag$/.test(
      message,
    )
  ) {
    return message;
  }
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < openerStart; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return `${message} at ${line}:${openerStart - lineStart + 1}`;
}

/** Thrown from a handler to stop htmljs-parser once the root tag closes. */
class StopWalk extends Error {}

/**
 * What stands in for a fragment's `<>` while it is walked. htmljs-parser has
 * no nameless open tag, and a static root would ignore the fragment's
 * nameless `</>` (see `onCloseTagEnd`), so the walk sees a dynamic-named root
 * whose close may be nameless — the only shape htmljs-parser accepts `</>`
 * for. Its offsets are corrected back to the real source, so it is invisible
 * to every consumer except as the synthetic root the region's children hang
 * off.
 */
const FRAGMENT_OPEN = "<${_}>";

/**
 * Runs htmljs-parser over `source` starting at `start` and builds the raw MX
 * tree for the single root tag found there.
 *
 * Two things this has to get right:
 *
 * 1. **Offsets.** `Parser.parse(data)` takes no start offset and reports every
 *    range relative to `data`, so we pass `source.slice(start)` and add `start`
 *    back to every range as it is recorded.
 * 2. **Stopping.** There is no API to abort a parse, and mutating the parser's
 *    `pos`/`maxPos` from a handler does not stop it (`parse()` captures
 *    `maxPos` in a local). Throwing from the handler is what actually works, so
 *    the depth-0 close throws `StopWalk` and we catch it here. Without this,
 *    htmljs-parser scans the entire rest of the file as if it were markup —
 *    measurably (~44x more events on a 3000-line file).
 */
export function walkMxRegion(
  source: string,
  start: number,
  options: { fragment?: boolean } = {},
): MxWalkResult {
  const fragment = options.fragment === true;
  // A fragment region starts at its `<>`. The walk is handed a synthetic open
  // tag in its place, so every offset htmljs-parser reports is shifted by the
  // difference in length: `base` is the source offset of data index 0.
  const base = fragment ? start + 2 - FRAGMENT_OPEN.length : start;
  const data = fragment
    ? FRAGMENT_OPEN + source.slice(start + 2)
    : source.slice(start);
  const errors: MxWalkError[] = [];

  const rel = (r: { start: number; end: number }): MxRange => ({
    start: r.start + base,
    end: r.end + base,
  });

  let root: MxElement | null = null as MxElement | null;
  const stack: MxElement[] = [];
  let pending: MxElement | null = null;
  let pendingAttrName: { name: string; range: MxRange } | null = null;
  let end = -1;
  let done = false;
  let closeStart: number | null = null;
  let closeName: string | undefined;

  const top = (): MxElement | null =>
    stack.length > 0 ? (stack[stack.length - 1] as MxElement) : null;

  /**
   * Source offset of the innermost unclosed element's `<`. The fragment's
   * synthetic root is the stack's bottom entry and its range lies in the
   * shifted prefix; its real start is the region's `<>` (as for the returned
   * tree below).
   */
  const openerOffset = (): number | null => {
    const el = top();
    if (el === null) return null;
    return fragment && el === stack[0] ? start : el.range.start;
  };

  /** Flushes a name-only attribute as a boolean attribute. */
  const flushAttrName = () => {
    if (pendingAttrName && pending) {
      pending.attrs.push({
        kind: "boolean",
        name: pendingAttrName.name,
        nameRange: pendingAttrName.range,
      });
    }
    pendingAttrName = null;
  };

  const addChild = (child: MxChild) => {
    const parent = top();
    if (parent) parent.children.push(child);
  };

  const finish = (endOffset: number) => {
    done = true;
    end = endOffset + base;
    throw new StopWalk();
  };

  const parser = createParser({
    onOpenTagStart(range) {
      if (done) return;
      flushAttrName();
      pending = {
        name: { start: 0, end: 0, quasis: [], expressions: [] },
        staticName: null,
        attrs: [],
        children: [],
        selfClosing: false,
        shorthandClasses: [],
        shorthandIds: [],
        params: null,
        tagArgs: null,
        tagVar: null,
        range: rel(range),
        closeRange: null,
      };
    },

    onOpenTagName(range) {
      if (done || !pending) return;
      const name: MxTagName = {
        ...rel(range),
        quasis: range.quasis.map(rel),
        expressions: range.expressions.map((e) => rel(e.value)),
      };
      pending.name = name;
      pending.staticName =
        range.expressions.length === 0
          ? data.slice(range.start, range.end)
          : null;

      if (isVoidTag(pending.staticName)) return TagType.void;
      return undefined;
    },

    onTagShorthandClass(range) {
      if (done || !pending) return;
      pending.shorthandClasses.push(rel(range));
    },

    onTagShorthandId(range) {
      if (done || !pending) return;
      pending.shorthandIds.push(rel(range));
    },

    onTagParams(range) {
      if (done || !pending) return;
      pending.params = rel(range.value);
    },

    onTagArgs(range) {
      if (done || !pending) return;
      pending.tagArgs = rel(range.value);
    },

    onTagVar(range) {
      if (done || !pending) return;
      pending.tagVar = rel(range.value);
    },

    onAttrName(range) {
      if (done || !pending) return;
      flushAttrName();
      pendingAttrName = {
        name: data.slice(range.start, range.end),
        range: rel(range),
      };
    },

    onAttrValue(range) {
      if (done || !pending) return;
      const name = pendingAttrName?.name ?? "";
      const nameRange = pendingAttrName?.range ?? rel(range);
      pendingAttrName = null;
      const raw = data.slice(range.value.start, range.value.end);
      const quoted = raw.charCodeAt(0) === 34 || raw.charCodeAt(0) === 39;
      pending.attrs.push({
        kind: range.bound ? "bound" : quoted ? "static" : "dynamic",
        name,
        nameRange,
        value: rel(range.value),
      });
    },

    onAttrMethod(range) {
      if (done || !pending) return;
      const name = pendingAttrName?.name ?? "";
      const nameRange = pendingAttrName?.range ?? rel(range);
      pendingAttrName = null;
      pending.attrs.push({
        kind: "method",
        name,
        nameRange,
        params: rel(range.params.value),
        body: rel(range.body.value),
        async: range.async,
        range: rel(range),
      });
    },

    onAttrSpread(range) {
      if (done || !pending) return;
      flushAttrName();
      pending.attrs.push({
        kind: "spread",
        value: rel(range.value),
        range: rel(range),
      });
    },

    onOpenTagEnd(range) {
      if (done || !pending) return;
      flushAttrName();
      const el = pending;
      pending = null;
      const closesItself = range.selfClosed || isVoidTag(el.staticName);
      el.selfClosing = closesItself;
      el.range = { start: el.range.start, end: range.end + base };

      if (root === null) root = el;
      else addChild({ kind: "element", element: el });

      if (closesItself) {
        if (stack.length === 0) finish(range.end);
      } else {
        stack.push(el);
      }
    },

    onText(range) {
      if (done) return;
      addChild({ kind: "text", range: rel(range) });
    },

    onPlaceholder(range) {
      if (done) return;
      addChild({
        kind: "placeholder",
        range: rel(range),
        value: rel(range.value),
        escape: range.escape,
      });
    },

    onComment(range) {
      if (done) return;
      addChild({ kind: "comment", range: rel(range) });
    },

    onCloseTagStart(range) {
      if (done) return;
      closeStart = range.start;
      closeName = undefined;
    },

    onCloseTagName(range) {
      if (done) return;
      closeName = source.slice(base + range.start, base + range.end);
    },

    onCloseTagEnd(range) {
      if (done) return;

      const top = stack[stack.length - 1];
      // htmljs-parser treats `</>` as closing the current tag, but MX only allows nameless close tags
      // for dynamic tags (`<${Foo}>...</>`). For static tags, we ignore nameless close tags
      // so htmljs-parser can emit its own error later when the real close tag is encountered.
      if (!closeName && top && top.staticName !== null) {
        closeStart = null;
        return;
      }

      const el = stack.pop();
      if (el) {
        el.range = { start: el.range.start, end: range.end + base };
        // `onCloseTagStart` fires at the `</`; together with this range's end
        // that is the full `</name>` span, which is what the lowered
        // JSXClosingElement needs so source maps point at the closing tag.
        el.closeRange = {
          start: (closeStart ?? range.start) + base,
          end: range.end + base,
        };
      }
      closeStart = null;
      if (stack.length === 0) finish(range.end);
    },

    onError(range) {
      if (done) return;
      // An error that lands on the synthetic open tag is about the
      // fragment's own `<>`.
      const message = fragment ? fragmentMessage(range.message) : range.message;
      errors.push({
        message: withOpenerPosition(message, source, openerOffset()),
        start: Math.max(range.start + base, start),
        end: Math.max(range.end + base, start),
      });
    },
  });

  try {
    parser.parse(data);
  } catch (err) {
    if (!(err instanceof StopWalk)) {
      // Any other exception is an htmljs-parser internal failure. Surface it as
      // a walk error so the caller can turn it into a Babel parse error rather
      // than letting a foreign stack trace escape the parser.
      errors.push({
        message: err instanceof Error ? err.message : String(err),
        start,
        end: start,
      });
    }
  }

  if (!done && errors.length === 0) {
    errors.push({
      message: "Unterminated MX element.",
      start,
      end: source.length,
    });
  }

  // A void element closes at its open tag, so htmljs-parser stops before any
  // `</input>` the author wrote and would leave it for Babel to trip over as
  // stray syntax. Catch it here instead, where the element is still in hand.
  if (
    done &&
    root !== null &&
    isVoidTag(root.staticName) &&
    errors.length === 0
  ) {
    const closeTag = `</${root.staticName}>`;
    // Only the run of plain text right after the tag can belong to it: a `<`
    // starts something else, and anything past that is no longer this
    // element's business.
    const nextTag = source.indexOf("<", end);
    const closeAt = source.indexOf(closeTag, end);
    if (closeAt !== -1 && (nextTag === -1 || closeAt <= nextTag)) {
      errors.push({
        message: `<${root.staticName}> is a void element and cannot have a closing tag.`,
        start: closeAt,
        end: closeAt + closeTag.length,
      });
    }
  }

  // The synthetic open tag's own range lies in the shifted prefix; the
  // fragment root really starts at its `<>`.
  if (fragment && root !== null) {
    root.range = { start, end: root.range.end };
    root.name = { start, end: start, quasis: [], expressions: [] };
  }

  return { root, end, errors };
}
