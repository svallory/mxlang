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

  it("an input keeps authored order with a spread, and Marko's value last for `<input zz ...x value>`", () => {
    // Marko: `<input zz=1 id=i value=a>`; nothing is hoisted ahead of the spread.
    expect(
      render('<input zz="1" ...input.x value="a"/>', { x: { id: "i" } }).names,
    ).toEqual(["zz", "id", "value"]);
    expect(
      render('<input ...input.x value="a"/>', { x: { id: "i" } }).names,
    ).toEqual(["id", "value"]);
    // The later explicit value beats the spread's, whichever side.
    expect(
      render('<input type="text" ...input.x value="a"/>', {
        x: { value: "x" },
      }).kept.value,
    ).toBe("a");
    expect(
      render('<input type="text" value="a" ...input.x/>', {
        x: { value: "x" },
      }).kept.value,
    ).toBe("x");
  });

  it("an input without a spread still writes value first", () => {
    expect(render('<input type="text" value="a" id="i"/>', {}).names).toEqual([
      "value",
      "type",
      "id",
    ]);
  });

  it("ignores a null or undefined spread, leading or not", () => {
    expect(render("<div ...input.x>hi</div>", { x: null }).names).toEqual([]);
    expect(render("<div ...input.x>hi</div>", {}).names).toEqual([]);
    expect(render("<div a=1 ...input.x>hi</div>", { x: null }).kept).toEqual({
      a: "1",
    });
    expect(render('<div ...input.x id="p">hi</div>', { x: null }).kept).toEqual(
      {
        id: "p",
      },
    );
  });

  it("a key keeps its earlier slot when a later spread overwrites it, like an object merge", () => {
    // Marko: `<div id=x-id a=from-x>`.
    const out = render('<div id="q" a=1 ...input.x>hi</div>', {
      x: { a: "from-x", id: "x-id" },
    });
    expect(out.names).toEqual(["id", "a"]);
    expect(out.kept).toEqual({ id: "x-id", a: "from-x" });
  });
});

describe("a spread's own __proto__ key (html, rendered)", () => {
  const withProto = (value: unknown) =>
    Object.defineProperty({}, "__proto__", { value, enumerable: true });

  it("keeps an own enumerable __proto__ key as an attribute, like Marko's object merge", () => {
    expect(
      render("<div a=1 ...input.x>hi</div>", { x: withProto("pv") }).kept,
    ).toEqual({ a: "1", __proto__: "pv" });
    // The lone-spread path agrees.
    expect(
      render("<div ...input.x>hi</div>", { x: withProto("pv") }).names,
    ).toEqual(["__proto__"]);
    // And a spread after other attributes with a later explicit one.
    expect(
      render('<div a=1 ...input.x id="p">hi</div>', { x: withProto("pv") })
        .names,
    ).toEqual(["id", "a", "__proto__"]);
  });

  it("an object-valued __proto__ from JSON.parse does not become the merge object's prototype", () => {
    const x = JSON.parse('{"__proto__": {"polluted": "yes"}, "b": "2"}');
    const out = render("<div a=1 ...input.x>hi</div>", { x });
    expect(out.kept.b).toBe("2");
    expect(out.kept.polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // Marko's merge keeps the key as data, so it is an attribute here too.
    expect(out.names).toContain("__proto__");
  });

  it("an explicit attribute named __proto__ is dropped on a tag with a spread, as before", () => {
    const out = render('<div __proto__="1" a=2 ...input.x>hi</div>', {
      x: { k: "v" },
    });
    expect(out.names).toEqual(["a", "k"]);
  });
});

/**
 * Evaluation order, which Marko decides: the attributes after the last spread
 * are evaluated first, then everything before it in authored order.
 */
function order(source: string): string[] {
  const log: string[] = [];
  const f = (n: string) => {
    log.push(n);
    return n;
  };
  const o = (n: string) => {
    log.push(`spread:${n}`);
    return { [`k${n}`]: n };
  };
  mx(source)({ f, o });
  return log;
}

describe("evaluation order of attributes and spreads (html)", () => {
  it("evaluates the attributes after the last spread first", () => {
    expect(
      order(
        '<div a=input.f("a") ...input.o("x") b=input.f("b") c=input.f("c")>x</div>',
      ),
    ).toEqual(["b", "c", "a", "spread:x"]);
  });

  it("with two spreads: the tail, then authored order", () => {
    expect(
      order(
        '<div a=input.f("a") ...input.o("x") b=input.f("b") ...input.o("y") c=input.f("c")>x</div>',
      ),
    ).toEqual(["c", "a", "spread:x", "b", "spread:y"]);
  });

  it("a leading spread evaluates after the attributes that follow it", () => {
    expect(
      order('<div ...input.o("x") a=input.f("a") b=input.f("b")>x</div>'),
    ).toEqual(["a", "b", "spread:x"]);
  });

  it("an attribute before a spread runs before it, so the spread sees the mutation", () => {
    // Marko: `<div title=t k=k2>`.
    const box = { k: "k1" };
    const setk = () => {
      box.k = "k2";
      return "t";
    };
    const html = mx("<div title=input.setk() ...input.box>hi</div>")({
      setk,
      box,
    });
    expect(browserAttrs(html).kept).toEqual({ title: "t", k: "k2" });
  });
});
