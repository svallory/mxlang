// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * A `<define>` is in scope only inside the body that declares it, as in Marko
 * 6.4.4. Solid hoists a define written in an element body to module scope, so
 * the call after the element used to reach it even when `Foo` is an import;
 * it now renders the import, and with no import it is an unresolved tag.
 */
import { describe, expect, it } from "vitest";
import { compileSolidMx } from "./index.ts";

const FOO = "<define/Foo><p>inner</p></define>";

function compile(source: string, withImport: boolean): string {
  return compileSolidMx(source, {
    filename: "/f/t.solid.mx",
    ...(withImport
      ? {
          importSpecifiers: new Map([["Foo", "./foo.js"]]),
          moduleBindings: new Set(["Foo"]),
        }
      : {}),
  }).code;
}

describe("solid: a <define> is scoped to the body that declares it", () => {
  it("a native element body: the <Foo/> after it renders the import", () => {
    const code = compile(`<div>${FOO}</div>\n<Foo/>\n`, true);
    expect(code).not.toContain("__mx_DefineFoo");
    expect(code).toContain("const __mxDyn0 = Foo;");
  });

  it("a native element body: with no import the <Foo/> after it is an unresolved tag", () => {
    expect(() => compile(`<div>${FOO}</div>\n<Foo/>\n`, false)).toThrow(
      "Unable to find entry point for custom tag `<Foo>`.",
    );
  });

  it("a call inside the element body still calls the define", () => {
    const code = compile(`<div>${FOO}<Foo/></div>\n`, true);
    expect(code).toContain("__mx_DefineFoo1()");
  });

  it("a block below the top level is still refused, with or without a call after it", () => {
    for (const source of [
      `<if=input.a>${FOO}</if>\n<Foo/>\n`,
      `<for|i| of=[1]>${FOO}</for>\n`,
    ]) {
      expect(() => compile(source, true)).toThrow(
        "`<define>` inside `<for>`/`<if>`/another construct's body is not hoisted to module scope",
      );
    }
  });

  it("a top-level define is called from every later block", () => {
    const code = compile(`${FOO}\n<div><Foo/></div>\n<Foo/>\n`, false);
    expect(code.match(/__mx_DefineFoo1\(\)/g)).toHaveLength(2);
  });

  describe("a top-level define of the same name keeps the outer call", () => {
    const OUTER = "<define/Foo><p>outer</p></define>";
    const calls = (code: string) => code.match(/__mx_DefineFoo\d+\(\)/g);

    it("<try> body: the call inside is the inner define, the one after is the outer", () => {
      const code = compile(
        `${OUTER}<try>${FOO}<Foo/><@catch|e|>x</@catch></try>\n<Foo/>\n`,
        false,
      );
      expect(calls(code)).toEqual(["__mx_DefineFoo2()", "__mx_DefineFoo1()"]);
    });

    it("an attribute tag body: the call inside is the inner define, the one after is the outer", () => {
      const code = compileSolidMx(
        `${OUTER}<Bar><@item>${FOO}<Foo/></@item></Bar>\n<Foo/>\n`,
        {
          filename: "/f/t.solid.mx",
          importSpecifiers: new Map([["Bar", "./bar.js"]]),
          moduleBindings: new Set(["Bar"]),
        },
      ).code;
      expect(calls(code)).toEqual(["__mx_DefineFoo2()", "__mx_DefineFoo1()"]);
    });

    it("a define after the <try> gets a name no hoisted define already uses", () => {
      const code = compile(
        `<try>${FOO}<Foo/><@catch|e|>x</@catch></try>\n${FOO}<Foo/>\n`,
        false,
      );
      expect(calls(code)).toEqual(["__mx_DefineFoo1()", "__mx_DefineFoo2()"]);
      const hoisted = compileSolidMx(
        `<try>${FOO}<Foo/><@catch|e|>x</@catch></try>\n${FOO}<Foo/>\n`,
        { filename: "/f/t.solid.mx" },
      ).hoistedDefines.map((define) => define.binding);
      expect(hoisted).toEqual(["__mx_DefineFoo1", "__mx_DefineFoo2"]);
    });
  });
});
