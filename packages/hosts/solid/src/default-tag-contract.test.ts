import type { CustomTag } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { compileSolidUnit } from "./compile.ts";
import { solidTargets } from "./index.ts";

const tags: Record<string, CustomTag> = {
  "my-list": {
    defaultTag: "article",
    transform: (call) => call.content?.children ?? [],
  },
};

describe("the parent contract's defaultTag on Solid (decision 145 PR 3)", () => {
  it("beats the package config; elsewhere the config answers", () => {
    const run = (source: string) =>
      compileSolidUnit(source, {
        filename: "/tmp/a.mx",
        customTags: tags,
        defaultTag: "section",
        targets: solidTargets,
      }).code;
    expect(run("<my-list><.a>x</></my-list>")).toContain("<article");
    expect(run("<.a>x</>")).toContain("<section");
  });
});
