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

/** The fix: always the name without the colon, and the `mx.tags` prefix when some prefix can produce the name. */
const FIX = (prefix: string | null) =>
  prefix === null
    ? " A colon belongs to the tag name: write the name without the colon."
    : ` A colon belongs to the tag name: write the name without the colon, or declare it from an \`mx.tags\` directory with \`prefix: "${prefix}"\`.`;
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

interface Failure {
  message: string;
  line: number;
  column: number;
  end: { line: number; column: number };
}

function failureOf(run: () => unknown): Failure {
  try {
    run();
  } catch (error) {
    const e = error as Error & Omit<Failure, "message">;
    return { message: e.message, line: e.line, column: e.column, end: e.end };
  }
  throw new Error("expected a compile error, but the source compiled");
}

const errorOf = (source: string): Failure =>
  failureOf(() => compileReactMx(source, "/tmp/a.mx", { targets }));
const regionErrorOf = (source: string): Failure =>
  failureOf(() => regionWith(source, {}));

/** A colon name is one custom-tag name, as in Marko: undeclared, it is an error, never a JSX namespace element. */
describe("React host: an undeclared colon tag name", () => {
  // [label, source, name, mx.tags prefix that produces it (null: none), line, column, end column]
  it.each([
    ["at the root, self-closing", "<uuid:id/>", "uuid:id", "uuid:", 1, 0, 8],
    [
      "inside an element",
      "<div>\n  <uuid:id/>\n</div>",
      "uuid:id",
      "uuid:",
      2,
      2,
      10,
    ],
    ["with an attribute", "<uuid:id a=1/>", "uuid:id", "uuid:", 1, 0, 8],
    [
      "with a body",
      "<kind:name>hi</kind:name>",
      "kind:name",
      "kind:",
      1,
      0,
      10,
    ],
    [
      "after a hyphenated name",
      "<my-widget:x a=1/>",
      "my-widget:x",
      "my-widget:",
      1,
      0,
      12,
    ],
    ["with a leading colon", "<:email/>", ":email", ":", 1, 0, 7],
    ["when capitalized", "<Foo:bar/>", "Foo:bar", "Foo:", 1, 0, 8],
    ["with a lowercase namespace", "<ns:tag/>", "ns:tag", "ns:", 1, 0, 7],
    [
      "with a capitalized namespace and tag",
      "<Ns:Tag/>",
      "Ns:Tag",
      "Ns:",
      1,
      0,
      7,
    ],
    ["with two colons", "<a:b:c/>", "a:b:c", "a:b:", 1, 0, 6],
    ["after a stem that starts with a digit", "<a:1x/>", "a:1x", "a:", 1, 0, 5],
    ["ending in a hyphen run", "<a:b-/>", "a:b-", "a:", 1, 0, 5],
    // A prefix is any string, so a prefix ending after the colon produces it.
    ["with a hyphen after the colon", "<a:-x/>", "a:-x", "a:-", 1, 0, 5],
    ["with a dollar before the stem", "<a:$x/>", "a:$x", "a:$", 1, 0, 5],
    // No file stem ends these names: a stem is a letter, digit or `_`, then
    // letters, digits, `_` or `-`, all ASCII.
    ["with nothing after the colon", "<uuid:/>", "uuid:", null, 1, 0, 6],
    ["with only a hyphen after the colon", "<x:-/>", "x:-", null, 1, 0, 4],
    ["ending in a dollar", "<a:b$/>", "a:b$", null, 1, 0, 5],
    ["ending in a non-ASCII letter", "<a:é/>", "a:é", null, 1, 0, 4],
  ])(
    "is rejected %s, at the tag",
    (_label, source, name, prefix, line, column, endColumn) => {
      const endLine = source.slice(0, source.indexOf(name)).split("\n").length;
      expect(errorOf(source)).toEqual({
        message: UNRESOLVED(name) + FIX(prefix),
        line,
        column,
        end: { line: endLine, column: endColumn },
      });
    },
  );

  it("keeps Marko's suggestion for a near HTML element", () => {
    expect(errorOf("<div:x/>")).toEqual({
      message: `${UNRESOLVED("div:x")} Did you mean \`<div>\`?${FIX("div:")}`,
      line: 1,
      column: 0,
      end: { line: 1, column: 6 },
    });
  });

  it("is rejected inside a region at the authored position", () => {
    expect(regionErrorOf("<uuid:id/>")).toEqual({
      message: UNRESOLVED("uuid:id") + FIX("uuid:"),
      line: 3,
      column: 4,
      end: { line: 3, column: 12 },
    });
    expect(regionErrorOf("<uuid:/>")).toEqual({
      message: UNRESOLVED("uuid:") + FIX(null),
      line: 3,
      column: 4,
      end: { line: 3, column: 10 },
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

/**
 * The prefix in the error is a fix a user can apply: put it in `mx.tags`, name
 * the tag file after the rest of the name, and the same call compiles.
 */
describe("React host: the mx.tags prefix an error names declares the tag", () => {
  const dir = mkdtempSync(join(tmpdir(), "mx-react-colon-hint-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // [name, the prefix the error names, the tag file's stem]
  it.each([
    ["uuid:id", "uuid:", "id"],
    ["a:-x", "a:-", "x"],
    ["a:$x", "a:$", "x"],
    ["a:1x", "a:", "1x"],
    ["a:b-", "a:", "b-"],
    [":email", ":", "email"],
    ["a:b:c", "a:b:", "c"],
  ])("%s: prefix %j and a file %s.mx", (name, prefix, stem) => {
    const named = /prefix: "([^"]*)"/.exec(errorOf(`<${name}/>`).message)?.[1];
    expect(named).toBe(prefix);

    const root = join(dir, stem.replace(/\W/g, "_") + prefix.length);
    mkdirSync(join(root, "ui"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "t",
        mx: { tags: [{ dir: "ui", prefix: named }] },
      }),
    );
    writeFileSync(
      join(root, "ui", `${stem}.mx`),
      "export interface Input { label: string }\n<b title=input.label/>\n",
    );
    const file = join(root, "page.mx");
    const customTags = getCustomTags(file, { targets });
    expect(Object.keys(customTags)).toEqual([name]);

    const code = compileReactMx(`<${name} label="a"/>`, file, {
      customTags,
      targets,
    }).code;
    expect(code).toMatch(/<\$mx_\S+ label="a" \/>/);
    expect(code).not.toContain(`<${name}`);
  });
});
