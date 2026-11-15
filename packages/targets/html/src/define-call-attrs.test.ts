// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * On html, a `<define>` called with attributes and no tag arguments passes
 * ONE attribute object to the first param (Marko 6.4.4). The rendered
 * shapes are locked by the oracle fixture
 * `fixtures-marko/define-call-attrs`; this file locks the emitted call and
 * the warning for a define with several params.
 */
import { describe, expect, it } from "vitest";
import { mx } from "./helpers.ts";
import { compile } from "./index.ts";

const emit = (source: string) => compile(source, "/fixtures/row.mx").code;

describe("html: a <define> call passes its attributes as the first param", () => {
  it("emits the attribute object, never per-param lookups", () => {
    const code = emit(
      "<define/Row|p|><li>${p.n}</li></define>\n<ul><Row n=1/></ul>",
    );
    expect(code).toContain("Row({ n: 1 })");
    expect(code).not.toContain("Row(undefined");
  });

  it("keeps spread order and accepts a spread", () => {
    const code = emit(
      "<define/Row|p|><li>${p.x}</li></define>\n<ul><Row x=0 ...{ a: 1 } y=2/></ul>",
    );
    expect(code).toMatch(/Row\(\{ "?x"?: 0, \.\.\.\{ a: 1 \}, "?y"?: 2 \}\)/);
  });

  it("passes {} for a bare call and nothing to a define without params", () => {
    expect(
      emit("<define/Row|p|><li>${typeof p}</li></define>\n<ul><Row/></ul>"),
    ).toMatch(/Row\(\{ +\}\)/);
    expect(
      emit("<define/Row><li>x</li></define>\n<ul><Row n=1/></ul>"),
    ).toContain("Row()");
  });

  it("still rejects a spread next to tag arguments", () => {
    expect(() =>
      emit("<define/Row|a|><li>${a}</li></define>\n<Row(1) ...{ b: 2 }/>"),
    ).toThrow();
  });

  describe("the multi-param warning", () => {
    const def = "<define/Card|title, head|><div>${title}</div></define>\n";
    const run = (source: string) => {
      const warnings: Array<{ message: string; line: number; column: number }> =
        [];
      compile(source, "/fixtures/test.mx", { warnings });
      return warnings;
    };

    it("fires on html", () => {
      expect(run(`${def}<Card title="a"/>`)).toMatchObject([
        { line: 2, column: 1 },
      ]);
    });

    it("stays silent for the single-object form", () => {
      expect(
        run(
          '<define/Card|{ title, head }|><div>${title}</div></define>\n<Card title="a"/>',
        ),
      ).toEqual([]);
    });
  });
});

describe("html: a <define> that declares <return>", () => {
  // The escape helper is a bare import, so the renderer needs a file to
  // resolve it from; nothing is written there.
  const filename = new URL("../define-return.mx", import.meta.url).pathname;
  const render = (source: string) => mx(source, { filename })({});

  // Expected HTML is stock Marko 6.4.4's render, its resume comments removed.
  it.each([
    [
      "binds the returned value to the call's /var",
      "<define/Thing|input|>\n  <return=input.n * 2/>\n  <i>${input.n}</i>\n</define>\n<Thing/double n=21/>\n<p>${double}</p>\n",
      "<i>21</i><p>42</p>",
    ],
    [
      "renders only the output for a call without /var",
      "<define/T|{n}|><return=n/><b>${n}</b></define><T n=1/>",
      "<b>1</b>",
    ],
    [
      "binds a /var per <for> row",
      "<define/T|{n}|><return=n * 10/></define><for|i| of=[1, 2]><T/v n=i/>${v}</for>",
      "1020",
    ],
  ])("%s", (_what, source, html) => {
    expect(render(source)).toBe(html);
  });
});
