import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileSource } from "./compile.ts";
import { type Node, TranslateError } from "./core.ts";
import type {
  CustomTag,
  CustomTagAttributeTag,
  TagCall,
} from "./custom-tags.ts";
import type { HostDeclarations } from "./declarations.ts";
import { parseFragment } from "./fragment.ts";
import { getCustomTags } from "./scan-cache.ts";
import type { TemplateBackedTag } from "./template-tag.ts";
import { testTargetLookup } from "./test-targets.ts";

const targets = testTargetLookup();
const declarations: HostDeclarations = {
  tags: {},
  isElement: () => true,
  isComponent: () => false,
  attrTags: 2,
  resolveAttributeMethod: () => true,
};

function compile(source: string, row: CustomTagAttributeTag): TagCall {
  let seen: TagCall | undefined;
  compileSource(source, "/tmp/mx-attrtag-contract/page.mx", declarations, {
    targets,
    customTags: {
      card: {
        attributeTags: { row },
        declares: { kind: "node", from: "id" },
        transform(call) {
          seen = call;
          void call.attributeTags;
          return [];
        },
      },
    },
    tagDiscoveryDirs: [],
    warnings: [],
    emitIr: () => "",
  });
  if (!seen) throw new Error("no call");
  return seen;
}

// Independent authored-body measurement, before changing core's E2 walker.
// Reads the MX AST: tags are `MxTag` with a static `name.value`, children in
// `body` (null when the tag has none).
const tagName = (node: Node | undefined): string | undefined =>
  node?.type === "MxTag" && node.name.kind === "static"
    ? node.name.value
    : undefined;

function range(nodes: readonly Node[]): { min: number; max: number } {
  let min = 0;
  let max = 0;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const name = tagName(node);
    if (name === undefined) continue;
    if (name === "item") {
      min++;
      max++;
    } else if (name === "for") {
      if (range(node.body ?? []).max > 0) max = Infinity;
    } else if (name === "if") {
      const branches = [range(node.body ?? [])];
      let exhaustive = false;
      while (["else", "else-if"].includes(tagName(nodes[i + 1]) ?? "")) {
        const branch = nodes[++i];
        branches.push(range(branch.body ?? []));
        exhaustive = tagName(branch) === "else" && !branch.attributes?.length;
      }
      if (!exhaustive) branches.push({ min: 0, max: 0 });
      min += Math.min(...branches.map((b) => b.min));
      max += Math.max(...branches.map((b) => b.max));
    }
  }
  return { min, max };
}

const cases = [
  ["if", "<if=input.a><item/></if>", 0, 1],
  ["if/else", "<if=input.a><item/></if><else><item/></else>", 1, 1],
  [
    "if/else-if/else",
    "<if=input.a><item/></if><else-if=input.b><item/></else-if><else><item/></else>",
    1,
    1,
  ],
  ["for", "<for|x| of=input.xs><item/></for>", 0, Infinity],
  ["if in for", "<for|x| of=input.xs><if=x><item/></if></for>", 0, Infinity],
] as const;

describe("attribute-tag contracts step 0 (decision 138 E4)", () => {
  it.each(cases)(
    "measures authored children in @row: %s",
    (label, body, min, max) => {
      const parsed = parseFragment(`<card><@row>${body}</@row></card>`).body;
      const card = parsed.find((node: Node) => tagName(node) === "card");
      const row = card.body.find(
        (node: Node) =>
          node.type === "MxAttributeTag" && node.name.value === "row",
      );
      const measured = range(row.body);
      console.log(
        `STEP 0 @row ${label}: min=${measured.min} max=${measured.max}`,
      );
      expect(measured).toEqual({ min, max });
    },
  );
  it("enforces the measured if minimum on declared @row children", () => {
    expect(() =>
      compile("<card><@row><if=input.a><item/></if></@row></card>", {
        children: { item: { required: true } },
      }),
    ).toThrowError("`<card>`: `<@row>`: missing required child `<item>`");
  });
});

function fails(
  source: string,
  row: CustomTagAttributeTag,
  message: string,
  line = 1,
  column?: number,
): void {
  try {
    compile(source, row);
    throw new Error("expected contract failure");
  } catch (error) {
    expect(error).toBeInstanceOf(TranslateError);
    expect(error).toMatchObject({
      message,
      line,
      ...(column === undefined ? {} : { column }),
    });
  }
}

const row: CustomTagAttributeTag = {
  attributes: {
    n: { type: "number", required: true },
    mode: { enum: ["small", "large"] },
    enabled: { type: "boolean" },
    expr: { type: "expression" },
    literal: { literalOnly: true },
  },
};

const owner = "`<card>`: `<@row>`: ";

describe("recursive attribute-tag contracts (decision 138 E4)", () => {
  it("accepts authored attributes without rewriting them", () => {
    const call = compile(
      '<card><@row n=1 mode="small" enabled expr=input.x literal=[1]/></card>',
      row,
    );
    expect(
      call.attributeTags[0]?.attrs.map((attr) =>
        attr.kind === "spread" ? "..." : attr.name,
      ),
    ).toEqual(["n", "mode", "enabled", "expr", "literal"]);
  });
  it.each([
    ["n=1 bogus=2", "unknown attribute `bogus`"],
    ["", "missing required attribute `n`"],
    ['n="one"', "attribute `n` must be number, got string"],
    ['n=1 enabled="yes"', "attribute `enabled` must be boolean, got string"],
    ['n=1 expr="static"', "attribute `expr` must be an expression"],
    ["n=1 literal=input.x", "attribute `literal` must be a literal"],
    [
      'n=1 mode="tiny"',
      'attribute `mode` must be one of "small", "large", got "tiny"',
    ],
    [
      "n=1 mode=2",
      'attribute `mode` must be a string from "small", "large", got number',
    ],
    [
      "n=1 mode=input.mode",
      'attribute `mode` must be a static value from "small", "large"',
    ],
    [
      "n=1 ...rest",
      "spread attributes cannot be checked against this tag's declared attributes",
    ],
  ])("checks %s", (attrs, message) => {
    fails(`<card><@row ${attrs}/></card>`, row, owner + message);
  });
  it("positions unknown/typed attributes on the attribute and missing ones on @row", () => {
    fails(
      "<card>\n  <@row n=1 bogus=2/>\n</card>",
      row,
      `${owner}unknown attribute \`bogus\``,
      2,
      12,
    );
    fails(
      '<card>\n  <@row n="bad"/>\n</card>',
      row,
      `${owner}attribute \`n\` must be number, got string`,
      2,
      8,
    );
    fails(
      "<card>\n  <@row/>\n</card>",
      row,
      `${owner}missing required attribute \`n\``,
      2,
      2,
    );
  });
  it("empty attributes reject a named attribute and spread identically", () => {
    for (const attrs of ["n=1", "...rest"]) {
      fails(
        `<card><@row ${attrs}/></card>`,
        { attributes: {} },
        `${owner}accepts no attributes`,
      );
    }
  });
  it("keeps legacy no-declaration rejection, even on an attrTags-v2 host", () => {
    expect(() =>
      compileSource(
        "<card><@row n=1/></card>",
        "/no-declaration.mx",
        declarations,
        {
          targets,
          customTags: { card: { transform: () => [] } },
          tagDiscoveryDirs: [],
          emitIr: () => "",
        },
      ),
    ).toThrowError(
      "`<card>`: attribute tag `<@row>` does not support attributes",
    );
    fails(
      "<card><@row n=1/></card>",
      {},
      "`<card>`: attribute tag `<@row>` does not support attributes",
    );
    fails(
      "<card><@row><@item/></@row></card>",
      {},
      "`<card>`: attribute tag `<@row>` does not support nested attribute tags",
    );
    fails(
      "<card><if=input.a><@row/></if></card>",
      {},
      "`<card>`: attribute tag `<@row>` may not appear inside `<if>`; registered custom tags cannot preserve attribute-tag control flow",
    );
  });
  it("does not apply defaults or let them satisfy required attributes", () => {
    const defaults = {
      attributes: { n: { type: "number", default: 7 } },
    } satisfies CustomTagAttributeTag;
    expect(
      compile("<card><@row/></card>", defaults).attributeTags[0]?.attrs,
    ).toEqual([]);
    fails(
      "<card><@row/></card>",
      { attributes: { n: { required: true, default: 7 } } },
      `${owner}missing required attribute \`n\``,
    );
  });
  it("recurses through group/item and names the complete owner chain", () => {
    const nested = {
      attributeTags: { item: { ...row, required: true, repeatable: true } },
    };
    expect(
      compile("<card><@row><@item n=1/><@item n=2/></@row></card>", nested)
        .attributeTags[0]?.attributeTags,
    ).toHaveLength(2);
    fails(
      "<card><@row><@item n=1 bogus=2/></@row></card>",
      nested,
      `${owner}\`<@item>\`: unknown attribute \`bogus\``,
    );
    fails(
      "<card><@row><@bad/></@row></card>",
      nested,
      `${owner}unknown attribute tag \`<@bad>\``,
    );
    fails(
      "<card><@row/></card>",
      nested,
      `${owner}missing required attribute tag \`<@item>\``,
    );
    fails(
      "<card><@row><@item n=1/><@item n=2/></@row></card>",
      { attributeTags: { item: row } },
      `${owner}attribute tag \`<@item>\` may not be repeated`,
    );
  });
  it("accepts the brief's group/item spelling", () => {
    let seen: TagCall | undefined;
    compileSource(
      "<card><@group><@item n=1/></@group></card>",
      "/group.mx",
      declarations,
      {
        targets,
        customTags: {
          card: {
            attributeTags: { group: { attributeTags: { item: row } } },
            transform(call) {
              seen = call;
              void call.attributeTags;
              return [];
            },
          },
        },
        tagDiscoveryDirs: [],
        warnings: [],
        emitIr: () => "",
      },
    );
    expect(seen?.attributeTags[0]?.name).toBe("group");
  });
  it("enforces top-level row repetition and branch requirements", () => {
    fails(
      "<card><@row n=1/><@row n=2/></card>",
      row,
      "`<card>`: attribute tag `<@row>` may not be repeated",
      1,
      17,
    );
    expect(() =>
      compile("<card><@row n=1/><@row n=2/></card>", {
        ...row,
        repeatable: true,
      }),
    ).not.toThrow();
    fails(
      "<card><if=input.a><@row n=1/></if></card>",
      { ...row, required: true },
      "`<card>`: missing required attribute tag `<@row>`",
    );
    expect(() =>
      compile(
        "<card><if=input.a><@row n=1/></if><else><@row n=2/></else></card>",
        { ...row, required: true },
      ),
    ).not.toThrow();
  });
  it.each([{ attributes: {} }, { children: {} }])(
    "leaves omitted attributeTags recursively open on an extended declaration: %j",
    (contract) => {
      for (const body of [
        "<@x a=1/>",
        "<@x ...rest/>",
        "<@x a=1><@y b=2><@z c=3/></@y></@x>",
        "<if=input.a><@x a=1/></if>",
        "<for|x| of=input.xs><@x a=x/></for>",
      ]) {
        const call = compile(`<card><@row>${body}</@row></card>`, contract);
        expect(call.attributeTags[0]?.attributeTags[0]?.name).toBe("x");
        expect(call.attributeTags[0]?.attributeTags[0]?.attrs).toHaveLength(1);
      }
      const call = compile(
        "<card><@row><@x a=1/><@x a=2/></@row></card>",
        contract,
      );
      expect(call.attributeTags[0]?.attributeTags).toHaveLength(2);
    },
  );
  it("keeps declared legacy nested contracts byte-identical and explicit maps closed", () => {
    fails(
      "<card><@row><@x a=1/></@row></card>",
      { attributeTags: { x: {} } },
      `${owner}attribute tag \`<@x>\` does not support attributes`,
      1,
      16,
    );
    fails(
      "<card><@row><@x><@y/></@x></@row></card>",
      { attributeTags: { x: {} } },
      `${owner}attribute tag \`<@x>\` does not support nested attribute tags`,
      1,
      17,
    );
    fails(
      "<card><@row><@x/></@row></card>",
      { attributeTags: {} },
      `${owner}unknown attribute tag \`<@x>\``,
    );
    fails(
      "<card><@row><@x a=1/></@row></card>",
      { attributeTags: { x: { attributes: {} } } },
      `${owner}\`<@x>\`: accepts no attributes`,
    );
  });
  it("leaves omitted maps open only after an explicit extension and preserves host gates", () => {
    expect(() =>
      compile("<card><@row n=1/></card>", { children: {} }),
    ).not.toThrow();
    expect(() =>
      compile("<card><@row><@item/></@row></card>", { children: {} }),
    ).not.toThrow();
    expect(() =>
      compileSource(
        "<card><@row n=1/></card>",
        "/page.mx",
        { ...declarations, attrTags: undefined },
        {
          targets,
          customTags: { card: { attributeTags: { row }, transform: () => [] } },
          tagDiscoveryDirs: [],
          emitIr: () => "",
        },
      ),
    ).toThrowError(/attributes on attribute tags/);
  });
  it("checks attributes on each occurrence under if/for and preserves the tree", () => {
    for (const body of [
      "<if=input.a><@row n=1/></if><else><@row n=2/></else>",
      "<for|x| of=input.xs><@row n=x/></for>",
    ]) {
      const call = compile(`<card>${body}</card>`, {
        ...row,
        repeatable: true,
      });
      expect(call.attributeTagTree?.[0]?.kind).toMatch(/AttributeTag(If|For)/);
    }
    fails(
      '<card><for|x| of=input.xs><@row n="bad"/></for></card>',
      { ...row, repeatable: true },
      `${owner}attribute \`n\` must be number, got string`,
    );
    fails(
      "<card><if=input.a><@row/></if></card>",
      row,
      `${owner}missing required attribute \`n\``,
    );
  });
  it.each(cases)(
    "applies nested attribute-tag cardinality through %s",
    (_label, body, min, max) => {
      const atBody = body.replaceAll("<item/>", "<@item/>");
      const source = `<card><@row>${atBody}</@row></card>`;
      const item = { attributes: {}, required: true, repeatable: true };
      if (min === 0)
        fails(
          source,
          { attributeTags: { item } },
          `${owner}missing required attribute tag \`<@item>\``,
        );
      else
        expect(() =>
          compile(source, { attributeTags: { item } }),
        ).not.toThrow();
      if (max === Infinity)
        fails(
          source,
          { attributeTags: { item: { attributes: {} } } },
          `${owner}attribute tag \`<@item>\` may not be repeated`,
        );
    },
  );
});

describe("E1 vocabulary on attribute-tag attributes", () => {
  const composite: CustomTagAttributeTag = {
    attributes: {
      values: { type: "array", items: "string" },
      run: { type: "function" },
    },
  };
  it.each([
    'values=["a", value, ...rest] run=(x) => x',
    "values=[] run=function (x) { return x }",
    "values=list run=handler",
    "values=make() run=handlers.run",
    'values:=["a"] run:=handler',
    "run({ post }) { return post }",
  ])("accepts %s", (attrs) => {
    expect(() =>
      compile(`<card><@row ${attrs}/></card>`, composite),
    ).not.toThrow();
  });
  it.each([
    ['values="bad"', "attribute `values` must be array, got string"],
    ['values=["a", 2]', "attribute `values` item 2 must be string, got number"],
    ["values:=[1]", "attribute `values` item 1 must be string, got number"],
    ["run=[1]", "attribute `run` must be function, got array"],
    ["run={}", "attribute `run` must be function, got object"],
  ])("rejects %s", (attrs, message) => {
    fails(`<card><@row ${attrs}/></card>`, composite, owner + message);
  });
  it("positions array item errors at the item", () => {
    fails(
      '<card><@row values=["a",\n  2]/></card>',
      composite,
      `${owner}attribute \`values\` item 2 must be string, got number`,
      2,
      2,
    );
  });
});

describe("E1 vocabulary on attribute-tag attributes: atoms (decision 156 addendum 7)", () => {
  const atoms: CustomTagAttributeTag = {
    attributes: {
      mode: { type: "atom", values: ["a", "b"] },
      code: { type: "atom", pattern: "^[a-z]+$" },
      to: { type: "atom", ref: "node" },
    },
  };
  it.each([
    "mode=:a",
    "mode=[:a, :b]",
    "mode=cond ? :a : :b",
    "code=:abc",
    "to=:known",
    "mode=dynamicValue",
  ])("accepts %s", (attrs) => {
    expect(() =>
      compile(`<card#known><@row ${attrs}/></card>`, atoms),
    ).not.toThrow();
  });
  it.each([
    [
      'mode="a"',
      "attribute `mode` must be atom, got string (one of :a, :b)",
      1,
      23,
    ],
    [
      "mode=3",
      "attribute `mode` must be atom, got number (one of :a, :b)",
      1,
      23,
    ],
    [
      "mode=[:a, 2]",
      "attribute `mode` must be atom, got number (one of :a, :b)",
      1,
      28,
    ],
    ["mode=:zzz", "attribute `mode`: `:zzz` is not one of :a, :b", 1, 23],
    [
      "code=:A1",
      "attribute `code`: `:A1` does not match the pattern /^[a-z]+$/",
      1,
      23,
    ],
    [
      "to=:nope",
      "attribute `to`: `:nope` is not a declared node here (one of :known)",
      1,
      21,
    ],
  ])("rejects %s", (attrs, message, line, column) => {
    fails(
      `<card#known><@row ${attrs}/></card>`,
      atoms,
      owner + message,
      line,
      column,
    );
  });
});

describe("children on attribute tags (decision 138 E4, 16:50 ruling)", () => {
  it("rejects an unlisted child before its transform can run; first error only", () => {
    const bad = vi.fn(() => []);
    expect(() =>
      compileSource(
        "<card><@row>\n  <bad/><other/>\n</@row></card>",
        "/children.mx",
        declarations,
        {
          targets,
          customTags: {
            card: {
              attributeTags: { row: { children: { item: {} } } },
              transform: () => [],
            },
            bad: { transform: bad },
          },
          tagDiscoveryDirs: [],
          emitIr: () => "",
        },
      ),
    ).toThrowError(
      `${owner}\`<bad>\` is not allowed here; allowed children: \`<item>\``,
    );
    expect(bad).not.toHaveBeenCalled();
    fails(
      "<card><@row>\n  <bad/>\n</@row></card>",
      { children: { item: {} } },
      `${owner}\`<bad>\` is not allowed here; allowed children: \`<item>\``,
      2,
      2,
    );
  });
  it("rejects text without #text and accepts it when declared", () => {
    fails(
      "<card><@row>hello</@row></card>",
      { children: { item: {} } },
      owner +
        "text is not allowed here; it accepts only the child tags `<item>`",
      1,
      12,
    );
    fails(
      `<card><@row>\${input.x}</@row></card>`,
      { children: {} },
      `${owner}text is not allowed here; it accepts no child tags`,
    );
    expect(() =>
      compile(`<card><@row>hello \${input.x}</@row></card>`, {
        children: { "#text": { repeatable: true } },
      }),
    ).not.toThrow();
    expect(() =>
      compile("<card><@row> \n <!-- hi --><const/x=1/> </@row></card>", {
        children: {},
      }),
    ).not.toThrow();
  });
  it.each(cases)(
    "uses E2 required/repeatable ranges through %s",
    (_label, body, min, max) => {
      const source = `<card><@row>${body}</@row></card>`;
      const children = { item: { required: true, repeatable: true } };
      if (min === 0)
        fails(
          source,
          { children },
          `${owner}missing required child \`<item>\``,
        );
      else expect(() => compile(source, { children })).not.toThrow();
      if (max === Infinity)
        fails(
          source,
          { children: { item: {} } },
          `${owner}\`<item>\` may not be repeated`,
          1,
          source.indexOf("<item"),
        );
      else
        expect(() => compile(source, { children: { item: {} } })).not.toThrow();
    },
  );
  it("checks children at nested attribute-tag levels and keeps attribute tags out of child counts", () => {
    const nested = {
      children: {},
      attributeTags: { item: { children: { leaf: { required: true } } } },
    };
    expect(() =>
      compile("<card><@row><@item><leaf/></@item></@row></card>", nested),
    ).not.toThrow();
    fails(
      "<card><@row><@item><bad/></@item></@row></card>",
      nested,
      owner +
        "`<@item>`: `<bad>` is not allowed here; allowed children: `<leaf>`",
    );
    fails(
      "<card><@row><@item/></@row></card>",
      nested,
      `${owner}\`<@item>\`: missing required child \`<leaf>\``,
    );
  });
  it("rejects a dynamic child in a closed contract", () => {
    fails(
      `<card><@row><\${input.tag}/></@row></card>`,
      { children: {} },
      owner +
        `a dynamic tag \`<\${…}>\` cannot be checked against the declared children`,
    );
  });
  it("checks repeated children and #text cardinality", () => {
    fails(
      "<card><@row><item/><item/></@row></card>",
      { children: { item: {} } },
      `${owner}\`<item>\` may not be repeated`,
      1,
      19,
    );
    fails(
      "<card><@row/></card>",
      { children: { "#text": { required: true } } },
      `${owner}missing required child \`<#text>\``,
    );
    fails(
      `<card><@row>hello \${input.x}</@row></card>`,
      { children: { "#text": {} } },
      `${owner}\`<#text>\` may not be repeated`,
    );
  });
  it("checks a mixed plain-child/attribute-tag branch on authored names", () => {
    const nested = {
      children: { item: { required: true } },
      attributeTags: { slot: { attributes: {} } },
    };
    fails(
      "<card><@row><if=input.a><@slot/></if><else><item/></else></@row></card>",
      nested,
      `${owner}missing required child \`<item>\``,
    );
    expect(() =>
      compile(
        "<card><@row><if=input.a><@slot/></if><item/></@row></card>",
        nested,
      ),
    ).not.toThrow();
    // The pre-existing control-flow mixed-content guard is not lifted by E4.
    expect(() =>
      compile(
        "<card><@row><if=input.a><@slot/><item/></if><else><item/></else></@row></card>",
        nested,
      ),
    ).toThrowError(
      "Cannot have attribute tags and body content under a control flow tag.",
    );
  });
  it("does not descend into a plain child's own body", () => {
    expect(() =>
      compile("<card><@row><item><bad/></item></@row></card>", {
        children: { item: {} },
      }),
    ).not.toThrow();
  });
  it("checks children even on a template-backed tag", () => {
    const card = {
      template: {
        filename: "/tmp/mx-attrtag-contract/card.mx",
        source: "<div/>",
      },
      attributeTags: { row: { children: { item: {} } } },
    } satisfies TemplateBackedTag;
    expect(() =>
      compileSource(
        "<card><@row><bad/></@row></card>",
        "/page.mx",
        declarations,
        {
          targets,
          customTags: { card },
          tagDiscoveryDirs: [],
          emitIr: () => "",
        },
      ),
    ).toThrowError(
      `${owner}\`<bad>\` is not allowed here; allowed children: \`<item>\``,
    );
  });
});

describe("attribute-tag children/parents registration cross-check (round 2)", () => {
  function registry(
    row: CustomTagAttributeTag,
    parents: readonly string[] | undefined,
    nested: boolean,
  ): Record<string, CustomTag> {
    return {
      card: {
        attributeTags: nested ? { group: { attributeTags: { row } } } : { row },
        transform: () => [],
      },
      item: { parents: parents && [...parents], transform: () => [] },
    };
  }
  it.each([false, true])(
    "rejects a closed @row omitting its child at registration (nested=%s)",
    (nested) => {
      const rowOwner = nested
        ? "`<card>`: `<@group>`: `<@row>`"
        : "`<card>`: `<@row>`";
      const customTags = registry(
        { children: { other: {} } },
        ["@row"],
        nested,
      );
      const message = `\`<item>\`: parent ${rowOwner} declares \`children\` without \`<item>\`; add \`<item>\` to ${rowOwner}'s \`children\`, or remove \`<@row>\` from \`<item>\`'s \`parents\``;
      expect(() => parseFragment("<div/>", { customTags })).toThrowError(
        message,
      );
      expect(() =>
        compileSource("<div/>", "/unused.mx", declarations, {
          targets,
          customTags,
          tagDiscoveryDirs: [],
          emitIr: () => "",
        }),
      ).toThrowError(message);
    },
  );
  it.each([false, true])(
    "rejects @row listing a child whose parents omits @row (nested=%s)",
    (nested) => {
      const rowOwner = nested
        ? "`<card>`: `<@group>`: `<@row>`"
        : "`<card>`: `<@row>`";
      for (const parents of [[], ["other"], ["row"]]) {
        const customTags = registry(
          { children: { item: {} } },
          parents,
          nested,
        );
        expect(() => parseFragment("<div/>", { customTags })).toThrowError(
          `${rowOwner}: child \`<item>\` declares \`parents\` without \`<@row>\`; add \`<@row>\` to \`<item>\`'s \`parents\`, or remove \`<item>\` from ${rowOwner}'s \`children\``,
        );
      }
    },
  );
  it.each([false, true])(
    "checks every @row owner even when another declaration permits item (reverse=%s)",
    (reverse) => {
      for (const permitted of [{}, { children: { item: {} } }]) {
        const customTags = {
          ...registry({ children: {} }, ["@row"], true),
          other: { attributeTags: { row: permitted }, transform: () => [] },
        };
        const entries = Object.entries(customTags);
        expect(() =>
          parseFragment("<div/>", {
            customTags: Object.fromEntries(
              reverse ? entries.reverse() : entries,
            ),
          }),
        ).toThrowError(
          "parent `<card>`: `<@group>`: `<@row>` declares `children` without `<item>`",
        );
      }
    },
  );
  it("keeps omitted contracts, unregistered names, #root and #text open", () => {
    for (const nested of [false, true]) {
      for (const [row, parents] of [
        [{}, ["@row"]],
        [{ children: { item: {} } }, ["@row"]],
        [{ children: { item: {} } }, undefined],
        [{ children: { "#text": {}, external: {} } }, undefined],
      ] as const) {
        expect(() =>
          parseFragment("<div/>", {
            customTags: registry(row, parents, nested),
          }),
        ).not.toThrow();
      }
    }
    expect(() =>
      parseFragment("<div/>", {
        customTags: {
          item: { parents: ["@missing", "#root"], transform: () => [] },
        },
      }),
    ).not.toThrow();
  });
});

describe("recursive contract registration", () => {
  function register(declaration: CustomTagAttributeTag): void {
    parseFragment("<div/>", {
      customTags: {
        unused: {
          attributeTags: { group: { attributeTags: { row: declaration } } },
          transform: () => [],
        },
      },
    });
  }
  it.each([
    [{ repeated: true }, 'Unknown key "repeated"'],
    [{ attributes: { n: { typo: true } } }, 'Unknown key "typo"'],
    [{ children: { item: { attributes: {} } } }, 'Unknown key "attributes"'],
    [{ attributeTags: { inner: { typo: true } } }, 'Unknown key "typo"'],
    [
      { attributes: { values: { items: "string" } } },
      '`items` requires `type: "array"`',
    ],
    [
      { attributes: { values: { type: "array", items: "object" } } },
      "`items` must be one of string, number, boolean",
    ],
    [
      { attributes: { values: { type: "function", enum: ["x"] } } },
      '`enum` cannot be combined with `type: "function"`',
    ],
  ])("rejects invalid unused declarations at depth: %j", (invalid, message) => {
    // SAFETY: deliberately invalid runtime declaration verifies the pre-parse schema checks.
    expect(() =>
      register(invalid as unknown as CustomTagAttributeTag),
    ).toThrowError(message);
    expect(() =>
      register(invalid as unknown as CustomTagAttributeTag),
    ).toThrowError('tag "unused": "<@group>"');
    expect(() =>
      register(invalid as unknown as CustomTagAttributeTag),
    ).toThrowError(/"row"|"<@row>"/);
  });
  it("lists all six allowed attribute-tag keys", () => {
    // SAFETY: deliberately misspelled key exercises registration diagnostics.
    expect(() =>
      register({ typo: true } as unknown as CustomTagAttributeTag),
    ).toThrowError(
      "allowed: repeatable, required, attributes, attributeTags, children, defaultTag",
    );
  });
  it("does not widen the plain children vocabulary", () => {
    // SAFETY: children remain cardinality-only, not recursive tag declarations.
    const invalid = {
      card: { children: { item: { attributes: {} } }, transform: () => [] },
    } as unknown as Record<string, CustomTag>;
    expect(() => parseFragment("<div/>", { customTags: invalid })).toThrowError(
      "allowed: repeatable, required",
    );
  });
  it("loads recursive contracts from a discovered sidecar", () => {
    const directory = mkdtempSync(join(tmpdir(), "mx-attrtag-sidecar-"));
    try {
      mkdirSync(join(directory, "tags"));
      writeFileSync(
        join(directory, "package.json"),
        '{"name":"attrtag-contract"}',
      );
      writeFileSync(
        join(directory, "tags/card.tag.ts"),
        'export default { attributeTags: { row: { attributes: { n: { type: "number", required: true } }, children: { item: {} } } } };',
      );
      const filename = join(directory, "page.mx");
      const customTags = getCustomTags(filename, { targets });
      expect(() =>
        compileSource(
          '<card><@row n="bad"/></card>',
          filename,
          { ...declarations, isDelegatedTag: () => true },
          { targets, customTags, tagDiscoveryDirs: [], emitIr: () => "" },
        ),
      ).toThrowError(`${owner}attribute \`n\` must be number, got string`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
