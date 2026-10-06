// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the inputs are MX source with ${…} placeholders
/**
 * The front end's boundary: required options (a `TypeError`, the only
 * throw), `tagShape` calls, the PR 2b rules seam, internal failures returned
 * as `MX_FRONT_END_INTERNAL`, `lineColumnAt`, and the package not exposing
 * any of it until PR 3.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import type { MxBodyMode, MxStatementKeyword } from "@mxlang/babel/mx-ast";
import { afterEach, describe, expect, it } from "vitest";
import * as packageIndex from "../template/index.ts";
import { lineColumnAt } from "./line-column.ts";
import { parse, seams } from "./parse.ts";
import { checkInvariants } from "./test-support/invariants.ts";
import { OPTIONS, SIX, tagShape } from "./test-support/options.ts";

const original = { ...seams };
afterEach(() => {
  Object.assign(seams, original);
});

describe("options", () => {
  it("a missing tagShape or keyword set is a TypeError at the call", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately wrong calls
    const loose = parse as any;
    expect(() => loose("<a/>", { statementKeywords: SIX })).toThrow(TypeError);
    expect(() => loose("<a/>", { tagShape })).toThrow(TypeError);
    expect(() => loose("<a/>")).toThrow(TypeError);
  });

  it("tagShape is asked once per static-named tag, with the written name; never for a dynamic name or an attribute tag", () => {
    const asked: string[] = [];
    const shape = (name: string): MxBodyMode => {
      asked.push(name);
      return tagShape(name);
    };
    parse("<div><input:email/><${x}/><.c/><Card><@head/></Card></div>", {
      statementKeywords: SIX,
      tagShape: shape,
    });
    expect(asked).toEqual(["div", "input:email", "", "Card"]);
    expect(asked.some((name) => name.startsWith("@"))).toBe(false);
  });

  it("the statement test uses the written name: import:x is a tag", () => {
    const document = parse("import:x y", OPTIONS);
    expect(document.body[0]?.type).toBe("MxTag");
  });

  it("an empty keyword set makes every statement word a tag", () => {
    const none: ReadonlySet<MxStatementKeyword> = new Set();
    const document = parse("static x = 1", {
      statementKeywords: none,
      tagShape,
    });
    expect(document.body[0]?.type).toBe("MxTag");
  });
});

describe("the PR 2b rules seam", () => {
  it("is called once per tag, finished or incomplete", () => {
    const seen: string[] = [];
    seams.frontEndRules = (tag) => {
      seen.push(`${tag.type}@${tag.start}`);
      return [];
    };
    parse("<a><b/><@c/>${x}</a>\n<d>", OPTIONS);
    expect(seen.sort()).toEqual(
      ["MxAttributeTag@7", "MxTag@0", "MxTag@3", "MxTag@21"].sort(),
    );
  });

  it("its errors are recorded, ordered by start, before the template error", () => {
    seams.frontEndRules = (tag) => [
      {
        type: "MxParseError",
        start: tag.start,
        end: tag.start + 1,
        code: "MX_SECOND_NAME",
        origin: "front-end",
        message: "test",
        context: null,
      },
    ];
    const document = parse("<a/><b></c>", OPTIONS);
    expect(document.errors.map((e) => [e.code, e.start])).toEqual([
      ["MX_SECOND_NAME", 0],
      ["MX_SECOND_NAME", 4],
      ["MISMATCHED_CLOSING_TAG", 7],
    ]);
  });
});

describe("internal failures", () => {
  it("a throwing internal step yields MX_FRONT_END_INTERNAL and the partial tree, never a throw", () => {
    seams.frontEndRules = (tag) => {
      if (tag.start === 8) throw new Error("injected\nsecond line");
      return [];
    };
    const document = parse("<a><b/>\n<c/><d/></a>", OPTIONS);
    expect(document.complete).toBe(false);
    const last = document.errors[document.errors.length - 1];
    expect(last).toMatchObject({
      code: "MX_FRONT_END_INTERNAL",
      origin: "front-end",
      message:
        "The MX front end failed while building the syntax tree (not yours: an MX bug): injected",
    });
    const a = document.body[0] as unknown as {
      incomplete: boolean;
      body: unknown[];
    };
    expect(a.incomplete).toBe(true);
    expect(a.body).toHaveLength(3);
    expect(checkInvariants(document)).toEqual([]);
  });

  it("a tagShape answer that is not a body mode is an internal failure", () => {
    const document = parse("<a/>", {
      statementKeywords: SIX,
      tagShape: () => "weird" as MxBodyMode,
    });
    expect(document.errors[0]?.code).toBe("MX_FRONT_END_INTERNAL");
  });
});

describe("lineColumnAt", () => {
  it("1-based line, 0-based column; only \\n starts a line", () => {
    const document = parse("<a>\r\n  <b/></a>", OPTIONS);
    expect(lineColumnAt(document, 0)).toEqual({ line: 1, column: 0 });
    expect(lineColumnAt(document, 4)).toEqual({ line: 1, column: 4 });
    expect(lineColumnAt(document, 7)).toEqual({ line: 2, column: 2 });
    expect(lineColumnAt(document, 15)).toEqual({ line: 2, column: 10 });
  });

  it("applies the fragment base: line, and column on the first line only", () => {
    const document = parse("<a>\n<b/></a>", {
      ...OPTIONS,
      base: { offset: 20, line: 2, column: 5 },
    });
    expect(lineColumnAt(document, 20)).toEqual({ line: 3, column: 5 });
    expect(lineColumnAt(document, 22)).toEqual({ line: 3, column: 7 });
    expect(lineColumnAt(document, 24)).toEqual({ line: 4, column: 0 });
    expect(document.body[0]).toMatchObject({ start: 20, end: 32 });
  });

  it("an offset outside the document is a RangeError", () => {
    const document = parse("<a/>", OPTIONS);
    expect(() => lineColumnAt(document, 5)).toThrow(RangeError);
  });

  it("the document carries no index member", () => {
    const document = parse("<a/>\n<b/>", OPTIONS);
    lineColumnAt(document, 6);
    expect(Object.keys(document).sort()).toEqual(
      [
        "base",
        "body",
        "complete",
        "end",
        "errors",
        "source",
        "start",
        "type",
      ].sort(),
    );
  });
});

describe("not exposed until PR 3 (decision 166 addendum 1)", () => {
  it("the package index exports nothing of the front end", () => {
    expect(Object.keys(packageIndex)).not.toContain("parse");
    expect(Object.keys(packageIndex)).not.toContain("lineColumnAt");
    const source = readFileSync(
      new URL("../template/index.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/frontend/);
  });

  it("package.json exposes only the template parser", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    expect(manifest.exports).toEqual({ ".": "./src/template/index.ts" });
    expect(manifest.private).toBe(true);
  });

  it("no file under src/template imports the front end", () => {
    const root = new URL("../template/", import.meta.url).pathname;
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = `${dir}${name}`;
        return statSync(path).isDirectory() ? walk(`${path}/`) : [path];
      });
    const offenders = walk(root).filter(
      (path) =>
        path.endsWith(".ts") &&
        /from "\.\.\/(\.\.\/)?frontend/.test(readFileSync(path, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
