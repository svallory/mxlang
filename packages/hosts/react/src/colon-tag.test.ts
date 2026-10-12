import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CustomTag,
  createTargetLookup,
  getCustomTags,
} from "@mxlang/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import descriptor from "./descriptor.ts";
import { compileReactMx, compileReactRegion } from "./index.ts";

const FIX = (name: string) =>
  ` A colon belongs to the tag name: write the name without the colon, or declare it from an \`mx.tags\` directory with \`prefix: "${name.slice(0, name.lastIndexOf(":") + 1)}"\`.`;
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
    ["when capitalized", "<Foo:bar/>", "Foo:bar", 1, 0],
    ["with two colons", "<a:b:c/>", "a:b:c", 1, 0],
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

/**
 * The route a colon tag is declared by files: an `mx.tags` directory whose
 * `prefix` ends in the colon. Unlike the `transform` contract above, the
 * discovered tag reaches the host as a component call.
 */
describe("React host: a colon tag declared from an mx.tags prefix directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "mx-react-colon-tag-"));
  const scan = (file: string) => getCustomTags(file, { targets });

  beforeAll(() => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "t",
        mx: { tags: [{ dir: "ui", prefix: "uuid:" }] },
      }),
    );
    mkdirSync(join(dir, "ui"));
    writeFileSync(
      join(dir, "ui", "id.mx"),
      "export interface Input { label: string }\n<b title=input.label/>\n",
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("is found by the scan under its full name", () => {
    expect(Object.keys(scan(join(dir, "page.mx")))).toEqual(["uuid:id"]);
  });

  it("whole-file: imports the tag file and calls it", () => {
    const file = join(dir, "page.mx");
    const code = compileReactMx('<div><uuid:id label="a"/></div>', file, {
      customTags: scan(file),
      targets,
    }).code;
    expect(code).toMatch(/^import \$mx_Uuid_id(\d+) from "\.\/ui\/id\.mx"$/m);
    expect(code).toMatch(/<div><\$mx_Uuid_id\d+ label="a" \/><\/div>/);
    expect(code).not.toContain("<uuid:id");
  });

  it("region: calls the tag", () => {
    const file = join(dir, "page.react.mx");
    const code = compileReactRegion('<uuid:id label="a"/>', {
      filename: file,
      customTags: scan(file),
      targets,
    }).code;
    expect(code).toMatch(/<\$mx_Uuid_id\d+ label="a" \/>/);
    expect(code).not.toContain("<uuid:id");
  });
});
