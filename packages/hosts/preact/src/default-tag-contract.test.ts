import type { CustomTag } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

const tags: Record<string, CustomTag> = {
  "my-list": {
    defaultTag: "article",
    transform: (call) => call.content?.children ?? [],
  },
};

describe("the parent contract's defaultTag on the JSX hosts (decision 145 PR 3)", () => {
  it("beats the package config; elsewhere the config answers", () => {
    const run = (source: string) =>
      compilePreactMx(source, "/tmp/a.mx", {
        customTags: tags,
        defaultTag: "section",
      }).code;
    expect(run("<my-list><.a>x</></my-list>")).toContain("<article");
    expect(run("<.a>x</>")).toContain("<section");
  });

  it("skips control flow between the parent and the unnamed tag (if, else, for)", () => {
    const run = (src: string) =>
      compilePreactMx(src, "/tmp/a.mx", {
        customTags: tags,
        defaultTag: "section",
      }).code;
    const out = run(
      "<my-list><if=x><.a>1</></if><else><.b>2</></else><for|i| of=xs><.c>3</></for></my-list>",
    );
    expect(out.match(/<article/g)?.length).toBe(3);
    expect(out).not.toContain("<section");
  });

  it("skips try", () => {
    const run = (src: string) =>
      compilePreactMx(src, "/tmp/a.mx", {
        customTags: tags,
        defaultTag: "section",
      }).code;
    expect(run("<my-list><try><.a>x</></try></my-list>")).toContain("<article");
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
      compilePreactMx(src, "/tmp/a.mx", {
        customTags: tags,
        defaultTag: "section",
      }).code;
    const out = run("<my-list><.a>x</></my-list>");
    expect(out).not.toContain("<input");
    expect(out).toContain("<section");
  });

  it("a dashed custom-element name compiles as a native element, from config and from a contract (sl-card)", () => {
    const run = (src: string, cfg?: string) =>
      compilePreactMx(src, "/tmp/a.mx", { customTags: tags, defaultTag: cfg })
        .code;
    expect(run("<.a>x</>", "sl-card")).toContain('<sl-card class="a">');
    const dashed: Record<string, CustomTag> = {
      "my-list": {
        defaultTag: "sl-card",
        transform: (call) => call.content?.children ?? [],
      },
    };
    const out = run("<my-list><.a>x</></my-list>", undefined).length;
    expect(out).toBeGreaterThan(0);
    const viaContract = (src: string) =>
      compilePreactMx(src, "/tmp/a.mx", {
        customTags: dashed,
        defaultTag: undefined,
      }).code;
    expect(viaContract("<my-list><.a>x</></my-list>")).toContain(
      '<sl-card class="a">',
    );
  });
});
