// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * A `<define>` tag's attributes are properties of its value, as in Marko
 * 6.4.4 (`<define/D a=1 b="s"/>` is `const D = { a: 1, b: "s" }`). The html
 * target's value is the function a call runs, so the attributes ride on it as
 * own properties: `Object.assign(<function>, { a: 1 })`. The rendered shapes
 * are locked by the oracle fixture `fixtures-marko/define-attributes`.
 */
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

const emit = (source: string) => compile(source, "/fixtures/page.mx").code;

const FN = `() => {
    const __mxOut = __mxCreateOut();
    __mxOut.write("<p>x</p>");
    return __mxOut.toString();
  }`;

describe("html: a <define> carries its attributes as properties", () => {
  it("a define with no body: attributes of every kind, in source order", () => {
    const code = emit(
      '<define/D a=1 b="s" c d=input.x/>\n<p>${D.a} ${D.b}${D.c}${D.d}</p>',
    );
    expect(code).toContain(
      `const D = Object.assign(() => {
    const __mxOut = __mxCreateOut();
    return __mxOut.toString();
  }, { a: 1, b: "s", c: true, d: input.x });`,
    );
    expect(code).toContain("__mxOut.write(__mxEscape(D.a));");
  });

  it("a define with a body keeps the body as the function", () => {
    const code = emit("<define/D a=1><p>x</p></define>\n<D/>");
    expect(code).toContain(`const D = Object.assign(${FN}, { a: 1 });`);
    expect(code).toContain("__mxOut.write(D())");
  });

  it("keeps a spread where it was written and a later attribute after it", () => {
    const code = emit("<define/D a=1 ...input.rest b=2/>\n<p>${D.b}</p>");
    expect(code).toContain("{ a: 1, ...input.rest, b: 2 });");
  });

  it("a last-wins duplicate is one property", () => {
    const code = emit("<define/D a=1 a=2/>\n<p>${D.a}</p>");
    expect(code).toContain("{ a: 2 });");
    expect(code).not.toContain("a: 1");
  });

  it("quotes a name that is not an identifier", () => {
    const code = emit('<define/D data-x=1 aria-y="z"/>\n<p>${D["data-x"]}</p>');
    expect(code).toContain('{ "data-x": 1, "aria-y": "z" });');
  });

  it("evaluates the attributes where the define is written, outside its params", () => {
    const code = emit("<define/D|x| a=x><p>${x}</p></define>\n<p>${D.a}</p>");
    expect(code).toMatch(
      /const D = Object\.assign\(\(x\) => \{[\s\S]*\}, \{ a: x \}\);/,
    );
  });

  it("an attribute named content is a property when the define has no body", () => {
    expect(emit('<define/D content="x"/>\n<p>${D.content}</p>')).toContain(
      '{ content: "x" });',
    );
  });

  it("an attribute named content next to a body is dropped: the body wins", () => {
    const code = emit(
      '<define/D a=1 content="x"><p>x</p></define>\n<p>${D.a}</p>',
    );
    expect(code).toContain("}, { a: 1 });");
    expect(code).not.toContain("content");
  });

  describe("name, length, caller and arguments are not writable on a function", () => {
    const WRITABLE = "Object.assign(Object.defineProperties(() => {";
    const KEEP =
      "{ name: { writable: true }, length: { writable: true }, caller: { writable: true }, arguments: { writable: true } }), ";

    it("an attribute named name makes the properties writable first", () => {
      const code = emit('<define/Field name="email"/>\n<p>${Field.name}</p>');
      expect(code).toContain(WRITABLE);
      expect(code).toContain(`${KEEP}{ name: "email" });`);
    });

    it("an attribute named length does too", () => {
      expect(emit("<define/D length=3/>\n<p>${D.length}</p>")).toContain(KEEP);
    });

    it("an attribute named caller or arguments does too: they are inherited accessors", () => {
      expect(emit('<define/D caller="c"/>\n<p>${D.caller}</p>')).toContain(
        `${KEEP}{ caller: "c" });`,
      );
      expect(emit("<define/D arguments=2/>\n<p>${D.arguments}</p>")).toContain(
        `${KEEP}{ arguments: 2 });`,
      );
    });

    it("a spread does too: its keys are known only at run time", () => {
      expect(emit("<define/D ...input.rest/>\n<p>${D.a}</p>")).toContain(KEEP);
    });

    it("other attributes do not", () => {
      expect(emit("<define/D a=1/>\n<p>${D.a}</p>")).not.toContain(
        "defineProperties",
      );
    });
  });

  it("a define with no attributes is unchanged", () => {
    const code = emit("<define/D><p>x</p></define>\n<D/>");
    expect(code).toContain(`const D = ${FN};`);
    expect(code).not.toContain("Object.assign");
  });
});
