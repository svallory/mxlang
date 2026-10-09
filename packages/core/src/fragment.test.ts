import { lineColumnAt } from "@mxlang/parser/frontend";
import { describe, expect, it } from "vitest";
import { PARSE_OPTIONS_TAGLIB } from "./core-taglib.ts";
import {
  type Node,
  parseFragment,
  parseFragmentNative,
  positionRegionSource,
  TranslateError,
} from "./index.ts";

/**
 * The fragment front door: positions reported against the *enclosing* file.
 *
 * Since port PR 5 `parseFragment` returns the MX AST: every node carries
 * file-relative UTF-16 `start`/`end` offsets (the base already applied), and
 * a line/column is derived from the document with `lineColumnAt`, which
 * applies the base column on the fragment's first line only. The Babel
 * payload inside an expression container carries the same file-relative
 * positions on its own `loc`.
 */

/** The first tag in a fragment's body. */
function firstTag(body: readonly Node[]): Node {
  const tag = body.find((node: Node) => node.type === "MxTag");
  if (!tag) throw new Error("no MxTag in fragment body");
  return tag;
}

/** The file line/column of `offset`, the fragment base applied. */
function at(ast: Node, offset: number): { line: number; column: number } {
  return lineColumnAt(ast, offset);
}

describe("parseFragment shifts positions by the base", () => {
  it("shifts a tag on the fragment's first line by line and column", () => {
    // A fragment starting at file line 6, column 8 (spike 1's own numbers).
    const { ast, body } = parseFragment('<div class="a">x</div>\n', {
      filename: "Counter.solid.mx",
      baseOffset: 120,
      baseLine: 5,
      baseColumn: 8,
    });
    const tag = firstTag(body);
    expect(tag.start).toBe(120);
    expect(at(ast, tag.start)).toEqual({ line: 6, column: 8 });
  });

  it("shifts a later line's line only, leaving its column alone", () => {
    // Line 2 of the fragment begins at column 0 in the file too, so only the
    // line moves — the base column applies to the first line and nowhere else.
    const { ast, body } = parseFragment("<div>\n  <span>x</span>\n</div>\n", {
      baseLine: 10,
      baseColumn: 4,
      baseOffset: 200,
    });
    const outer = firstTag(body);
    const inner = firstTag(outer.body);
    expect(outer.start).toBe(200);
    expect(inner.start).toBe(208);
    expect(at(ast, outer.start)).toEqual({ line: 11, column: 4 });
    expect(at(ast, inner.start)).toEqual({ line: 12, column: 2 });
  });

  it("shifts an attribute and the offset on its value expression", () => {
    const { ast, body } = parseFragment(
      "<div>\n  <a href=input.url>x</a>\n</div>\n",
      {
        baseLine: 2,
        baseColumn: 6,
        baseOffset: 42,
      },
    );
    const anchor = firstTag(firstTag(body).body);
    const attr = anchor.attributes[0];
    expect(attr.type).toBe("MxAttribute");
    expect(attr.name).toBe("href");
    // Raw `{ line: 2, column: 5 }`: line shifts, column does not (line 2).
    expect(at(ast, attr.start)).toEqual({ line: 4, column: 5 });
    // Raw offset of `input.url` is 16; the file's is 16 + 42, on the
    // container and on the Babel payload inside it. Getting 100 would mean
    // the base was applied twice.
    expect(attr.value.start).toBe(58);
    expect(attr.value.node.start).toBe(58);
    expect(attr.value.node.loc.start.index).toBe(58);
  });

  it("shifts the end as well as the start", () => {
    // Both ends of a node's range move, and a node that spans lines has its
    // end on a later line where the base column must *not* apply.
    const { ast, body } = parseFragment("<div>\n  <span>x</span>\n</div>\n", {
      baseLine: 4,
      baseColumn: 3,
      baseOffset: 50,
    });
    const outer = firstTag(body);
    // Raw: [0, 29), start { line: 1, column: 0 }, end { line: 3, column: 6 }.
    expect([outer.start, outer.end]).toEqual([50, 79]);
    expect(at(ast, outer.start)).toEqual({ line: 5, column: 3 });
    expect(at(ast, outer.end)).toEqual({ line: 7, column: 6 });
    const inner = firstTag(outer.body);
    // Raw: start { line: 2, column: 2 }, end { line: 2, column: 16 } — one
    // line, neither end on the fragment's first line, so both columns stand.
    expect(at(ast, inner.start)).toEqual({ line: 6, column: 2 });
    expect(at(ast, inner.end)).toEqual({ line: 6, column: 16 });
  });

  it("shifts a text node's own position", () => {
    const { ast, body } = parseFragment("<p>hello</p>\n", {
      baseLine: 3,
      baseColumn: 2,
    });
    const text = firstTag(body).body.find(
      (node: Node) => node.type === "MxText",
    );
    expect(text.value).toBe("hello");
    // No `baseOffset`: offsets stay fragment-relative, line/column shift.
    expect([text.start, text.end]).toEqual([3, 8]);
    // Raw `{ line: 1, column: 3 }`, on the fragment's first line, so the base
    // column applies: 3 + 2.
    expect(at(ast, text.start)).toEqual({ line: 4, column: 5 });
  });

  it("reports file-relative positions with a zero base unchanged", () => {
    const { ast, body } = parseFragment("<p>x</p>\n");
    const tag = firstTag(body);
    expect([tag.start, tag.end]).toEqual([0, 8]);
    expect(at(ast, tag.start)).toEqual({ line: 1, column: 0 });
  });
});

describe("parseFragment parses an <html-comment> body as text", () => {
  // Stock Marko 6.3.51 renders `<!--x <i&gt;z-->` (measured through
  // packages/stock-marko): the body is parsed-text, markup inside is text.
  // The fragment path registers only the statement slice of core's taglib,
  // so `<html-comment>`'s `parseOptions.text: true` must still reach the
  // parser here, exactly as the whole-file path does.
  it("keeps markup in the body as text", () => {
    const { body } = parseFragment("<html-comment>x <i>z</html-comment>");
    const comment = firstTag(body);
    expect(comment.body).toHaveLength(1);
    expect(comment.body[0].type).toBe("MxText");
    expect((comment.body[0] as { value: string }).value).toBe("x <i>z");
  });

  it("keeps a nested comment and its surrounding whitespace in the raw text", () => {
    // Text mode reads the whole body as one run: stock Marko renders
    // `<!--a <!-- b --&gt; c-->` (measured through packages/stock-marko),
    // so `<!-- b -->` is literal text, not a nested comment node.
    const { body } = parseFragment(
      "<html-comment>a <!-- b --> c</html-comment>",
    );
    const comment = firstTag(body);
    expect(comment.body).toHaveLength(1);
    expect((comment.body[0] as { value: string }).value).toBe("a <!-- b --> c");
  });

  it("reports a missing ending tag like Marko", () => {
    expect(() => parseFragment("<html-comment>x <!-- unterminated")).toThrow(
      /Missing ending "html-comment" tag/,
    );
  });
});

describe("parseFragment's raw-text taglib slice", () => {
  /**
   * `PARSE_OPTIONS_TAGLIB` is the filter over core's taglib that keeps every
   * `parseOptions.text` tag (`<html-comment>`, `<script>`, `<style>`,
   * `<html-script>`, `<html-style>`) and drops the rest. Each entry below
   * pins a choice the filter makes.
   */

  it("has no controlFlow entry, so <if> stays an ordinary element", () => {
    // `controlFlow` (on `<if>`/`<else>`/`<else-if>`/`<for>`) is deliberately
    // left out: it makes the parser treat those tags as non-elements, which
    // changes `@tag` nesting rules a fragment's host does not opt into. With
    // it registered, `<if=x><@a/></if>` throws "@tags must be nested within
    // another element"; without it, today's element shape holds.
    expect(() => parseFragment("<if=x><@a/></if>")).not.toThrow();
    expect(Object.keys(PARSE_OPTIONS_TAGLIB as object)).not.toContain("<if>");
    for (const entry of Object.values(
      PARSE_OPTIONS_TAGLIB as Record<string, { parseOptions?: object }>,
    )) {
      expect(entry.parseOptions ?? {}).not.toHaveProperty("controlFlow");
    }
  });

  it("reads <script>'s body as raw text", () => {
    const { body } = parseFragment("<script>if (a<b) x()</script>");
    const script = firstTag(body);
    expect(script.body).toHaveLength(1);
    expect(script.body[0].type).toBe("MxText");
    expect((script.body[0] as { value: string }).value).toBe("if (a<b) x()");
  });

  it("reads <style>'s body as raw text", () => {
    const { body } = parseFragment("<style>a>b{}</style>");
    const style = firstTag(body);
    expect(style.body).toHaveLength(1);
    expect(style.body[0].type).toBe("MxText");
    expect((style.body[0] as { value: string }).value).toBe("a>b{}");
  });

  it("reads <style>'s attributes as attributes despite rawOpenTag", () => {
    // `<style>` carries `rawOpenTag: true` and `html: false` in core's
    // taglib; the fragment path now inherits both, and attributes still
    // surface as attributes on the tag.
    const { body } = parseFragment("<style media=print>a>b{}</style>");
    const style = firstTag(body) as unknown as {
      attributes: Array<{ name: string }>;
    };
    expect(style.attributes[0]?.name).toBe("media");
  });

  it("reads <html-script>'s body as raw text", () => {
    const { body } = parseFragment("<html-script>if (a<b) x()</html-script>");
    const script = firstTag(body);
    expect(script.body).toHaveLength(1);
    expect(script.body[0].type).toBe("MxText");
    expect((script.body[0] as { value: string }).value).toBe("if (a<b) x()");
  });

  it("reads <html-style>'s body as raw text", () => {
    const { body } = parseFragment("<html-style>a>b{}</html-style>");
    const style = firstTag(body);
    expect(style.body).toHaveLength(1);
    expect(style.body[0].type).toBe("MxText");
    expect((style.body[0] as { value: string }).value).toBe("a>b{}");
  });
});

describe("parseFragment shifts a thrown parse error", () => {
  /**
   * A parse error's position is on the exception object, never in a tree, so
   * the tree walk can never reach it (spike 1, limit 2). It is shifted
   * separately and the same error rethrown.
   */
  it("shifts err.loc for an error on the fragment's first line", () => {
    type Positioned = { loc?: { start?: { line: number; column: number } } };
    let caught: Positioned | null = null;
    try {
      parseFragment("<div>unclosed\n", {
        baseLine: 7,
        baseColumn: 4,
        baseOffset: 90,
      });
    } catch (error) {
      caught = error as Positioned;
    }
    expect(caught).not.toBeNull();
    // Raw `{ line: 1, column: 0 }` for an unclosed `<div>`; on the fragment's
    // first line, so both halves of the base apply.
    expect(caught?.loc?.start).toMatchObject({ line: 8, column: 4 });
  });
});

/** Strips ANSI, so the assertions hold under FORCE_COLOR. */
const plain = (text: string) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte is the point
  text.replace(/\u001b\[[0-9;]*m/g, "");

function caught(run: () => unknown): TranslateError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TranslateError);
    return error as TranslateError;
  }
  throw new Error("expected a TranslateError");
}

describe("parseFragment validates the base numbers (padding contract)", () => {
  it("prints a 1-based padding-contract position but keeps structured columns 0-based", () => {
    const error = caught(() =>
      parseFragment("<p/>", {
        filename: "fragment.mx",
        baseOffset: 7,
        baseLine: 0,
        baseColumn: 6,
      }),
    ) as TranslateError;
    expect(error.message).toBe(
      "parseFragment: broken padding contract in fragment.mx at line 1, column 7: baseOffset must equal baseColumn when baseLine is 0 (the fragment is on the file's first line) (baseOffset: 7, baseLine: 0, baseColumn: 6)",
    );
    expect(error.line).toBe(1);
    expect(error.column).toBe(6);
  });

  it("prints a 1-based position for a negative pre-wrapper offset", () => {
    const error = caught(() =>
      positionRegionSource(
        "<p/>",
        {
          baseOffset: -1,
          baseLine: 0,
          baseColumn: -1,
        },
        { filename: "fragment.mx" },
      ),
    ) as TranslateError;
    expect(error.message).toBe(
      "parseFragment: broken padding contract in fragment.mx at line 1, column 1: baseOffset and baseColumn must be >= 0 before any wrapper is subtracted (baseOffset: -1, baseLine: 0, baseColumn: -1)",
    );
    expect(error.column).toBe(-1);
  });
  for (const [label, run] of [
    ["parseFragment", parseFragment],
    ["parseFragmentNative", parseFragmentNative],
  ] as const) {
    describe(label, () => {
      it("accepts the boundary baseOffset === baseLine + baseColumn", () => {
        // A file of 3 empty lines, then the fragment at column 4: 3 + 4.
        expect(() =>
          run("<p>x</p>\n", { baseOffset: 7, baseLine: 3, baseColumn: 4 }),
        ).not.toThrow();
      });

      it("rejects one below the boundary, naming the rule and the position", () => {
        const error = caught(() =>
          run("<p>x</p>\n", {
            filename: "a.mx",
            baseOffset: 6,
            baseLine: 3,
            baseColumn: 4,
          }),
        );
        const message = plain(error.message);
        expect(message).toContain(
          "baseOffset must be >= baseLine + baseColumn",
        );
        expect(message).toContain("a.mx at line 4, column 5");
        expect(error.line).toBe(4);
        expect(error.column).toBe(4);
        expect(error.file).toBe("a.mx");
      });

      it.each([
        ["baseOffset", { baseOffset: 1.5 }],
        ["baseLine", { baseLine: Number.NaN }],
        ["baseColumn", { baseColumn: Number.POSITIVE_INFINITY }],
      ])("rejects a non-integer %s", (name, base) => {
        const error = caught(() => run("<p>x</p>\n", base));
        expect(plain(error.message)).toContain(
          `${name} must be a finite integer`,
        );
      });

      it("rejects a negative baseLine", () => {
        const error = caught(() => run("<p>x</p>\n", { baseLine: -1 }));
        expect(plain(error.message)).toContain("baseLine must be >= 0");
      });

      it("requires equality on line 0: the reviewer's exact case throws", () => {
        // `<div class=..>` at column 19 of a one-line file: offset must be 19.
        const error = caught(() =>
          run('<div class="a">x</div>', {
            filename: "c.mx",
            baseOffset: 24,
            baseLine: 0,
            baseColumn: 19,
          }),
        );
        const message = plain(error.message);
        expect(message).toContain("baseOffset must equal baseColumn");
        expect(message).toContain("c.mx at line 1, column 20");
      });

      it("line 0 boundaries: equal passes, one above and one below throw", () => {
        const at = (baseOffset: number) => () =>
          run("<p>x</p>", { baseOffset, baseLine: 0, baseColumn: 19 });
        expect(at(19)).not.toThrow();
        expect(at(20)).toThrow(/must equal baseColumn/);
        expect(at(18)).toThrow(/must equal baseColumn/);
      });

      it("line 1 is the first line that allows a larger offset", () => {
        const at = (baseOffset: number) => () =>
          run("<p>x</p>", { baseOffset, baseLine: 1, baseColumn: 19 });
        expect(at(20)).not.toThrow(); // empty first line
        expect(at(57)).not.toThrow(); // a long first line
        expect(at(19)).toThrow(/must be >= baseLine \+ baseColumn/);
      });

      it("rejects a negative baseColumn without its baseOffset partner", () => {
        const error = caught(() => run("<p>x</p>", { baseColumn: -3 }));
        expect(plain(error.message)).toContain(
          "a negative baseColumn needs its baseOffset partner",
        );
      });

      it("skips the offset check when baseOffset is omitted", () => {
        expect(() =>
          run("<p>x</p>\n", { baseLine: 3, baseColumn: 2 }),
        ).not.toThrow();
      });

      it("allows a wrapper-compensated pair: negative baseOffset and baseColumn together", () => {
        // A host that prepends 6 characters to the parsed text subtracts 6 from
        // both, so a fragment at the very start of a file goes negative.
        expect(() =>
          run("<p>x</p>\n", { baseOffset: -4, baseColumn: -4 }),
        ).not.toThrow();
      });
    });
  }

  it("leaves a valid base's positions unchanged", () => {
    // Raw: `href` attr starts at column 3, `input` at index 8, `class` value at
    // index 24. Line +2 and (first line) column +6; every index +42.
    const { ast, body } = parseFragment('<a href=input.url class="c">x</a>\n', {
      baseOffset: 42,
      baseLine: 2,
      baseColumn: 6,
    });
    const tag = firstTag(body);
    expect(tag.start).toBe(42);
    expect(at(ast, tag.start)).toEqual({ line: 3, column: 6 });
    expect(tag.attributes[0].start).toBe(45);
    expect(at(ast, tag.attributes[0].start)).toEqual({ line: 3, column: 9 });
    expect(tag.attributes[0].value.node.object.loc.start).toMatchObject({
      line: 3,
      column: 14,
      index: 50,
    });
    expect(tag.attributes[0].value.node.object.start).toBe(50);
    expect(tag.attributes[1].value.start).toBe(66);
    expect(tag.attributes[1].value.node.loc.start).toMatchObject({ index: 66 });
  });
});

describe("positionRegionSource", () => {
  const PREAMBLE = 'import x from "y";\n\nconst t = ';
  const at = {
    baseOffset: PREAMBLE.length,
    baseLine: 2,
    baseColumn: "const t = ".length,
  };

  /** `offsetOf`'s walk: preceding line lengths plus newlines, then the column. */
  const walk = (text: string, line: number, column: number) => {
    const lines = text.split("\n");
    let offset = 0;
    for (let i = 0; i < line; i++) offset += (lines[i]?.length ?? 0) + 1;
    return offset + column;
  };

  it("pads so the (line, column) walk and the length both land on baseOffset", () => {
    const { padded } = positionRegionSource("<p>x</p>", at);
    expect(padded.length - "<p>x</p>".length).toBe(at.baseOffset);
    expect(walk(padded, at.baseLine, at.baseColumn)).toBe(at.baseOffset);
    expect(padded.split("\n")[at.baseLine]).toBe(
      `${" ".repeat(at.baseColumn)}<p>x</p>`,
    );
  });

  it("returns the base unchanged without a wrapper, and minus it with one", () => {
    expect(positionRegionSource("x", at).base).toEqual(at);
    const wrapped = positionRegionSource("x", at, { wrapper: 6 });
    expect(wrapped.base).toEqual({
      baseOffset: at.baseOffset - 6,
      baseLine: at.baseLine,
      baseColumn: at.baseColumn - 6,
    });
    // `padded` describes the file, so the wrapper never reaches it.
    expect(wrapped.padded).toBe(positionRegionSource("x", at).padded);
  });

  it("the pre-#176 hand-rolled pad walks to the wrong offset; this one does not", () => {
    // Angular's old shape: baseLine newlines, then max(baseOffset - baseLine,
    // baseColumn) spaces on the region's own line.
    const oldPad = `${"\n".repeat(at.baseLine)}${" ".repeat(
      Math.max(at.baseOffset - at.baseLine, at.baseColumn),
    )}<p>x</p>`;
    const oldWalk = walk(oldPad, at.baseLine, at.baseColumn);
    expect(oldWalk).not.toBe(at.baseOffset);
    // Sliced where the old pad says `<p>` starts, the region is not there.
    expect(oldPad.slice(oldWalk, oldWalk + 3)).not.toBe("<p>");

    const { padded } = positionRegionSource("<p>x</p>", at);
    const newWalk = walk(padded, at.baseLine, at.baseColumn);
    expect(padded.slice(newWalk, newWalk + 3)).toBe("<p>");
  });

  it("throws the contract's error instead of clamping a negative filler", () => {
    const error = caught(() =>
      positionRegionSource(
        "x",
        { baseOffset: 3, baseLine: 2, baseColumn: 4 },
        { filename: "b.mx" },
      ),
    );
    expect(plain(error.message)).toContain("b.mx at line 3, column 5");
    expect(plain(error.message)).toContain("baseOffset must be >=");
  });

  it("rejects a negative pre-wrapper position with a positioned error, not a RangeError", () => {
    // Line 0 with offset === column passes the base check; only the
    // non-negativity of a *file* position catches it.
    const error = caught(() =>
      positionRegionSource(
        "x",
        { baseOffset: -4, baseLine: 0, baseColumn: -4 },
        { filename: "d.mx" },
      ),
    );
    expect(plain(error.message)).toContain("d.mx at line 1, column 1");
    expect(plain(error.message)).toContain("must be >= 0");
    // A lone negative column on a later line: the base check cannot see it.
    const lone = caught(() =>
      positionRegionSource("x", {
        baseOffset: 30,
        baseLine: 2,
        baseColumn: -3,
      }),
    );
    expect(plain(lone.message)).toContain("must be >= 0");
  });

  it("pre-#176 pad, end to end through parseFragment: attribute name slices wrong, then right", () => {
    const region = '<div class="a" id="b">x</div>';
    const { ast, body } = parseFragment(region, at);
    const tag = firstTag(body);
    const readNames = (padded: string) =>
      tag.attributes.map((attribute: Node) => {
        // What `sliceLoc`/`offsetOf` do for a line/column-only position:
        // take the file-relative start and read the padded text there.
        const { line, column } = lineColumnAt(ast, attribute.start);
        const text = padded.split("\n")[line - 1] ?? "";
        return text.slice(column, column + attribute.name.length);
      });

    const oldPad = `${"\n".repeat(at.baseLine)}${" ".repeat(
      Math.max(at.baseOffset - at.baseLine, at.baseColumn),
    )}${region}`;
    expect(readNames(oldPad)).not.toEqual(["class", "id"]);

    const { padded } = positionRegionSource(region, at);
    expect(readNames(padded)).toEqual(["class", "id"]);
  });

  it("handles the file's first position (all zeros)", () => {
    const { padded, base } = positionRegionSource("x", {
      baseOffset: 0,
      baseLine: 0,
      baseColumn: 0,
    });
    expect(padded).toBe("x");
    expect(base).toEqual({ baseOffset: 0, baseLine: 0, baseColumn: 0 });
  });

  it("CRLF files only raise baseOffset, so the invariant still holds", () => {
    const prefix = "a\r\nbb\r\n  ";
    const base = { baseOffset: prefix.length, baseLine: 2, baseColumn: 2 };
    expect(base.baseOffset).toBeGreaterThanOrEqual(
      base.baseLine + base.baseColumn,
    );
    expect(() => positionRegionSource("x", base)).not.toThrow();
  });
});
