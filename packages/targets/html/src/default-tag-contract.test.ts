/**
 * The parent-contract rung of the ladder (decision 145, PR 3), through a real
 * compile: a parent's contract `defaultTag` beats the package config, the
 * config beats the built-in; structural parents are skipped; an unnamed tag
 * under an attribute tag reads its declaration.
 */
import type { AttributeTag, CustomTag, IrNode } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { compile, htmlTargets } from "./index.ts";

const pass: Pick<CustomTag, "transform"> = {
  transform: (call) => call.content?.children ?? [],
};

/** Every attribute tag's block, nested ones included, as the call's output. */
const emitted = (list: readonly AttributeTag[]): IrNode[] =>
  list.flatMap((tag) => [
    ...(tag.block?.children ?? []),
    ...emitted(tag.attributeTags ?? []),
  ]);

const tags: Record<string, CustomTag> = {
  "my-list": { ...pass, defaultTag: "article" },
  plain: { ...pass },
  panel: {
    transform: (call) => emitted(call.attributeTags),
    attributeTags: {
      head: { defaultTag: "header" },
      body: { attributeTags: { inner: { defaultTag: "footer" } } },
    },
  },
};

function html(source: string, defaultTag?: string): string {
  const { code } = compile(source, "/tmp/mx-contract/a.mx", {
    customTags: tags,
    targets: htmlTargets,
    ...(defaultTag ? { defaultTag } : {}),
  });
  return code;
}

describe("the parent contract's defaultTag", () => {
  it("beats the package config, which beats the built-in", () => {
    expect(html("<my-list><.a>x</></my-list>")).toContain("<article");
    expect(html("<my-list><.a>x</></my-list>", "section")).toContain(
      "<article",
    );
    expect(html("<plain><.a>x</></plain>", "section")).toContain("<section");
    expect(html("<plain><.a>x</></plain>")).toContain("<div");
  });

  it("is ordinary after resolution: id and class lower as on an authored tag", () => {
    const shorthand = html('<my-list><#x.a class="b">hi</></my-list>');
    const authored = html(
      '<my-list><article#x.a class="b">hi</article></my-list>',
    );
    expect(shorthand).toBe(authored);
  });

  it("skips control flow: if, else, for", () => {
    const out = html(
      "<my-list><if=x><.a>1</></if><else><.b>2</></else><for|i| of=xs><.c>3</></for></my-list>",
    );
    expect(out.match(/<article/g)?.length).toBe(3);
  });

  it("an unnamed tag under an element has no contract: the next rung answers", () => {
    expect(html("<my-list><p><.a>x</></p></my-list>", "section")).toContain(
      "<section",
    );
  });

  it("a nested unnamed tag resolves through its own parent", () => {
    const out = html("<my-list><.a><.b>x</></></my-list>");
    // `.a` is an article (my-list's default); an article has no contract, so `.b` gets the built-in.
    expect(out).toContain("<article");
    expect(out).toContain("<div");
  });

  it("an attribute-tag parent reads its declaration in the owner's attributeTags", () => {
    expect(html("<panel><@head><.a>x</></@head></panel>")).toContain("<header");
    expect(
      html("<panel><@body><@inner><.a>x</></@inner></@body></panel>"),
    ).toContain("<footer");
    // `body` declares no defaultTag of its own: it does not borrow `inner`'s.
    expect(html("<panel><@body><.a>x</></@body></panel>", "section")).toContain(
      "<section",
    );
  });

  it("an invalid contract value falls through: `input` never emits <input>, the next rung answers", () => {
    const bad: Record<string, CustomTag> = {
      "my-list": { ...pass, defaultTag: "input" },
      "my-box": { ...pass, defaultTag: "not-a-tag" },
      "my-wait": { ...pass, defaultTag: "await" },
    };
    for (const name of ["my-list", "my-box", "my-wait"]) {
      const { code } = compile(
        `<${name}><.a>x</></${name}>`,
        "/tmp/mx-contract/a.mx",
        {
          customTags: bad,
          targets: htmlTargets,
          defaultTag: "section",
        },
      );
      expect(code, name).not.toContain("<input");
      expect(code, name).toContain("<section");
    }
    const { code } = compile(
      "<my-list><.a>x</></my-list>",
      "/tmp/mx-contract/a.mx",
      {
        customTags: bad,
        targets: htmlTargets,
      },
    );
    expect(code).toContain("<div");
  });
});
