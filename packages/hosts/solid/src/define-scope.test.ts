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
});
