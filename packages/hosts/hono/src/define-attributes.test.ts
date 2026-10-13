// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * A `<define>` tag's attributes are properties of its value, as in Marko
 * 6.4.4 (`<define/D a=1/>` is `const D = { a: 1 }`, and `${D.a}` reads `1`).
 * The Hono host shares the Preact emitter; the rendered shapes are locked by
 * the oracle fixture `html/fixtures-marko/define-attributes`.
 */
import { describe, expect, it } from "vitest";
import { compileHonoMx } from "./index.ts";

const emit = (source: string) => compileHonoMx(source, "/f/page.mx").code;

describe("hono: a <define> carries its attributes as properties", () => {
  it("emits them as own properties of the define's function", () => {
    expect(
      emit('<define/D a=1 b="s"><p>x</p></define>\n<p>${D.a}${D.b}</p>'),
    ).toContain(
      'const D = Object.assign(() => (<><p>x</p></>), { "a": 1, "b": "s" });',
    );
  });

  it("makes name and length writable first when they could be set", () => {
    expect(emit('<define/D name="n"/>\n<p>${D.name}</p>')).toContain(
      'Object.assign(Object.defineProperties(() => (<></>), { name: { writable: true }, length: { writable: true } }), { "name": "n" });',
    );
  });
});
