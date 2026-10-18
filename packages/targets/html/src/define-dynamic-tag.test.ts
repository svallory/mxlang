// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * `<${D}/>` of a `<define>` renders the define: the html target's value is the
 * function a call runs, so the dynamic tag hands `D` itself to the renderer.
 * The Solid and Angular hosts lower the same source differently (the define is
 * hoisted, or a template reference); this pins the html output byte for byte.
 * The rendered shapes are locked by the oracle fixtures
 * `fixtures-marko/define-dynamic-tag` and `define-dynamic-tag-conditional`.
 */
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

const emit = (source: string) => compile(source, "/fixtures/page.mx").code;

const FN = `const D = () => {
    const __mxOut = __mxCreateOut();
    __mxOut.write("<i>b</i>");
    return __mxOut.toString();
  };`;

describe("html: a dynamic tag reads a <define>", () => {
  it("passes the define to the renderer as written", () => {
    const code = emit("<define/D><i>b</i></define>\n<${D}/>");
    expect(code).toContain(FN);
    expect(code).toContain("__mxRenderDynamic(__mxOut, D, {  });");
  });

  it("with a body, the same call carries the body as content", () => {
    const code = emit("<define/D><i>b</i></define>\n<${D}>x</>");
    expect(code).toContain("__mxRenderDynamic(__mxOut, D, { content: () => {");
  });

  it("a conditional target keeps the define in its branch", () => {
    const code = emit(
      '<define/D><i>b</i></define>\n<${input.c ? D : "span"}/>',
    );
    expect(code).toContain(
      '__mxRenderDynamic(__mxOut, input.c ? D : "span", {  });',
    );
  });
});
