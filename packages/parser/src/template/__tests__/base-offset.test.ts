/**
 * Base position for a fragment parse: `parse(code, options?)` accepts a
 * `{ startOffset, startLine, startColumn }` base so that a substring of a
 * larger file can be parsed on its own and still report positions, locations
 * and offsets relative to the enclosing file.
 *
 * The contract these tests pin:
 *
 * - Ranges passed to handlers (including error ranges) and read back by
 *   `read(range)` stay relative to the string passed to `parse`, exactly as
 *   without the options.
 * - `positionAt`, `locationAt` and `offsetAt` are relative to the enclosing
 *   file. `startColumn` applies to the fragment's first line only; later lines
 *   start at column 0. `startLine` shifts every line. `startOffset` shifts
 *   every offset, and only offsets.
 *
 * Positions are UTF-16 code units, as they are without the options.
 *
 * Expectations here never re-implement the shift rule: every position is
 * compared against either a literal, or a whole-document parse of the string
 * the fragment was embedded in.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createParser, type Handlers, type ParseOptions } from "../index.ts";

type RangePair = [number, number];

interface Recorded {
  handler: string;
  ranges: RangePair[];
}

interface ParseRun {
  log: Recorded[];
  errors: Recorded[];
  parser: ReturnType<typeof createParser>;
}

/**
 * Collects every `{ start, end }` pair reachable from a handler argument,
 * including the nested `value`/`body`/`params`/`typeParams` ranges.
 */
function collectRanges(value: unknown, out: RangePair[] = []): RangePair[] {
  if (Array.isArray(value)) {
    for (const item of value) collectRanges(item, out);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  const record = value as Record<string, unknown>;
  if (typeof record.start === "number" && typeof record.end === "number") {
    out.push([record.start, record.end]);
  }
  for (const [key, child] of Object.entries(record)) {
    if (key !== "start" && key !== "end") collectRanges(child, out);
  }
  return out;
}

/**
 * Parses with a handler for every `on*` name, recording each handler's
 * ranges in call order.
 */
function parse(source: string, options?: ParseOptions): ParseRun {
  const log: Recorded[] = [];
  const handlers = new Proxy(
    {},
    {
      get(_target, name) {
        if (typeof name !== "string" || !name.startsWith("on")) {
          return undefined;
        }
        return (data: unknown) => {
          log.push({ handler: name, ranges: collectRanges(data) });
        };
      },
    },
  );
  const parser = createParser(handlers as never);
  parser.parse(source, options);
  return { log, errors: log.filter((e) => e.handler === "onError"), parser };
}

/**
 * Builds a larger document in which `source` starts at exactly
 * (`startLine`, `startColumn`), and returns both it and the offset its first
 * character sits at. `eol` selects the line ending, for the CRLF case.
 */
function embed(
  source: string,
  startLine: number,
  startColumn: number,
  eol = "\n",
): { head: string; doc: string } {
  const head = `${eol.repeat(startLine)}${" ".repeat(startColumn)}`;
  return { head, doc: head + source };
}

const BASE = { startOffset: 137, startLine: 9, startColumn: 14 };

/**
 * HTML-mode source exercising the handler surface: declarations, doctype,
 * CDATA, comments, scriptlets, statements, tag shorthand, attribute tags,
 * arguments, params, type args, type params, methods, spreads, placeholders,
 * an atom (decision 156) and close tags.
 */
const HTML_SOURCE = [
  '<?xml version="1.0"?>',
  "<!DOCTYPE html>",
  "<![CDATA[raw]]>",
  "<!-- html comment -->",
  "// line comment",
  "/* block comment */",
  "static const statement = 1",
  "$ const scriptlet = 1;",
  "$ { block(); }",
  "<div.cls#id/tagVar|p|(arg) a=1 b:=bound ...spread c(x) { body } d<T>(y) { body } e=:atom f(1) /* in tag */>",
  "<typed <A, B = string> |data: A & B|>typed body</typed>",
  "  ${placeholder}",
  "  <!-- inner comment -->",
  "  <@attrTag<AT> at=1 />",
  "</div>",
  "<tag<Args> typeArgs=1/>",
  "-- text",
].join("\n");

/**
 * Concise-mode source: the same handler kinds written in concise syntax —
 * tags with no angle brackets, attributes with no `=`, `--` text lines, an
 * indented body, scriptlet lines, and a concise attribute group (args, method,
 * generic method, spread, shorthand, tag variable, type args, type params).
 */
const CONCISE_SOURCE = [
  '<?xml version="1.0"?>',
  "<!DOCTYPE html>",
  "<![CDATA[raw]]>",
  "div.cls#id/tagVar a=1 b:=bound ...spread onClick() { body } c(1) d<T>(y) { body } e=:atom",
  "  -- text",
  "  -- hi ${x} there",
  "  // line comment",
  "  /* block comment */",
  "  $ const scriptlet = 1;",
  "  $ { block(); }",
  "  span.inner",
  "    -- more text",
  "typed <A> |data: A|",
  "  -- typed body",
  "typedArgs<A> f=1",
  "  -- body",
  "tagArgs(1) f=1",
  "  -- tag args body",
  "div [",
  "  a=1 // c",
  "  /* b */ b=2",
  "]",
  "  -- attributed group",
].join("\n");

/** Concise-mode error at end of input (an unclosed HTML tag at EOF). */
const CONCISE_ERROR_SOURCE = "div\n  -- text\n<div>";

/** Every handler name the contract names that HTML mode produces. */
const HTML_HANDLERS = [
  "onText",
  "onOpenTagStart",
  "onOpenTagName",
  "onTagShorthandId",
  "onTagShorthandClass",
  "onTagVar",
  "onTagArgs",
  "onTagParams",
  "onTagTypeArgs",
  "onTagTypeParams",
  "onAttrName",
  "onAttrArgs",
  "onAttrValue",
  "onAttrMethod",
  "onAttrSpread",
  "onOpenTagComment",
  "onOpenTagEnd",
  "onCloseTagStart",
  "onCloseTagName",
  "onCloseTagEnd",
  "onComment",
  "onCDATA",
  "onDeclaration",
  "onDoctype",
  "onScriptlet",
  "onPlaceholder",
  "onAtom",
];

/**
 * Handlers the interface declares that concise mode cannot produce. Each one
 * is listed with the input that was run to establish that, and each claim is
 * re-tested at runtime by "unreachable handlers really do not fire in concise
 * mode" below — nothing here is inferred.
 *
 * A concise tag is written without `<` and closes implicitly at end of line,
 * so there is no open-tag start and no close tag to report.
 */
// `Handlers` is the interface index.ts re-exports under that name.
type ParserOptionName = keyof Handlers;

/** Every handler `ParserOptions` (util/constants.ts) declares. */
const DECLARED_HANDLERS = [
  "onError",
  "onText",
  "onOpenTagStart",
  "onOpenTagName",
  "onTagShorthandId",
  "onTagShorthandClass",
  "onTagTypeArgs",
  "onTagVar",
  "onTagArgs",
  "onTagTypeParams",
  "onTagParams",
  "onAttrName",
  "onAttrArgs",
  "onAttrValue",
  "onAttrMethod",
  "onAttrSpread",
  "onOpenTagComment",
  "onOpenTagEnd",
  "onCloseTagStart",
  "onCloseTagName",
  "onCloseTagEnd",
  "onComment",
  "onCDATA",
  "onDeclaration",
  "onDoctype",
  "onScriptlet",
  "onPlaceholder",
  "onAtom",
  "onTrigger",
] as const;

/**
 * MX (decision 182): handlers only a syntax table with triggers can produce.
 * The default row has none, so neither source here fires them; "table-only
 * handlers do not fire on the default row" below re-tests that.
 */
const TABLE_ONLY_HANDLERS: readonly string[] = ["onTrigger"];

// Compile-time exhaustiveness: if `ParserOptions` ever gains a handler that
// DECLARED_HANDLERS does not name, this stops typechecking, because
// `Record<Undeclared, never>` demands a property `{}` does not have.
type Undeclared = Exclude<ParserOptionName, (typeof DECLARED_HANDLERS)[number]>;
const _everyDeclaredHandlerIsListed: Record<Undeclared, never> = {};

const CONCISE_UNREACHABLE: Array<
  [handler: string, input: string, why: string]
> = [
  [
    "onOpenTagStart",
    "div\na=1",
    "a concise tag is written without `<`, so there is nothing to mark a start with",
  ],
  [
    "onCloseTagStart",
    "div</div>",
    "a concise tag closes implicitly at end of line; there is no `</`",
  ],
  ["onCloseTagName", "div</div>", "a concise close tag has no name to report"],
];

/** Everything concise mode can produce: the declared handlers minus the
 * unreachable ones above. `onError` is covered by CONCISE_ERROR_SOURCE. */
const CONCISE_HANDLERS = DECLARED_HANDLERS.filter(
  (handler) =>
    handler !== "onError" &&
    !TABLE_ONLY_HANDLERS.includes(handler) &&
    !CONCISE_UNREACHABLE.some(([unreachable]) => unreachable === handler),
);

/**
 * Asserts the whole handler-side contract for one source: identical events
 * and ranges with and without the base options, `offsetAt` shifting by
 * exactly `startOffset`, `read(range)` returning the source's own text, and
 * `positionAt`/`locationAt` at every reported endpoint matching a
 * whole-document parse of the embedded fragment.
 */
function assertBaseContract(source: string, base: ParseOptions): ParseRun {
  const based = parse(source, base);
  const plain = parse(source);

  // Events and ranges are untouched by the options.
  assert.ok(based.log.length > 0, "no events were recorded");
  assert.deepEqual(based.log, plain.log);

  const offset = base.startOffset ?? 0;
  const line = base.startLine ?? 0;
  const column = base.startColumn ?? 0;
  const { head, doc } = embed(source, line, column);
  const whole = parse(doc);

  // read() stands each atom in with its same-length numeric stand-in
  // (`0.` then zeros, decision 156). The raw open tag, which reads the
  // source, is never a handler range.
  const atoms = based.log
    .filter((e) => e.handler === "onAtom")
    .map((e) => e.ranges[0] as RangePair);
  const stoodIn = (start: number, end: number): string => {
    let text = "";
    let at = start;
    for (const [atomStart, atomEnd] of atoms) {
      if (atomStart < start || atomEnd > end) continue;
      text += `${source.slice(at, atomStart)}0.${"0".repeat(atomEnd - atomStart - 2)}`;
      at = atomEnd;
    }
    return text + source.slice(at, end);
  };

  for (const entry of based.log) {
    for (const [start, end] of entry.ranges) {
      // read() reads the parsed string, not the enclosing document.
      const read = based.parser.read({ start, end });
      assert.equal(
        read,
        stoodIn(start, end),
        `${entry.handler} ${start}-${end}`,
      );
      // offsetAt is the raw rebasing, and nothing else moves.
      assert.equal(based.parser.offsetAt(start), start + offset);
      assert.equal(based.parser.offsetAt(end), end + offset);
      // Positions match what the same characters have in the whole document.
      assert.deepEqual(
        based.parser.locationAt({ start, end }),
        whole.parser.locationAt({
          start: start + head.length,
          end: end + head.length,
        }),
        `${entry.handler} ${start}-${end}`,
      );
      assert.deepEqual(
        based.parser.positionAt(start),
        whole.parser.positionAt(start + head.length),
        `${entry.handler} ${start}`,
      );
    }
  }
  return based;
}

describe("base offset: handler ranges", () => {
  it("are identical with and without the options (html mode)", () => {
    assertBaseContract(HTML_SOURCE, BASE);
  });

  it("are identical with and without the options (concise mode)", () => {
    assertBaseContract(CONCISE_SOURCE, BASE);
  });

  it("exercises every handler kind html mode can produce", () => {
    const seen = new Set(parse(HTML_SOURCE).log.map((e) => e.handler));
    for (const handler of HTML_HANDLERS) {
      assert.ok(seen.has(handler), `no ${handler} event was recorded`);
    }
  });

  it("exercises every handler kind concise mode can produce", () => {
    const seen = new Set(parse(CONCISE_SOURCE).log.map((e) => e.handler));
    for (const handler of CONCISE_HANDLERS) {
      assert.ok(seen.has(handler), `no ${handler} event was recorded`);
    }
    // The two modes are genuinely different inputs, not one source twice.
    assert.notDeepEqual(
      parse(CONCISE_SOURCE).log.map((e) => e.handler),
      parse(HTML_SOURCE).log.map((e) => e.handler),
    );
  });

  it("accounts for every handler the interface declares", () => {
    // The compile-time exhaustiveness guard, exercised here so it is used:
    // if ParserOptions gains a handler DECLARED_HANDLERS omits, the
    // `Record<Undeclared, never>` annotation above stops typechecking.
    assert.deepEqual(_everyDeclaredHandlerIsListed, {});
    const declared = new Set<string>(DECLARED_HANDLERS);
    const html = new Set<string>(HTML_HANDLERS);
    const concise = new Set<string>(CONCISE_HANDLERS);
    const unreachable = new Set(CONCISE_UNREACHABLE.map(([h]) => h));

    // Nothing may be asserted in a mode, or declared unreachable, unless the
    // interface actually declares it.
    for (const handler of [...html, ...concise, ...unreachable]) {
      assert.ok(
        declared.has(handler),
        `${handler} is listed but ParserOptions does not declare it`,
      );
    }
    // Every declared handler is accounted for: exercised in a mode, or listed
    // unreachable with a reason. onError is covered by the error sources.
    for (const handler of declared) {
      assert.ok(
        handler === "onError" ||
          TABLE_ONLY_HANDLERS.includes(handler) ||
          html.has(handler) ||
          concise.has(handler) ||
          unreachable.has(handler),
        `${handler} is neither exercised nor listed unreachable`,
      );
    }
  });

  it("table-only handlers do not fire on the default row", () => {
    for (const source of [HTML_SOURCE, CONCISE_SOURCE]) {
      const seen = new Set(parse(source).log.map((e) => e.handler));
      for (const handler of TABLE_ONLY_HANDLERS) {
        assert.ok(!seen.has(handler), `${handler} fired without a table`);
      }
    }
  });

  it("unreachable handlers really do not fire in concise mode", () => {
    // Each claim was established by running the input, not inferred; this
    // keeps that honest.
    for (const [handler, input, why] of CONCISE_UNREACHABLE) {
      const seen = new Set(parse(input).log.map((e) => e.handler));
      assert.ok(!seen.has(handler), `${handler} fired for ${why}`);
      // The input is a real concise parse, not an immediate error.
      assert.ok(parse(input).log.length > 0, `no events for ${handler}`);
    }
  });

  it("reports a concise-mode error at end of input unchanged", () => {
    const run = assertBaseContract(CONCISE_ERROR_SOURCE, BASE);
    assert.ok(run.errors.length > 0, "no error was reported");
    assert.deepEqual(run.errors, parse(CONCISE_ERROR_SOURCE).errors);
  });
});

/**
 * One tag event, with everything a consumer might derive from a node read
 * *inside* the handler: the raw fragment-relative range it was handed, the
 * `offsetAt` rebasing of it, the text, and the position/location.
 */
interface TagEvent {
  at: string;
  nodeStart: number;
  nodeEnd: number;
  offStart: number;
  offEnd: number;
  text: string;
  pos: unknown;
  loc: unknown;
}

/**
 * Parses `source`, recording those reads from inside the tag handlers, while
 * the parse is still running.
 */
function tagEvents(source: string, options?: ParseOptions): TagEvent[] {
  const seen: TagEvent[] = [];

  function record(at: string, node: { start: number; end: number }): void {
    seen.push({
      at,
      nodeStart: node.start,
      nodeEnd: node.end,
      offStart: parser.offsetAt(node.start),
      offEnd: parser.offsetAt(node.end),
      text: parser.read(node),
      pos: parser.positionAt(node.start),
      loc: parser.locationAt(node),
    });
  }

  const parser = createParser({
    onOpenTagStart: (node) => record("openStart", node),
    onOpenTagEnd: (node) => record("openEnd", node),
    onCloseTagStart: (node) => record("closeStart", node),
    onCloseTagEnd: (node) => record("closeEnd", node),
  });
  parser.parse(source, options);
  return seen;
}

describe("base offset: positions and locations", () => {
  const SOURCE = "<div>\n  hi\n</div>";

  it("applies the base column to the first line only", () => {
    const { parser } = parse(SOURCE, {
      startOffset: 100,
      startLine: 5,
      startColumn: 8,
    });
    assert.deepEqual(parser.positionAt(0), { line: 5, character: 8 });
    assert.deepEqual(parser.positionAt(8), { line: 6, character: 2 });
    assert.deepEqual(parser.locationAt({ start: 8, end: 8 }), {
      start: { line: 6, character: 2 },
      end: { line: 6, character: 2 },
    });
  });

  it("rebases a multi-line fragment across every line", () => {
    const source = "line one\nline two\nline three";
    const { parser } = parse(source, {
      startOffset: 40,
      startLine: 2,
      startColumn: 6,
    });
    assert.deepEqual(parser.positionAt(0), { line: 2, character: 6 });
    assert.deepEqual(parser.positionAt(9), { line: 3, character: 0 });
    assert.deepEqual(parser.positionAt(18), { line: 4, character: 0 });
    assert.deepEqual(parser.locationAt({ start: 9, end: 18 }), {
      start: { line: 3, character: 0 },
      end: { line: 4, character: 0 },
    });
  });

  it("counts UTF-16 code units for characters outside the BMP", () => {
    // "😀" is one code point but two UTF-16 code units.
    const source = "😀<div>😀😀\n😀x</div>";
    const base = { startOffset: 7, startLine: 1, startColumn: 3 };
    const { parser } = parse(source, base);
    const { head, doc } = embed(source, base.startLine, base.startColumn);
    const whole = parse(doc);
    for (const offset of [0, 2, 7, 9, 11, 12, 14, source.length - 1]) {
      assert.deepEqual(
        parser.positionAt(offset),
        whole.parser.positionAt(head.length + offset),
        `offset ${offset}`,
      );
    }
    assert.deepEqual(parser.offsetAt(2), 9);
  });

  it("handles CRLF line endings", () => {
    // `\r` is an ordinary character on its line; only `\n` starts a new one.
    const source = "<div>\r\n  hi\r\n</div>";
    const base = { startOffset: 11, startLine: 3, startColumn: 5 };
    const { parser } = parse(source, base);
    const { head, doc } = embed(
      source,
      base.startLine,
      base.startColumn,
      "\r\n",
    );
    const whole = parse(doc);
    for (const offset of [0, 6, 7, 9, 12, source.length]) {
      assert.deepEqual(
        parser.positionAt(offset),
        whole.parser.positionAt(head.length + offset),
        `offset ${offset}`,
      );
    }
    // The `\r` counts toward the column of the line it terminates.
    assert.deepEqual(parser.positionAt(0), { line: 3, character: 5 });
    assert.deepEqual(parser.positionAt(9), { line: 4, character: 2 });
  });

  it("behaves exactly as before when every base value is zero", () => {
    const source = `${SOURCE}\n<div>${"x".repeat(200)}</div>`;
    const zero = parse(source, {
      startOffset: 0,
      startLine: 0,
      startColumn: 0,
    });
    const plain = parse(source);
    assert.deepEqual(zero.log, plain.log);
    for (const offset of [0, 1, 6, 12, source.length]) {
      assert.deepEqual(
        zero.parser.positionAt(offset),
        plain.parser.positionAt(offset),
      );
      assert.equal(zero.parser.offsetAt(offset), offset);
    }
  });

  it("stays unchanged when the options object is empty or all-zero", () => {
    const plain = parse(SOURCE);
    for (const options of [{}, { startOffset: 0 }, { startColumn: 0 }]) {
      const based = parse(SOURCE, options);
      assert.deepEqual(based.log, plain.log);
      assert.deepEqual(based.parser.positionAt(8), plain.parser.positionAt(8));
    }
  });

  it("shifts lines for startLine alone, leaving columns alone", () => {
    const source = "<div>\n  hi\n</div>";
    const base = { startLine: 6 };
    const { parser } = parse(source, base);
    const { head, doc } = embed(source, 6, 0);
    const whole = parse(doc);
    for (const offset of [0, 5, 6, 8, 12]) {
      assert.deepEqual(
        parser.positionAt(offset),
        whole.parser.positionAt(head.length + offset),
        `offset ${offset}`,
      );
    }
    assert.deepEqual(parser.positionAt(0), { line: 6, character: 0 });
    assert.deepEqual(parser.positionAt(8), { line: 7, character: 2 });
    // offsetAt with no startOffset does not move.
    assert.equal(parser.offsetAt(8), 8);
  });

  it("shifts the first line's columns for startColumn alone", () => {
    const source = "<div>\n  hi\n</div>";
    const base = { startColumn: 9 };
    const { parser } = parse(source, base);
    const { head, doc } = embed(source, 0, 9);
    const whole = parse(doc);
    for (const offset of [0, 5, 6, 8, 12]) {
      assert.deepEqual(
        parser.positionAt(offset),
        whole.parser.positionAt(head.length + offset),
        `offset ${offset}`,
      );
    }
    assert.deepEqual(parser.positionAt(0), { line: 0, character: 9 });
    assert.deepEqual(parser.positionAt(8), { line: 1, character: 2 });
    assert.equal(parser.offsetAt(8), 8);
  });

  it("does not leak one parse's base into the next on one instance", () => {
    const source = "<div>\n  hi\n</div>";
    const parser = createParser({});

    parser.parse(source, { startOffset: 100, startLine: 5, startColumn: 8 });
    const first = parser.positionAt(8);
    assert.deepEqual(first, { line: 6, character: 2 });
    assert.equal(parser.offsetAt(8), 108);

    parser.parse(source, { startOffset: 3, startLine: 1, startColumn: 0 });
    assert.deepEqual(parser.positionAt(8), { line: 2, character: 2 });
    assert.equal(parser.offsetAt(8), 11);

    parser.parse(source);
    assert.deepEqual(parser.positionAt(8), { line: 1, character: 2 });
    assert.equal(parser.offsetAt(8), 8);
  });

  it("rebases an error raised at end of input", () => {
    const source = "<div>\n  unclosed(";
    const base = { startOffset: 55, startLine: 4, startColumn: 2 };
    const based = parse(source, base);
    const plain = parse(source);
    assert.ok(based.errors.length > 0);
    assert.deepEqual(based.errors, plain.errors);

    const { head, doc } = embed(source, base.startLine, base.startColumn);
    const whole = parse(doc);
    for (const [start, end] of based.errors.flatMap((e) => e.ranges)) {
      assert.equal(based.parser.offsetAt(start), start + base.startOffset);
      assert.deepEqual(
        based.parser.locationAt({ start, end }),
        whole.parser.locationAt({
          start: start + head.length,
          end: end + head.length,
        }),
      );
    }
  });

  it("rebases positions a handler reads mid-parse, exactly once", () => {
    // `@marko/compiler`'s onCloseTagEnd reads the tag's own start/end back
    // through locationAt *during* the parse to compute the node's loc. Since
    // handler ranges stay fragment-relative and positionAt/locationAt are
    // rebased, that read shifts once, not twice.
    //
    // Every expectation is the corresponding offset, position and location
    // from an independent parse of the whole embedding document, which has no
    // base options and therefore reports absolute values directly. Nothing
    // here is derived from the values under test.
    //
    // The base column is 0 so the fragment starts at the start of a line and
    // the whole document yields the same events: an embedding that indents the
    // fragment with leading spaces changes how the document parses (the
    // indented fragment becomes an HTML block and the parse errors), which
    // would leave nothing to correspond the events to. The column shift is
    // covered by the first-line, startColumn-only and embedding tests above.
    const source = '<div class="a">\n  <span>hi</span>\n</div>';
    const startLine = 9;
    const { head, doc } = embed(source, startLine, 0);
    // `offsetAt` shifts by the *declared* startOffset, so for its results to
    // line up with the whole document's own offsets that offset has to be
    // where the fragment really starts in `doc` — nine newlines in, offset 9.
    const base = { startOffset: head.length, startLine, startColumn: 0 };
    assert.equal(base.startOffset, 9);

    const based = tagEvents(source, base);
    const whole = tagEvents(doc);

    assert.ok(based.length >= 6, `only ${based.length} tag events`);
    assert.equal(based.length, whole.length);

    for (let i = 0; i < based.length; i++) {
      const b = based[i] as TagEvent;
      const w = whole[i] as TagEvent;
      assert.equal(b.at, w.at, "event order");
      // offsetAt, read inside the handler, lands on the whole document's own
      // offsets for the same characters.
      assert.equal(b.offStart, w.nodeStart, b.at);
      assert.equal(b.offEnd, w.nodeEnd, b.at);
      // The raw range the handler was handed is the same text, shifted back
      // into the fragment.
      assert.equal(b.nodeStart + head.length, w.nodeStart, b.at);
      assert.equal(b.nodeEnd + head.length, w.nodeEnd, b.at);
      assert.equal(b.text, source.slice(b.nodeStart, b.nodeEnd), b.at);
      assert.deepEqual(b.pos, w.pos, b.at);
      assert.deepEqual(b.loc, w.loc, b.at);
    }
  });
});

describe("base offset: embedding equivalence", () => {
  const INPUTS = [
    "",
    "hello",
    "<div>text</div>",
    "<div>\n  <span>a</span>\n  <span>b</span>\n</div>",
    "<div.cls#id>x</div>",
    "<div|a, b| a=1 b:=2 />",
    "<div ...spread onClick() { body } />",
    '<${dynamic} class="x"/>',
    "<div<T> typeArgs=1/>",
    "${placeholder}\n$ { block(); }\n-- text",
    '<!-- comment -->\n<!DOCTYPE html>\n<![CDATA[raw]]>\n<?xml version="1.0"?>',
    "<div>\n  unclosed(",
    "😀<div>😀😀\n😀x</div>",
    "div.cls#id/tagVar a=1 ...spread c(1)\n  -- text\n  ${placeholder}",
    "unclosed(",
    "<div>\r\n  hi\r\n</div>",
  ];

  const BASES = [
    { startOffset: 0, startLine: 0, startColumn: 0 },
    { startOffset: 137, startLine: 9, startColumn: 14 },
    { startOffset: 4, startLine: 0, startColumn: 3 },
    { startOffset: 1, startLine: 41, startColumn: 0 },
    { startLine: 7 },
    { startColumn: 5 },
  ];

  for (const base of BASES) {
    it(`matches a whole-document parse of the embedded fragment (base ${JSON.stringify(base)})`, () => {
      const eol = base.startLine && base.startLine % 2 === 1 ? "\r\n" : "\n";
      for (const input of INPUTS) {
        const based = parse(input, base);
        const plain = parse(input);
        // Identical events, identical ranges.
        assert.deepEqual(based.log, plain.log, input);

        const { head, doc } = embed(
          input,
          base.startLine ?? 0,
          base.startColumn ?? 0,
          eol,
        );
        const whole = parse(doc);

        const offsets = new Set<number>([
          0,
          input.length,
          Math.max(0, input.length - 1),
        ]);
        for (const entry of based.log) {
          for (const [start, end] of entry.ranges) {
            offsets.add(start);
            offsets.add(end);
            assert.equal(
              based.parser.offsetAt(start),
              start + (base.startOffset ?? 0),
            );
            assert.equal(
              based.parser.offsetAt(end),
              end + (base.startOffset ?? 0),
            );
          }
        }
        for (const offset of offsets) {
          assert.deepEqual(
            based.parser.positionAt(offset),
            whole.parser.positionAt(head.length + offset),
            `positionAt(${offset}) of ${JSON.stringify(input)}`,
          );
          assert.deepEqual(
            based.parser.locationAt({ start: offset, end: offset }),
            whole.parser.locationAt({
              start: head.length + offset,
              end: head.length + offset,
            }),
            `locationAt(${offset}) of ${JSON.stringify(input)}`,
          );
          if (offset > 0) {
            const end = Math.min(input.length, offset + 5);
            assert.deepEqual(
              based.parser.locationAt({ start: offset, end }),
              whole.parser.locationAt({
                start: head.length + offset,
                end: head.length + end,
              }),
              `locationAt(${offset},${end}) of ${JSON.stringify(input)}`,
            );
          }
        }
      }
    });
  }
});
