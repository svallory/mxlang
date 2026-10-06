// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * Decision 160 on html: a `<define>` called with attributes and no tag
 * arguments passes ONE attribute object to the first param (Marko 6.3.51).
 * The rendered shapes are locked by the oracle fixture
 * `fixtures-marko/define-call-attrs`; this file locks the emitted call and
 * the warning for a define with several params.
 */
import { describe, expect, it } from "vitest";
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
