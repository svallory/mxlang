import type { CustomTag } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

const tags: Record<string, CustomTag> = {
  "my-list": {
    defaultTag: "article",
    transform: (call) => call.content?.children ?? [],
  },
};

describe("the parent contract's defaultTag on Angular (decision 145 PR 3)", () => {
  it("beats the package config; elsewhere the config answers", () => {
    const run = (source: string) =>
      compile(source, "/tmp/a.mx", { customTags: tags, defaultTag: "section" })
        .code;
    expect(run("<my-list><.a>x</></my-list>")).toContain("<article");
    expect(run("<.a>x</>")).toContain("<section");
  });

  it("skips control flow between the parent and the unnamed tag (if, else, for)", () => {
    const run = (src: string) =>
      compile(src, "/tmp/a.mx", { customTags: tags, defaultTag: "section" })
        .code;
    const out = run(
      "<my-list><if=x><.a>1</></if><else><.b>2</></else><for|i| of=xs><.c>3</></for></my-list>",
    );
    expect(out.match(/<article/g)?.length).toBe(3);
    expect(out).not.toContain("<section");
  });

  it("an invalid contract value falls through to the next rung: no <input>, the config answers", () => {
    const bad: Record<string, CustomTag> = {
      "my-list": {
        defaultTag: "input",
        transform: (call) => call.content?.children ?? [],
      },
    };
    const tags = bad;
    const run = (src: string) =>
      compile(src, "/tmp/a.mx", { customTags: tags, defaultTag: "section" })
        .code;
    const out = run("<my-list><.a>x</></my-list>");
    expect(out).not.toContain("<input");
    expect(out).toContain("<section");
  });
});
