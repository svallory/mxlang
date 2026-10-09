// Core's tag table against the `@marko/compiler` lookup it replaces (decision
// 197, PR 6 slice S3a): for every translator shape MX builds, each name the
// lookup knows resolves to the same taglib id, `html` flag and parse switches,
// and the table knows no name the lookup does not.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WEB_ELEMENTS } from "@mxlang/web-elements";
import { afterAll, describe, expect, it } from "vitest";
import { createTranslator } from "./compile.ts";
import {
  CORE_TAGLIB,
  CORE_TAGLIB_ID,
  PARSE_OPTIONS_TAGLIB,
  PARSE_OPTIONS_TAGLIB_ID,
  STATEMENT_TAGLIB,
  STATEMENT_TAGLIB_ID,
  withStatementTags,
} from "./core-taglib.ts";
import type { CustomTag } from "./custom-tags.ts";
import { customTagTaglib } from "./custom-tags.ts";
import { markoCompiler } from "./marko-frontend.ts";
import { tagTable } from "./tag-table.ts";

// No `tags/`, `marko.json` or `package.json` around it: the lookup holds only
// what the translator registers, which is all the table models.
const dir = mkdtempSync(join(tmpdir(), "mx-tag-table-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface MarkoTag {
  name: string;
  taglibId?: string;
  html?: boolean;
  parseOptions?: Record<string, unknown>;
}

function markoLookup(translator: unknown) {
  return markoCompiler().taglib.buildLookup(
    dir,
    withStatementTags(translator),
  ) as unknown as {
    getTag(name: string): MarkoTag | undefined;
    getTagsSorted(): MarkoTag[];
  };
}

const project = (tag: MarkoTag | object | undefined) => {
  if (!tag) return undefined;
  const { taglibId, html, parseOptions } = tag as MarkoTag;
  const options =
    parseOptions && Object.keys(parseOptions).length > 0
      ? parseOptions
      : undefined;
  return { taglibId, html: html === true, parseOptions: options };
};

const custom = (parseOptions?: CustomTag["parseOptions"]): CustomTag =>
  // SAFETY: the table reads only a custom tag's name and `parseOptions`.
  ({ parseOptions }) as CustomTag;

const CUSTOM_TAGS: Record<string, CustomTag> = {
  card: custom(),
  // A custom tag over a native element: the id moves, `html` stays.
  div: custom(),
  code: custom({ text: true }),
  // Over a native with its own switches: merged key by key.
  pre: custom({ text: true }),
  textarea: custom({ preserveWhitespace: false }),
};

// The data target's shape: its own statement entries and a layer that turns
// every native parse switch off (`@mxlang/data`'s `dataTaglib`).
const dataLike = (): [string, unknown] => {
  const definition: Record<string, unknown> = { taglibId: "mx-data-like" };
  for (const [name, tag] of WEB_ELEMENTS) {
    if (tag.body === "html") continue;
    definition[`<${name}>`] = {
      parseOptions:
        tag.body === "void"
          ? { openTagOnly: false }
          : tag.body === "preserve"
            ? { preserveWhitespace: false }
            : tag.body === "parsed-text"
              ? { text: false }
              : { text: false, preserveWhitespace: false },
    };
  }
  definition["<if>"] = { parseOptions: { controlFlow: true } };
  definition["<import>"] = {
    parseOptions: { statement: true, rawOpenTag: true },
  };
  return ["mx-data-like", definition];
};

const SHAPES: Array<[string, unknown]> = [
  [
    "no taglibs",
    {
      taglibs: [],
      statementTags: false,
      tagDiscoveryDirs: [],
      translate: {},
    },
  ],
  ["a third-party translator", { taglibs: [], tagDiscoveryDirs: [] }],
  ["createTranslator({})", createTranslator({ emitIr: () => "" } as never)],
  [
    "the html translator with custom tags",
    createTranslator({
      taglibs: [[CORE_TAGLIB_ID, CORE_TAGLIB]],
      tagDiscoveryDirs: ["tags"],
      customTags: CUSTOM_TAGS,
    } as never),
  ],
  [
    "the fragment translator",
    {
      taglibs: [
        [STATEMENT_TAGLIB_ID, STATEMENT_TAGLIB],
        [PARSE_OPTIONS_TAGLIB_ID, PARSE_OPTIONS_TAGLIB],
        customTagTaglib(CUSTOM_TAGS),
      ],
      tagDiscoveryDirs: [],
      translate: {},
    },
  ],
  [
    "a data-shaped translator",
    {
      taglibs: [dataLike()],
      statementTags: false,
      tagDiscoveryDirs: [],
      translate: {},
    },
  ],
];

const PROBES = [
  "my-widget",
  "Card",
  "toString",
  "constructor",
  "__proto__",
  "hasOwnProperty",
  "@item",
  "",
];

describe("tagTable", () => {
  for (const [label, translator] of SHAPES) {
    it(`matches Marko's lookup for ${label}`, () => {
      const lookup = markoLookup(translator);
      const table = tagTable(translator, WEB_ELEMENTS);
      const known = lookup.getTagsSorted().map((tag) => tag.name);
      expect(known.length).toBeGreaterThan(200);
      for (const name of known) {
        expect(project(table.getTag(name)), name).toEqual(
          project(lookup.getTag(name)),
        );
      }
      for (const name of [...WEB_ELEMENTS.keys(), ...PROBES]) {
        expect(project(table.getTag(name)), name).toEqual(
          project(known.includes(name) ? lookup.getTag(name) : undefined),
        );
      }
    });
  }

  it("has no native layer without natives", () => {
    const table = tagTable(createTranslator({} as never), undefined);
    expect(table.getTag("div")).toBeUndefined();
    expect(table.getTag("import")?.parseOptions?.statement).toBe(true);
  });

  it("is cached per translator and native set", () => {
    const translator = createTranslator({} as never);
    expect(tagTable(translator, WEB_ELEMENTS)).toBe(
      tagTable(translator, WEB_ELEMENTS),
    );
    expect(tagTable(translator, undefined)).not.toBe(
      tagTable(translator, WEB_ELEMENTS),
    );
  });

  it("ignores definition keys that are not tags, and non-object taglibs", () => {
    const table = tagTable(
      {
        taglibs: [
          ["odd", null],
          ["x", { taglibId: "x", "@attr": {}, "<x-tag>": null }],
        ],
        statementTags: false,
      },
      undefined,
    );
    expect(table.getTag("x-tag")).toEqual({ taglibId: "x" });
    expect(table.getTag("@attr")).toBeUndefined();
    expect(table.getTag("taglibId")).toBeUndefined();
  });
});
