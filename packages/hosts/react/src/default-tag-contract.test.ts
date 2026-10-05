import type { CustomTag } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { compileReactMx } from "./index.ts";

const pass = (call: { content?: { children: never[] } | null }) =>
  call.content?.children ?? [];
const tags: Record<string, CustomTag> = {
  "my-list": { defaultTag: "article", transform: pass as never },
};
const bad: Record<string, CustomTag> = {
  "my-list": { defaultTag: "input", transform: pass as never },
};
const run = (src: string, customTags = tags) =>
  compileReactMx(src, "/tmp/a.mx", { customTags, defaultTag: "section" }).code;

describe("the parent contract's defaultTag on react (decision 145 PR 3)", () => {
  it("beats the package config; elsewhere the config answers", () => {
    expect(run("<my-list><.a>x</></my-list>")).toContain("<article");
    expect(run("<.a>x</>")).toContain("<section");
  });

  it("skips control flow between the parent and the unnamed tag (if, else, for, try)", () => {
    const out = run(
      "<my-list><if=x><.a>1</></if><else><.b>2</></else><for|i| of=xs><.c>3</></for><try><.d>4</></try></my-list>",
    );
    expect(out.match(/<article/g)?.length).toBe(4);
    expect(out).not.toContain("<section");
  });

  it("an invalid contract value falls through: no <input>, the config answers", () => {
    const out = run("<my-list><.a>x</></my-list>", bad);
    expect(out).not.toContain("<input");
    expect(out).toContain("<section");
  });

  it("a dashed custom-element name compiles as a native element, from config and from a contract (sl-card)", () => {
    expect(run("<.a>x</>").length).toBeGreaterThan(0);
    const config = compileReactMx("<.a>x</>", "/tmp/a.mx", {
      customTags: tags,
      defaultTag: "sl-card",
    }).code;
    expect(config).toContain('<sl-card className="a">');
    const dashed: Record<string, CustomTag> = {
      "my-list": { defaultTag: "sl-card", transform: pass as never },
    };
    expect(run("<my-list><.a>x</></my-list>", dashed)).toContain(
      '<sl-card className="a">',
    );
  });

  it("a dashed Marko core tag as a contract value falls through: no error, no raw element", () => {
    for (const name of [
      "else-if",
      "html-script",
      "html-style",
      "html-comment",
    ]) {
      const badTags: Record<string, CustomTag> = {
        "my-list": { defaultTag: name, transform: pass as never },
      };
      const out = run("<my-list><.a>x</></my-list>", badTags);
      expect(out, name).not.toContain("<" + name);
      expect(out, name).toContain("<section");
    }
  });
});
