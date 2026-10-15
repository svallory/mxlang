// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { describe, expect, it } from "vitest";
import { compileSolidMx } from "./index.ts";

/**
 * `innerHTML` is Solid's raw-HTML prop, so an authored `innerHTML=input.h` on a
 * native element wrote raw markup where stock Marko prints an escaped
 * attribute. It is refused at the attribute, with the way to write raw HTML
 * (`$!{html}` as the sole child, which lowers to `innerHTML` itself), the way
 * the JSX hosts refuse `dangerouslySetInnerHTML=`. A component keeps
 * `innerHTML` as an ordinary prop.
 */

const message =
  "`innerHTML` is not a valid attribute, did you mean `$!{html}`?";

function failure(source: string): {
  message: string;
  line: number;
  column: number;
} {
  try {
    compileSolidMx(source, { filename: "fixture.solid.mx" });
  } catch (error) {
    return error as { message: string; line: number; column: number };
  }
  throw new Error("expected a compile error, but the template compiled");
}

describe("a literal innerHTML= on a native element is refused", () => {
  it.each([
    ["a dynamic value", "<div innerHTML=input.h/>", 1, 5],
    ["a string value", '<div innerHTML="a"/>', 1, 5],
    ["no value", "<div innerHTML/>", 1, 5],
    ["beside a body", "<div innerHTML=input.h>x</div>", 1, 5],
    ["beside a raw child", "<div innerHTML=input.h>$!{input.h}</div>", 1, 5],
    ["a custom element", "<my-el innerHTML=input.h/>", 1, 7],
    ["a void element", "<img innerHTML=input.h/>", 1, 5],
    [
      "<html-script> with a body",
      "<html-script innerHTML=input.h>y</html-script>",
      1,
      13,
    ],
    ["<html-script> without a body", "<html-script innerHTML=input.h/>", 1, 13],
    [
      "a later line",
      '<section>\n  <div class="a"\n    innerHTML=input.h/>\n</section>',
      3,
      4,
    ],
  ])("%s", (_name, source, line, column) => {
    expect(failure(source)).toMatchObject({ message, line, column });
  });

  it.each([
    ["prop:innerHTML", "<div prop:innerHTML=input.h/>", 1, 5],
    ["prop:outerHTML", "<div prop:outerHTML=input.h/>", 1, 5],
    ["prop:innerHTML as a string", '<div prop:innerHTML="a"/>', 1, 5],
    [
      "prop:outerHTML on a custom element",
      "<section><my-el prop:outerHTML=input.h/></section>",
      1,
      16,
    ],
    [
      "prop:innerHTML on <html-script>",
      "<html-script prop:innerHTML=input.h>y</html-script>",
      1,
      13,
    ],
  ])("the prop: spelling, %s", (name, source, line, column) => {
    const prop = name.startsWith("prop:outerHTML")
      ? "prop:outerHTML"
      : "prop:innerHTML";
    expect(failure(source)).toMatchObject({
      message: `\`${prop}\` is not a valid attribute, did you mean \`$!{html}\`?`,
      line,
      column,
    });
  });

  it("is not refused on a component", () => {
    const { code } = compileSolidMx("<${input.C} innerHTML=input.h/>", {
      filename: "fixture.solid.mx",
    });
    expect(code).toContain("innerHTML");
  });
});

describe("a literal text prop on a raw-text element is refused", () => {
  it.each([
    ["<style textContent=input.t>x</style>", "textContent", "style", 1, 7],
    ["<style children=input.t/>", "children", "style", 1, 7],
    ["<style prop:textContent=input.t/>", "prop:textContent", "style", 1, 7],
    ["<style prop:innerText=input.t/>", "prop:innerText", "style", 1, 7],
    ["<html-script prop:text=input.t/>", "prop:text", "html-script", 1, 13],
    ["<html-script textContent=input.t/>", "textContent", "html-script", 1, 13],
    [
      "<html-script textContent=input.t>y</html-script>",
      "textContent",
      "html-script",
      1,
      13,
    ],
  ])("%s", (source, name, tag, line, column) => {
    expect(failure(source)).toMatchObject({
      message: `\`${name}\` is not a valid attribute on \`<${tag}>\`: write the text as its body`,
      line,
      column,
    });
  });

  it("is fine on an element whose server render escapes it", () => {
    expect(() =>
      compileSolidMx("<div textContent=input.t/>", {
        filename: "fixture.solid.mx",
      }),
    ).not.toThrow();
  });

  it("a dynamic tag routes the literal through the guarded view instead", () => {
    const { code } = compileSolidMx(
      "<${input.tag} textContent=input.t innerHTML=input.h/>",
      { filename: "fixture.solid.mx" },
    );
    expect(code).toContain('{...__mxAttrSpread({"textContent": (input.t)}');
    expect(code).toContain('{...__mxAttrSpread({"innerHTML": (input.h)}');
  });

  it("a dynamic tag routes the literal prop: text names through the view too", () => {
    const { code } = compileSolidMx(
      "<${input.tag} prop:textContent=input.t prop:text=input.u/>",
      { filename: "fixture.solid.mx" },
    );
    expect(code).toContain(
      '{...__mxAttrSpread({"prop:textContent": (input.t)}',
    );
    expect(code).toContain('{...__mxAttrSpread({"prop:text": (input.u)}');
  });

  it("a native element routes a non-literal children= through the view", () => {
    const { code } = compileSolidMx("<div children=input.x/>", {
      filename: "fixture.solid.mx",
    });
    expect(code).toContain(
      '{...__mxAttrSpread({"children": (input.x)}, "div")}',
    );
    const literal = compileSolidMx('<div children="x"/>', {
      filename: "fixture.solid.mx",
    }).code;
    expect(literal).not.toContain("__mxAttrSpread");
  });
});

describe("raw HTML still has its way", () => {
  it("`$!{…}` as the sole child lowers to innerHTML", () => {
    const { code } = compileSolidMx("<div>$!{input.h}</div>", {
      filename: "fixture.solid.mx",
    });
    expect(code).toContain("<div innerHTML={input.h}></div>");
  });

  it("a spread's innerHTML key is not refused at compile time", () => {
    expect(() =>
      compileSolidMx("<div ...input.a/>", { filename: "fixture.solid.mx" }),
    ).not.toThrow();
  });
});
