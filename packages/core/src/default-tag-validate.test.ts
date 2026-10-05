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
