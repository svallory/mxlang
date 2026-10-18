/**
 * `NodeType.label`: the name core's messages to a file's author show for a
 * dialect's node type in place of its registry key (spec 13.9.9). Every
 * message that names a node type in a contract check is pinned twice, with a
 * label and without one (the fixture dialect's `atom:Atom`, labelled `atom`),
 * so the unlabelled text is shown to be unchanged. Messages to the dialect's
 * own author (registration, row and hook errors) keep the key, pinned last.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CustomTag } from "../custom-tags.ts";
import { MX_VOICE, voiceOf } from "../message-vocabulary.ts";
import type { Dialect } from "../syntax-table.ts";
import { lowerSource } from "./index.ts";

const MODULE = join(import.meta.dirname, "../fixtures/syntax/atom-fixture.ts");

const plain = (createRequire(import.meta.url)(MODULE) as { default: Dialect })
  .default;

/** The same dialect with `label: "atom"` on its one node type. */
const labelled: Dialect = {
  ...plain,
  nodeTypes: {
    Atom: { ...(plain.nodeTypes?.Atom as object), label: "atom" } as never,
  },
};

const tags = (customTags: Record<string, unknown>) =>
  customTags as Record<string, CustomTag>;

const messages = (
  dialect: Dialect,
  source: string,
  customTags: Record<string, CustomTag>,
): string[] =>
  lowerSource(source, "/v/entity.mx", { dialect, customTags }).diagnostics.map(
    (each) => each.message,
  );

const SLOTS = tags({
  pick: {
    attributes: {
      mode: { type: "atom:Atom" },
      list: { type: "array", items: "atom:Atom" },
      s: { type: "string" },
      n: { type: "number" },
      e: { enum: ["a", "b"] },
      es: { type: "string", enum: ["a", "b"] },
      a: { type: "array" },
      f: { type: "function" },
      ai: { type: "array", items: "string" },
    },
  },
});

/** [what is refused, source, the message with the key, the message with the label]. */
const CASES: [string, string, string, string][] = [
  [
    "a plain value against a node slot",
    '<pick mode="on"/>',
    "attribute `mode` must be atom:Atom, got string",
    "attribute `mode` must be atom, got string",
  ],
  [
    "a number against a node slot",
    "<pick mode=1/>",
    "attribute `mode` must be atom:Atom, got number",
    "attribute `mode` must be atom, got number",
  ],
  [
    "a node against a string slot",
    "<pick s=~on/>",
    "attribute `s` must be string, got atom:Atom",
    "attribute `s` must be string, got atom",
  ],
  [
    "a node in parentheses (its forward) against a number slot",
    "<pick n=(~on)/>",
    "attribute `n` must be number, got atom:Atom",
    "attribute `n` must be number, got atom",
  ],
  [
    "a node against an enum slot",
    "<pick e=~a/>",
    'attribute `e` must be a string from "a", "b", got atom:Atom',
    'attribute `e` must be a string from "a", "b", got atom',
  ],
  [
    "a node against a typed enum slot",
    "<pick es=~a/>",
    "attribute `es` must be string, got atom:Atom",
    "attribute `es` must be string, got atom",
  ],
  [
    "a node against an array slot",
    "<pick a=~on/>",
    "attribute `a` must be array, got atom:Atom",
    "attribute `a` must be array, got atom",
  ],
  [
    "a node against a function slot",
    "<pick f=~on/>",
    "attribute `f` must be function, got atom:Atom",
    "attribute `f` must be function, got atom",
  ],
  [
    "a node against a list of strings, as an item",
    "<pick ai=['x', ~on]/>",
    "attribute `ai` item 2 must be string, got atom:Atom",
    "attribute `ai` item 2 must be string, got atom",
  ],
  [
    "a node where a list of nodes goes",
    "<pick list=~a/>",
    "attribute `list` must be array, got atom:Atom; write it as a list: `[~a]`",
    "attribute `list` must be array, got atom; write it as a list: `[~a]`",
  ],
  [
    "a plain value where a list of nodes goes",
    '<pick list="a"/>',
    "attribute `list` must be array, got string",
    "attribute `list` must be array, got string",
  ],
  [
    "a wrong item in a list of nodes",
    "<pick list=[~a, 2]/>",
    "attribute `list` item 2 must be atom:Atom, got number",
    "attribute `list` item 2 must be atom, got number",
  ],
];

describe("a node type's `label` in the contract messages", () => {
  it.each(CASES)("%s", (_, source, withKey, withLabel) => {
    expect(messages(plain, source, SLOTS)).toEqual([`\`<pick>\`: ${withKey}`]);
    expect(messages(labelled, source, SLOTS)).toEqual([
      `\`<pick>\`: ${withLabel}`,
    ]);
  });

  it("an attribute-tag slot is worded the same", () => {
    const ROW = tags({
      pick: {
        attributeTags: { row: { attributes: { mode: { type: "atom:Atom" } } } },
      },
    });
    const source = '<pick><@row mode="x"/></pick>';
    expect(messages(plain, source, ROW)).toEqual([
      "`<pick>`: `<@row>`: attribute `mode` must be atom:Atom, got string",
    ]);
    expect(messages(labelled, source, ROW)).toEqual([
      "`<pick>`: `<@row>`: attribute `mode` must be atom, got string",
    ]);
  });

  it("a plain string deferred behind the dialect's `afterLower` carries the label", () => {
    const BOX = tags({
      box: {
        attributes: {
          one: { type: "atom:Atom", values: ["a", "b"] },
          list: { type: "array", items: "atom:Atom", values: ["a", "b"] },
        },
      },
    });
    expect(messages(plain, '<box one="a"/>', BOX)).toEqual([
      "`<box>`: attribute `one` must be atom:Atom, got string (one of ~a, ~b)",
    ]);
    expect(messages(labelled, '<box one="a"/>', BOX)).toEqual([
      "`<box>`: attribute `one` must be atom, got string (one of ~a, ~b)",
    ]);
    expect(messages(plain, '<box list=[~a, "b"]/>', BOX)).toEqual([
      "`<box>`: attribute `list` item 2 must be atom:Atom, got string (one of ~a, ~b)",
    ]);
    expect(messages(labelled, '<box list=[~a, "b"]/>', BOX)).toEqual([
      "`<box>`: attribute `list` item 2 must be atom, got string (one of ~a, ~b)",
    ]);
  });

  it("a node of the type the slot asks for is still accepted", () => {
    expect(messages(labelled, "<pick mode=~on/>", SLOTS)).toEqual([]);
  });

  it("the voice answers the label for the key, and the key for anything else", () => {
    const voice = voiceOf(labelled);
    expect(voice.nodeType("atom:Atom")).toBe("atom");
    expect(voice.nodeType("atom:Other")).toBe("atom:Other");
    expect(voice.nodeType("other:Atom")).toBe("other:Atom");
    expect(voice.nodeType("string")).toBe("string");
    expect(MX_VOICE.nodeType("atom:Atom")).toBe("atom:Atom");
    expect(voiceOf(plain).nodeType("atom:Atom")).toBe("atom:Atom");
  });

  it("a dialect that labels no type speaks MX's voice", () => {
    expect(voiceOf(plain)).toBe(MX_VOICE);
  });

  it("a dialect's own vocabulary and its labels work together", () => {
    const both: Dialect = {
      ...labelled,
      messageVocabulary: { attribute: { one: "option", many: "options" } },
    };
    expect(messages(both, '<pick mode="on"/>', SLOTS)).toEqual([
      "`<pick>`: option `mode` must be atom, got string",
    ]);
  });
});

describe("messages to the dialect's own author keep the key", () => {
  it("a contract naming a type the dialect does not register", () => {
    const BAD = tags({ pick: { attributes: { mode: { type: "atom:Nope" } } } });
    const text = messages(labelled, "<pick/>", BAD).join("\n");
    expect(text).toContain("`atom:Atom`");
    expect(text).not.toMatch(/\(atom\)/);
  });
});
