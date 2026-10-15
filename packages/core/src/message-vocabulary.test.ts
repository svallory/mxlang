/**
 * `Dialect.messageVocabulary`: the words core's messages use for a dialect's
 * files. Three things are pinned here:
 *
 * - the default (a dialect with no vocabulary, or no dialect at all) spells
 *   every message exactly as MX always did, one row per function group;
 * - the same rows under the `optionVocabulary` fixture, which states every
 *   member: before and after side by side;
 * - the contract of each member: the article, the plural, `formatTag`'s
 *   three forms and its failures, and the load-time validation.
 *
 * `optionVocabulary` is a fixture, not any real dialect.
 */
import { describe, expect, it } from "vitest";
import type { CustomTag } from "./custom-tags.ts";
import { validateCustomTagChildren } from "./custom-tags.ts";
import { DIALECT_HOOK_ERROR_CODE } from "./diagnostic-codes.ts";
import memberSyntax from "./fixtures/syntax/member-fixture.ts";
import { type LowerSourceOptions, lowerSource } from "./ir-entry/index.ts";
import {
  articleFor,
  MX_VOICE,
  mxSpelling,
  VoiceHookError,
  voiceOf,
} from "./message-vocabulary.ts";
import type { Dialect, MessageVocabulary } from "./syntax-table.ts";

// ---------------------------------------------------------------------------
// Fixtures

/** Mesh's real settings, under a generic name (core knows no Mesh). */
const optionVocabulary: MessageVocabulary = {
  attribute: { one: "option", many: "options" },
  file: "Mesh file",
  tree: "Mesh file",
  formatTag: ({ name, trigger }) => (trigger ? trigger.text : name),
};

function dialectWith(vocabulary?: unknown): Dialect {
  return {
    ...memberSyntax,
    name: "member",
    ...(vocabulary === undefined ? {} : { messageVocabulary: vocabulary }),
  } as Dialect;
}

const noVocabulary = dialectWith();
const optionDialect = dialectWith(optionVocabulary);

const contracts = {
  entity: {
    attributes: { name: { type: "string", required: true } },
    children: { attributes: {}, member: {}, string: {} },
  },
  attributes: { children: { string: {} } },
  member: { attributes: { name: { type: "string" } } },
  string: {
    attributes: {
      name: { type: "string", required: true },
      min: { type: "number" },
    },
  },
  card: { attributeTags: { head: {} } },
} as unknown as Record<string, CustomTag>;

const OPTIONS: LowerSourceOptions = {
  customTags: contracts,
  structural: "reject",
  unknownTags: "reject",
};

/** The diagnostics lowering `source` reports under `dialect`. */
function diagnose(
  source: string,
  dialect: Dialect | undefined,
  options: LowerSourceOptions = OPTIONS,
) {
  return lowerSource(source, "/v/a.mx", {
    ...options,
    ...(dialect ? { dialect } : {}),
  }).diagnostics;
}

function messages(
  source: string,
  dialect: Dialect | undefined,
  options?: LowerSourceOptions,
): string[] {
  return diagnose(source, dialect, options).map((d) => d.message);
}

// ---------------------------------------------------------------------------
// The identity table: one row per function group, default and dialect column.

interface Row {
  /** What the row exercises. */
  readonly name: string;
  readonly source: string;
  /** The function group the message is built in. */
  readonly group: "ir-entry" | "contracts" | "lowering";
  /** MX's message, byte for byte (the default column). */
  readonly mx: string;
  /** The same message under `optionVocabulary`. */
  readonly option: string;
  readonly options?: LowerSourceOptions;
}

const ROWS: readonly Row[] = [
  {
    name: "a trigger-made child that is not allowed (authored text)",
    source: 'entity name="e"\n  attributes\n    &title\n',
    group: "contracts",
    mx: "`<attributes>`: `<member>` is not allowed here; allowed children: `<string>`",
    option:
      "`attributes`: `&title` is not allowed here; allowed children: `string`",
  },
  {
    name: "an unknown attribute",
    source: 'entity name="e"\n  string name="a" bogus=1\n',
    group: "contracts",
    mx: "`<string>`: unknown attribute `bogus`",
    option: "`string`: unknown option `bogus`",
  },
  {
    name: "an attribute of the wrong type",
    source: 'entity name="e"\n  string name="a" min="x"\n',
    group: "contracts",
    mx: "`<string>`: attribute `min` must be number, got string",
    option: "`string`: option `min` must be number, got string",
  },
  {
    name: "a missing required attribute",
    source: 'entity name="e"\n  string min=1\n',
    group: "contracts",
    mx: "`<string>`: missing required attribute `name`",
    option: "`string`: missing required option `name`",
  },
  {
    name: "spread attributes against a declared tag (plural)",
    source: 'entity name="e"\n  string ...x name="a"\n',
    group: "contracts",
    mx: "`<string>`: spread attributes cannot be checked against this tag's declared attributes",
    option:
      "`string`: spread options cannot be checked against this tag's declared options",
  },
  {
    name: "an unknown attribute tag",
    source: "card\n  @bad\n",
    group: "contracts",
    mx: "`<card>`: unknown attribute tag `<@bad>`",
    option: "`card`: unknown option tag `bad`",
  },
  {
    name: "a duplicate attribute",
    source: 'entity name="e"\n  string name="a" name="b"\n',
    group: "lowering",
    mx: "duplicate attribute `name`: the later one at 2:19 wins, so this one is dropped",
    option:
      "duplicate option `name`: the later one at 2:19 wins, so this one is dropped",
  },
  {
    name: "an invalid attribute name (singular and plural)",
    source: 'entity name="e"\n  string name="a" a?b=1\n',
    group: "lowering",
    mx: "Invalid attribute name `a?b` — an attribute name may use letters, digits and `._:-`",
    option:
      "Invalid option name `a?b` — an option name may use letters, digits and `._:-`",
  },
  {
    name: "a tag that takes no arguments (the value attribute)",
    source: 'if(x)\n  entity name="e"\n',
    group: "lowering",
    mx: "Tag does not support arguments. Write the condition as a value attribute instead: `<if=condition>`. For an event handler write `onX=handler`",
    option:
      "Tag does not support arguments. Write the condition as a value option instead: `<if=condition>`. For an event handler write `onX=handler`",
  },
  {
    name: "an unknown tag",
    source: 'entity name="e"\n  bogus\n',
    group: "ir-entry",
    mx: "`<bogus>` is not a known tag in the `member` dialect",
    option: "`bogus` is not a known tag in the `member` dialect",
  },
  {
    name: "a macro in a data tree (the tree noun)",
    source: 'entity name="e"\n  define/x\n',
    group: "ir-entry",
    mx: "`<define>` is a render-time macro: the data tree is static and cannot expand it; inline the content at each use",
    option:
      "`define` is a render-time macro: the Mesh file is static and cannot expand it; inline the content at each use",
  },
  {
    name: "a doctype in a data file (the file noun)",
    source: "<!doctype html>\n",
    group: "ir-entry",
    mx: "`<!doctype>` means nothing in a data file; the data tree describes tags and data, not a page",
    option:
      "`!doctype` means nothing in a Mesh file; the Mesh file describes tags and data, not a page",
  },
  {
    name: "a dynamic tag (form: dynamic, name = the expression source)",
    source: `<\${x}/>\n`,
    group: "ir-entry",
    mx: `a dynamic tag (\`<\${expr}>\`) has no name; the data tree is static and needs one`,
    option:
      "a dynamic tag (`expr`) has no name; the Mesh file is static and needs one",
  },
];

describe("messages in MX's words (the default column)", () => {
  for (const row of ROWS) {
    it(`${row.group}: ${row.name}`, () => {
      const options = row.options ?? OPTIONS;
      // No dialect vocabulary, and a dialect that states none, read alike.
      expect(messages(row.source, noVocabulary, options)).toEqual([row.mx]);
      expect(messages(row.source, dialectWith({}), options)).toEqual([row.mx]);
    });
  }

  it("a file with no dialect at all reads the same words", () => {
    expect(messages('entity name="e"\n  string min=1\n', undefined)).toEqual([
      "`<string>`: missing required attribute `name`",
    ]);
  });
});

describe("messages in the dialect's words (the optionVocabulary column)", () => {
  for (const row of ROWS) {
    it(`${row.group}: ${row.name}`, () => {
      const options = row.options ?? OPTIONS;
      expect(messages(row.source, optionDialect, options)).toEqual([
        row.option,
      ]);
    });
  }

  it('reads "data file" and "data tree" as one noun without breaking the sentence', () => {
    // "a Mesh file" (file) and "the Mesh file" (tree), in the same message.
    const [message] = messages("<!doctype html>\n", optionDialect);
    expect(message).toBe(
      "`!doctype` means nothing in a Mesh file; the Mesh file describes tags and data, not a page",
    );
    expect(message).not.toMatch(/data (file|tree)/);
  });

  it("an authored tag keeps its name; a trigger-made tag prints what the user wrote", () => {
    const authored = messages(
      'entity name="e"\n  attributes\n    member name="t"\n',
      optionDialect,
    );
    expect(authored).toEqual([
      "`attributes`: `member` is not allowed here; allowed children: `string`",
    ]);
    const triggered = messages(
      'entity name="e"\n  attributes\n    &title\n',
      optionDialect,
    );
    expect(triggered).toEqual([
      "`attributes`: `&title` is not allowed here; allowed children: `string`",
    ]);
  });

  it("the default spelling ignores the trigger (`<member>` for `&title`)", () => {
    expect(
      messages('entity name="e"\n  attributes\n    &title\n', noVocabulary),
    ).toEqual([
      "`<attributes>`: `<member>` is not allowed here; allowed children: `<string>`",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The voice itself.

describe("voiceOf", () => {
  it("is MX's voice for no dialect, or one with no vocabulary", () => {
    expect(voiceOf(undefined)).toBe(MX_VOICE);
    expect(voiceOf(noVocabulary)).toBe(MX_VOICE);
  });

  it("MX's voice is MX's words", () => {
    expect(MX_VOICE).toMatchObject({
      attribute: "attribute",
      attributes: "attributes",
      Attribute: "Attribute",
      Attributes: "Attributes",
      anAttribute: "an attribute",
      attributeTag: "attribute tag",
      attributeTags: "attribute tags",
      attributeTagCompound: "attribute-tag",
      file: "data file",
      aFile: "a data file",
      tree: "data tree",
    });
    expect(MX_VOICE.tag("box")).toBe("`<box>`");
    expect(MX_VOICE.attrTag("head")).toBe("`<@head>`");
    expect(MX_VOICE.dynamicTag("expr")).toBe(`\`<\${expr}>\``);
  });

  it("is cached per dialect object", () => {
    expect(voiceOf(optionDialect)).toBe(voiceOf(optionDialect));
    expect(voiceOf(dialectWith(optionVocabulary))).not.toBe(
      voiceOf(optionDialect),
    );
  });

  it("derives every noun form from the stated nouns", () => {
    const voice = voiceOf(optionDialect);
    expect(voice).toMatchObject({
      attribute: "option",
      attributes: "options",
      Attribute: "Option",
      Attributes: "Options",
      anAttribute: "an option",
      attributeTag: "option tag",
      attributeTags: "option tags",
      attributeTagCompound: "option-tag",
      file: "Mesh file",
      aFile: "a Mesh file",
      tree: "Mesh file",
    });
  });

  it("only the members the dialect states change", () => {
    const voice = voiceOf(dialectWith({ file: "entity file" }));
    expect(voice.file).toBe("entity file");
    expect(voice.aFile).toBe("an entity file");
    expect(voice.attribute).toBe("attribute");
    expect(voice.tree).toBe("data tree");
    expect(voice.tag("box")).toBe("`<box>`");
  });

  describe("the article", () => {
    it("is derived from the first letter: `an` before a vowel letter, else `a`", () => {
      expect(articleFor("option")).toBe("an");
      expect(articleFor("Option")).toBe("an");
      expect(articleFor("property")).toBe("a");
      expect(articleFor("hour")).toBe("a");
      expect(
        voiceOf(
          dialectWith({ attribute: { one: "property", many: "properties" } }),
        ).anAttribute,
      ).toBe("a property");
      expect(
        voiceOf(dialectWith({ attribute: { one: "item", many: "items" } }))
          .anAttribute,
      ).toBe("an item");
    });

    it("is the stated one when given, whatever the letter", () => {
      expect(
        voiceOf(
          dialectWith({
            attribute: { one: "hour", many: "hours", article: "an" },
          }),
        ).anAttribute,
      ).toBe("an hour");
      expect(
        voiceOf(
          dialectWith({
            attribute: { one: "user", many: "users", article: "a" },
          }),
        ).anAttribute,
      ).toBe("a user");
    });

    it("reaches the messages that say `an attribute`", () => {
      // "an attribute tag" is `${anAttribute} tag`.
      const source = 'card\n  @head\n    string name="a"\n  @head=1\n';
      const hasArticle = diagnose(source, undefined).map((d) => d.message);
      const withNoun = diagnose(
        source,
        dialectWith({
          attribute: { one: "property", many: "properties", article: "a" },
        }),
      ).map((d) => d.message);
      // Whatever the file says, a stated noun never leaves MX's noun behind.
      for (const message of withNoun) expect(message).not.toMatch(/attribute/);
      expect(hasArticle.length).toBe(withNoun.length);
    });
  });
});

describe("formatTag", () => {
  const spelling = (formatTag: MessageVocabulary["formatTag"]) =>
    voiceOf(dialectWith({ formatTag }));

  it("spells each form, and is wrapped in backticks by core", () => {
    const seen: unknown[] = [];
    const voice = spelling((tag) => {
      seen.push(tag);
      return `${tag.form}:${tag.name}`;
    });
    expect(voice.tag("box")).toBe("`tag:box`");
    expect(voice.attrTag("head")).toBe("`attributeTag:head`");
    expect(voice.dynamicTag("expr")).toBe("`dynamic:expr`");
    expect(seen).toEqual([
      { name: "box", form: "tag" },
      { name: "head", form: "attributeTag" },
      { name: "expr", form: "dynamic" },
    ]);
  });

  it("receives the trigger that made the tag", () => {
    const trigger = {
      id: "member",
      span: { sourceStart: 4, sourceEnd: 10 },
      text: "&title",
    };
    const voice = spelling(({ trigger }) => trigger?.text);
    expect(voice.tag("member", trigger)).toBe("`&title`");
    expect(voice.tag("member")).toBe("`<member>`");
  });

  it("returning undefined is MX's spelling, for every form", () => {
    const voice = spelling(() => undefined);
    expect(voice.tag("box")).toBe("`<box>`");
    expect(voice.attrTag("head")).toBe("`<@head>`");
    expect(voice.dynamicTag("expr")).toBe(`\`<\${expr}>\``);
    expect(mxSpelling({ name: "x", form: "attributeTag" })).toBe("<@x>");
  });

  it("a throw is a VoiceHookError naming the tag and the reason", () => {
    const voice = spelling(() => {
      throw new Error("boom");
    });
    expect(() => voice.tag("box")).toThrow(VoiceHookError);
    try {
      voice.tag("box");
    } catch (error) {
      expect((error as VoiceHookError).tag).toBe("box");
      expect((error as Error).message).toBe(
        "the dialect's `messageVocabulary.formatTag` threw while spelling `<box>`: boom",
      );
    }
  });

  it("a throw that is not an Error is described", () => {
    const voice = spelling(() => {
      throw "plain";
    });
    expect(() => voice.attrTag("head")).toThrow(
      'threw while spelling `<@head>`: "plain"',
    );
  });

  for (const [what, value, described] of [
    ["a number", 3, "a number"],
    ["null", null, "null"],
    ["an object", {}, "an object"],
    ["an empty string", "", '""'],
    ["a multi-line string", "a\nb", '"a\\nb"'],
    ["a string with a backtick", "a`b", '"a`b"'],
  ] as const) {
    it(`${what} is a VoiceHookError, never a silent fallback`, () => {
      const voice = spelling((() => value) as never);
      expect(() => voice.tag("box")).toThrow(VoiceHookError);
      expect(() => voice.tag("box")).toThrow(
        `must return undefined or a non-empty single-line string without backticks, got ${described} for \`<box>\``,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// formatTag failures as diagnostics: MX_DIALECT_HOOK_ERROR at the tag.

describe("a formatTag that breaks its contract", () => {
  const throwing = dialectWith({
    formatTag: () => {
      throw new Error("no spelling");
    },
  });
  const nonString = dialectWith({ formatTag: () => 42 });

  it("IR entry: the hook error replaces the message, at the tag", () => {
    const [diagnostic] = diagnose('entity name="e"\n  bogus\n', throwing);
    expect(diagnostic?.code).toBe(DIALECT_HOOK_ERROR_CODE);
    expect(diagnostic?.message).toBe(
      "the dialect's `messageVocabulary.formatTag` threw while spelling `<entity>`: no spelling",
    );
    // The first tag the message spells is the parent's, so the error sits there.
    expect([diagnostic?.line, diagnostic?.column]).toEqual([1, 0]);
  });

  it("contract validation: a non-string is the hook error", () => {
    const [diagnostic] = diagnose(
      'entity name="e"\n  string min=1\n',
      nonString,
    );
    expect(diagnostic?.code).toBe(DIALECT_HOOK_ERROR_CODE);
    expect(diagnostic?.message).toBe(
      "the dialect's `messageVocabulary.formatTag` must return undefined or a non-empty single-line string without backticks, got a number for `<entity>`",
    );
  });

  it("generic lowering: the hook error is raised at the tag", () => {
    const [diagnostic] = diagnose("if=x\n  p\nelse\n  p\n", throwing, {});
    expect(diagnostic?.code).toBe(DIALECT_HOOK_ERROR_CODE);
    expect(diagnostic?.message).toContain("threw while spelling `<else>`");
    expect([diagnostic?.line, diagnostic?.column]).toEqual([1, 0]);
  });

  it("a message that spells no tag is unaffected", () => {
    expect(
      messages("<!doctype html>\n", dialectWith({ formatTag: () => "x" })),
    ).toEqual([
      "`x` means nothing in a data file; the data tree describes tags and data, not a page",
    ]);
  });
});

// ---------------------------------------------------------------------------
// ChildTag.trigger

describe("ChildTag.trigger", () => {
  const definition = {
    children: { string: {} },
  } as unknown as CustomTag;
  const trigger = {
    id: "member",
    span: { sourceStart: 3, sourceEnd: 9 },
    text: "&title",
  };

  it("is reported to formatTag as the authored text", () => {
    const voice = voiceOf(optionDialect);
    expect(() =>
      validateCustomTagChildren(
        definition,
        {
          name: "box",
          loc: { line: 1, column: 0 },
          childTree: [{ name: "member", loc: { line: 2, column: 2 }, trigger }],
        } as never,
        undefined,
        undefined,
        voice,
      ),
    ).toThrow("`&title` is not allowed here");
  });

  it("is ignored by the default spelling", () => {
    expect(() =>
      validateCustomTagChildren(definition, {
        name: "box",
        loc: { line: 1, column: 0 },
        childTree: [{ name: "member", loc: { line: 2, column: 2 }, trigger }],
      } as never),
    ).toThrow("`<member>` is not allowed here");
  });

  it("an authored child has none", () => {
    expect(() =>
      validateCustomTagChildren(
        definition,
        {
          name: "box",
          loc: { line: 1, column: 0 },
          childTree: [{ name: "member", loc: { line: 2, column: 2 } }],
        } as never,
        undefined,
        undefined,
        voiceOf(optionDialect),
      ),
    ).toThrow("`member` is not allowed here");
  });
});

// ---------------------------------------------------------------------------
// Load validation: a malformed vocabulary refuses the dialect.

describe("load validation", () => {
  const refusal = (vocabulary: unknown): string | undefined =>
    diagnose("<a/>\n", dialectWith(vocabulary), {})[0]?.message;
  const PREFIX = "the `dialect` option is not a valid dialect: ";

  it("accepts every member, and an empty object", () => {
    expect(refusal(optionVocabulary)).toBeUndefined();
    expect(refusal({})).toBeUndefined();
    expect(
      refusal({ attribute: { one: "item", many: "items", article: "an" } }),
    ).toBeUndefined();
  });

  for (const [what, vocabulary, message] of [
    [
      "a string vocabulary",
      "x",
      "`dialect.messageVocabulary` must be an object (attribute, file, tree, formatTag)",
    ],
    [
      "an unknown member",
      { bogus: 1 },
      "`dialect.messageVocabulary.bogus` is not a message vocabulary field (attribute, file, tree, formatTag)",
    ],
    [
      "a bare-string attribute noun",
      { attribute: "option" },
      '`dialect.messageVocabulary.attribute` must be an object `{ one, many, article? }`, such as `{ one: "option", many: "options" }`',
    ],
    [
      "an attribute noun without `many`",
      { attribute: { one: "option" } },
      "`dialect.messageVocabulary.attribute.many` must be a non-empty single-line string without backticks, got undefined",
    ],
    [
      "an unknown attribute noun field",
      { attribute: { one: "o", many: "os", plural: "x" } },
      "`dialect.messageVocabulary.attribute.plural` is not a field of the attribute noun (one, many, article)",
    ],
    [
      "an article that is neither a nor an",
      { attribute: { one: "o", many: "os", article: "the" } },
      '`dialect.messageVocabulary.attribute.article` must be "a" or "an", got "the"',
    ],
    [
      "an empty file noun",
      { file: "" },
      '`dialect.messageVocabulary.file` must be a non-empty single-line string without backticks, got ""',
    ],
    [
      "a multi-line tree noun",
      { tree: "a\nb" },
      '`dialect.messageVocabulary.tree` must be a non-empty single-line string without backticks, got "a\\nb"',
    ],
    [
      "a file noun with a backtick",
      { file: "a`b" },
      '`dialect.messageVocabulary.file` must be a non-empty single-line string without backticks, got "a`b"',
    ],
    [
      "a formatTag that is not a function",
      { formatTag: "x" },
      "`dialect.messageVocabulary.formatTag` must be a function",
    ],
  ] as const) {
    it(`refuses ${what}`, () => {
      expect(refusal(vocabulary)).toBe(`${PREFIX}${message}`);
    });
  }
});
