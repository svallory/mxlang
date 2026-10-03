import { describe, expect, it } from "vitest";
import { parseData } from "./parse.ts";
import { DATA_TAGLIB_ID, dataTaglib, neutralizations } from "./taglib.ts";
import type { DataNode, DataTag } from "./tree.ts";

/**
 * The data taglib's neutralization list is *derived* from Marko's own taglib
 * lookup (note §4.3), never hand-listed. These tests pin the measured state
 * of Marko 6.3.51 / `@marko/compiler` 5.42.5: a Marko bump that adds a void
 * tag, changes `getTagsSorted`, or alters a rule must fail here loudly rather
 * than silently change what a data file parses.
 */

// Measured on Marko 6.3.51 (`marko-html.json`): 14 `openTagOnly` names, 4
// `text` names, and `pre` (`preserveWhitespace` only).
const MEASURED_19 = [
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "pre",
  "script",
  "source",
  "style",
  "textarea",
  "title",
  "track",
  "wbr",
];

const STRUCTURAL_NAMES = [
  "if",
  "else",
  "else-if",
  "for",
  "const",
  "define",
  "return",
  "import",
  "static",
  "export",
];

// Names the html host's taglib owns; the data taglib must omit them so they
// stay ordinary data tag names.
const HOST_OWNED_NAMES = [
  "let",
  "id",
  "effect",
  "lifecycle",
  "log",
  "debug",
  "await",
  "class",
  "client",
  "server",
  "html-comment",
  "html-script",
  "html-style",
];

function definition(): Record<string, unknown> {
  const [id, def] = dataTaglib();
  expect(id).toBe(DATA_TAGLIB_ID);
  return def as Record<string, unknown>;
}

function tagNames(def: Record<string, unknown>): string[] {
  return Object.keys(def)
    .filter((key) => key.startsWith("<"))
    .map((key) => key.slice(1, -1))
    .sort();
}

function firstTag(node: DataNode | undefined): DataTag {
  expect(node?.kind).toBe("tag");
  return node as DataTag;
}

describe("the derived neutralization list", () => {
  it("equals the 19 names measured on Marko 6.3.51", () => {
    expect([...neutralizations().keys()].sort()).toEqual(MEASURED_19);
  });

  it("sets openTagOnly, text and preserveWhitespace to false where Marko sets them true", () => {
    const n = neutralizations();
    // Void tags: openTagOnly only.
    expect(n.get("input")).toEqual({ openTagOnly: false });
    // Raw-text tags: text and preserveWhitespace.
    expect(n.get("script")).toEqual({
      text: false,
      preserveWhitespace: false,
    });
    expect(n.get("title")).toEqual({ text: false });
    // `pre`: preserveWhitespace only.
    expect(n.get("pre")).toEqual({ preserveWhitespace: false });
  });

  it("the built taglib carries the 19 neutralizations plus the 10 structural entries", () => {
    const names = tagNames(definition());
    expect(names).toEqual([...MEASURED_19, ...STRUCTURAL_NAMES].sort());
  });

  it("omits the host-owned entries so id, log, debug and class stay data tag names", () => {
    const names = tagNames(definition());
    for (const owned of HOST_OWNED_NAMES) {
      expect(names).not.toContain(owned);
    }
    const result = parseData(
      `<id=1/>\n<log=x/>\n<debug=y/>\n<class=z/>\n`,
      "/t.mx",
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.tree?.children.map((node) => (node as DataTag).name)).toEqual(
      ["id", "log", "debug", "class"],
    );
  });

  it.each(MEASURED_19)("`<%s>` accepts a child tag", (name) => {
    const result = parseData(`<${name}><child/></${name}>\n`, "/t.mx");
    expect(result.diagnostics).toEqual([]);
    const tag = firstTag(result.tree?.children[0]);
    expect(tag.name).toBe(name);
    const child = firstTag(tag.children[0]);
    expect(child.name).toBe("child");
    // No whitespace text survived around the child either.
    expect(tag.children).toHaveLength(1);
  });
});

describe("preserveWhitespace neutralization", () => {
  it.each(["pre", "script", "style", "textarea"])(
    "`<%s>` keeps no whitespace text around a child tag",
    (name) => {
      const result = parseData(`<${name}>\n  <child/>\n</${name}>\n`, "/t.mx");
      expect(result.diagnostics).toEqual([]);
      const tag = firstTag(result.tree?.children[0]);
      expect(tag.children).toHaveLength(1);
      expect(firstTag(tag.children[0]).name).toBe("child");
    },
  );
});
