import { describe, expect, it } from "vitest";
import type { CustomTag } from "./custom-tags.ts";
import { validateDefaultTag } from "./default-tag-validate.ts";

/** A lookup shaped like Marko's: a name maps to a tag def with parseOptions. */
function lookupOf(tags: Record<string, Record<string, unknown> | undefined>) {
  return {
    getTag: (name: string) =>
      Object.hasOwn(tags, name) ? { parseOptions: tags[name] } : undefined,
  };
}

const lookup = lookupOf({
  div: undefined,
  br: { openTagOnly: true },
  input: { openTagOnly: true },
  script: { text: true, preserveWhitespace: true },
  textarea: { text: true, preserveWhitespace: true },
  title: { text: true },
  pre: { preserveWhitespace: true },
  import: { statement: true, rawOpenTag: true },
  if: { controlFlow: true },
});

const validate = (
  name: string,
  extra: {
    customTags?: Record<string, CustomTag>;
    builtins?: string[];
  } = {},
) => validateDefaultTag(name, { lookup, ...extra });

describe("validateDefaultTag", () => {
  it("accepts a plain tag the lookup knows", () => {
    expect(validate("div")).toBeUndefined();
  });

  it.each([
    ["br", "`<br>` is a void tag, not a plain tag"],
    ["input", "`<input>` is a void tag, not a plain tag"],
    ["script", "`<script>` is a text tag, not a plain tag"],
    ["textarea", "`<textarea>` is a text tag, not a plain tag"],
    ["title", "`<title>` is a text tag, not a plain tag"],
    ["pre", "`<pre>` is a whitespace-preserving tag, not a plain tag"],
    ["import", "`<import>` is a statement tag, not a plain tag"],
    ["if", "`<if>` is a control-flow tag, not a plain tag"],
  ])("rejects %s with its reason", (name, reason) => {
    expect(validate(name)).toBe(reason);
  });

  it("rejects a name no lookup, custom tag or built-in knows", () => {
    expect(validate("my-crd")).toBe(
      "`<my-crd>` is not a tag reachable from this package",
    );
  });

  it("accepts a custom tag, and a name only `builtins` lists", () => {
    expect(
      validate("my-card", { customTags: { "my-card": {} } }),
    ).toBeUndefined();
    expect(validate("object", { builtins: ["object"] })).toBeUndefined();
  });

  it("applies the same parse-shape rule to a custom tag", () => {
    expect(
      validate("raw", {
        customTags: { raw: { parseOptions: { text: true } } },
      }),
    ).toBe("`<raw>` is a text tag, not a plain tag");
    expect(
      validate("v", {
        customTags: { v: { parseOptions: { openTagOnly: true } } },
      }),
    ).toBe("`<v>` is a void tag, not a plain tag");
  });

  it("a custom tag outranks the lookup's entry of the same name", () => {
    expect(validate("input", { customTags: { input: {} } })).toBeUndefined();
  });

  it("answers for an inherited name without throwing", () => {
    expect(validate("toString")).toContain("not a tag reachable");
    expect(validate("__proto__", { customTags: {} })).toContain(
      "not a tag reachable",
    );
  });

  it("works without a lookup: custom tags and built-ins only", () => {
    expect(validateDefaultTag("x", { customTags: { x: {} } })).toBeUndefined();
    expect(validateDefaultTag("y", {})).toContain("not a tag reachable");
  });
});

describe("validateDefaultTag: only elements of the target are built-ins", () => {
  // Marko's html lookup also holds core and translator tags (await, try,
  // define, effect): plain-parsing, but not elements of any target.
  const mixed = lookupOf({
    div: { html: true } as never,
    await: undefined,
    try: undefined,
    define: undefined,
    effect: undefined,
  });
  const isElement = (name: string) => name === "div";

  it("accepts an element and rejects a core tag the lookup also holds", () => {
    const scope = { lookup: mixed, isElement };
    expect(validateDefaultTag("div", scope)).toBeUndefined();
    for (const name of ["await", "try", "define", "effect"]) {
      expect(validateDefaultTag(name, scope)).toBe(
        `\`<${name}>\` is not an element of this target`,
      );
    }
  });

  it("without a predicate every lookup tag stays reachable", () => {
    expect(validateDefaultTag("await", { lookup: mixed })).toBeUndefined();
  });

  it("a target with no elements: reachable means built-ins plus custom tags", () => {
    const scope = {
      lookup: mixed,
      isElement: () => false,
      builtins: ["object"],
      customTags: { item: {} },
    };
    expect(validateDefaultTag("object", scope)).toBeUndefined();
    expect(validateDefaultTag("item", scope)).toBeUndefined();
    for (const name of ["div", "section", "pre", "input"]) {
      expect(validateDefaultTag(name, scope)).toContain("not");
    }
  });

  it("a parse-shape reason outranks the element answer", () => {
    expect(
      validateDefaultTag("input", { lookup, isElement: () => false }),
    ).toBe("`<input>` is a void tag, not a plain tag");
  });
});

describe("validateDefaultTag when the custom tags are unknown (round 3)", () => {
  const scope = { lookup, customTagsUnknown: true as const };

  it("keeps the parse-shape verdicts of lookup tags", () => {
    expect(validateDefaultTag("input", scope)).toBe(
      "`<input>` is a void tag, not a plain tag",
    );
    expect(validateDefaultTag("pre", scope)).toContain("whitespace-preserving");
  });

  it("skips the reachability verdicts: a custom tag might provide the name", () => {
    expect(validateDefaultTag("nope", scope)).toBeUndefined();
    expect(
      validateDefaultTag("div", { ...scope, isElement: () => false }),
    ).toBeUndefined();
  });
});

describe("validateDefaultTag: a native custom element (decision 145, round 2 addition)", () => {
  const native = (name: string) => !/^[A-Z]/.test(name);
  const scope = { lookup, isElement: () => false, isNativeElement: native };

  it("accepts a valid custom-element name the host compiles natively", () => {
    expect(validateDefaultTag("sl-card", scope)).toBeUndefined();
    expect(validateDefaultTag("x-a.b_c-1", scope)).toBeUndefined();
  });

  it("still rejects a non-dashed unknown name, an invalid or reserved dashed name", () => {
    for (const name of [
      "nope",
      "Sl-card",
      "-card",
      "sl-Card",
      "annotation-xml",
      "font-face",
    ]) {
      expect(validateDefaultTag(name, scope), name).toContain(
        "not a tag reachable",
      );
    }
  });

  it("rejects it where the host does not compile it natively (html, data)", () => {
    expect(
      validateDefaultTag("sl-card", { lookup, isNativeElement: () => false }),
    ).toContain("not a tag reachable");
    expect(validateDefaultTag("sl-card", { lookup })).toContain(
      "not a tag reachable",
    );
  });

  it("a Marko core tag is still rejected even when the host calls everything native", () => {
    const withCore = lookupOf({ await: {}, "html-comment": { text: true } });
    expect(
      validateDefaultTag("await", {
        lookup: withCore,
        isElement: () => false,
        isNativeElement: native,
      }),
    ).toBeDefined();
    expect(
      validateDefaultTag("html-comment", {
        lookup: withCore,
        isNativeElement: native,
      }),
    ).toContain("text tag");
  });
});
