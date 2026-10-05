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
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createParser, type ParseOptions } from "../index.ts";

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
 * character sits at.
 */
function embed(
  source: string,
  startLine: number,
  startColumn: number,
): { head: string; doc: string } {
  const head = `${"\n".repeat(startLine)}${" ".repeat(startColumn)}`;
  return { head, doc: head + source };
}

/**
 * One source exercising every handler kind: declarations, doctype, CDATA,
 * comments, scriptlets, statements, concise and HTML mode, tag shorthand,
 * attribute tags, arguments, params, type args, type params, methods,
 * spreads, placeholders and close tags.
 */
const ALL_HANDLERS = [
  '<?xml version="1.0"?>',
  "<!DOCTYPE html>",
  "<![CDATA[raw]]>",
  "<!-- html comment -->",
  "// line comment",
  "/* block comment */",
  "static const statement = 1",
  "$ const scriptlet = 1;",
  "$ { block(); }",
  "<div.cls#id/tagVar|p|(arg) a=1 b:=bound ...spread c(x) { body } d<T>(y) { body } f(1) /* in tag */>",
  "<typed <A, B = string> |data: A & B|>typed body</typed>",
  "  ${placeholder}",
  "  <!-- inner comment -->",
  "  <@attrTag<AT> at=1 />",
  "</div>",
  "<tag<Args> typeArgs=1/>",
  "-- text",
].join("\n");

const BASE = { startOffset: 137, startLine: 9, startColumn: 14 };

/** Every handler name AC 5 asks for, plus the rest of the handler surface. */
const REQUIRED_HANDLERS = [
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
];

describe("base offset: handler ranges", () => {
  for (const mode of ["concise", "html"] as const) {
    it(`are identical with and without the base options (${mode} mode)`, () => {
      const based = parse(ALL_HANDLERS, BASE);
      const plain = parse(ALL_HANDLERS);
      assert.ok(based.log.length > 0);
      assert.deepEqual(based.log, plain.log);
    });
  }

  it("exercises every handler kind the contract names", () => {
    const seen = new Set(parse(ALL_HANDLERS).log.map((e) => e.handler));
    for (const handler of REQUIRED_HANDLERS) {
      assert.ok(seen.has(handler), `no ${handler} event was recorded`);
    }
  });

  it("shift offsets by exactly startOffset through offsetAt", () => {
    const { log, parser } = parse(ALL_HANDLERS, BASE);
    for (const entry of log) {
      for (const [start, end] of entry.ranges) {
        assert.equal(parser.offsetAt(start), start + BASE.startOffset);
        assert.equal(parser.offsetAt(end), end + BASE.startOffset);
      }
    }
  });

  it("leave read(range) returning the fragment's own text", () => {
    const { log, parser } = parse(ALL_HANDLERS, BASE);
    const plain = parse(ALL_HANDLERS);
    for (let i = 0; i < log.length; i++) {
      for (const range of log[i].ranges) {
        assert.equal(
          parser.read({ start: range[0], end: range[1] }),
          plain.parser.read({ start: range[0], end: range[1] }),
        );
      }
    }
  });
});

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
    for (const offset of [
      0,
      2,
      7,
      9,
      11,
      12,
      14,
      source.length,
      source.length - 1,
    ]) {
      assert.deepEqual(
        parser.positionAt(offset),
        whole.parser.positionAt(head.length + offset),
        `offset ${offset}`,
      );
    }
    assert.deepEqual(parser.offsetAt(2), 9);
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

  it("stays unchanged when the options object is empty or omitted", () => {
    const plain = parse(SOURCE);
    for (const options of [{}, { startOffset: 0 }, { startColumn: 0 }]) {
      const based = parse(SOURCE, options);
      assert.deepEqual(based.log, plain.log);
      assert.deepEqual(based.parser.positionAt(8), plain.parser.positionAt(8));
    }
  });

  it("rebases an error raised at end of input", () => {
    const source = "<div>\n  unclosed(";
    const base = { startOffset: 55, startLine: 4, startColumn: 2 };
    const based = parse(source, base);
    const plain = parse(source);
    assert.ok(based.errors.length > 0);
    assert.ok(plain.errors.length > 0);
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

  it("does not double-shift a location computed from a node's own range", () => {
    // `@marko/compiler`'s onCloseTagEnd reads the tag's own start/end back
    // through locationAt mid-parse to compute the node's loc. Since handler
    // ranges stay fragment-relative and locationAt is rebased, that read
    // shifts exactly once: every location a handler derives from a node it
    // was handed equals the location the same characters have in a
    // whole-document parse of the embedded fragment.
    const source = '<div class="a">\n  <span>hi</span>\n</div>';
    const { head, doc } = embed(source, BASE.startLine, BASE.startColumn);
    const whole = parse(doc);

    const seen: unknown[] = [];
    const parser = createParser({
      onOpenTagStart(node) {
        seen.push({ at: "openStart", node: { ...node } });
      },
      onOpenTagEnd(node) {
        seen.push({ at: "openEnd", node: { ...node } });
      },
      onCloseTagStart(node) {
        seen.push({ at: "closeStart", node: { ...node } });
      },
      onCloseTagEnd(node) {
        seen.push({ at: "closeEnd", node: { ...node } });
      },
    });
    parser.parse(source, BASE);

    assert.ok(seen.length >= 6, `only ${seen.length} tag events`);
    for (const entry of seen as Array<{
      at: string;
      node: { start: number; end: number };
    }>) {
      const { start, end } = entry.node;
      assert.equal(parser.read(entry.node), source.slice(start, end), entry.at);
      assert.equal(parser.offsetAt(start), start + BASE.startOffset, entry.at);
      assert.equal(parser.offsetAt(end), end + BASE.startOffset, entry.at);
      assert.deepEqual(
        parser.locationAt(entry.node),
        whole.parser.locationAt({
          start: start + head.length,
          end: end + head.length,
        }),
        entry.at,
      );
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
  ];

  const BASES = [
    { startOffset: 0, startLine: 0, startColumn: 0 },
    { startOffset: 137, startLine: 9, startColumn: 14 },
    { startOffset: 4, startLine: 0, startColumn: 3 },
    { startOffset: 1, startLine: 41, startColumn: 0 },
  ];

  for (const base of BASES) {
    it(`matches a whole-document parse of the embedded fragment (base ${JSON.stringify(base)})`, () => {
      for (const input of INPUTS) {
        const based = parse(input, base);
        const plain = parse(input);
        // Identical events, identical ranges.
        assert.deepEqual(based.log, plain.log, input);

        const { head, doc } = embed(input, base.startLine, base.startColumn);
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
              start + base.startOffset,
            );
            assert.equal(based.parser.offsetAt(end), end + base.startOffset);
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
