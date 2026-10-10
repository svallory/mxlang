// The tag rules presets (decision 204) against the tables the targets build
// today: `html` is the html target's table, `markup` the JSX/Solid/Astro/
// Angular hosts' plus open-tag-only `<const>`/`<return>`, and `none` knows
// only the module statements and those two.
import { WEB_ELEMENTS } from "@mxlang/web-elements";
import { describe, expect, it } from "vitest";
import {
  CORE_TAG_NAMES,
  CORE_TAGLIB,
  CORE_TAGLIB_ID,
  STATEMENT_TAGLIB,
} from "./core-taglib.ts";
import {
  TAG_RULES_PRESETS,
  type TagRulesPreset,
  taglibsOfRules,
  tagRulesPreset,
} from "./tag-presets.ts";
import { coreNativeTags, type TagTable, tagTable } from "./tag-table.ts";

/** Every name either table could know. */
const NAMES = [
  ...new Set([...WEB_ELEMENTS.keys(), ...CORE_TAG_NAMES, "x-unknown"]),
].sort();

function presetTable(
  preset: TagRulesPreset,
  natives: typeof WEB_ELEMENTS | undefined,
): TagTable {
  const rules = tagRulesPreset(preset, natives);
  return tagTable({ taglibs: taglibsOfRules(rules) }, rules.nativeTags);
}

/** The language tags `markup` and `none` give `openTagOnly` (lead ruling). */
const OPEN_TAG_ONLY = ["const", "return"];

function sameTable(
  actual: TagTable,
  expected: TagTable,
  except: readonly string[] = [],
) {
  for (const name of NAMES) {
    if (except.includes(name)) continue;
    expect(actual.getTag(name), name).toEqual(expected.getTag(name));
  }
}

function openTagOnly(table: TagTable) {
  for (const name of OPEN_TAG_ONLY) {
    expect(table.getTag(name)?.parseOptions, name).toEqual({
      openTagOnly: true,
    });
  }
}

describe("tag rules presets", () => {
  it("lists html, markup and none", () => {
    expect(TAG_RULES_PRESETS).toEqual(["html", "markup", "none"]);
  });

  it("`html` is the html target's table: natives plus core's whole taglib", () => {
    // `packages/targets/html/src/compiler.ts` registers exactly this.
    const html = tagTable(
      { taglibs: [[CORE_TAGLIB_ID, CORE_TAGLIB]] },
      WEB_ELEMENTS,
    );
    sameTable(presetTable("html", WEB_ELEMENTS), html);
  });

  it("`markup` is the hosts' table: natives plus the statement tags", () => {
    // The JSX, Solid, Astro and Angular hosts register no taglib of their
    // own; `withStatementTags` adds core's statement entries. `markup` adds
    // `<const>`/`<return>` as open-tag-only, which the hosts' table lacks.
    const markup = tagTable({ taglibs: [] }, WEB_ELEMENTS);
    const table = presetTable("markup", WEB_ELEMENTS);
    sameTable(table, markup, OPEN_TAG_ONLY);
    openTagOnly(table);
  });

  it("`markup`'s statement entries are the hosts' statement taglib", () => {
    // `STATEMENT_TAGLIB` is what `compileSource` registers for a host with
    // no taglib of its own (decision 168): the JSX hosts' statement set.
    const hosts = Object.keys(STATEMENT_TAGLIB as object)
      .map((key) => key.slice(1, -1))
      .sort();
    const statements = [...tagRulesPreset("markup", WEB_ELEMENTS).tags]
      .filter(([, entry]) => entry.parseOptions?.statement === true)
      .map(([name]) => name)
      .sort();
    expect(statements).toEqual(hosts);
    expect(
      [...tagRulesPreset("markup", WEB_ELEMENTS).tags.keys()].sort(),
    ).toEqual([...hosts, ...OPEN_TAG_ONLY].sort());
  });

  it("`html` and `markup` fall back to core's own elements without natives", () => {
    expect(tagRulesPreset("html").nativeTags).toBe(coreNativeTags());
    expect(tagRulesPreset("markup").nativeTags).toBe(coreNativeTags());
    sameTable(
      presetTable("markup", undefined),
      tagTable({ taglibs: [] }, undefined),
      OPEN_TAG_ONLY,
    );
  });

  describe("`none`", () => {
    const table = presetTable("none", WEB_ELEMENTS);

    it("has no native elements, whatever natives it is given", () => {
      expect(tagRulesPreset("none", WEB_ELEMENTS).nativeTags.size).toBe(0);
      expect(tagRulesPreset("none").nativeTags.size).toBe(0);
    });

    it("knows the module statements, open-tag-only `<const>`/`<return>` and nothing else", () => {
      const known = NAMES.filter((name) => table.getTag(name) !== undefined);
      expect(known).toEqual(["const", "export", "import", "return", "static"]);
      for (const name of ["export", "import", "static"]) {
        expect(table.getTag(name)?.parseOptions?.statement, name).toBe(true);
      }
      openTagOnly(table);
    });

    it.each([
      // HTML parse rules: void, raw text, preserved whitespace.
      "br",
      "input",
      "script",
      "style",
      "textarea",
      "title",
      "pre",
      // Core tags a dialect may use as plain tag names.
      "class",
      "client",
      "server",
      "let",
      "id",
      "log",
      "if",
      "else",
      "for",
      "define",
    ])("leaves `<%s>` an ordinary tag with no parse rules", (name) => {
      expect(table.getTag(name)).toBeUndefined();
    });
  });

  it("is cached per preset and native set", () => {
    expect(tagRulesPreset("html", WEB_ELEMENTS)).toBe(
      tagRulesPreset("html", WEB_ELEMENTS),
    );
    expect(tagRulesPreset("none", WEB_ELEMENTS)).toBe(tagRulesPreset("none"));
    const rules = tagRulesPreset("markup", WEB_ELEMENTS);
    expect(taglibsOfRules(rules)).toBe(taglibsOfRules(rules));
  });

  it("refuses an unknown preset by name", () => {
    expect(() => tagRulesPreset("data" as TagRulesPreset)).toThrow(
      'unknown tag rules preset "data"; expected one of "html", "markup", "none"',
    );
  });
});
