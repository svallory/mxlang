import type { CustomTag } from "@mxlang/core";
import { createTargetLookup } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import descriptor from "./descriptor.ts";
import { compileReactMx, compileReactRegion } from "./index.ts";

const FIX = (name: string) =>
  ` A colon belongs to the tag name: declare a tag named \`${name}\`, or write the name without the colon.`;
const UNRESOLVED = (name: string) =>
  `Unable to find entry point for custom tag \`<${name}>\`.`;

const targets = createTargetLookup([descriptor]);

function compileWith(
  source: string,
  customTags: Record<string, CustomTag>,
): string {
  return compileReactMx(source, "/tmp/a.mx", { customTags, targets }).code;
}

function regionWith(
  source: string,
  customTags: Record<string, CustomTag>,
): string {
  return compileReactRegion(source, {
    filename: "/tmp/Panel.react.mx",
    baseOffset: 40,
    baseLine: 2,
    baseColumn: 4,
    customTags,
    targets,
  }).code;
}

function errorOf(source: string): {
  message: string;
  line: number;
  column: number;
} {
  try {
    compileReactMx(source, "/tmp/a.mx", { targets });
  } catch (error) {
    const e = error as Error & { line: number; column: number };
    return { message: e.message, line: e.line, column: e.column };
  }
  throw new Error("expected a compile error, but the module compiled");
}

function regionErrorOf(source: string): {
  message: string;
  line: number;
  column: number;
} {
  try {
    regionWith(source, {});
  } catch (error) {
    const e = error as Error & { line: number; column: number };
    return { message: e.message, line: e.line, column: e.column };
  }
  throw new Error("expected a compile error, but the region compiled");
}

/** A colon name is one custom-tag name, as in Marko: undeclared, it is an error, never a JSX namespace element. */
describe("React host: an undeclared colon tag name", () => {
  it.each([
    ["at the root, self-closing", "<uuid:id/>", "uuid:id", 1, 0],
    ["inside an element", "<div>\n  <uuid:id/>\n</div>", "uuid:id", 2, 2],
    ["with an attribute", "<uuid:id a=1/>", "uuid:id", 1, 0],
    ["with a body", "<kind:name>hi</kind:name>", "kind:name", 1, 0],
    ["after a hyphenated name", "<my-widget:x a=1/>", "my-widget:x", 1, 0],
    ["with a leading colon", "<:email/>", ":email", 1, 0],
  ])("is rejected %s, at the tag", (_label, source, name, line, column) => {
    expect(errorOf(source)).toEqual({
      message: UNRESOLVED(name) + FIX(name),
      line,
      column,
    });
  });

  it("keeps Marko's suggestion for a near HTML element", () => {
    expect(errorOf("<div:x/>")).toEqual({
      message: `${UNRESOLVED("div:x")} Did you mean \`<div>\`?${FIX("div:x")}`,
      line: 1,
      column: 0,
    });
  });

  it("is rejected inside a region at the authored position", () => {
    expect(regionErrorOf("<uuid:id/>")).toEqual({
      message: UNRESOLVED("uuid:id") + FIX("uuid:id"),
      line: 3,
      column: 4,
    });
  });
});

describe("React host: a declared colon tag name", () => {
  const tags: Record<string, CustomTag> = {
    "uuid:id": { transform: (call) => call.content?.children ?? [] },
  };

  it("still compiles, as the custom tag it names", () => {
    const code = compileWith("<uuid:id a=1>hi</uuid:id>", tags);
    expect(code).toContain("hi");
    expect(code).not.toContain("uuid:id");
  });

  it("still compiles inside an element and in a region", () => {
    expect(compileWith("<div><uuid:id>hi</uuid:id></div>", tags)).toContain(
      "<div>hi</div>",
    );
    expect(regionWith("<uuid:id>hi</uuid:id>", tags)).toContain("hi");
  });
});
