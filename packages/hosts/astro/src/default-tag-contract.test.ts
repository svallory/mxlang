import type { CustomTag } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { lowerAstroMx } from "./astro-template.ts";

const tags: Record<string, CustomTag> = {
  "my-list": {
    defaultTag: "article",
    transform: (call) => call.content?.children ?? [],
  },
};

describe("the parent contract's defaultTag on Astro templates (decision 145 PR 3)", () => {
  it("beats the package config; elsewhere the config answers", () => {
    const run = (source: string) =>
      lowerAstroMx(source, "/tmp/a.astro.mx", {
        customTags: tags,
        defaultTag: "section",
      }).code;
    expect(run("---\n---\n<my-list><.a>x</></my-list>")).toContain("<article");
    expect(run("---\n---\n<.a>x</>")).toContain("<section");
  });
});
