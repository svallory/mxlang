import { describe, expect, it } from "vitest";
import { compile, mx } from "./index.ts";

/**
 * A duplicate attribute (`<div class="a" class="b">`) resolves last-wins in
 * core, like stock Marko 6.3.51 (decision 135): the earlier occurrence is
 * dropped from the output and gets a positioned warning naming the survivor.
 * Never an error. The structured position is core's 0-based column; the
 * message text is 1-based.
 */
interface Warning {
  message: string;
  line: number;
  column: number;
  file?: string;
}

function run(source: string) {
  const warnings: Warning[] = [];
  const result = compile(source, "/fixtures/test.mx", { warnings });
  return { code: result.code, warnings };
}

/** `line`/`column` locate the SURVIVOR (column 0-based, like the warning). */
const MESSAGE = (name: string, line: number, column: number) =>
  `duplicate attribute \`${name}\`: the later one at ${line}:${column + 1} wins, so this one is dropped`;

describe("duplicate attributes (html)", () => {
  it("warns once at the dropped occurrence, naming the survivor", () => {
    const { code, warnings } = run('<div class="a" class="b">hi</div>');
    expect(warnings).toEqual([
      {
        message: MESSAGE("class", 1, 15),
        line: 1,
        column: 5,
        file: "/fixtures/test.mx",
      },
    ]);
    // Only the survivor is emitted.
    expect(code).toContain('class=\\"b\\"');
    expect(code).not.toContain('class=\\"a\\"');
  });

  it("warns per repeated name, on the right lines", () => {
    const { warnings } = run(
      '<div id="a"\n  id="b" title="t" title="u">hi</div>',
    );
    expect(warnings.map((w) => [w.message, w.line, w.column])).toEqual([
      [MESSAGE("id", 2, 2), 1, 5],
      [MESSAGE("title", 2, 19), 2, 9],
    ]);
  });

  it("counts columns in UTF-16 code units after non-ASCII text", () => {
    // `é` is one unit, the emoji two: the surviving `title` is at column 15.
    const { warnings } = run('<p title="é😀" title="b"/>');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      message: MESSAGE("title", 1, 15),
      line: 1,
      column: 3,
    });
  });

  it("a third occurrence: each dropped one warns, naming the last", () => {
    const { warnings } = run('<div class="a" class="b" class="c"/>');
    expect(warnings.map((w) => [w.message, w.column])).toEqual([
      [MESSAGE("class", 1, 25), 5],
      [MESSAGE("class", 1, 25), 15],
    ]);
  });

  it("stays silent for distinct names, other tags and case differences", () => {
    expect(run('<div class="a" id="b">x</div>').warnings).toEqual([]);
    expect(
      run('<div class="a"><span class="b">x</span></div>').warnings,
    ).toEqual([]);
    // Names compare case-sensitively, as Marko's do.
    expect(run('<div data-a="1" data-A="2">x</div>').warnings).toEqual([]);
  });

  it("stays silent for a spread next to an explicit attribute", () => {
    expect(run('<div class="a" ...input.rest>x</div>').warnings).toEqual([]);
  });

  it("keeps the survivor at its own position, as Marko does", () => {
    // Marko: `<div class="a" id="x" class="b">` -> `<div id=x class=b>`.
    const { code, warnings } = run('<div class="a" id="x" class="b">hi</div>');
    expect(code).toContain('id=\\"x\\" class=\\"b\\"');
    expect(code).not.toContain('class=\\"a\\"');
    expect(warnings).toHaveLength(1);
  });

  it("drops the earlier one even with a spread between them", () => {
    // `a=2` already won over the spread's `a`; the dead `a=1` is dropped.
    const { code, warnings } = run('<div a="1" ...input.rest a="2">x</div>');
    expect(code).toContain(String.raw`a=\"2\"`);
    expect(code).not.toContain(String.raw`a=\"1\"`);
    expect(warnings.map((w) => [w.message, w.line, w.column])).toEqual([
      [MESSAGE("a", 1, 25), 1, 5],
    ]);
  });

  it("does not warn or drop for a lone attribute before a spread", () => {
    const { code, warnings } = run('<div a="1" ...input.rest>x</div>');
    expect(warnings).toEqual([]);
    expect(code).toContain(String.raw`a=\"1\"`);
  });
});

/**
 * The html target concatenates into one string and a browser keeps the FIRST
 * duplicate attribute, so these RENDER the module and read the attributes the
 * way a browser does. Marko compiles the same templates to an object merge
 * (`{a: 1, ...x, a: 2}`), where the later write wins.
 */
function browserAttrs(html: string): {
  names: string[];
  kept: Record<string, string>;
} {
  const tag = /^<[a-z]+((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*>/.exec(html);
  if (!tag) throw new Error(`no open tag in ${html}`);
  const names: string[] = [];
  const kept: Record<string, string> = {};
  for (const m of (tag[1] ?? "").matchAll(/([^\s=>]+)(?:="([^"]*)")?/g)) {
    const name = m[1] as string;
    names.push(name);
    if (!(name in kept)) kept[name] = m[2] ?? "";
  }
  return { names, kept };
}

function render(source: string, input: Record<string, unknown>) {
  return browserAttrs(mx(source)(input));
}

describe("duplicate attributes next to a spread (html, rendered)", () => {
  it("a later explicit attribute beats the spread's value, which is not emitted", () => {
    const out = render("<div a=1 ...input.x a=2>hi</div>", {
      x: { a: "from-x", id: "x-id" },
    });
    expect(out.kept).toEqual({ id: "x-id", a: "2" });
    expect(out.names.filter((n) => n === "a")).toHaveLength(1);
  });

  it("the last explicit attribute beats every spread", () => {
    const out = render("<div ...input.x a=1 ...input.y a=2>hi</div>", {
      x: { a: "x", b: "bx" },
      y: { a: "y", b: "by", c: "cy" },
    });
    expect(out.kept).toEqual({ b: "by", c: "cy", a: "2" });
    expect(out.names).toHaveLength(3);
  });

  it("a spread after an explicit attribute wins, so the explicit one is not emitted", () => {
    const out = render("<div a=1 ...input.x>hi</div>", { x: { a: "from-x" } });
    expect(out.kept).toEqual({ a: "from-x" });
    expect(out.names).toHaveLength(1);
  });

  it("an explicit attribute survives when the spread lacks its key", () => {
    expect(
      render("<div a=1 ...input.x>hi</div>", { x: { b: "2" } }).kept,
    ).toEqual({
      a: "1",
      b: "2",
    });
  });

  it("a spread key explicitly undefined still removes the earlier attribute, like an object merge", () => {
    const out = render("<div a=1 ...input.x>hi</div>", { x: { a: undefined } });
    expect(out.names).toEqual([]);
  });

  it("class and style come from the spread when it follows, from the explicit attribute when it does not", () => {
    const x = { class: "from-x", style: "color:red" };
    expect(
      render('<div class="a" style="b:1" ...input.x>hi</div>', { x }).kept,
    ).toEqual(x);
    expect(
      render('<div ...input.x class="a" style="b:1">hi</div>', { x }).kept,
    ).toEqual({
      class: "a",
      style: "b:1",
    });
  });

  it("two spreads sharing a key emit it once, the later one's", () => {
    const out = render("<div ...input.x ...input.y>hi</div>", {
      x: { k: "x" },
      y: { k: "y" },
    });
    expect(out.kept).toEqual({ k: "y" });
    expect(out.names).toHaveLength(1);
  });

  it("an input writes value first, yet a later spread still decides it", () => {
    // `value` hoists ahead of `type` for the browser; the spread was written
    // after it, so the spread's `value` wins and the explicit one is dropped.
    const out = render('<input type="text" value="a" ...input.x/>', {
      x: { value: "from-x" },
    });
    expect(out.names).toEqual(["type", "value"]);
    expect(out.kept.value).toBe("from-x");
    // Without a competing spread key the hoist still happens.
    expect(
      render('<input type="text" value="a" ...input.x/>', { x: { id: "i" } })
        .names,
    ).toEqual(["value", "type", "id"]);
    expect(
      render('<input type="text" ...input.x value="a"/>', { x: { value: "x" } })
        .kept.value,
    ).toBe("a");
  });
});
