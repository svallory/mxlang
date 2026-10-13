// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * A `<define>` is in scope only inside the body that declares it (Marko
 * 6.4.4 declares it `const` inside that branch, loop or tag body). A `<Foo/>`
 * after the block calls the import of the same name, or is an unresolved tag
 * when there is none; it never calls the define. The html emitter writes the
 * define as a `const` inside the same block, so the call after it has to be
 * the import's dynamic render.
 */
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

const IMPORT = 'import Foo from "./foo.js"\n';
const FOO = "<define/Foo><p>inner</p></define>";
const emit = (source: string) => compile(source, "/fixtures/page.mx").code;

describe("html: a <define> is scoped to the body that declares it", () => {
  const BLOCKS: Array<[string, string]> = [
    ["<if>", `<if=input.a>${FOO}</if>`],
    ["<else>", `<if=input.a><p>a</p></if><else>${FOO}</else>`],
    ["<for>", `<for|i| of=[1]>${FOO}</for>`],
    ["a native element", `<div>${FOO}</div>`],
    ["<try>", `<try>${FOO}<@catch|e|>x</@catch></try>`],
  ];

  for (const [label, block] of BLOCKS) {
    it(`${label}: the <Foo/> after it renders the import`, () => {
      const code = emit(`${IMPORT}${block}\n<Foo/>\n`);
      expect(code).toContain("__mxRenderDynamic(__mxOut, Foo, {");
      expect(code).not.toContain("__mxOut.write(Foo())");
    });

    it(`${label}: with no import the <Foo/> after it is an unresolved tag`, () => {
      expect(() => emit(`${block}\n<Foo/>\n`)).toThrow(
        "Unable to find entry point for custom tag `<Foo>`.",
      );
    });
  }

  it("a call inside the block still calls the define, and the one after the import", () => {
    const code = emit(`${IMPORT}<if=input.a>${FOO}<Foo/></if>\n<Foo/>\n`);
    expect(code).toContain("__mxOut.write(Foo())");
    expect(code).toContain("__mxRenderDynamic(__mxOut, Foo, {");
    expect(code.indexOf("__mxOut.write(Foo())")).toBeLessThan(
      code.indexOf("__mxRenderDynamic(__mxOut, Foo, {"),
    );
  });

  it("a top-level define is called from every later block", () => {
    const code = emit(`${FOO}\n<if=input.a><Foo/></if>\n<div><Foo/></div>\n`);
    expect(code.match(/__mxOut\.write\(Foo\(\)\)/g)).toHaveLength(2);
  });
});
