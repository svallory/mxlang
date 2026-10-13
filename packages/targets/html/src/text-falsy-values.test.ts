// biome-ignore-all lint/suspicious/noTemplateCurlyInString: every template here is Marko source with `${…}` placeholders
import { describe, expect, it } from "vitest";
import { compile, mx } from "./index.ts";

/**
 * Text position by real render. Expectations are Marko 6.4.4's html runtime
 * (`_escape` / `_unescaped` / `_to_text`): a truthy value prints as its string,
 * `0` and `-0` print `0`, and every other falsy value prints nothing.
 * `fixtures-marko/text-falsy-values` is the live-Marko lock for the same rule.
 *
 * Attribute values follow a different Marko rule (`_attr` drops `false` and
 * `null`, prints `NaN` and `0n`); the last block pins that this fix left them
 * alone.
 */

const render = (source: string, input: Record<string, unknown> = {}) =>
  String(mx(source)(input));

/** [name, value, text] — what `[${value}]` renders. */
const cases: Array<[string, unknown, string]> = [
  ["false", false, ""],
  ["NaN", Number.NaN, ""],
  ["0n", 0n, ""],
  ["empty string", "", ""],
  ["null", null, ""],
  ["undefined", undefined, ""],
  ["0", 0, "0"],
  ["-0", -0, "0"],
  ["1n", 1n, "1"],
  ["1", 1, "1"],
  ["-1", -1, "-1"],
  ["true", true, "true"],
  ["a string", "text", "text"],
  ["an array", [1, 2], "1,2"],
  ["Infinity", Number.POSITIVE_INFINITY, "Infinity"],
];

const wrap = (placeholder: string) => `<p>[${placeholder}]</p>`;

describe("escaped placeholders in text position (rendered)", () => {
  it.each(cases)("%s in an element", (_name, value, text) => {
    expect(render(wrap("${input.v}"), { v: value })).toBe(`<p>[${text}]</p>`);
  });

  it.each(cases)("%s in an <if> body", (_name, value, text) => {
    expect(render("<if=true><b>[${input.v}]</b></if>", { v: value })).toBe(
      `<b>[${text}]</b>`,
    );
  });

  it.each(cases)("%s in a <for> body", (_name, value, text) => {
    expect(
      render("<for|v| of=input.items><i>[${v}]</i></for>", {
        items: [value, value],
      }),
    ).toBe(`<i>[${text}]</i><i>[${text}]</i>`);
  });

  it.each(cases)("%s at the top level", (_name, value, text) => {
    expect(render("-- [${input.v}]", { v: value })).toBe(`[${text}]`);
  });

  it.each(cases)("%s in <html-script>", (_name, value, text) => {
    expect(
      render("<html-script>[${input.v}]</html-script>", { v: value }),
    ).toBe(`<script>[${text}]</script>`);
  });

  it("still escapes markup characters", () => {
    expect(render("<p>${input.v}</p>", { v: `<&>"'` })).toBe(
      "<p>&lt;&amp;&gt;&quot;&#39;</p>",
    );
  });

  it("escapes the string form of a number or bigint it prints", () => {
    expect(render("<p>${input.v}</p>", { v: { toString: () => "<b>" } })).toBe(
      "<p>&lt;b&gt;</p>",
    );
  });

  it("prints a falsy value once it is a sibling of text", () => {
    expect(
      render("<p>a${input.f}b${input.z}c${input.n}d</p>", {
        f: false,
        z: 0,
        n: Number.NaN,
      }),
    ).toBe("<p>ab0cd</p>");
  });

  it("renders values the template computes, not only input", () => {
    expect(
      render(
        "<const/nan=(input.z / input.z)/><const/big=BigInt(input.z)/><p>[${nan}][${big}]</p>",
        { z: 0 },
      ),
    ).toBe("<p>[][]</p>");
  });
});

describe("static placeholders in text position (rendered)", () => {
  it("prints nothing for false, NaN, 0n, null and undefined literals", () => {
    expect(
      render("<p>[${false}][${NaN}][${0n}][${null}][${undefined}][${''}]</p>"),
    ).toBe("<p>[][][][][][]</p>");
  });

  it("prints 0, 1n and true literals", () => {
    expect(render("<p>[${0}][${-0}][${1n}][${true}]</p>")).toBe(
      "<p>[0][0][1][true]</p>",
    );
  });
});

describe("unescaped placeholders in text position (rendered)", () => {
  it.each(cases)("%s", (_name, value, text) => {
    expect(render("<p>[$!{input.v}]</p>", { v: value })).toBe(
      `<p>[${text}]</p>`,
    );
  });

  it("does not escape what it prints", () => {
    expect(render("<p>$!{input.v}</p>", { v: "<b>&" })).toBe("<p><b>&</p>");
  });

  it("prints nothing for null and undefined, not their names", () => {
    expect(render("<p>[$!{input.n}][$!{input.u}]</p>", { n: null })).toBe(
      "<p>[][]</p>",
    );
  });
});

describe("attribute values keep their own rule (rendered)", () => {
  const attr = (value: unknown) =>
    render("<div data-x=input.v></div>", { v: value });

  it.each([
    ["false", false, "<div></div>"],
    ["null", null, "<div></div>"],
    ["undefined", undefined, "<div></div>"],
    ["NaN", Number.NaN, '<div data-x="NaN"></div>'],
    ["0n", 0n, '<div data-x="0"></div>'],
    ["0", 0, '<div data-x="0"></div>'],
    ["-0", -0, '<div data-x="0"></div>'],
    ["1n", 1n, '<div data-x="1"></div>'],
    ["empty string", "", '<div data-x=""></div>'],
    ["true", true, "<div data-x></div>"],
    ["a string", `a"<&`, '<div data-x="a&quot;&lt;&amp;"></div>'],
  ])("%s", (_name, value, html) => {
    expect(attr(value)).toBe(html);
  });

  it("keeps static attribute values, including false and NaN literals", () => {
    expect(render('<div title="false" data-n="NaN"></div>')).toBe(
      '<div title="false" data-n="NaN"></div>',
    );
  });
});

describe("emitted code", () => {
  const emit = (source: string) => compile(source, "Probe.mx").code;

  it("routes text placeholders through the text helper, escaped or not", () => {
    const code = emit("<p>${input.a}$!{input.b}</p>");
    expect(code).toContain("__mxOut.write(__mxEscape(__mxTextOf(input.a)));");
    expect(code).toContain("__mxOut.write(__mxTextOf(input.b));");
    expect(code).toContain("function __mxTextOf(");
  });

  it("leaves attribute values on the attribute helper", () => {
    const code = emit("<div data-x=input.v title='static'></div>");
    expect(code).toContain("__mxRenderAttr(");
    expect(code).not.toContain("__mxTextOf");
  });

  it("inlines the text helper only into templates that print a placeholder", () => {
    expect(emit("<p>static</p>")).not.toContain("__mxTextOf");
  });
});
