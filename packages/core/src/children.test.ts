import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileSource } from "./compile.ts";
import { TranslateError } from "./core.ts";
import type {
  ChildNode,
  CustomTag,
  CustomTagChild,
  TagCall,
} from "./custom-tags.ts";
import type { HostDeclarations } from "./declarations.ts";
import { parseFragment } from "./fragment.ts";
import type { Ir, IrNode } from "./ir.ts";
import { testTargetLookup } from "./test-targets.ts";

const targets = testTargetLookup();
const declarations: HostDeclarations = {
  tags: {},
  isElement: () => true,
  isComponent: (name, ctx) => ctx.defines.has(name),
};

function compile(
  source: string,
  tags: Record<string, CustomTag>,
  policy = declarations,
): Ir {
  let result: Ir | undefined;
  compileSource(source, "/tmp/mx-children-test/page.mx", policy, {
    targets,
    customTags: tags,
    tagDiscoveryDirs: [],
    emitIr(ir) {
      result = ir;
      return "";
    },
  });
  if (!result) throw new Error("no IR");
  return result;
}

function range(nodes: readonly (IrNode | ChildNode)[]): {
  min: number;
  max: number;
  inFor: boolean;
} {
  let min = 0;
  let max = 0;
  let inFor = false;
  for (const node of nodes) {
    if (
      (node.kind === "Element" || node.kind === "ChildTag") &&
      node.name === "item"
    ) {
      min++;
      max++;
    } else if (node.kind === "For" || node.kind === "ChildFor") {
      const inner = range(node.kind === "For" ? node.children : node.nodes);
      if (inner.max > 0) {
        max = Infinity;
        inFor = true;
      }
    } else if (node.kind === "IfChain" || node.kind === "ChildIf") {
      const branches =
        node.kind === "IfChain"
          ? node.branches.map((branch) => range(branch.children))
          : node.branches.map((branch) => range(branch.nodes));
      const exhaustive =
        node.kind === "IfChain"
          ? node.branches.some((branch) => branch.condition === null)
          : node.branches.some((branch) => branch.unconditional);
      if (!exhaustive) {
        branches.push({ min: 0, max: 0, inFor: false });
      }
      min += Math.min(...branches.map((branch) => branch.min));
      max += Math.max(...branches.map((branch) => branch.max));
      inFor ||= branches.some((branch) => branch.inFor);
    }
  }
  return { min, max, inFor };
}

const cases = [
  ["if alone", "<if=input.a><item/></if>", 0, 1, false],
  ["if/else", "<if=input.a><item/></if><else><item/></else>", 1, 1, false],
  [
    "if/else-if/else",
    "<if=input.a><item/></if><else-if=input.b><item/></else-if><else><item/></else>",
    1,
    1,
    false,
  ],
  ["for", "<for|x| of=input.xs><item/></for>", 0, Infinity, true],
  [
    "for containing if",
    "<for|x| of=input.xs><if=x><item/></if></for>",
    0,
    Infinity,
    true,
  ],
  [
    "nested if in branch",
    "<if=input.a><if=input.b><item/></if><else><item/></else></if><else><item/></else>",
    1,
    1,
    false,
  ],
] as const;

describe("authored children step 0 measurement", () => {
  it.each(cases)(
    "measures %s and exposes its authored tree",
    (label, body, min, max, inFor) => {
      let seen: TagCall | undefined;
      compile(`<box>${body}</box>`, {
        box: {
          transform(call) {
            seen = call;
            return call.content?.children ?? [];
          },
        },
      });
      const measured = range(seen?.content?.children ?? []);
      console.log(
        `STEP 0 ${label}: min=${measured.min} max=${measured.max} inFor=${measured.inFor}`,
      );
      expect(measured).toEqual({ min, max, inFor });
      expect(seen).toHaveProperty("childTree");
      expect(range(seen?.childTree ?? [])).toEqual(measured);
    },
  );
});

const passthrough: CustomTag = {
  transform: (call) => call.content?.children ?? [],
};

function fails(
  source: string,
  children: Record<string, CustomTagChild>,
  message: string,
  line: number,
  column: number,
) {
  try {
    compile(source, { box: { ...passthrough, children } as CustomTag });
    throw new Error("expected contract failure");
  } catch (error) {
    expect(error).toBeInstanceOf(TranslateError);
    expect(error).toMatchObject({
      message: `\`<box>\`: ${message}`,
      line,
      column,
    });
  }
}

describe("closed authored children contracts (decision 138 E2)", () => {
  it("keeps children open when omitted and closes an empty declaration", () => {
    expect(() =>
      compile("<box><item/>text</box>", { box: passthrough }),
    ).not.toThrow();
    fails(
      "<box>\n  <bad/>\n</box>",
      {},
      "`<bad>` is not allowed here; allowed children: none",
      2,
      2,
    );
    expect(() =>
      compile("<box/>", { box: { ...passthrough, children: {} } as CustomTag }),
    ).not.toThrow();
  });

  it("says no child tags are accepted when an empty declaration rejects text", () => {
    fails(
      "<box>\n-- hello\n</box>",
      {},
      "text is not allowed here; it accepts no child tags",
      2,
      0,
    );
  });
  it("positions an unlisted child before lowering it, and reports only the first", () => {
    const bad = vi.fn(() => {
      throw new Error("must not transform");
    });
    try {
      compile("<box>\n  <bad/>\n  <other/>\n</box>", {
        box: { ...passthrough, children: { item: {} } } as CustomTag,
        bad: { transform: bad },
      });
      throw new Error("expected contract failure");
    } catch (error) {
      expect(error).toMatchObject({
        message:
          "`<box>`: `<bad>` is not allowed here; allowed children: `<item>`",
        line: 2,
        column: 2,
      });
    }
    expect(bad).not.toHaveBeenCalled();
  });
  it.each(["hello", `\${input.x}`, "$!{input.x}"])(
    "rejects text or interpolation %s",
    (text) => {
      fails(
        `<box>${text}</box>`,
        { item: {} },
        "text is not allowed here; it accepts only the child tags `<item>`",
        1,
        5,
      );
    },
  );
  it("allows #text and ignores whitespace, comments, const and define declarations", () => {
    const tag = {
      ...passthrough,
      children: { "#text": { repeatable: true } },
    } as CustomTag;
    expect(() =>
      compile(`<box>hello \${input.x} $!{input.y}</box>`, { box: tag }),
    ).not.toThrow();
    expect(() =>
      compile(
        "<box> \n <!-- comment --> <const/x=1/><define/Row><bad/></define> </box>",
        {
          box: { ...passthrough, children: {} } as CustomTag,
        },
      ),
    ).not.toThrow();
    fails(
      `<box>hello \${input.x}</box>`,
      { "#text": {} },
      "`<#text>` may not be repeated",
      1,
      11,
    );
    fails(
      "<box/>",
      { "#text": { required: true } },
      "missing required child `<#text>`",
      1,
      0,
    );
  });
  it("ignores preserved whitespace even with a required #text declaration", () => {
    expect(() =>
      compile("<box> \n  </box>", {
        box: {
          ...passthrough,
          children: {},
          parseOptions: { preserveWhitespace: true },
        },
      }),
    ).not.toThrow();
    fails(
      "<box> \n </box>",
      { "#text": { required: true } },
      "missing required child `<#text>`",
      1,
      0,
    );
  });
  it("counts script/style by name, without treating their bodies as parent text", () => {
    expect(() =>
      compile(
        "<box><script>const x = 1;</script><style>.x { color: red; }</style></box>",
        {
          box: {
            ...passthrough,
            children: { script: { required: true }, style: {} },
          },
        },
      ),
    ).not.toThrow();
  });
  it("allows unregistered children but preserves the target's unresolved-name error", () => {
    expect(() =>
      compile(
        "<box><item/></box>",
        { box: { ...passthrough, children: { item: {} } } },
        { ...declarations, isElement: () => false },
      ),
    ).toThrowError("unknown tag `<item>`");
  });
  it("uses branch minima and maxima, not the total authored leaf count", () => {
    fails(
      "<box><if=input.a><item/><item/></if><else><item/></else></box>",
      { item: { required: true } },
      "`<item>` may not be repeated",
      1,
      24,
    );
    fails(
      "<box><if=input.a><if=input.b><item/></if></if><else><item/></else></box>",
      { item: { required: true } },
      "missing required child `<item>`",
      1,
      0,
    );
    expect(() =>
      compile("<box><item/><for|x| of=input.xs><item/></for></box>", {
        box: {
          ...passthrough,
          children: { item: { required: true, repeatable: true } },
        },
      }),
    ).not.toThrow();
  });
  it("counts a define call by its authored name and does not descend into plain tags", () => {
    expect(() =>
      compile("<define/Row><bad/></define><box><Row/></box>", {
        box: {
          ...passthrough,
          children: { Row: { required: true } },
        } as CustomTag,
      }),
    ).not.toThrow();
    expect(() =>
      compile("<box><item><bad/></item></box>", {
        box: { ...passthrough, children: { item: {} } } as CustomTag,
      }),
    ).not.toThrow();
    fails(
      "<define/Row/><box><Row/></box>",
      {},
      "`<Row>` is not allowed here; allowed children: none",
      1,
      18,
    );
  });
  it("rejects a dynamic child before the host handles it", () => {
    fails(
      `<box>\n  <\${input.tag}/>\n</box>`,
      { item: {} },
      `a dynamic tag \`<\${…}>\` cannot be checked against the declared children`,
      2,
      2,
    );
  });
  it("counts a transform child by its written name, not its output", () => {
    expect(() =>
      compile("<box><item/></box>", {
        box: {
          ...passthrough,
          children: { item: { required: true } },
        } as CustomTag,
        item: { transform: (_call, ctx) => [ctx.build.element("bad")] },
      }),
    ).not.toThrow();
  });
  it("positions repetition at the second occurrence and missing at the call", () => {
    fails(
      "<box>\n  <item/>\n  <item/>\n</box>",
      { item: {} },
      "`<item>` may not be repeated",
      3,
      2,
    );
    fails(
      "<box/>\n",
      { item: { required: true } },
      "missing required child `<item>`",
      1,
      0,
    );
  });
  it.each(cases)("enforces path counts for %s", (_label, body, min, max) => {
    const source = `<box>${body}</box>`;
    const children = { item: { required: true, repeatable: true } };
    if (min === 0)
      fails(source, children, "missing required child `<item>`", 1, 0);
    else
      expect(() =>
        compile(source, { box: { ...passthrough, children } as CustomTag }),
      ).not.toThrow();
    if (max === Infinity)
      fails(
        source,
        { item: {} },
        "`<item>` may not be repeated",
        1,
        source.indexOf("<item"),
      );
    else
      expect(() =>
        compile(source, {
          box: { ...passthrough, children: { item: {} } } as CustomTag,
        }),
      ).not.toThrow();
  });
  it("accepts an exhaustive <else if> chain and skips layout between branches", () => {
    expect(() =>
      compile(
        "<box><if=input.a><item/></if>\n<!-- gap --><else if=input.b><item/></else>\n<else><item/></else></box>",
        {
          box: {
            ...passthrough,
            children: { item: { required: true } },
          } as CustomTag,
        },
      ),
    ).not.toThrow();
  });
  it("does not count attribute tags as plain children", () => {
    expect(() =>
      compile("<box><@row/></box>", {
        box: {
          ...passthrough,
          attributeTags: { row: {} },
          children: {},
          transform(call) {
            return call.attributeTags.flatMap((tag) => tag.block.children);
          },
        } as CustomTag,
      }),
    ).not.toThrow();
  });
  it("enforces children-only contract tags on delegated names", () => {
    const policy = { ...declarations, isDelegatedTag: () => true };
    const tags = { box: { children: { item: {} } } as CustomTag };
    expect(compile("<box><item/></box>", tags, policy).body[0]?.kind).toBe(
      "DelegatedTag",
    );
    expect(() => compile("<box><bad/></box>", tags, policy)).toThrowError(
      "`<bad>` is not allowed here",
    );
  });
  it("enforces a declaration-only sidecar on a template before its child lowers", () => {
    const directory = mkdtempSync(join(tmpdir(), "mx-child-contract-"));
    const filename = join(directory, "box.mx");
    const source = "<div/>";
    writeFileSync(filename, source);
    try {
      const tag = {
        template: { filename, source },
        children: { item: {} },
      } as CustomTag;
      expect(
        compile("<box><item/></box>", { box: tag }).body.some(
          (node) => node.kind === "Component",
        ),
      ).toBe(true);
      expect(() => compile("<box><bad/></box>", { box: tag })).toThrowError(
        "`<bad>` is not allowed here",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("exposes the authored child tree to analyze and transform", () => {
    let analyzed: TagCall | undefined;
    let transformed: TagCall | undefined;
    compile("<box><if=input.a><item/></if><else>text</else></box>", {
      box: {
        analyze(calls) {
          analyzed = calls[0];
        },
        transform(call) {
          transformed = call;
          return call.content?.children ?? [];
        },
      },
      item: { transform: (_call, ctx) => [ctx.build.element("changed")] },
    });
    expect(analyzed?.childTree).toEqual(transformed?.childTree);
    expect(transformed?.childTree).toMatchObject([
      {
        kind: "ChildIf",
        branches: [
          { unconditional: false, nodes: [{ kind: "ChildTag", name: "item" }] },
          { unconditional: true, nodes: [{ kind: "ChildText" }] },
        ],
      },
    ]);
  });
  it.each(["text", "openTagOnly"] as const)(
    "rejects children plus %s at registration in both front doors",
    (option) => {
      const customTags = {
        unused: {
          children: {},
          parseOptions: { [option]: true },
          ...passthrough,
        },
      } as Record<string, CustomTag>;
      const message = `\`<unused>\`: \`children\` cannot be combined with \`parseOptions.${option}: true\``;
      expect(() => compile("<div/>", customTags)).toThrowError(message);
      expect(() => parseFragment("<div/>", { customTags })).toThrowError(
        message,
      );
    },
  );
  it("rejects unknown child declaration keys before parsing", () => {
    // SAFETY: intentionally invalid runtime declaration exercises registration without TypeScript's schema.
    const customTags = {
      unused: { children: { item: { repeated: true } }, ...passthrough },
    } as unknown as Record<string, CustomTag>;
    expect(() => compile("<div/>", customTags)).toThrowError(
      'Unknown key "repeated" in the "item" child declaration of tag "unused"; allowed: repeatable, required',
    );
  });
});
