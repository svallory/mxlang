import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import type { MxWarning } from "./core.ts";
import type { CustomTag, TagCall } from "./custom-tags.ts";
import type { HostDeclarations } from "./declarations.ts";
import type { DelegatedTag, Ir, IrNode } from "./ir.ts";
import { testTargetLookup } from "./test-targets.ts";

const targets = testTargetLookup();

/** A data-like host: every name is delegated, the unnamed tag is `node`. */
const delegating: HostDeclarations = {
  attrTags: 2,
  tags: {},
  isElement: () => false,
  isComponent: () => false,
  isDelegatedTag: (name) => name !== "$dynamic",
  resolveDelegatedTag: () => undefined,
  resolveDefaultTag: (_node, parents, context) => {
    for (const parent of parents) {
      if (["if", "else", "else-if", "for"].includes(parent.name)) continue;
      const declared = context.customTags?.[parent.name]?.defaultTag;
      return declared ?? "node";
    }
    return "node";
  },
};

/** An html-like host: lowercase names are native elements, nothing is delegated. */
const native: HostDeclarations = {
  tags: {},
  isElement: () => true,
  isComponent: () => false,
};

function compile(
  source: string,
  tags: Record<string, CustomTag>,
  options: { host?: HostDeclarations; warnings?: MxWarning[] } = {},
): Ir {
  let result: Ir | undefined;
  compileSource(
    source,
    "/tmp/mx-wildcard-test/page.mx",
    options.host ?? delegating,
    {
      targets,
      customTags: tags,
      tagDiscoveryDirs: [],
      ...(options.warnings ? { warnings: options.warnings } : {}),
      emitIr(ir) {
        result = ir;
        return "";
      },
    },
  );
  if (!result) throw new Error("no IR");
  return result;
}

function failure(run: () => unknown): {
  message: string;
  line: number;
  column: number;
} {
  try {
    run();
  } catch (error) {
    const e = error as { message: string; line: number; column: number };
    return { message: e.message, line: e.line, column: e.column };
  }
  throw new Error("expected a failure");
}

/** Direct DelegatedTag children of a node list, skipping whitespace text. */
function tags(nodes: readonly IrNode[]): DelegatedTag[] {
  return nodes
    .filter((node) => node.kind === "DelegatedTag")
    .map((node) => (node as Extract<IrNode, { kind: "DelegatedTag" }>).tag);
}

const attribute: CustomTag = {
  attributes: {
    type: { type: "string", enum: ["string", "int"] },
    required: { type: "boolean" },
  },
};

const vocabulary = (
  wildcard: NonNullable<CustomTag["children"]>["*"],
  extra: Record<string, CustomTag> = {},
): Record<string, CustomTag> => ({
  attributes: { children: { "*": wildcard } },
  attribute,
  ...extra,
});

describe('children["*"] by contract reference (decision 147)', () => {
  it("a matched child takes the canonical name and keeps its authored spelling as `alias`", () => {
    const source = '<attributes>\n  <title type="string"/>\n</attributes>\n';
    const ir = compile(
      source,
      vocabulary({ pattern: "[a-z][a-z0-9_]*", contract: "attribute" }),
    );
    const [parent] = tags(ir.body);
    const [child] = tags(parent?.children ?? []);
    expect(child?.name).toBe("attribute");
    const start = source.indexOf("title");
    expect(child?.alias).toEqual({
      authored: "title",
      span: expect.objectContaining({
        sourceStart: start,
        sourceEnd: start + "title".length,
      }),
      groups: {},
    });
    expect(child?.nameSpan).toEqual(child?.alias?.span);
  });

  it("the pattern is anchored by MX: a partial match is no match", () => {
    const error = failure(() =>
      compile(
        "<attributes>\n  <title2/>\n</attributes>\n",
        vocabulary({ pattern: "[a-z]+", contract: "attribute" }),
      ),
    );
    expect(error.message).toContain("`<title2>` is not allowed here");
  });

  it("named captures land in `alias.groups`", () => {
    const ir = compile(
      "<attributes><on_click/></attributes>\n",
      vocabulary(
        [
          { pattern: "on_(?<event>[a-z]+)", contract: "hook" },
          { contract: "attribute" },
        ],
        { hook: {} },
      ),
    );
    const [child] = tags(tags(ir.body)[0]?.children ?? []);
    expect(child?.name).toBe("hook");
    expect(child?.alias?.groups).toEqual({ event: "click" });
  });

  it("entries are tried in declaration order: the first match wins", () => {
    const ir = compile(
      "<attributes><on_click/><title/></attributes>\n",
      vocabulary(
        [
          { pattern: "on_[a-z]+", contract: "hook" },
          { pattern: "[a-z_]+", contract: "attribute" },
        ],
        { hook: {} },
      ),
    );
    const names = tags(tags(ir.body)[0]?.children ?? []).map((t) => [
      t.alias?.authored,
      t.name,
    ]);
    expect(names).toEqual([
      ["on_click", "hook"],
      ["title", "attribute"],
    ]);
    const reversed = compile(
      "<attributes><on_click/></attributes>\n",
      vocabulary(
        [
          { pattern: "[a-z_]+", contract: "attribute" },
          { pattern: "on_[a-z]+", contract: "hook" },
        ],
        { hook: {} },
      ),
    );
    expect(tags(tags(reversed.body)[0]?.children ?? [])[0]?.name).toBe(
      "attribute",
    );
  });

  it("an entry with no pattern is a catch-all", () => {
    const ir = compile(
      "<attributes><Title/></attributes>\n",
      vocabulary({ contract: "attribute" }),
    );
    expect(tags(tags(ir.body)[0]?.children ?? [])[0]?.alias?.authored).toBe(
      "Title",
    );
  });

  it("explicit entries win over `*`: an explicit name is never aliased", () => {
    const ir = compile("<attributes><title/></attributes>\n", {
      attributes: {
        children: { title: {}, "*": { contract: "attribute" } },
      },
      attribute,
    });
    const [child] = tags(tags(ir.body)[0]?.children ?? []);
    expect(child?.name).toBe("title");
    expect(child?.alias).toBeUndefined();
  });

  it("a declared tag is never aliased, and outside `*` it is still a closed-children error", () => {
    const error = failure(() =>
      compile(
        "<attributes>\n  <hook/>\n</attributes>\n",
        vocabulary({ pattern: "[a-z]+", contract: "attribute" }, { hook: {} }),
      ),
    );
    expect(error.message).toBe(
      "`<attributes>`: `<hook>` is not allowed here; names must match `[a-z]+` (`<hook>` is a registered tag, so the wildcard does not apply to it)",
    );
    expect([error.line, error.column]).toEqual([2, 2]);
  });

  it("a name that matches no entry is a positioned error listing the patterns and the explicit names", () => {
    const tagsWithExplicit: Record<string, CustomTag> = {
      attributes: {
        children: {
          id: {},
          "*": [
            { pattern: "^[a-z][a-z0-9_]*$", contract: "attribute" },
            { pattern: "on_[a-z]+", contract: "attribute" },
          ],
        },
      },
      attribute,
    };
    const error = failure(() =>
      compile(
        "<attributes>\n  <id/>\n  <Bad-Name/>\n</attributes>\n",
        tagsWithExplicit,
      ),
    );
    expect(error.message).toBe(
      "`<attributes>`: `<Bad-Name>` is not allowed here; allowed children: `<id>`; other names must match `^[a-z][a-z0-9_]*$` or `on_[a-z]+`",
    );
    expect([error.line, error.column]).toEqual([3, 2]);
  });

  it("the matched contract's E1 attributes apply, and messages print both names", () => {
    const error = failure(() =>
      compile(
        '<attributes>\n  <title kind="x"/>\n</attributes>\n',
        vocabulary({ contract: "attribute" }),
      ),
    );
    expect(error.message).toBe(
      "`<title>` (as `attribute`): unknown attribute `kind`",
    );
    expect(error.line).toBe(2);
    const required = failure(() =>
      compile("<attributes><title/></attributes>\n", {
        ...vocabulary({ contract: "attribute" }),
        attribute: { attributes: { type: { required: true } } },
      }),
    );
    expect(required.message).toBe(
      "`<title>` (as `attribute`): missing required attribute `type`",
    );
  });

  it("the matched contract's E2 children apply", () => {
    const tagsWithChildren = vocabulary(
      { contract: "attribute" },
      { attribute: { children: { constraint: {} } }, constraint: {} },
    );
    const ok = compile(
      "<attributes><field><constraint/></field></attributes>\n",
      tagsWithChildren,
    );
    const [title] = tags(tags(ok.body)[0]?.children ?? []);
    expect(tags(title?.children ?? []).map((t) => t.name)).toEqual([
      "constraint",
    ]);
    const error = failure(() =>
      compile(
        "<attributes><field><other/></field></attributes>\n",
        tagsWithChildren,
      ),
    );
    expect(error.message).toBe(
      "`<field>` (as `attribute`): `<other>` is not allowed here; allowed children: `<constraint>`",
    );
  });

  it("the matched contract's E4 attribute tags apply", () => {
    const tagsWithAttrTags = vocabulary(
      { contract: "attribute" },
      {
        attribute: {
          attributeTags: { doc: { attributes: { lang: { required: true } } } },
        },
      },
    );
    const ok = compile(
      '<attributes><field><@doc lang="en">x</@doc></field></attributes>\n',
      tagsWithAttrTags,
    );
    const [title] = tags(tags(ok.body)[0]?.children ?? []);
    expect(title?.attributeTags.map((t) => t.name)).toEqual(["doc"]);
    const error = failure(() =>
      compile(
        "<attributes><field><@note/></field></attributes>\n",
        tagsWithAttrTags,
      ),
    );
    expect(error.message).toBe(
      "`<field>` (as `attribute`): unknown attribute tag `<@note>`",
    );
  });

  it("the matched contract's `defaultTag` resolves an unnamed tag inside the child", () => {
    const ir = compile(
      "<attributes><field><.rule/></field></attributes>\n",
      vocabulary(
        { contract: "attribute" },
        { attribute: { defaultTag: "constraint" }, constraint: {} },
      ),
    );
    const [title] = tags(tags(ir.body)[0]?.children ?? []);
    expect(tags(title?.children ?? []).map((t) => t.name)).toEqual([
      "constraint",
    ]);
  });

  it("the transform of the referenced tag gets the canonical name and the alias", () => {
    let seen: TagCall | undefined;
    compile("<attributes><title/></attributes>\n", {
      attributes: { children: { "*": { contract: "attribute" } } },
      attribute: {
        transform(call) {
          seen = call;
          return [];
        },
      },
    });
    expect(seen?.name).toBe("attribute");
    expect(seen?.alias?.authored).toBe("title");
  });

  it("one identity: the canonical name counts against the parent's explicit cardinality", () => {
    const error = failure(() =>
      compile("<attributes>\n  <attribute/>\n  <title/>\n</attributes>\n", {
        attributes: {
          children: { attribute: {}, "*": { contract: "attribute" } },
        },
        attribute,
      }),
    );
    expect(error.message).toBe(
      "`<attributes>`: `<title>` (as `attribute`) may not be repeated",
    );
    expect(error.line).toBe(3);
  });

  it("the referenced tag's `parents` see the parent, and a child's `parents` see the canonical name", () => {
    const ir = compile("<attributes><title><rule/></title></attributes>\n", {
      attributes: { children: { "*": { contract: "attribute" } } },
      attribute: { parents: ["attributes"] },
      rule: { parents: ["attribute"] },
    });
    expect(tags(tags(ir.body)[0]?.children ?? [])[0]?.name).toBe("attribute");
  });

  it("a wildcard in an attribute-tag declaration's `children` fires there too", () => {
    const ir = compile("<entity><@fields><title/></@fields></entity>\n", {
      entity: {
        attributeTags: {
          fields: { children: { "*": { contract: "attribute" } } },
        },
      },
      attribute,
    });
    const [entity] = tags(ir.body);
    const fields = entity?.attributeTags[0];
    const [title] = tags(fields?.block.children ?? []);
    expect(title?.name).toBe("attribute");
    expect(title?.alias?.authored).toBe("title");
  });

  it("control flow between the parent and the child is transparent", () => {
    const ir = compile(
      "<attributes><if=input.a><title/></if><for|x| of=input.xs><body/></for></attributes>\n",
      vocabulary({ contract: "attribute" }),
    );
    const parent = tags(ir.body)[0];
    const json = JSON.stringify(parent?.children, (key, value) =>
      key === "node" || key === "paramNodes" ? undefined : value,
    );
    expect(json).toContain('"authored":"title"');
    expect(json).toContain('"authored":"body"');
  });

  it("the wildcard never reaches a grandchild through an uncontracted tag", () => {
    const ir = compile(
      "<attributes><field><plain><zork/></plain></field></attributes>\n",
      vocabulary({ contract: "attribute" }, { attribute: {} }),
    );
    const [title] = tags(tags(ir.body)[0]?.children ?? []);
    const [plain] = tags(title?.children ?? []);
    const [zork] = tags(plain?.children ?? []);
    expect(plain?.alias).toBeUndefined();
    expect(zork?.name).toBe("zork");
    expect(zork?.alias).toBeUndefined();
  });

  it("parse rules follow the name as written: a raw-text name keeps a raw-text body", () => {
    // Marko parses before the wildcard resolves anything, so `<title>`'s body
    // is text wherever the target's lookup says so (the data target
    // neutralizes these rules; html keeps them).
    const ir = compile(
      "<attributes><title>a <b/> c</title></attributes>\n",
      vocabulary({ contract: "attribute" }),
    );
    const [title] = tags(tags(ir.body)[0]?.children ?? []);
    expect(title?.alias?.authored).toBe("title");
    expect(title?.children.map((node) => node.kind)).toEqual(["Text"]);
  });

  it("structural names and built-in custom tags are never wildcard children", () => {
    const ir = compile(
      "<attributes><const/x=1/><title/></attributes>\n",
      vocabulary({ contract: "attribute" }),
    );
    expect(tags(tags(ir.body)[0]?.children ?? []).map((t) => t.name)).toEqual([
      "attribute",
    ]);
  });
});

describe('children["*"] inline contracts', () => {
  const inline: Record<string, CustomTag> = {
    env: {
      children: {
        "*": {
          pattern: "[A-Z][A-Z0-9_]*",
          attributes: { secret: { type: "boolean" } },
        },
      },
    },
  };

  it("validates the child with the inline contract and keeps the authored name", () => {
    const ir = compile("<env><PORT secret=false>3000</PORT></env>\n", inline);
    const [port] = tags(tags(ir.body)[0]?.children ?? []);
    expect(port?.name).toBe("PORT");
    expect(port?.alias?.authored).toBe("PORT");
    const error = failure(() => compile("<env><PORT size=1/></env>\n", inline));
    expect(error.message).toBe(
      "`<PORT>` (inline contract): unknown attribute `size`",
    );
  });

  it("a matched inline child on a target that needs a transform gets a targeted error", () => {
    const error = failure(() =>
      compile("<env><PORT secret=false>3000</PORT></env>\n", inline, {
        host: { ...native, name: "html" },
      }),
    );
    expect(error.message).toBe(
      '`<PORT>` (inline contract): an inline `children["*"]` contract has no transform; on html a matched child needs `contract:` naming a tag with a transform or template',
    );
  });

  it("a nested inline contract recurses", () => {
    const ir = compile("<env><DB><HOST/></DB></env>\n", {
      env: {
        children: {
          "*": {
            children: { "*": { pattern: "[A-Z]+" } },
          },
        },
      },
    });
    const [db] = tags(tags(ir.body)[0]?.children ?? []);
    const [host] = tags(db?.children ?? []);
    expect(host?.alias?.authored).toBe("HOST");
  });
});

describe('children["*"] recursion by reference', () => {
  it("a contract may reference itself, and a → b → a is fine", () => {
    const ir = compile("<tree><a><b><c/></b></a></tree>\n", {
      tree: { children: { "*": { contract: "node" } } },
      node: { children: { "*": { contract: "leaf" } } },
      leaf: { children: { "*": { contract: "node" } } },
    });
    const a = tags(tags(ir.body)[0]?.children ?? [])[0];
    const b = tags(a?.children ?? [])[0];
    const c = tags(b?.children ?? [])[0];
    expect([a?.name, b?.name, c?.name]).toEqual(["node", "leaf", "node"]);
    expect([a, b, c].map((t) => t?.alias?.authored)).toEqual(["a", "b", "c"]);
  });
});

describe("the did-you-mean guard (decision 147)", () => {
  const near: Record<string, CustomTag> = {
    attributes: {
      children: { title: {}, "*": { contract: "attribute" } },
    },
    attribute,
  };

  it("is an error when a wildcard child's name is near an explicit child of the same parent", () => {
    const error = failure(() =>
      compile("<attributes>\n  <titel/>\n</attributes>\n", near),
    );
    expect(error).toEqual({
      message:
        "`<titel>` (as `attribute`) matched the wildcard of `<attributes>`; did you mean the explicit child `<title>`?",
      line: 2,
      column: 2,
    });
  });

  it("stays silent for a name no explicit child is near", () => {
    const warnings: MxWarning[] = [];
    compile("<attributes><summary/></attributes>\n", near, { warnings });
    expect(warnings).toEqual([]);
  });
});

describe("text under a parent whose only entry is a wildcard", () => {
  it("says tags are accepted, not that there are none", () => {
    const error = failure(() =>
      compile("<resource>hello</resource>\n", {
        attribute: {},
        resource: {
          children: { "*": [{ pattern: "[a-z]+", contract: "attribute" }] },
        },
      }),
    );
    expect(error.message).toBe(
      "`<resource>`: text is not allowed here; it accepts only child tags: names matching `[a-z]+`",
    );
  });
});

describe('children["*"] registration errors', () => {
  const run = (tagsMap: Record<string, CustomTag>) =>
    failure(() => compile("<x/>\n", tagsMap));

  it("a pattern whose unbalanced `)` would escape the anchors", () => {
    expect(
      run({
        list: { children: { "*": { pattern: "a)|(?:b", contract: "x" } } },
        x: {},
      }).message,
    ).toMatch(
      /^`<list>`: `children\["\*"\]` entry 1 has an invalid `pattern` "a\)\|\(\?:b": /,
    );
  });

  it("an invalid regex", () => {
    expect(
      run({
        list: { children: { "*": { pattern: "(", contract: "x" } } },
        x: {},
      }).message,
    ).toMatch(
      /^`<list>`: `children\["\*"\]` entry 1 has an invalid `pattern` "\(": /,
    );
  });

  it("a `contract` naming no reachable tag", () => {
    expect(
      run({ list: { children: { "*": { contract: "nope" } } }, x: {} }).message,
    ).toBe(
      '`<list>`: `children["*"]` entry 1 references `contract: "nope"`, which is not a tag reachable from this compile',
    );
  });

  it("a `contract` together with inline keys", () => {
    expect(
      run({
        list: {
          children: { "*": { contract: "x", attributes: {} } as never },
        },
        x: {},
      }).message,
    ).toBe(
      '`<list>`: `children["*"]` entry 1 has both `contract` and an inline contract (`attributes`); use one',
    );
  });

  it("an unknown key in an entry", () => {
    expect(
      run({
        list: { children: { "*": { pattern: "a", as: "x" } as never } },
        x: {},
      }).message,
    ).toBe(
      'Unknown key "as" in the `children["*"]` entry 1 of tag "list"; allowed: pattern, contract, attributes, attributeTags, children, defaultTag',
    );
  });

  it("a non-string `pattern` or `contract`", () => {
    expect(
      run({ list: { children: { "*": { pattern: 1 } as never } } }).message,
    ).toBe('`<list>`: `children["*"]` entry 1: `pattern` must be a string');
    expect(run({ list: { children: { "*": { contract: "" } } } }).message).toBe(
      '`<list>`: `children["*"]` entry 1: `contract` must be a non-empty tag name',
    );
  });

  it("a referenced tag whose parse options cannot apply to the authored name", () => {
    expect(
      run({
        list: { children: { "*": { contract: "raw" } } },
        raw: { parseOptions: { text: true } },
      }).message,
    ).toBe(
      '`<list>`: `children["*"]` entry 1 references `<raw>`, which sets `parseOptions.text`; parse options apply to the name as written, before the wildcard resolves it',
    );
  });

  it("a referenced tag whose `parents` excludes the parent", () => {
    expect(
      run({
        list: { children: { "*": { contract: "item" } } },
        item: { parents: ["other"] },
      }).message,
    ).toBe(
      '`<list>`: `children["*"]` references `<item>`, which declares `parents` without `<list>`; add `<list>` to `<item>`\'s `parents`, or remove the reference',
    );
  });

  it("a child whose `parents` names the parent is reachable through the wildcard", () => {
    expect(() =>
      compile("<x/>\n", {
        list: { children: { "*": { contract: "item" } } },
        item: { parents: ["list"] },
        x: {},
      }),
    ).not.toThrow();
  });

  it("an inline contract that contains itself (the case a resolver cannot terminate)", () => {
    const entry: Record<string, unknown> = { pattern: "a" };
    entry.children = { "*": entry };
    expect(run({ list: { children: { "*": entry as never } } }).message).toBe(
      '`<list>`: `children["*"]` holds an inline contract that contains itself; declare it as a tag and refer to it with `contract`',
    );
  });
});

describe("an html-like host: the wildcard fires only inside a contract parent", () => {
  const html: Record<string, CustomTag> = {
    attributes: {
      children: { "*": { pattern: "[a-z]+", contract: "attribute" } },
      transform: (call, ctx) => [
        ctx.build.element("dl", [], call.content?.children ?? []),
      ],
    },
    attribute: {
      transform: (call, ctx) => [
        ctx.build.element("dt", [
          ctx.build.attr("data-name", call.alias?.authored ?? call.name),
        ]),
      ],
    },
  };

  it("native elements outside a contract parent are untouched", () => {
    const ir = compile("<section><title/></section>\n", html, { host: native });
    const [section] = ir.body.filter((n) => n.kind === "Element");
    expect(section).toMatchObject({ kind: "Element", name: "section" });
    const children = (section as Extract<IrNode, { kind: "Element" }>).children;
    expect(children[0]).toMatchObject({ kind: "Element", name: "title" });
  });

  it("inside a contract parent the same name goes through the referenced contract", () => {
    const ir = compile("<attributes><title/></attributes>\n", html, {
      host: native,
    });
    const json = JSON.stringify(ir.body, (key, value) =>
      key === "node" ? undefined : value,
    );
    expect(json).toContain('"name":"dt"');
    expect(json).toContain('"value":"title"');
    expect(json).not.toContain('"name":"title"');
  });
});
