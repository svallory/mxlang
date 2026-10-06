import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { taglib } from "@marko/compiler";
import { describe, expect, test } from "vitest";
import {
  HTML_ELEMENTS,
  isKnownElement,
  MATHML_ELEMENTS,
  SVG_ELEMENTS,
} from "./element-table.ts";

/**
 * The table is this package's own, so it cannot drift silently from Marko:
 * each list is compared, name for name, with the taglib Marko loads for it.
 * A difference fails here with the names on each side; fix the table, or the
 * test with a reason if the divergence is deliberate.
 */
const lookup = (
  taglib as unknown as {
    buildLookup(
      dir: string,
      translator: { taglibs: []; tagDiscoveryDirs: [] },
    ): {
      taglibsById: Record<string, { tags: Record<string, unknown> }>;
      getTag(name: string): { taglibId?: string } | undefined;
    };
  }
).buildLookup(dirname(fileURLToPath(import.meta.url)), {
  taglibs: [],
  tagDiscoveryDirs: [],
});

const sorted = (names: Iterable<string>) => [...names].sort();

describe("html element table equals Marko's element taglibs", () => {
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

    test(`${id}: no duplicate inside the list`, () => {
      expect(new Set(table).size).toBe(table.length);
    });
  }

  test("the three lists are disjoint", () => {
    const all = [...HTML_ELEMENTS, ...SVG_ELEMENTS, ...MATHML_ELEMENTS];
    expect(new Set(all).size).toBe(all.length);
  });

  test("isKnownElement agrees with Marko's lookup on every name, and on names that are not elements", () => {
    const elementIds = new Set(["marko-html", "marko-svg", "marko-math"]);
    const names = [
      ...HTML_ELEMENTS,
      ...SVG_ELEMENTS,
      ...MATHML_ELEMENTS,
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
        isKnownElement(name),
        `${JSON.stringify(name)}: Marko says ${marko}`,
      ).toBe(marko !== undefined && elementIds.has(marko));
    }
  });
});

test("the table's package pins @marko/compiler as a dev dependency", () => {
  const pkg = JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../package.json"),
      "utf8",
    ),
  );
  expect(pkg.devDependencies["@marko/compiler"]).toMatch(/^\d+\.\d+\.\d+$/);
  expect(pkg.dependencies?.["@marko/compiler"]).toBeUndefined();
});
