import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { taglib } from "@marko/compiler";
import {
  HTML_ELEMENTS,
  isWebElement,
  MATHML_ELEMENTS,
  SVG_ELEMENTS,
  WEB_ELEMENTS,
  type WebBodyMode,
} from "@mxlang/web-elements";
import { describe, expect, test } from "vitest";

/**
 * `@mxlang/web-elements` is MX's own table, so it cannot drift silently from
 * Marko: each list is compared, name for name, with the taglib Marko loads
 * for it (`@marko/compiler` 5.42.11, this package's pin), and each element's
 * body mode with that taglib's parse rules. A difference fails here with the
 * names on each side; fix the table, or the test with a reason if the
 * divergence is deliberate.
 */
interface MarkoTag {
  taglibId?: string;
  html?: boolean;
  parseOptions?: {
    openTagOnly?: boolean;
    text?: boolean;
    preserveWhitespace?: boolean;
  };
}

const lookup = (
  taglib as unknown as {
    buildLookup(
      dir: string,
      translator: { taglibs: []; tagDiscoveryDirs: [] },
    ): {
      taglibsById: Record<string, { tags: Record<string, unknown> }>;
      getTag(name: string): MarkoTag | undefined;
    };
  }
).buildLookup(dirname(fileURLToPath(import.meta.url)), {
  taglibs: [],
  tagDiscoveryDirs: [],
});

const sorted = (names: Iterable<string>) => [...names].sort();

/** The body mode MX's parser gives a tag with these Marko parse options. */
function bodyOf(parse: MarkoTag["parseOptions"]): WebBodyMode {
  if (!parse) return "html";
  if (parse.openTagOnly) return "void";
  if (parse.text)
    return parse.preserveWhitespace ? "parsed-text-preserve" : "parsed-text";
  return parse.preserveWhitespace ? "preserve" : "html";
}

describe("@mxlang/web-elements equals Marko's element taglibs", () => {
  for (const [id, table] of [
    ["marko-html", HTML_ELEMENTS],
    ["marko-svg", SVG_ELEMENTS],
    ["marko-math", MATHML_ELEMENTS],
  ] as const) {
    test(`${id}: same names`, () => {
      const marko = Object.keys(lookup.taglibsById[id]?.tags ?? {});
      expect(marko.length).toBeGreaterThan(0);
      expect(sorted(table)).toEqual(sorted(marko));
    });
  }

  test("every element's body mode is its Marko parse rule, and Marko marks it html", () => {
    for (const [name, element] of WEB_ELEMENTS) {
      const tag = lookup.getTag(name);
      expect(tag?.html, name).toBe(true);
      expect(element.body, name).toBe(bodyOf(tag?.parseOptions));
    }
  });

  test("isWebElement agrees with Marko's lookup on every name, and on names that are not elements", () => {
    const elementIds = new Set(["marko-html", "marko-svg", "marko-math"]);
    const names = [
      ...WEB_ELEMENTS.keys(),
      "my-widget",
      "Div",
      "DIV",
      "badge",
      "if",
      "for",
      "",
      "constructor",
      "toString",
      "__proto__",
    ];
    for (const name of names) {
      const marko = lookup.getTag(name)?.taglibId;
      expect(
        isWebElement(name),
        `${JSON.stringify(name)}: Marko says ${marko}`,
      ).toBe(marko !== undefined && elementIds.has(marko));
    }
  });
});
