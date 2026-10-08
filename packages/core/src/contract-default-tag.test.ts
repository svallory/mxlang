import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMarkoLookup, createTranslator } from "./compile.ts";
import { contractDefaultTag } from "./contract-default-tag.ts";
import { type Ctx, type Node, newCtx, TranslateError } from "./core.ts";
import { CORE_TAGLIB } from "./core-taglib.ts";
import type { CustomTag, CustomTagAttributeTag } from "./custom-tags.ts";
import type { DefaultTagParent, Policy } from "./declarations.ts";
import { lower } from "./lower.ts";
import { scanCustomTags } from "./scan.ts";
import { lookup, testTargetLookup } from "./test-targets.ts";

const targets = testTargetLookup();
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>, manifest: object = {}): string {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "mx-contract-default-tag-")),
  );
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}
const scan = (dir: string) => scanCustomTags(join(dir, "page.mx"), { targets });
function failure(dir: string): TranslateError {
  try {
    scan(dir);
  } catch (e) {
    return e as TranslateError;
  }
  throw new Error("expected a scan error");
}

describe("the defaultTag declaration key", () => {
  it("is accepted in mx.contracts, top level and on attribute-tag declarations", () => {
    const dir = project(
      {
        "contracts.ts": `export default {
          list: { defaultTag: "item", children: { item: {} },
                  attributeTags: { items: { defaultTag: "entry", attributeTags: { sub: { defaultTag: "x" } } } } },
        };`,
      },
      { mx: { contracts: "./contracts.ts" } },
    );
    const tag = scan(dir).customTags.list as CustomTag;
    expect(tag.defaultTag).toBe("item");
    const items = tag.attributeTags?.items as CustomTagAttributeTag;
    expect(items.defaultTag).toBe("entry");
    const sub = items.attributeTags?.sub as CustomTagAttributeTag;
    expect(sub.defaultTag).toBe("x");
  });

  it("is accepted in a sidecar, top level and on attribute-tag declarations", () => {
    const dir = project({
      "tags/list.tag.ts": `export default { defaultTag: "item", transform: () => [],
        attributeTags: { items: { defaultTag: "entry" } } };`,
    });
    const tag = scan(dir).customTags.list as CustomTag;
    expect(tag.defaultTag).toBe("item");
    const items = tag.attributeTags?.items as CustomTagAttributeTag;
    expect(items.defaultTag).toBe("entry");
  });

  it.each([1, null, true, ["a"], {}, ""])(
    "a non-string value %j is a positioned error naming the tag (mx.contracts)",
    (value) => {
      const dir = project(
        {
          "contracts.ts": `export default { list: { defaultTag: ${JSON.stringify(value)} } };`,
        },
        { mx: { contracts: "./contracts.ts" } },
      );
      const error = failure(dir);
      expect(error).toBeInstanceOf(TranslateError);
      expect(error.message).toContain("`defaultTag`");
      expect(error.message).toContain("`<list>`");
      expect(error.file).toBe(join(dir, "contracts.ts"));
    },
  );

  it("a non-string value on an attribute-tag declaration is rejected, naming the chain", () => {
    const dir = project(
      {
        "contracts.ts": `export default { list: { attributeTags: { items: { defaultTag: 3 } } } };`,
      },
      { mx: { contracts: "./contracts.ts" } },
    );
    const error = failure(dir);
    expect(error.message).toContain("`defaultTag`");
    expect(error.message).toContain("<@items>");
  });

  it("a non-string value in a sidecar is rejected at the sidecar", () => {
    const dir = project({
      "tags/list.tag.ts":
        "export default { defaultTag: 3, transform: () => [] };",
    });
    const error = (() => {
      try {
        // Sidecars load lazily: reading the property triggers the check.
        return (scan(dir).customTags.list as CustomTag).defaultTag, undefined;
      } catch (e) {
        return e as TranslateError;
      }
    })();
    expect(error?.message).toContain("`defaultTag`");
    expect(error?.file).toBe(join(dir, "tags", "list.tag.ts"));
  });

  it("an unknown key beside it is still rejected", () => {
    const dir = project(
      {
        "contracts.ts": `export default { list: { attributeTags: { items: { defaultTags: "x" } } } };`,
      },
      { mx: { contracts: "./contracts.ts" } },
    );
    expect(failure(dir).message).toContain('Unknown key "defaultTags"');
  });
});

describe("contractDefaultTag: the nearest authored parent's contract", () => {
  const translator = createTranslator({
    taglibs: [["mx-translator-core", CORE_TAGLIB]],
    tagDiscoveryDirs: [],
    targets: lookup,
  });
  /** A lookup with no core taglib: `if`, `for`, `try` have no tag def, as on the JSX, Solid, Astro and Angular hosts. */
  const bareTranslator = createTranslator({
    taglibs: [],
    tagDiscoveryDirs: [],
    targets: lookup,
  });
  const customTags: Record<string, CustomTag> = {
    "my-list": {
      defaultTag: "item",
      attributeTags: {
        items: {
          defaultTag: "entry",
          attributeTags: { sub: { defaultTag: "leaf" } },
        },
        plain: {},
      },
      transform: () => [],
    },
    "no-default": { transform: () => [] },
    // The names the contracts above resolve to must be tags: an invalid
    // value falls through.
    item: { transform: () => [] },
    entry: { transform: () => [] },
    leaf: { transform: () => [] },
  };

  /** What the resolver is asked for each unnamed tag, in source order. */
  function asked(
    source: string,
    tags = customTags,
    options: { bare?: boolean; policy?: Partial<Policy> } = {},
  ): Array<string | undefined> {
    const answers: Array<string | undefined> = [];
    const policy: Policy = {
      tags: {},
      isElement: () => true,
      attrTags: 2,
      isDelegatedTag: () => true,
      isComponent: (name) => name in tags,
      ...options.policy,
      resolveDefaultTag: (_node, parents, context) => {
        const found = contractDefaultTag(parents, context);
        answers.push(found);
        return found ?? "div";
      },
    };
    const compiler = createRequire(import.meta.url)("@marko/compiler");
    compiler.compileSync(source, "/tmp/mx-cdt/a.mx", {
      translator: {
        ...translator,
        translate: {
          Program: {
            exit(path: { node: { body: Node[] } }) {
              const ctx: Ctx = newCtx(
                source,
                () => "",
                policy,
                buildMarkoLookup(
                  tmpdir(),
                  options.bare ? bareTranslator : translator,
                ),
                "a.mx",
                lookup,
              );
              ctx.customTags = tags;
              lower(ctx, path.node.body);
              path.node.body = [];
            },
          },
        },
      },
      output: "html",
      writeVersionComment: false,
    });
    return answers;
  }

  it("a direct parent's contract", () => {
    expect(asked("<my-list><.a/></my-list>")).toEqual(["item"]);
  });

  it("a parent with no contract default, or no contract at all, has none and does not climb", () => {
    expect(asked("<my-list><no-default><.a/></no-default></my-list>")).toEqual([
      undefined,
    ]);
    expect(asked("<section><.a/></section>")).toEqual([undefined]);
  });

  it("skips control flow: if, else, for", () => {
    expect(
      asked(
        "<my-list><if=x><.a/></if><else><.b/></else><for|i| of=xs><.c/></for></my-list>",
      ),
    ).toEqual(["item", "item", "item"]);
  });

  it("skips try, await and their attribute tags", () => {
    expect(
      asked(
        "<my-list><try><@catch|e|><.a/></@catch></try><await|v|=p><@then><.b/></@then></await></my-list>",
      ),
    ).toEqual(["item", "item"]);
  });

  it("an attribute-tag parent: its declaration in the owner's attributeTags", () => {
    expect(asked("<my-list><@items><.a/></@items></my-list>")).toEqual([
      "entry",
    ]);
  });

  it("a nested attribute tag reads its own nested declaration", () => {
    expect(
      asked("<my-list><@items><@sub><.a/></@sub></@items></my-list>"),
    ).toEqual(["leaf"]);
  });

  it("an attribute tag declared with no defaultTag has none", () => {
    expect(asked("<my-list><@plain><.a/></@plain></my-list>")).toEqual([
      undefined,
    ]);
  });

  it("a nested unnamed tag looks at its own parent, not the outer one", () => {
    // The outer `.a` resolves to `item` (an unknown name here, so its own
    // contract is none): the inner tag does not inherit my-list's default.
    expect(asked("<my-list><.a><.b/></.a></my-list>")).toEqual([
      "item",
      undefined,
    ]);
  });

  it("skips if, else, for and try on a lookup that has no core taglib", () => {
    expect(
      asked(
        "<my-list><if=x><.a/></if><else><.b/></else><for|i| of=xs><.c/></for><try><.d/></try></my-list>",
        customTags,
        { bare: true },
      ),
    ).toEqual(["item", "item", "item", "item"]);
  });

  it("an invalid contract value falls through: the answer is none", () => {
    const bad: Record<string, CustomTag> = {
      "my-list": { defaultTag: "input", transform: () => [] },
      nope: { defaultTag: "notatag", transform: () => [] },
      awaited: { defaultTag: "await", transform: () => [] },
    };
    expect(asked("<my-list><.a/></my-list>", bad)).toEqual([undefined]);
    expect(asked("<nope><.a/></nope>", bad)).toEqual([undefined]);
    expect(asked("<awaited><.a/></awaited>", bad)).toEqual([undefined]);
  });

  it("a valid value is still answered (an element, a declared tag, the built-ins)", () => {
    const good: Record<string, CustomTag> = {
      a: { defaultTag: "section", transform: () => [] },
      b: { defaultTag: "item", transform: () => [] },
      item: { transform: () => [] },
    };
    expect(asked("<a><.x/></a>", good)).toEqual(["section"]);
    expect(asked("<b><.x/></b>", good)).toEqual(["item"]);
  });

  it("a host that forbids the rung never consults the contract", () => {
    expect(
      asked("<my-list><.a/></my-list>", customTags, {
        policy: { allowContractDefaultTag: false },
      }),
    ).toEqual([undefined]);
  });

  /** The first error compiling `source`, with a resolver that ranks the config above the contract. */
  function configFirstError(
    source: string,
    tags: Record<string, CustomTag>,
  ): string {
    const policy: Policy = {
      tags: {},
      attrTags: 2,
      isDelegatedTag: () => true,
      isElement: () => true,
      isComponent: (name) => name in tags,
      // A target may order the ladder as it likes: config before the contract.
      resolveDefaultTag: (_node, parents, context) =>
        context.configured ?? contractDefaultTag(parents, context) ?? "div",
    };
    const compiler = createRequire(import.meta.url)("@marko/compiler");
    try {
      compiler.compileSync(source, "/tmp/mx-cdt/a.mx", {
        translator: {
          ...translator,
          translate: {
            Program: {
              exit(path: { node: { body: Node[] } }) {
                const ctx: Ctx = newCtx(
                  source,
                  () => "",
                  policy,
                  buildMarkoLookup(tmpdir(), translator),
                  "a.mx",
                  lookup,
                );
                ctx.customTags = tags;
                ctx.defaultTag = "section";
                lower(ctx, path.node.body);
                path.node.body = [];
              },
            },
          },
        },
        output: "html",
        writeVersionComment: false,
      });
    } catch (error) {
      return (error as Error).message;
    }
    return "";
  }

  it("the E2 hint only claims a value is invalid when validation rejected it (config-first resolver)", () => {
    const span: Record<string, CustomTag> = {
      "my-list": {
        defaultTag: "span",
        children: { span: {} },
        transform: () => [],
      },
      span: { transform: () => [] },
    };
    // `span` is valid: the config answered, the E2 names `section`, and there is no declaration error to "see".
    const valid = configFirstError("<my-list><.a/></my-list>", span);
    expect(valid).toContain("`<section>` is not allowed here");
    expect(valid).not.toContain("is invalid");
    // An invalid value the resolver never consulted (config answered) is no
    // claim either; a consulted-and-rejected one is covered by the data tests.
    const bad = configFirstError("<my-list><.a/></my-list>", {
      ...span,
      "my-list": { ...(span["my-list"] as CustomTag), defaultTag: "nope" },
    });
    expect(bad).not.toContain("is invalid");
  });

  it("the top level has no parent contract", () => {
    expect(asked("<.a/>")).toEqual([undefined]);
  });
});

describe("DefaultTagParent carries what the helper needs", () => {
  it("is the shape the hook already receives", () => {
    const parent: DefaultTagParent = {
      name: "x",
      attributeTag: false,
      node: {} as Node,
    };
    expect(parent.name).toBe("x");
  });
});
