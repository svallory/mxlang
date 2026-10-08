// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the inputs are MX source with ${…} placeholders
/**
 * The whitespace layer (ast §3.8, §3.12; decision 166 item 2): `MxText.value`
 * per body mode, the runs that produce no node, `raw` and `valueSpan`. One
 * row per shape of brief §1.1.4: every body mode crossed with leading,
 * trailing and inner whitespace, newlines and CRLF, text beside
 * placeholders, comments, scriptlets and tags, at the edges of a body and of
 * the file, concise text lines and `--` blocks, and a preserving tag nested
 * in a normal one and the reverse.
 */
import type { MxDocument, MxText } from "@mxlang/babel/mx-ast";
import { describe, expect, it } from "vitest";
import { parse } from "./parse.ts";
import { OPTIONS } from "./test-support/options.ts";

interface Row {
  readonly source: string;
  readonly values: readonly string[];
}

/** The `value` of every text node in the document, in order. */
function values(source: string): string[] {
  const document: MxDocument = parse(source, OPTIONS);
  const out: string[] = [];
  const walk = (body: readonly unknown[]): void => {
    for (const child of body as { type: string; body?: unknown[] }[]) {
      if (child.type === "MxText") {
        out.push((child as unknown as MxText).value);
      } else if (child.body) walk(child.body);
    }
  };
  walk(document.body);
  return out;
}

/** The first text node, for span assertions. */
function firstText(source: string): MxText {
  const document: MxDocument = parse(source, OPTIONS);
  const stack: unknown[] = [...document.body];
  while (stack.length > 0) {
    const node = stack.shift() as {
      type: string;
      body?: unknown[];
      value?: string;
    };
    if (node.type === "MxText") return node as unknown as MxText;
    if (node.body) stack.unshift(...node.body);
  }
  throw new Error(`no text node in ${JSON.stringify(source)}`);
}

describe("the html body mode normalizes", () => {
  const rows: Row[] = [
    { source: "<p>  a\n  b</p>", values: [" a b"] },
    { source: "<p>\n  a</p>", values: ["a"] },
    { source: "<p>a\n</p>", values: ["a"] },
    { source: "<p>a  b</p>", values: ["a b"] },
    { source: "<p>a\tb</p>", values: ["a b"] },
    { source: "<p>a \r\n b</p>", values: ["a b"] },
    { source: "-- text", values: ["text"] },
    { source: "-- text\n", values: ["text"] },
    { source: "-- text  ", values: ["text "] },
    { source: "--   text", values: [" text"] },
  ];
  for (const { source, values: expected } of rows) {
    it(`${JSON.stringify(source)} gives ${JSON.stringify(expected)}`, () => {
      expect(values(source)).toEqual(expected);
    });
  }

  it("inner whitespace collapses to one space, valueSpan covers the uncollapsed trim", () => {
    const text = firstText("<p>  a\n  b</p>");
    expect(text.valueSpan).toEqual({ start: 3, end: 10 });
    expect(text.raw).toBe("  a\n  b");
  });

  it("valueSpan is the trimmed range: a newline-led lead is outside it", () => {
    const text = firstText("<p>\n  a</p>");
    expect(text.start).toBe(3);
    expect(text.end).toBe(7);
    expect(text.valueSpan).toEqual({ start: 6, end: 7 });
  });

  it("a whole-line run between tags produces no node", () => {
    expect(values("<p>a</p>\n<p>b</p>")).toEqual(["a", "b"]);
  });

  it("a pure space run without a newline is kept, collapsed", () => {
    expect(values("<p>a</p>  <p>b</p>")).toEqual(["a", " ", "b"]);
  });

  it("text at the very start and end of a file", () => {
    expect(values("-- a<div/>")).toEqual(["a"]);
    expect(values("-- a\n<div/>\n-- b")).toEqual(["a", "b"]);
  });
});

describe("the neighbours of a run", () => {
  it("beside a placeholder the run keeps its edges", () => {
    expect(values("<p>a ${x} b</p>")).toEqual(["a ", " b"]);
    expect(values("<p>a${x}b</p>")).toEqual(["a", "b"]);
    expect(values("<p>${x}  ${y}</p>")).toEqual([" "]);
  });

  it("a run before a placeholder keeps trailing whitespace; after keeps leading", () => {
    expect(values("<p>a \n${x}</p>")).toEqual(["a "]);
    expect(values("<p>${x}\n b</p>")).toEqual([" b"]);
  });

  it("beside a comment or scriptlet the run keeps its edges", () => {
    expect(values("<p>a <!-- c --> b</p>")).toEqual(["a ", "b"]);
    expect(values("-- a\n$ x;\n-- b")).toEqual(["a", "b"]);
    expect(values("-- a\n<!-- c -->\n-- b")).toEqual(["a", "b"]);
  });

  it("beside an ordinary tag a newline becomes a space; before an attribute tag it is dropped", () => {
    expect(values("<p>a</p>\n<p>b</p>")).toEqual(["a", "b"]);
    expect(values("<div>a\n  <p>b</p></div>")).toEqual(["a ", "b"]);
    expect(values("<div>a\n<@x/></div>")).toEqual(["a"]);
  });

  it("after a statement tag a newline-led run loses the break", () => {
    expect(values("static const a = 1\n-- b")).toEqual(["b"]);
  });

  it("consecutive text runs: a run with a break before a placeholder keeps it; plain runs are one run", () => {
    expect(values("<p>a ${x}\nb</p>")).toEqual(["a ", " b"]);
    expect(values("<p>a \nb</p>")).toEqual(["a b"]);
  });
});

describe("preserving body modes", () => {
  const rows: Row[] = [
    { source: "<pre>  a\n  b</pre>", values: ["  a\n  b"] },
    { source: "<script>  a\n  b</script>", values: ["  a\n  b"] },
    { source: "<pre>\n  a</pre>", values: ["\n  a"] },
    { source: "<pre>a\n</pre>", values: ["a\n"] },
    { source: "<pre> </pre>", values: [" "] },
  ];
  for (const { source, values: expected } of rows) {
    it(`${JSON.stringify(source)} keeps the authored text`, () => {
      expect(values(source)).toEqual(expected);
    });
  }

  it("valueSpan equals the node span in a preserving body", () => {
    const text = firstText("<pre>  a\n  b</pre>");
    expect(text.valueSpan).toEqual({ start: text.start, end: text.end });
    expect(text.value).toBe(text.raw);
  });

  it("a preserving tag nested in a normal one preserves; the runs around it normalize", () => {
    expect(values("<div>a\n<pre> b\n c </pre>\nd</div>")).toEqual([
      "a ",
      " b\n c ",
      " d",
    ]);
  });

  it("a normal tag nested in a preserving one: every descendant run preserves", () => {
    expect(values("<pre> a <div> b </div> c </pre>")).toEqual([
      " a ",
      " b ",
      " c ",
    ]);
  });
});

describe("concise mode", () => {
  it("concise `--` text lines and blocks normalize like html", () => {
    expect(values("p\n  -- a\n  -- b")).toEqual(["a", "b"]);
    expect(values("-- a  b")).toEqual(["a b"]);
    expect(values("p\n  --  a \n  -- b")).toEqual([" a ", "b"]);
  });
});

describe("the drop rule", () => {
  const dropped = [
    "<p>a</p>\n\n<p>b</p>",
    "<div>\n  <p>a</p>\n</div>",
    "<p>a</p>\r\n<p>b</p>",
    "a\n\n\nb",
  ];
  for (const source of dropped) {
    it(`${JSON.stringify(source)} keeps no whitespace-only run`, () => {
      expect(values(source).every((value) => value.trim() !== "")).toBe(true);
    });
  }

  it("raw is never empty on a kept node; valueSpan lies inside the span", () => {
    const document = parse("<p>a  b</p>\n<p> c </p>", OPTIONS);
    const stack: unknown[] = [...document.body];
    while (stack.length > 0) {
      const node = stack.shift() as {
        type: string;
        body?: unknown[];
        raw?: string;
        start?: number;
        end?: number;
        valueSpan?: { start: number; end: number };
      };
      if (node.type === "MxText") {
        expect(node.raw).not.toBe("");
        expect(node.valueSpan?.start).toBeGreaterThanOrEqual(node.start!);
        expect(node.valueSpan?.end).toBeLessThanOrEqual(node.end!);
      }
      if (node.body) stack.push(...node.body);
    }
  });
});
