// Core's tag table (decision 197, PR 6 slice S3a). S3a pinned it against the
// `@marko/compiler` lookup it replaced, live, for every translator shape MX
// builds. S3b deleted that lookup (`buildMarkoLookup`), so the comparison is
// frozen in `tag-table.expected.json`: for each shape, every name whose entry
// differs from the bare native layer, as Marko 5.42.11's lookup gave it
// (`null`: a name the lookup did not know). The native layer itself follows
// `WEB_ELEMENTS`, which `packages/stock-marko/src/web-elements.test.ts`
// compares with Marko's element taglibs.
import { WEB_ELEMENTS } from "@mxlang/web-elements";
import { describe, expect, it } from "vitest";
import { createTranslator } from "./compile.ts";
import { VOID_TAGS } from "./core.ts";
import {
  CORE_TAGLIB,
  CORE_TAGLIB_ID,
  PARSE_OPTIONS_TAGLIB,
  PARSE_OPTIONS_TAGLIB_ID,
  STATEMENT_TAGLIB,
  STATEMENT_TAGLIB_ID,
} from "./core-taglib.ts";
import type { CustomTag } from "./custom-tags.ts";
import { customTagTaglib } from "./custom-tags.ts";
import expected from "./tag-table.expected.json" with { type: "json" };
import { type TagEntry, tagTable } from "./tag-table.ts";

interface ProjectedTag {
  taglibId?: string;
  html?: boolean;
  parseOptions?: Record<string, unknown>;
}

const project = (tag: TagEntry | ProjectedTag | undefined) => {
  if (!tag) return undefined;
  const { taglibId, html, parseOptions } = tag as ProjectedTag;
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
  const NAMESPACE_IDS = {
    html: "marko-html",
    svg: "marko-svg",
    mathml: "marko-math",
  } as const;
  const BODY_OPTIONS = {
    html: undefined,
    void: { openTagOnly: true },
    preserve: { preserveWhitespace: true },
    "parsed-text": { text: true },
    "parsed-text-preserve": { text: true, preserveWhitespace: true },
  } as const;
  const native = (name: string) => {
    const tag = WEB_ELEMENTS.get(name);
    if (!tag) return undefined;
    return {
      taglibId: NAMESPACE_IDS[tag.namespace],
      html: true,
      parseOptions: BODY_OPTIONS[tag.body],
    };
  };
  const frozen = expected as Record<
    string,
    Record<string, ProjectedTag | null>
  >;

  it("lays the target's native elements down first, one entry each", () => {
    const table = tagTable(SHAPES[0]?.[1], WEB_ELEMENTS);
    expect(WEB_ELEMENTS.size).toBeGreaterThan(200);
    for (const name of WEB_ELEMENTS.keys()) {
      expect(project(table.getTag(name)), name).toEqual(native(name));
    }
  });

  for (const [label, translator] of SHAPES) {
    it(`matches Marko's frozen lookup for ${label}`, () => {
      const delta = frozen[label];
      if (!delta) throw new Error(`no frozen expectations for ${label}`);
      const table = tagTable(translator, WEB_ELEMENTS);
      const taglibNames = (
        (translator as { taglibs?: Array<[string, unknown]> }).taglibs ?? []
      ).flatMap(([, definition]) =>
        Object.keys(definition ?? {})
          .filter((key) => key.startsWith("<") && key.endsWith(">"))
          .map((key) => key.slice(1, -1)),
      );
      const names = new Set([
        ...WEB_ELEMENTS.keys(),
        ...Object.keys(delta),
        ...Object.keys(CORE_TAGLIB as object)
          .filter((key) => key.startsWith("<"))
          .map((key) => key.slice(1, -1)),
        ...taglibNames,
        ...PROBES,
      ]);
      for (const name of names) {
        const want = Object.hasOwn(delta, name)
          ? (delta[name] ?? undefined)
          : native(name);
        expect(project(table.getTag(name)), name).toEqual(project(want));
      }
    });
  }

  it("falls back to core's own HTML elements without natives", () => {
    const table = tagTable(createTranslator({} as never), undefined);
    const shape = (name: string) => project(table.getTag(name));
    const html = (parseOptions?: Record<string, unknown>) => ({
      taglibId: "marko-html",
      html: true,
      parseOptions,
    });
    expect(shape("div")).toEqual(html());
    // Every void name lowering treats as void, `param` included.
    for (const name of VOID_TAGS) {
      expect(shape(name), name).toEqual(html({ openTagOnly: true }));
    }
    expect(shape("pre")).toEqual(html({ preserveWhitespace: true }));
    expect(shape("title")).toEqual(html({ text: true }));
    for (const name of ["script", "style", "textarea"]) {
      expect(shape(name), name).toEqual(
        html({ text: true, preserveWhitespace: true }),
      );
    }
    // HTML only: SVG and MathML come from a target's own table.
    expect(table.getTag("circle")).toBeUndefined();
    expect(table.getTag("math")).toBeUndefined();
    expect(table.getTag("import")?.parseOptions?.statement).toBe(true);
  });

  it("gives core's fallback the web elements' HTML parse rules", () => {
    const fallback = tagTable(createTranslator({} as never), undefined);
    const web = tagTable(createTranslator({} as never), WEB_ELEMENTS);
    for (const [name, tag] of WEB_ELEMENTS) {
      if (tag.namespace !== "html" || !fallback.getTag(name)) continue;
      expect(project(fallback.getTag(name)), name).toEqual(
        project(web.getTag(name)),
      );
    }
  });

  it("is cached per translator and native set", () => {
    const translator = createTranslator({} as never);
    expect(tagTable(translator, WEB_ELEMENTS)).toBe(
      tagTable(translator, WEB_ELEMENTS),
    );
    expect(tagTable(translator, undefined)).toBe(
      tagTable(translator, undefined),
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
