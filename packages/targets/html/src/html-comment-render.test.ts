import { describe, expect, it } from "vitest";
import { mx } from "./index.ts";

/**
 * `<html-comment>` placeholders by real render. Expectations are what Marko
 * 6.3.51 renders (`fixtures-marko/html-comment-falsy` is the live-Marko lock);
 * the object guard follows Marko's debug build, which throws where
 * `optimize: true` renders `[object Object]`.
 */
// biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
const body = "<html-comment>${input.v}</html-comment>";

const render = (source: string, input: Record<string, unknown>) =>
  String(mx(source)(input));

describe("<html-comment> object placeholders (rendered)", () => {
  const plain =
    "Text content cannot be a plain object (it would render as `[object Object]`).";

  it("throws for a plain object, in either escape mode", () => {
    expect(() => render(body, { v: {} })).toThrow(plain);
    expect(() => render(body, { v: { a: 1 } })).toThrow(plain);
    expect(() =>
      render("<html-comment>a $!{input.v}</html-comment>", { v: {} }),
    ).toThrow(plain);
  });

  it("throws for a null-prototype object, whose coercion fails", () => {
    expect(() => render(body, { v: Object.create(null) })).toThrow(plain);
  });

  it("throws for other [object X] values, naming the text", () => {
    expect(() => render(body, { v: Promise.resolve(1) })).toThrow(
      "Text content cannot be a value that renders as `[object Promise]`.",
    );
  });

  it("renders objects with a meaningful toString, arrays and dates", () => {
    expect(render(body, { v: { toString: () => "ok>" } })).toBe(
      "<!--ok&gt;-->",
    );
    expect(render(body, { v: [1, 2] })).toBe("<!--1,2-->");
  });

  it("keeps rendering 0, falsy values and strings as before", () => {
    expect(render(body, { v: 0 })).toBe("<!--0-->");
    expect(render(body, { v: false })).toBe("<!-- -->");
    expect(render(body, { v: "a>b" })).toBe("<!--a&gt;b-->");
  });
});
