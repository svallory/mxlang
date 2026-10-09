import { describe, expect, test } from "vitest";
import {
  HTML_ELEMENTS,
  isWebElement,
  MATHML_ELEMENTS,
  SVG_ELEMENTS,
  WEB_ELEMENTS,
  type WebBodyMode,
  webElement,
} from "./index.ts";

/** Marko's comparison lives in `packages/stock-marko/src/web-elements.test.ts`. */
describe("the web element table", () => {
  test("each list has no duplicate, and the three are disjoint", () => {
    for (const list of [HTML_ELEMENTS, SVG_ELEMENTS, MATHML_ELEMENTS]) {
      expect(new Set(list).size).toBe(list.length);
    }
    const all = [...HTML_ELEMENTS, ...SVG_ELEMENTS, ...MATHML_ELEMENTS];
    expect(new Set(all).size).toBe(all.length);
    expect(WEB_ELEMENTS.size).toBe(all.length);
  });

  test("every name maps to its own list's namespace", () => {
    for (const [list, namespace] of [
      [HTML_ELEMENTS, "html"],
      [SVG_ELEMENTS, "svg"],
      [MATHML_ELEMENTS, "mathml"],
    ] as const) {
      for (const name of list) {
        expect(webElement(name)?.namespace, name).toBe(namespace);
      }
    }
  });

  test("the 19 elements with a body that is not plain markup", () => {
    const modes: Record<string, WebBodyMode> = {};
    for (const [name, element] of WEB_ELEMENTS) {
      if (element.body !== "html") modes[name] = element.body;
    }
    expect(modes).toEqual({
      area: "void",
      base: "void",
      br: "void",
      col: "void",
      embed: "void",
      hr: "void",
      img: "void",
      input: "void",
      link: "void",
      meta: "void",
      param: "void",
      source: "void",
      track: "void",
      wbr: "void",
      pre: "preserve",
      script: "parsed-text-preserve",
      style: "parsed-text-preserve",
      textarea: "parsed-text-preserve",
      title: "parsed-text",
    });
    for (const name of Object.keys(modes)) {
      expect(webElement(name)?.namespace, name).toBe("html");
    }
  });

  test("names that are not elements, including Object.prototype keys and other cases", () => {
    for (const name of [
      "",
      "Div",
      "DIV",
      "my-widget",
      "if",
      "for",
      "badge",
      "constructor",
      "toString",
      "hasOwnProperty",
      "__proto__",
      " div",
      "div ",
    ]) {
      expect(isWebElement(name), JSON.stringify(name)).toBe(false);
      expect(webElement(name), JSON.stringify(name)).toBeUndefined();
    }
  });

  test("entries are frozen, so one consumer cannot change another's table", () => {
    const div = webElement("div");
    expect(div).toEqual({ namespace: "html", body: "html" });
    expect(Object.isFrozen(div)).toBe(true);
  });
});
