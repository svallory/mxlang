import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileSource } from "./compile.ts";
import { TranslateError } from "./core.ts";
import type { CustomTag, TagCall } from "./custom-tags.ts";
import type { Policy } from "./declarations.ts";
import type { Attr, AttributeTag, Ir, IrNode } from "./ir.ts";
import { resetTemplateCache } from "./template-tag.ts";
import { lookup } from "./test-targets.ts";

function fakeDeclarations(overrides: Partial<Policy> = {}): Policy {
  return {
    tags: {},
    isElement: () => true,
    isComponent: (name, ctx) => ctx.defines.has(name),
    ...overrides,
  };
}

function lowerWithTags(
  source: string,
  customTags: Readonly<Record<string, CustomTag>>,
  policy = fakeDeclarations(),
): Ir {
  let ir: Ir | null = null;
  compileSource(source, "/tmp/mx-core-test/custom-tags.mx", policy, {
    customTags,
    targets: lookup,
    tagDiscoveryDirs: [],
    emitIr(lowered) {
      ir = lowered;
      return "";
    },
  });
  if (!ir) throw new Error("lowerer produced no IR");
  return ir;
}

function named(attrs: Attr[], name: string): Attr | undefined {
  return attrs.find((attr) => attr.kind !== "spread" && attr.name === name);
}

function find<K extends IrNode["kind"]>(
  nodes: IrNode[],
  kind: K,
): Extract<IrNode, { kind: K }> {
  for (const node of nodes) {
    if (node.kind === kind) return node as Extract<IrNode, { kind: K }>;
    const children =
      "children" in node && Array.isArray(node.children)
        ? (node.children as IrNode[])
        : [];
    for (const branch of node.kind === "IfChain" ? node.branches : []) {
      const hit = tryFind(branch.children, kind);
      if (hit) return hit;
    }
    const hit = tryFind(children, kind);
    if (hit) return hit;
  }
  throw new Error(`no ${kind} node in the IR`);
}

function tryFind<K extends IrNode["kind"]>(
  nodes: IrNode[],
  kind: K,
): Extract<IrNode, { kind: K }> | null {
  try {
    return find(nodes, kind);
  } catch {
    return null;
  }
}

const svgTag: CustomTag = {
  attributes: {
    name: { type: "string", required: true, literalOnly: true },
  },
  transform(call, ctx) {
    const name = named(call.attrs, "name");
    if (name?.kind !== "static") {
      throw ctx.fail("requires a static `name` attribute");
    }
    return [
      ctx.build.element(
        "svg",
        [ctx.build.attr("data-name", name.value)],
        [ctx.build.element("path", [ctx.build.attr("d", "M0 0")])],
      ),
    ];
  },
};

describe("custom tag transforms", () => {
  it("expands to ordinary IR that no host has to know about", () => {
    const ir = lowerWithTags('<icon name="check"/>\n', { icon: svgTag });
    const svg = find(ir.body, "Element");
    expect(svg).toMatchObject({ name: "svg" });
    expect(svg.attrs).toEqual([
      expect.objectContaining({
        kind: "static",
        name: "data-name",
        value: "check",
      }),
    ]);
    expect(tryFind(ir.body, "DelegatedTag")).toBeNull();
    expect(tryFind(ir.body, "Component")).toBeNull();
  });

  it("stamps synthetic nodes with the call site", () => {
    const ir = lowerWithTags('<div>\n  <icon name="check"/>\n</div>\n', {
      icon: svgTag,
    });
    const svg = find(ir.body, "Element").children[0];
    expect(svg).toMatchObject({ kind: "Element", name: "svg" });
    expect(svg?.loc.line).toBe(2);
    if (svg?.kind !== "Element") throw new Error("expected svg element");
    expect(svg.children[0]?.loc.line).toBe(2);
  });

  it("keeps author-written material's real position", () => {
    const passthrough: CustomTag = {
      transform: (call) => call.content?.children ?? [],
    };
    const ir = lowerWithTags("<box>\n  <p>hello</p>\n</box>\n", {
      box: passthrough,
    });
    expect(find(ir.body, "Element")).toMatchObject({
      name: "p",
      loc: { line: 2 },
    });
  });

  it("keeps `on*` on a custom tag call a dynamic prop, not an event", () => {
    // The `isElement` gate (decision 101): a custom tag is a call, so its
    // `onClick` is the tag author's own prop contract, not a DOM event. Only a
    // native element lowers `on<Name>` to `kind: "event"`.
    let seen: TagCall | null = null;
    const capture: CustomTag = {
      attributes: { onClick: { type: "expression" } },
      transform(call, ctx) {
        seen = call;
        return [ctx.build.text("")];
      },
    };
    lowerWithTags("<capture onClick=pick/>\n", { capture });
    expect(named((seen as unknown as TagCall).attrs, "onClick")).toMatchObject({
      kind: "dynamic",
      name: "onClick",
    });
  });

  it("gives transform attrs, content, attribute tags, and params", () => {
    let seen: TagCall | null = null;
    const capture: CustomTag = {
      attributeTags: { column: { repeatable: true } },
      transform(call, ctx) {
        seen = call;
        void call.attributeTags;
        return [ctx.build.text("")];
      },
    };
    lowerWithTags(
      [
        "<table-of|row| rows=input.rows>",
        "  <@column>a</@column>",
        "  <@column>b</@column>",
        "  body",
        "</table-of>",
      ].join("\n"),
      { "table-of": capture },
    );
    const call = seen as TagCall | null;
    expect(call?.name).toBe("table-of");
    expect(call?.params).toEqual(["row"]);
    expect(call?.var).toBeNull();
    expect(call?.attributeTags.map((tag) => tag.name)).toEqual([
      "column",
      "column",
    ]);
    expect(call?.content?.children.length).toBeGreaterThan(0);
  });

  it("revalidates a declared singular tag duplicated by a transform", () => {
    const directory = mkdtempSync(join(tmpdir(), "mx-transform-singular-"));
    const filename = join(directory, "tag.mx");
    const source = "export interface Input { item?: AttrTag }\n<div/>\n";
    writeFileSync(filename, source);
    const tag: CustomTag = {
      template: { filename, source },
      transform(call, ctx) {
        const item = call.attributeTags[0];
        return ctx.build.template({
          ...call,
          attributeTags: item ? [item, item] : [],
        });
      },
    } as CustomTag;
    try {
      expect(() =>
        lowerWithTags(
          "<tag><@item/></tag>\n",
          { tag },
          {
            ...fakeDeclarations(),
            attrTags: 2,
          },
        ),
      ).toThrowError("`<@item>` may appear at most once");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps declared array cardinality when a transform filters to one", () => {
    const directory = mkdtempSync(join(tmpdir(), "mx-transform-array-"));
    const filename = join(directory, "tag.mx");
    const source = "export interface Input { item?: AttrTag[] }\n<div/>\n";
    writeFileSync(filename, source);
    const tag: CustomTag = {
      template: { filename, source },
      transform(call, ctx) {
        return ctx.build.template({
          ...call,
          attributeTags: call.attributeTags.slice(0, 1),
        });
      },
    } as CustomTag;
    try {
      const ir = lowerWithTags(
        "<tag><@item/><@item/></tag>\n",
        { tag },
        {
          ...fakeDeclarations(),
          attrTags: 2,
        },
      );
      expect(find(ir.body, "Component").attrTagProps).toMatchObject([
        { name: "item", cardinality: "array" },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rebuilds an untyped fallback shape from the transformed occurrences", () => {
    const directory = mkdtempSync(join(tmpdir(), "mx-transform-fallback-"));
    const filename = join(directory, "tag.mx");
    const source = "<div/>\n";
    writeFileSync(filename, source);
    const tag: CustomTag = {
      attributeTags: { item: { repeatable: true } },
      template: { filename, source },
      transform(call, ctx) {
        return ctx.build.template({
          ...call,
          attributeTags: call.attributeTags.slice(0, 1),
        });
      },
    } as CustomTag;
    try {
      const ir = lowerWithTags(
        '<tag><@item/><@item label="removed"/></tag>\n',
        { tag },
        {
          ...fakeDeclarations(),
          attrTags: 2,
        },
      );
      expect(find(ir.body, "Component").attrTagProps).toMatchObject([
        { name: "item", cardinality: "single", as: "renderable" },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rebuilds unified nested shape and cardinality after filtering a parent occurrence", () => {
    const directory = mkdtempSync(join(tmpdir(), "mx-transform-nested-"));
    const filename = join(directory, "tag.mx");
    const source = "<div/>\n";
    writeFileSync(filename, source);
    const tag: CustomTag = {
      template: { filename, source },
      transform(call, ctx) {
        return ctx.build.template({
          ...call,
          attributeTags: call.attributeTags.slice(0, 1),
        });
      },
    } as CustomTag;
    try {
      const ir = lowerWithTags(
        '<tag><@tab><@icon>I</@icon></@tab><@tab><@icon k="1">J</@icon><@icon>K</@icon></@tab></tag>\n',
        { tag },
        {
          ...fakeDeclarations(),
          attrTags: 2,
        },
      );
      const tab = find(ir.body, "Component").attributeTags[0] as AttributeTag;
      expect(tab.attrTagProps).toMatchObject([
        { name: "icon", cardinality: "single", as: "renderable" },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps sibling parent plans isolated when a transform rebuilds them", () => {
    const directory = mkdtempSync(join(tmpdir(), "mx-transform-siblings-"));
    const filename = join(directory, "tag.mx");
    const source = "<div/>\n";
    writeFileSync(filename, source);
    const tag: CustomTag = {
      template: { filename, source },
      transform(call, ctx) {
        return ctx.build.template(call);
      },
    } as CustomTag;
    try {
      const ir = lowerWithTags(
        '<tag><@tab><@icon>I</@icon></@tab><@card><@icon k="1">J</@icon></@card></tag>\n',
        { tag },
        {
          ...fakeDeclarations(),
          attrTags: 2,
        },
      );
      const parents = find(ir.body, "Component").attributeTags;
      expect(parents.map((parent) => parent.attrTagProps)).toMatchObject([
        [{ name: "icon", cardinality: "single", as: "renderable" }],
        [{ name: "icon", cardinality: "single", as: "data" }],
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // Both of these tags are *template-less*: a sidecar `transform`, with no
  // `.mx` unit behind it. `/var` binds what a unit returns with `<return>`,
  // so a tag with no template has nothing to bind — which is a different
  // rejection from "this tag's template declares no `<return>`" (that one is
  // raised where the target's metadata is known, in `routeTemplateCall`).
  it("rejects `/var` on a template-less custom tag call", () => {
    const passthrough: CustomTag = {
      transform: (call) => call.content?.children ?? [],
    };
    expect(() =>
      lowerWithTags('\n<box/x name="a"><p>hi</p></box>\n', {
        box: passthrough,
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "TranslateError",
        message: expect.stringContaining(
          "`/var` on `<box>` is not supported: it has no template, so it has no `<return>` to bind",
        ),
        line: 2,
        column: 0,
      }),
    );
  });

  it("rejects `/var` on a sidecar custom tag call", () => {
    expect(() =>
      lowerWithTags('\n<icon/x name="check"/>\n', { icon: svgTag }),
    ).toThrowError(
      expect.objectContaining({
        name: "TranslateError",
        message: expect.stringContaining(
          "`/var` on `<icon>` is not supported: it has no template, so it has no `<return>` to bind",
        ),
        line: 2,
        column: 0,
      }),
    );
  });

  it("expands nested source calls inside-out", () => {
    const order: string[] = [];
    const wrap = (name: string): CustomTag => ({
      transform(call, ctx) {
        order.push(name);
        return [ctx.build.element(name, [], call.content?.children ?? [])];
      },
    });
    const ir = lowerWithTags("<outer><inner/></outer>\n", {
      outer: wrap("section"),
      inner: wrap("span"),
    });
    expect(order).toEqual(["span", "section"]);
    expect(find(ir.body, "Element")).toMatchObject({ name: "section" });
  });

  it("splices multiple roots in place", () => {
    const two: CustomTag = {
      transform: (_call, ctx) => [
        ctx.build.element("i"),
        ctx.build.element("b"),
      ],
    };
    const ir = lowerWithTags("<two/>\n", { two });
    expect(
      ir.body
        .filter((node) => node.kind === "Element")
        .map((node) => node.name),
    ).toEqual(["i", "b"]);
  });

  it("lets a custom tag override a host claim and request that primitive", () => {
    // `try` itself is a core-owned built-in (`builtin-tags.ts`) and cannot be
    // registered by a caller — see the "core-owned custom tags" describe
    // block below — so this exercises the general mechanism under a name the
    // core does not reserve.
    const boundary: CustomTag = {
      transform: (call, ctx) => [
        ctx.build.delegatedTag(
          "boundary",
          call.content?.children ?? [],
          call.attributeTags,
        ),
      ],
    };
    const ir = lowerWithTags(
      "<boundary><p>x</p></boundary>\n",
      { boundary },
      {
        ...fakeDeclarations(),
        isDelegatedTag: (name) => name === "boundary",
        resolveDelegatedTag: (name) => ({ name }),
      },
    );
    expect(find(ir.body, "DelegatedTag").tag).toMatchObject({
      name: "boundary",
      data: { name: "boundary" },
    });
  });

  it("refuses a host primitive the active host does not claim", () => {
    const tag: CustomTag = {
      transform: (_call, ctx) => [ctx.build.delegatedTag("missing", [], [])],
    };
    expect(() => lowerWithTags("<tag/>\n", { tag })).toThrowError(
      "`<tag>`: this host does not claim `<missing>`, so a custom tag cannot emit one",
    );
  });

  it("mints unique hygienic names across calls", () => {
    const names: string[] = [];
    const tag: CustomTag = {
      transform: (_call, ctx) => {
        names.push(ctx.gensym("value"));
        return [];
      },
    };
    lowerWithTags("<tag/><tag/>\n", { tag });
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^\$mx_tag_value\d+$/);
    expect(names[1]).not.toBe(names[0]);
  });

  it("wraps unexpected throws at the call site with the tag first", () => {
    const broken: CustomTag = {
      transform() {
        throw new Error("boom");
      },
    };
    expect(() => lowerWithTags("\n<broken/>\n", { broken })).toThrowError(
      expect.objectContaining({
        name: "TranslateError",
        message: expect.stringContaining("`<broken>`: custom tag threw: boom"),
        line: 2,
        column: 0,
      }),
    );
  });

  it("keeps ctx.fail's selected author position", () => {
    expect(() =>
      lowerWithTags("\n<icon name=input.name/>\n", { icon: svgTag }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining(
          "`<icon>`: attribute `name` must be a literal",
        ),
        line: 2,
      }),
    );
  });

  it("rejects a non-array return", () => {
    const broken = {
      transform: () => undefined,
    } as unknown as CustomTag;
    expect(() => lowerWithTags("<broken/>\n", { broken })).toThrowError(
      "`<broken>`: custom tag transform must return an array of IR nodes or a TagCall for its template",
    );
  });

  it("changes nothing when no custom tag is registered", () => {
    expect(() => lowerWithTags("<Missing/>\n", {})).toThrowError(
      /has no matching import or `<define>`/,
    );
  });

  it("does not treat names inherited through the map prototype as registrations", () => {
    const inherited = Object.create({ ghost: svgTag }) as Record<
      string,
      CustomTag
    >;
    const ir = lowerWithTags("<ghost/>\n", inherited);
    expect(find(ir.body, "Element")).toMatchObject({ name: "ghost" });
  });
});

describe("custom tag declarations", () => {
  const declared: CustomTag = {
    attributes: {
      name: {
        type: "string",
        required: true,
        literalOnly: true,
        enum: ["check", "x"],
      },
      size: { type: "number", literalOnly: true, default: 24 },
    },
    attributeTags: {
      item: { repeatable: true, required: true },
      footer: {},
    },
    transform(call) {
      void call.attributeTags;
      return [];
    },
  };

  it("rejects unknown attributes at the attribute", () => {
    expect(() =>
      lowerWithTags('\n<declared name="check" typo="x"><@item/></declared>\n', {
        declared,
      }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining(
          "`<declared>`: unknown attribute `typo`",
        ),
        line: 2,
      }),
    );
  });

  it("does not treat attributes inherited from Object.prototype as declared", () => {
    expect(() =>
      lowerWithTags(
        '\n<declared name="check" toString="x"><@item/></declared>\n',
        { declared },
      ),
    ).toThrowError(/unknown attribute `toString`/);
  });

  it("rejects the retired `staticOnly`/`repeated` declaration keys at registration", () => {
    // `staticOnly`/`repeated` were renamed to `literalOnly`/`repeatable`
    // (decision 2026-09-16). There is no legacy alias: a sidecar still
    // written against the old names fails registration like any other
    // unknown key, rather than registering with the option silently ignored.
    // Cast through `unknown` to write the retired key past `CustomTag`'s
    // current type, the same way a type-stripped `.tag.ts` sidecar would.
    const staleAttribute = {
      attributes: { name: { type: "string", staticOnly: true } },
      transform: () => [],
    } as unknown as CustomTag;
    expect(() =>
      lowerWithTags('<stale name="check"/>\n', { stale: staleAttribute }),
    ).toThrowError(
      /Unknown key "staticOnly" in the "name" attribute declaration of tag "stale"/,
    );

    const staleAttributeTag = {
      attributeTags: { item: { repeated: true } },
      transform: () => [],
    } as unknown as CustomTag;
    expect(() =>
      lowerWithTags("<stale/>\n", { stale: staleAttributeTag }),
    ).toThrowError(
      /Unknown key "repeated" in the "item" attribute tag declaration of tag "stale"/,
    );
  });

  it("rejects a missing required attribute at the call", () => {
    expect(() =>
      lowerWithTags("\n<declared><@item/></declared>\n", { declared }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining(
          "`<declared>`: missing required attribute `name`",
        ),
        line: 2,
        column: 0,
      }),
    );
  });

  it("rejects enum violations at the attribute", () => {
    expect(() =>
      lowerWithTags('\n<declared name="nope"><@item/></declared>\n', {
        declared,
      }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining(
          '`<declared>`: attribute `name` must be one of "check", "x", got "nope"',
        ),
        line: 2,
      }),
    );
  });

  it("rejects a boolean that spells an enum member as a string", () => {
    // `<t mode/>` is boolean `true`. Comparing through `String()` would let it
    // satisfy `enum: ["true"]`; with the declared type in hand it is the wrong
    // type, and the type check reports it before the enum branch is reached.
    const moded: CustomTag = {
      attributes: { mode: { type: "string", enum: ["true", "auto"] } },
      transform: () => [],
    };
    expect(() => lowerWithTags("\n<moded mode/>\n", { moded })).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining(
          "`<moded>`: attribute `mode` must be string, got boolean",
        ),
        line: 2,
      }),
    );
  });

  it("rejects a number that spells an enum member as a string", () => {
    // Same class as the boolean above: `size=24` is a numeric literal and must
    // not satisfy `enum: ["24"]`, whose members are strings.
    const sized: CustomTag = {
      attributes: { size: { type: "string", enum: ["24", "32"] } },
      transform: () => [],
    };
    expect(() => lowerWithTags("\n<sized size=24/>\n", { sized })).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining(
          "`<sized>`: attribute `size` must be string, got number",
        ),
        line: 2,
      }),
    );
  });

  it("rejects a non-string enum value when the declaration omits `type`", () => {
    // `enum` is `string[]`, so an undeclared type still means string. This is
    // the path the type check above does not cover, and the one where
    // comparing through `String()` silently accepted `24` and `true`.
    const loose: CustomTag = {
      attributes: { mode: { enum: ["true", "24"] } },
      transform: () => [],
    };
    for (const [source, got] of [
      ["\n<loose mode/>\n", "boolean"],
      ["\n<loose mode=24/>\n", "number"],
    ] as const) {
      expect(() => lowerWithTags(source, { loose })).toThrowError(
        expect.objectContaining({
          message: expect.stringContaining(
            `\`<loose>\`: attribute \`mode\` must be a string from "true", "24", got ${got}`,
          ),
          line: 2,
        }),
      );
    }
    expect(() =>
      lowerWithTags('\n<loose mode="24"/>\n', { loose }),
    ).not.toThrow();
  });

  it("supplies a declared default for an omitted attribute", () => {
    // The transform must see the default as an ordinary attribute, carrying a
    // real literal node, so a tag needs no fallback of its own.
    const seen: Array<{ kind: string; code?: string }> = [];
    const defaulted: CustomTag = {
      attributes: {
        size: { type: "number", default: 24 },
        label: { type: "string", default: "none" },
      },
      transform(call) {
        for (const attr of call.attrs) {
          if (attr.kind === "spread") continue;
          seen.push({
            kind: attr.kind,
            code: attr.kind === "dynamic" ? attr.value.code : undefined,
          });
        }
        return [];
      },
    };

    lowerWithTags("<defaulted/>\n", { defaulted });

    expect(seen).toEqual([
      { kind: "dynamic", code: "24" },
      { kind: "static", code: undefined },
    ]);
  });

  it("a declared default's fabricated literal carries no span", () => {
    // The text was never authored, so a span would point at unrelated
    // source — `Expr.span` must stay undefined rather than fabricated
    // (core contract C4, §3).
    let sizeExpr: { span?: unknown } | undefined;
    const defaulted: CustomTag = {
      attributes: { size: { type: "number", default: 24 } },
      transform(call) {
        const attr = call.attrs.find(
          (candidate) => candidate.kind === "dynamic",
        );
        sizeExpr = attr?.kind === "dynamic" ? attr.value : undefined;
        return [];
      },
    };

    lowerWithTags("<defaulted/>\n", { defaulted });

    expect(sizeExpr?.span).toBeUndefined();
  });

  it("leaves a supplied attribute alone rather than defaulting it", () => {
    let size: string | undefined;
    const defaulted: CustomTag = {
      attributes: { size: { type: "number", default: 24 } },
      transform(call) {
        const attr = call.attrs.find(
          (candidate) => candidate.kind === "dynamic",
        );
        size = attr?.kind === "dynamic" ? attr.value.code : undefined;
        return [];
      },
    };

    lowerWithTags("<defaulted size=32/>\n", { defaulted });

    expect(size).toBe("32");
  });

  it("accepts a static numeric literal and rejects a runtime expression", () => {
    expect(() =>
      lowerWithTags('\n<declared name="check" size=24><@item/></declared>\n', {
        declared,
      }),
    ).not.toThrow();
    expect(() =>
      lowerWithTags(
        '\n<declared name="check" size=input.size><@item/></declared>\n',
        { declared },
      ),
    ).toThrowError(/attribute `size` must be a literal/);
  });

  it("rejects unknown, repeated, and missing required attribute tags", () => {
    expect(() =>
      lowerWithTags('\n<declared name="check"><@unknown/></declared>\n', {
        declared,
      }),
    ).toThrowError("`<declared>`: unknown attribute tag `<@unknown>`");
    expect(() =>
      lowerWithTags('\n<declared name="check"><@toString/></declared>\n', {
        declared,
      }),
    ).toThrowError("`<declared>`: unknown attribute tag `<@toString>`");

    const oneFooter: CustomTag = {
      ...declared,
      attributeTags: { footer: {} },
    };
    expect(() =>
      lowerWithTags(
        '\n<declared name="check"><@footer/><@footer/></declared>\n',
        { declared: oneFooter },
      ),
    ).toThrowError(
      "`<declared>`: attribute tag `<@footer>` may not be repeated",
    );

    expect(() =>
      lowerWithTags('\n<declared name="check"/>\n', { declared }),
    ).toThrowError("`<declared>`: missing required attribute tag `<@item>`");
  });

  it("warns when transform silently drops authored attribute tags", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dropping: CustomTag = {
      attributeTags: { item: {} },
      transform: () => [],
    };
    lowerWithTags("<dropping><@item/></dropping>\n", { dropping });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("transform did not read its attributeTags"),
    );
    warn.mockRestore();
  });
});

describe("custom tag phase boundaries", () => {
  it("rejects a tag with neither a transform nor a template", () => {
    expect(() => lowerWithTags("<tag/>\n", { tag: {} })).toThrowError(
      "`<tag>`: custom tag has neither a `transform` nor a template file, so a call has nothing to expand to",
    );
  });
});

/**
 * Phase 5: `analyze`, `finalize` and `ctx.store`.
 *
 * The invariants these pin are the ones an author cannot check by reading one
 * file: that every `analyze` sees every call before any `transform` runs, that
 * `finalize` output is ordered by tag name rather than by the order the calls
 * happened to appear, and that a store belongs to one tag in one file and
 * nothing wider — a definition object is a module singleton the scan hands to
 * every file in a package, so a store keyed anywhere but the file's `Ctx`
 * would carry one page's collected state into the next.
 */
describe("analyze, finalize and the per-file store", () => {
  // A file using a tag with `analyze` is lowered twice: once over a scratch
  // `Ctx` to collect the calls, then for real. The scratch walk enters
  // through `lowerChildren` rather than `lower`, so it never got `lower`'s
  // `returnDepth = -1` and started one level deep — which made a
  // legitimately top-level `<return>` report as nested, but *only* in a file
  // that also used an `analyze` tag. Nothing else runs that second walk.
  it("accepts a top-level <return> in a file that also uses an analyze tag", () => {
    const collector: CustomTag = {
      analyze() {},
      transform: (_call, ctx) => [ctx.build.element("span", [], [])],
    };

    const ir = lowerWithTags("<marker/>\n<p>x</p>\n<return value=1/>\n", {
      marker: collector,
    });

    expect(ir.returnValue?.code).toBe("1");
  });

  it("still rejects a nested <return> in such a file", () => {
    // The fix restores the starting depth; it must not disable the rule.
    const collector: CustomTag = {
      analyze() {},
      transform: (_call, ctx) => [ctx.build.element("span", [], [])],
    };

    expect(() =>
      lowerWithTags("<marker/>\n<div><return value=1/></div>\n", {
        marker: collector,
      }),
    ).toThrow(/`<return>` must be at the top level/);
  });

  function textOf(node: IrNode): string {
    return node.kind === "Text" ? node.value : "";
  }

  it("runs analyze over every call before any transform runs", () => {
    const order: string[] = [];
    const tag: CustomTag = {
      analyze(calls) {
        order.push(`analyze:${calls.length}`);
      },
      transform(call) {
        const name = named(call.attrs, "n");
        order.push(`transform:${name?.kind === "static" ? name.value : "?"}`);
        return [];
      },
    };
    lowerWithTags('<tag n="a"/><tag n="b"/><tag n="c"/>\n', { tag });
    expect(order).toEqual([
      "analyze:3",
      "transform:a",
      "transform:b",
      "transform:c",
    ]);
  });

  it("hands analyze the same TagCall shape transform receives", () => {
    let analyzed: TagCall | null = null;
    let transformed: TagCall | null = null;
    const tag: CustomTag = {
      attributes: { n: { type: "string" }, size: { default: "24" } },
      analyze(calls) {
        analyzed = calls[0] ?? null;
      },
      transform(call) {
        transformed = call;
        return [];
      },
    };
    lowerWithTags('<tag n="a"><b>body</b></tag>\n', { tag });
    const seen = analyzed as TagCall | null;
    const later = transformed as TagCall | null;
    expect(seen).not.toBeNull();
    expect(later).not.toBeNull();
    expect(seen?.name).toBe(later?.name);
    expect(seen?.loc).toEqual(later?.loc);
    // Declared defaults are materialized before `analyze` too, so the two
    // hooks agree about what the call said.
    expect(named(seen?.attrs ?? [], "size")?.kind).toBe("static");
    expect(
      seen?.attrs.map((attr) => attr.kind !== "spread" && attr.name),
    ).toEqual(later?.attrs.map((attr) => attr.kind !== "spread" && attr.name));
    expect(seen?.content?.children.length).toBe(
      later?.content?.children.length,
    );
  });

  it("shares one store between analyze, transform and finalize", () => {
    const tag: CustomTag = {
      analyze(calls, ctx) {
        ctx.store.set("count", calls.length);
      },
      transform(_call, ctx) {
        return [ctx.build.text(`saw ${ctx.store.get<number>("count")}`)];
      },
      finalize(ctx) {
        return [ctx.build.text(`total ${ctx.store.get<number>("count")}`)];
      },
    };
    const ir = lowerWithTags("<tag/><tag/>\n", { tag });
    expect(ir.body.map(textOf)).toEqual(["total 2", "saw 2", "saw 2"]);
  });

  it("prepends finalize output to the program body", () => {
    const tag: CustomTag = {
      transform: (_call, ctx) => [ctx.build.text("call")],
      analyze: () => {},
      finalize: (ctx) => [ctx.build.text("sheet")],
    };
    const ir = lowerWithTags("<p>before</p><tag/>\n", { tag });
    expect(textOf(ir.body[0] as IrNode)).toBe("sheet");
  });

  it("orders finalize by tag name, not by call order", () => {
    function collecting(label: string): CustomTag {
      return {
        analyze: () => {},
        transform: () => [],
        finalize: (ctx) => [ctx.build.text(label)],
      };
    }
    const tags = { zebra: collecting("zebra"), alpha: collecting("alpha") };
    // `<zebra>` is called first and registered first; the prepended block is
    // still alphabetical, which is the whole point — otherwise output would
    // depend on the scan's directory listing.
    const ir = lowerWithTags("<zebra/><alpha/>\n", tags);
    expect(ir.body.map(textOf)).toEqual(["alpha", "zebra"]);
  });

  it("produces identical output across two runs and both call orders", () => {
    const icons: CustomTag = {
      attributes: {
        name: { type: "string", required: true, literalOnly: true },
      },
      analyze(calls, ctx) {
        const used = ctx.store.get<Set<string>>("used") ?? new Set<string>();
        for (const call of calls) {
          const name = named(call.attrs, "name");
          if (name?.kind === "static") used.add(name.value);
        }
        ctx.store.set("used", used);
      },
      transform: () => [],
      finalize(ctx) {
        const used = ctx.store.get<Set<string>>("used") ?? new Set<string>();
        return [ctx.build.text([...used].sort().join(","))];
      },
    };
    const forward = '<i name="b"/><i name="a"/><i name="b"/>\n';
    const reversed = '<i name="a"/><i name="b"/><i name="a"/>\n';
    const first = lowerWithTags(forward, { i: icons });
    const again = lowerWithTags(forward, { i: icons });
    const other = lowerWithTags(reversed, { i: icons });
    expect(textOf(first.body[0] as IrNode)).toBe("a,b");
    expect(textOf(again.body[0] as IrNode)).toBe("a,b");
    expect(textOf(other.body[0] as IrNode)).toBe("a,b");
  });

  it("keeps one file's store out of the next file's compile", () => {
    const tag: CustomTag = {
      analyze(calls, ctx) {
        const seen = ctx.store.get<number>("seen") ?? 0;
        ctx.store.set("seen", seen + calls.length);
      },
      transform: () => [],
      finalize: (ctx) => [ctx.build.text(`seen ${ctx.store.get("seen")}`)],
    };
    // The same definition object compiled twice, as the scan hands it to every
    // file in a package. A store keyed on the definition rather than on the
    // file's `Ctx` would report 3 the second time.
    const first = lowerWithTags("<tag/><tag/>\n", { tag });
    const second = lowerWithTags("<tag/>\n", { tag });
    expect(textOf(first.body[0] as IrNode)).toBe("seen 2");
    expect(textOf(second.body[0] as IrNode)).toBe("seen 1");
  });

  it("does not finalize a registered tag the file never calls", () => {
    const unused: CustomTag = {
      analyze: () => {},
      transform: () => [],
      finalize: (ctx) => [ctx.build.text("should not appear")],
    };
    const ir = lowerWithTags("<p>only markup</p>\n", { unused });
    expect(ir.body.map(textOf).join("")).not.toContain("should not appear");
  });

  it("keeps calls inside a tag template in that compilation unit", () => {
    const inner: CustomTag = {
      analyze: () => {},
      transform: (_call, ctx) => [ctx.build.text("inner")],
      finalize: (ctx) => [ctx.build.text("finalized")],
    };
    const outer = {
      template: { filename: "/tags/outer.mx", source: "<p><inner/></p>\n" },
    } as unknown as CustomTag;
    const ir = lowerWithTags("<outer/>\n", { inner, outer });
    expect(ir.body.filter((node) => textOf(node) === "finalized")).toHaveLength(
      0,
    );
  });

  it("hands analyze calls nested in templates and calls at file scope", () => {
    resetTemplateCache();
    let analyzed = 0;
    const inner: CustomTag = {
      analyze(calls) {
        analyzed = calls.length;
      },
      transform: (_call, ctx) => [ctx.build.text("inner")],
    };
    const outer = {
      template: {
        filename: "/tags/analyze-outer.mx",
        source: "<section><inner/><inner/></section>\n",
      },
    } as unknown as CustomTag;

    lowerWithTags("<outer/><inner/>\n", { inner, outer });

    expect(analyzed).toBe(1);
  });

  it("positions an analyze failure at the tag's first call", () => {
    const tag: CustomTag = {
      analyze(_calls, ctx) {
        throw ctx.fail("no good");
      },
      transform: () => [],
    };
    try {
      lowerWithTags("\n<p>x</p>\n<tag/>\n", { tag });
      expect.unreachable("analyze should have failed");
    } catch (error) {
      expect(error).toBeInstanceOf(TranslateError);
      expect((error as TranslateError).message).toContain("`<tag>`: no good");
      expect((error as TranslateError).line).toBe(3);
    }
  });

  it("wraps a non-TranslateError thrown by analyze, naming the hook", () => {
    const tag: CustomTag = {
      analyze() {
        throw new Error("boom");
      },
      transform: () => [],
    };
    expect(() => lowerWithTags("<tag/>\n", { tag })).toThrowError(
      "`<tag>`: custom tag `analyze` threw: boom",
    );
  });

  it("wraps a non-TranslateError thrown by finalize, naming the hook", () => {
    const tag: CustomTag = {
      transform: () => [],
      finalize() {
        throw new Error("boom");
      },
    };
    expect(() => lowerWithTags("<tag/>\n", { tag })).toThrowError(
      "`<tag>`: custom tag `finalize` threw: boom",
    );
  });

  it("rejects a finalize that returns something other than an array", () => {
    const tag = {
      transform: () => [],
      finalize: () => ({ kind: "Text", value: "nope" }),
    } as unknown as CustomTag;
    expect(() => lowerWithTags("<tag/>\n", { tag })).toThrowError(
      "`<tag>`: `finalize` must return an array of IR nodes",
    );
  });

  it("refuses ctx.build.delegatedTag in finalize", () => {
    const tag: CustomTag = {
      transform: () => [],
      finalize: (ctx) => [ctx.build.delegatedTag("try", [], [])],
    };
    expect(() => lowerWithTags("<tag/>\n", { tag })).toThrowError(
      "`<tag>`: `ctx.build.delegatedTag` is not available in `finalize`",
    );
  });

  it("refuses ctx.build.template in finalize", () => {
    const tag: CustomTag = {
      transform: () => [],
      finalize: (ctx) => ctx.build.template({} as TagCall),
    };
    expect(() => lowerWithTags("<tag/>\n", { tag })).toThrowError(
      "`<tag>`: `ctx.build.template` is not available in `finalize`",
    );
  });

  it("rejects a registration whose only hook is finalize", () => {
    const tag = { finalize: () => [] } as unknown as CustomTag;
    expect(() => lowerWithTags("<p>x</p>\n", { tag })).toThrowError(
      /`<tag>`: a custom tag that defines only `finalize`/,
    );
  });

  it("accepts a tag with analyze and transform but no finalize", () => {
    const tag: CustomTag = {
      analyze(calls, ctx) {
        ctx.store.set("n", calls.length);
      },
      transform: (_call, ctx) => [
        ctx.build.text(String(ctx.store.get<number>("n"))),
      ],
    };
    const ir = lowerWithTags("<tag/><tag/>\n", { tag });
    expect(ir.body.map(textOf)).toEqual(["2", "2"]);
  });

  it("does not emit the analyze pass's warnings a second time", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dropping: CustomTag = {
      attributeTags: { item: {} },
      analyze: () => {},
      transform: () => [],
    };
    lowerWithTags("<dropping><@item/></dropping>\n", { dropping });
    const drops = warn.mock.calls.filter((call) =>
      String(call[0]).includes("did not read its attributeTags"),
    );
    expect(drops).toHaveLength(1);
    warn.mockRestore();
  });
});

describe("custom tag parse options", () => {
  it("injects text mode before the caller is parsed", () => {
    let content: IrNode[] = [];
    const markdown: CustomTag = {
      parseOptions: { text: true },
      transform(call) {
        content = call.content?.children ?? [];
        return content;
      },
    };
    lowerWithTags("<markdown># title\n1 < 2 && 3 > 2</markdown>\n", {
      markdown,
    });
    expect(content).toEqual([
      expect.objectContaining({
        kind: "Text",
        value: "# title 1 < 2 && 3 > 2",
      }),
    ]);
  });

  it("injects preserveWhitespace mode before the caller is parsed", () => {
    let text = "";
    const preserve: CustomTag = {
      parseOptions: { preserveWhitespace: true },
      transform(call) {
        text =
          call.content?.children
            .filter((node) => node.kind === "Text")
            .map((node) => node.value)
            .join("") ?? "";
        return [];
      },
    };
    lowerWithTags("<preserve>\n  x\n</preserve>\n", { preserve });
    expect(text).toContain("\n  x\n");
  });

  it("injects openTagOnly mode before the caller is parsed", () => {
    const leaf: CustomTag = {
      parseOptions: { openTagOnly: true },
      transform: () => [],
    };
    expect(() => lowerWithTags("<leaf>body</leaf>\n", { leaf })).toThrow();
    expect(() => lowerWithTags("<leaf/>\n", { leaf })).not.toThrow();
  });
});

it("uses TranslateError for custom-tag diagnostics", () => {
  try {
    lowerWithTags("<icon/>\n", { icon: svgTag });
  } catch (error) {
    expect(error).toBeInstanceOf(TranslateError);
  }
});

describe("core-owned custom tags", () => {
  const tryDeclarations: Policy = {
    ...fakeDeclarations(),
    isDelegatedTag: (name) => name === "try",
    resolveDelegatedTag: (name) => ({ name }),
  };

  it("rejects a registered `try` custom tag as an attempt to shadow a built-in", () => {
    const shadow: CustomTag = { transform: () => [] };
    expect(() =>
      lowerWithTags("<try><p>x</p></try>\n", { try: shadow }, tryDeclarations),
    ).toThrowError(
      "`<try>` is a core-owned custom tag and cannot be shadowed by a registered custom tag of the same name",
    );
  });

  it("lowers a plain `<try>` to the host's `try` primitive with no attribute tags", () => {
    const ir = lowerWithTags("<try><p>x</p></try>\n", {}, tryDeclarations);
    const delegatedTag = find(ir.body, "DelegatedTag");
    expect(delegatedTag.tag).toMatchObject({ name: "try" });
    expect(delegatedTag.tag.attributeTags).toEqual([]);
  });

  it("passes `<@catch>`/`<@placeholder>` through as the host tag's attribute tags", () => {
    const ir = lowerWithTags(
      "<try><p>x</p><@catch|e|><p>${e}</p></@catch><@placeholder>wait</@placeholder></try>\n",
      {},
      tryDeclarations,
    );
    const delegatedTag = find(ir.body, "DelegatedTag");
    expect(
      delegatedTag.tag.attributeTags.map((tag) => tag.name).sort(),
    ).toEqual(["catch", "placeholder"]);
  });

  it.each([
    [
      "if",
      "<try><if=input.waiting><@placeholder>wait</@placeholder></if><p>body</p></try>\n",
      24,
    ],
    [
      "for",
      "<try><for|item| of=input.items><@placeholder>wait</@placeholder></for><p>body</p></try>\n",
      32,
    ],
    [
      "if",
      "<try><if=input.waiting><p/></if><else><@placeholder>wait</@placeholder></else></try>\n",
      39,
    ],
  ])(
    "rejects controlled attribute tags under <%s>",
    (control, source, column) => {
      let error: unknown;
      try {
        lowerWithTags(source, {}, { ...tryDeclarations, attrTags: 2 });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        message: expect.stringContaining(
          `attribute tag \`<@placeholder>\` may not appear inside \`<${control}>\``,
        ),
        line: 1,
        column,
      });
    },
  );

  it.each([
    [
      "attributes",
      '<try><@placeholder class="x">wait</@placeholder></try>\n',
      "does not support attributes",
    ],
    [
      "nested tags",
      "<try><@placeholder><@deep/></@placeholder></try>\n",
      "does not support nested attribute tags",
    ],
  ])(
    "rejects %s on registered attribute tags even on a v2 host",
    (_case, source, message) => {
      let error: unknown;
      try {
        lowerWithTags(source, {}, { ...tryDeclarations, attrTags: 2 });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        message: expect.stringContaining(message),
        line: 1,
        column: expect.any(Number),
      });
    },
  );

  it("rejects registered attribute-tag shapes before the legacy-host gate", () => {
    expect(() =>
      lowerWithTags(
        '<try><@placeholder class="x">wait</@placeholder></try>\n',
        {},
        tryDeclarations,
      ),
    ).toThrowError(
      "attribute tag `<@placeholder>` does not support attributes",
    );
  });

  it("rejects tag params on `<try>`", () => {
    expect(() =>
      lowerWithTags("<try|a|><p>x</p></try>\n", {}, tryDeclarations),
    ).toThrowError(/tag params .*on `<try>`/);
  });

  it("rejects a tag variable on `<try>`", () => {
    expect(() =>
      lowerWithTags("<try/v><p>x</p></try>\n", {}, tryDeclarations),
    ).toThrowError(/tag variable .*on `<try>`/);
  });

  it("rejects an unknown attribute tag inside `<try>`", () => {
    expect(() =>
      lowerWithTags(
        "<try><p>x</p><@other>y</@other></try>\n",
        {},
        tryDeclarations,
      ),
    ).toThrowError(/unknown attribute tag `<@other>`/);
  });

  it("rejects a repeated `<@catch>` inside `<try>`", () => {
    expect(() =>
      lowerWithTags(
        "<try><@catch>a</@catch><@catch>b</@catch></try>\n",
        {},
        tryDeclarations,
      ),
    ).toThrowError(/may not be repeated/);
  });

  it("rejects tag params on `<@placeholder>`", () => {
    expect(() =>
      lowerWithTags(
        "<try><@placeholder|v|>wait</@placeholder></try>\n",
        {},
        tryDeclarations,
      ),
    ).toThrowError(/tag params .*on `<@placeholder>`/);
  });

  // `<try>` is a structural pass-through: its body always reaches the host.
  // Decision 141 also keeps retained normalized spaces on ordinary tags;
  // built-ins still bypass the presence gate entirely.
  it("preserves a whitespace-only `<try>` body rather than dropping it", () => {
    const ir = lowerWithTags("<try>  </try>\n", {}, tryDeclarations);
    const delegatedTag = find(ir.body, "DelegatedTag");
    expect(delegatedTag.tag.children).toEqual([
      expect.objectContaining({ kind: "Text", value: " " }),
    ]);
  });

  it("preserves markup mixed with text in a `<try>` body", () => {
    const ir = lowerWithTags("<try>a <b>c</b></try>\n", {}, tryDeclarations);
    const delegatedTag = find(ir.body, "DelegatedTag");
    expect(delegatedTag.tag.children).toMatchObject([
      { kind: "Text", value: "a " },
      { kind: "Element", name: "b" },
    ]);
  });

  // Round 1 item 2: a shadowing registration that also sets `parseOptions`
  // used to change how the parser itself read `<try>` before lowering ever
  // ran, surfacing an unrelated parser error instead of the shadow
  // diagnostic. `createTranslator`/`parseOnlyTranslator` now reject the
  // registration before any parse.
  it("rejects a shadowing `try` registration with `parseOptions` before parsing", () => {
    const shadow: CustomTag = {
      parseOptions: { openTagOnly: true },
      transform: () => [],
    };
    expect(() =>
      lowerWithTags("<try><p>x</p></try>\n", { try: shadow }, tryDeclarations),
    ).toThrowError(
      "`<try>` is a core-owned custom tag and cannot be shadowed by a registered custom tag of the same name",
    );
  });

  // Round 1 item 3: an empty `attributes: {}` declaration used to report
  // "spread attributes cannot be checked against this tag's declared
  // attributes" for `<try ...rest>` — a message describing the checker
  // rather than the author's actual mistake.
  it("reports a spread on `<try>` as accepting no attributes", () => {
    expect(() =>
      lowerWithTags("<try ...rest><p>x</p></try>\n", {}, tryDeclarations),
    ).toThrowError("accepts no attributes");
  });
});

// Ref custom-tags-import-precedence: spec §4's precedence (explicit import >
// local `tags/` > `mx.tags`) means a file-local binding must win over a
// registered custom tag of the same name, not the other way around.
// Real-host coverage (an imported/`<define>`d PascalCase component winning
// over a registered custom tag, and a lowercase import *not* shadowing one)
// lives in `packages/targets/html/src/translate.test.ts`'s "import precedence
// over registered custom tags" describe block, against the real `compile()`
// entry point rather than a synthetic policy — see item 2 of round 1's
// review. What's left here is IR-level coverage a host-level test can't
// reach as directly: the casing gate itself, and that the fix doesn't
// disturb precedence rules it isn't supposed to touch.
describe("import precedence over registered custom tags (IR-level)", () => {
  const componentPolicy: Policy = {
    ...fakeDeclarations(),
    isComponent: (name, ctx) => ctx.defines.has(name) || ctx.imports.has(name),
  };

  // This is the regression round 1 found: `fileLocalBinding` had no casing
  // guard, so a *lowercase* import shadowed a registered custom tag of the
  // same name even though no host ever treats a lowercase local variable as
  // a component (Marko's own rule — html `translate.ts`'s `isComponent`,
  // preact `emitter.ts`'s `isComponentName`). Without the `/^[A-Z]/` guard
  // in `lower.ts`, this test fails: the `<panel>` call would route to
  // `Component` instead of expanding the custom tag.
  it("does not let a lowercase import shadow a registered custom tag of the same name", () => {
    const panel: CustomTag = {
      transform: (_call, ctx) => [ctx.build.element("mx-marker", [], [])],
    };
    const ir = lowerWithTags(
      'import panel from "./panel.marko"\n<panel/>\n',
      { panel },
      componentPolicy,
    );
    expect(find(ir.body, "Element").name).toBe("mx-marker");
  });

  // The `!fileLocalBinding && isDelegatedTag(...)` branch (lower.ts, gating a
  // host claim on the absence of a file-local binding) is currently
  // unreachable by any real host: every host that claims tags beyond `try`
  // and the dynamic-tag sentinel (only `@mxlang/html`, for `let`/`server`/
  // `html-comment`/`html-script`/`html-style`/`style`) claims exclusively
  // lowercase names, and the casing gate above means `fileLocalBinding` is
  // never true for a lowercase name in the first place — so on every real
  // host the `!fileLocalBinding &&` in front of `isDelegatedTag` never changes
  // the outcome. This test exercises it directly against a synthetic policy
  // that claims a PascalCase name, purely to pin the order the code encodes
  // (file-local binding wins over a host claim) should a host ever claim a
  // PascalCase tag; it is not evidence of a real-host code path today. See
  // AGENTS.md's custom-tags precedence bullet for the same caveat.
  it("would resolve a file-local binding over a host claim of the same PascalCase name (currently unreachable by any real host)", () => {
    const ir = lowerWithTags(
      'import Boundary from "./boundary.marko"\n<Boundary/>\n',
      {},
      {
        ...componentPolicy,
        isDelegatedTag: (name) => name === "Boundary",
        resolveDelegatedTag: (name) => ({ name }),
      },
    );
    expect(find(ir.body, "Component").target).toMatchObject({
      kind: "name",
      name: "Boundary",
    });
  });
});

// Ref custom-tags-local-bindings (decision 113): a *file-local scope*
// binding — `<const/Panel=…/>`, a `<for|Panel|>` param, or a
// `<define/Box|Panel|>` param — wins over a registered custom tag of the
// same name too, exactly like an `import`/`<define>` name (spec §4,
// extended). Measured against Marko 6.3.51's own translator
// (`normalizeTag`, `@marko/runtime-tags/dist/translator/index.js:5852-5860`):
// `tag.scope.getBinding(tagName)` — Babel's scope-binding lookup, covering
// `const`, `for`-params, and `define`-params uniformly — is checked before
// any custom-tag/taglib resolution, unconditionally, gated only by
// `TAG_NAME_IDENTIFIER_REG` (a capitalized name). MX's `ctx.tagVarShadowed`
// is the same scope-tracking set for the same three binding forms.
describe("local scope bindings shadow a registered custom tag (IR-level)", () => {
  const componentPolicy: Policy = {
    ...fakeDeclarations(),
    isComponent: (name, ctx) => ctx.defines.has(name) || ctx.imports.has(name),
  };

  const panel: CustomTag = {
    transform: (_call, ctx) => [ctx.build.element("mx-marker", [], [])],
  };

  it("a `<const/Panel=…/>` binding wins over a registered `Panel` custom tag", () => {
    const ir = lowerWithTags(
      '<const/Panel=() => "x"/>\n<Panel/>\n',
      { Panel: panel },
      componentPolicy,
    );
    expect(find(ir.body, "Component").target).toMatchObject({
      kind: "name",
      name: "Panel",
    });
  });

  it("a `<for|Panel|>` param wins over a registered `Panel` custom tag, only inside the loop body", () => {
    const ir = lowerWithTags(
      "<for|Panel| of=[1]>\n  <Panel/>\n</for>\n<Panel/>\n",
      { Panel: panel },
      componentPolicy,
    );
    const forNode = find(ir.body, "For");
    // A tag param's runtime value can never be inspected at lowering time,
    // so it is always "unknown" (local extension of decision 116) and
    // routes dynamic — it still wins over the registered custom tag
    // (proving the shadowing itself), just not as a direct `"name"` call.
    expect(find(forNode.children, "Component").target).toMatchObject({
      kind: "dynamic",
      valueImportBinding: "Panel",
    });
    // Outside the loop, the name is unbound again: the registered custom tag
    // expands, not a component call.
    const rest = ir.body.slice(ir.body.indexOf(forNode) + 1);
    expect(find(rest, "Element").name).toBe("mx-marker");
  });

  it("a `<define/Box|Panel|>` param wins over a registered `Panel` custom tag, only inside the define body", () => {
    const ir = lowerWithTags(
      "<define/Box|Panel|>\n  <Panel/>\n</define>\n<Box/>\n<Panel/>\n",
      { Panel: panel },
      componentPolicy,
    );
    const define = find(ir.body, "Define");
    // Same reasoning as the `<for|Panel|>` case above: a tag param is always
    // "unknown" and routes dynamic.
    expect(find(define.children, "Component").target).toMatchObject({
      kind: "dynamic",
      valueImportBinding: "Panel",
    });
    const rest = ir.body.slice(ir.body.indexOf(define) + 1);
    // `<Box/>` itself is an ordinary component call (a `<define>` name), not
    // the shadowing under test; only the *trailing* bare `<Panel/>` proves
    // the scope reverted outside `<define>`.
    expect(find(rest, "Element").name).toBe("mx-marker");
  });

  // Round 2 (lead review): `<const>` never calls its own `shadowBindings`
  // restore (by design — it shadows for the rest of *its enclosing scope*),
  // so the leak-prevention has to come entirely from the *branch's own*
  // `scopeBindings` wrapper. Before the round-2 fix, `scopeBindings`
  // snapshotted `ctx.bindings` but not `ctx.tagVarShadowed`, so a `<const>`
  // written inside an `<if>` branch permanently replaced
  // `ctx.tagVarShadowed` — leaking the shadow past the branch for the rest
  // of the file. Matches the Marko measurement in the brief: Marko reverts
  // to the registered tag immediately outside the `<if>`.
  it("a `<const/Panel=…/>` binding inside an `<if>` branch does not leak past the branch", () => {
    const ir = lowerWithTags(
      '<if=true>\n<const/Panel=() => "x"/>\n<Panel/>\n</if>\n<Panel/>\n',
      { Panel: panel },
      componentPolicy,
    );
    const ifChain = find(ir.body, "IfChain");
    expect(
      find(ifChain.branches[0]?.children ?? [], "Component").target,
    ).toMatchObject({
      kind: "name",
      name: "Panel",
    });
    const rest = ir.body.slice(ir.body.indexOf(ifChain) + 1);
    expect(find(rest, "Element").name).toBe("mx-marker");
  });

  it("a `<const/Panel=…/>` binding inside an `<else>` branch does not leak past the chain", () => {
    const ir = lowerWithTags(
      '<if=false>\n<p>a</p>\n</if>\n<else>\n<const/Panel=() => "x"/>\n<Panel/>\n</else>\n<Panel/>\n',
      { Panel: panel },
      componentPolicy,
    );
    const ifChain = find(ir.body, "IfChain");
    expect(
      find(ifChain.branches[1]?.children ?? [], "Component").target,
    ).toMatchObject({ kind: "name", name: "Panel" });
    const rest = ir.body.slice(ir.body.indexOf(ifChain) + 1);
    expect(find(rest, "Element").name).toBe("mx-marker");
  });

  it("a `<const/Panel=…/>` binding inside an `<if>` nested in a `<for>` body does not leak past either scope", () => {
    const ir = lowerWithTags(
      '<for|x| of=[1]>\n<if=true>\n<const/Panel=() => "x"/>\n<Panel/>\n</if>\n<Panel/>\n</for>\n<Panel/>\n',
      { Panel: panel },
      componentPolicy,
    );
    const forNode = find(ir.body, "For");
    const ifChain = find(forNode.children, "IfChain");
    expect(
      find(ifChain.branches[0]?.children ?? [], "Component").target,
    ).toMatchObject({
      kind: "name",
      name: "Panel",
    });
    // Outside the `<if>` but still inside the `<for>` body: the const's
    // shadow must not have escaped the `<if>` branch either.
    const afterIf = forNode.children.slice(
      forNode.children.indexOf(ifChain) + 1,
    );
    expect(find(afterIf, "Element").name).toBe("mx-marker");
    // Outside the `<for>` entirely.
    const rest = ir.body.slice(ir.body.indexOf(forNode) + 1);
    expect(find(rest, "Element").name).toBe("mx-marker");
  });
});

/**
 * Decision 130: a custom tag that declares only a contract (no `transform`, no
 * template) is valid on a name the active host claims. Core validates the call,
 * then lowers it to the same `DelegatedTag` an unregistered claimed tag would be.
 */
describe("contract-only custom tags", () => {
  const attribute: CustomTag = {
    attributes: {
      value: { type: "string", required: true },
      type: { type: "string", required: true, enum: ["string", "enum"] },
      public: { type: "boolean" },
    },
  };
  const claimAttribute = (): Policy =>
    fakeDeclarations({
      isDelegatedTag: (name) => name === "attribute",
      resolveDelegatedTag: (name) => ({ name }),
    });

  it("lowers a claimed contract-only tag to a DelegatedTag that carries its attributes", () => {
    const source = '<attribute="title" type="string" public/>\n';
    const ir = lowerWithTags(source, { attribute }, claimAttribute());
    const { tag } = find(ir.body, "DelegatedTag");
    expect(tag.name).toBe("attribute");
    expect(tag.data).toEqual({ name: "attribute" });
    expect(tag.attrs.map((attr) => attr.kind)).toEqual([
      "static",
      "static",
      "boolean",
    ]);
    expect(named(tag.attrs, "type")).toMatchObject({
      kind: "static",
      value: "string",
    });
    expect(named(tag.attrs, "public")).toMatchObject({ kind: "boolean" });
  });

  it("keeps each attribute's name span", () => {
    const source = '<attribute value="a" type="string"/>\n';
    const { tag } = find(
      lowerWithTags(source, { attribute }, claimAttribute()).body,
      "DelegatedTag",
    );
    const typeAttr = named(tag.attrs, "type");
    if (!typeAttr || typeAttr.kind === "spread") throw new Error("no type");
    const { sourceStart: start, sourceEnd: end } = typeAttr.nameSpan;
    expect(source.slice(start, end)).toBe("type");
  });

  it("keeps the tag's own position and its children", () => {
    const { tag } = find(
      lowerWithTags(
        '\n<attribute value="a" type="string"><p>x</p></attribute>\n',
        { attribute },
        claimAttribute(),
      ).body,
      "DelegatedTag",
    );
    expect(tag.loc).toMatchObject({ line: 2, column: 0 });
    expect(tag.children).toMatchObject([{ kind: "Element", name: "p" }]);
  });

  it("carries attribute tags a contract declares", () => {
    const resource: CustomTag = {
      attributes: { name: { type: "string", required: true } },
      attributeTags: { field: { repeatable: true } },
    };
    const { tag } = find(
      lowerWithTags(
        '<resource name="post"><@field/><@field/></resource>\n',
        { resource },
        fakeDeclarations({ isDelegatedTag: (name) => name === "resource" }),
      ).body,
      "DelegatedTag",
    );
    expect(tag.attributeTags.map((item) => item.name)).toEqual([
      "field",
      "field",
    ]);
  });

  it("still reports an unknown attribute on a claimed tag", () => {
    expect(() =>
      lowerWithTags(
        '<attribute value="a" type="string" nope="x"/>\n',
        { attribute },
        claimAttribute(),
      ),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("unknown attribute `nope`"),
        line: 1,
        column: 35,
      }),
    );
  });

  it("still reports a missing required attribute at the call", () => {
    expect(() =>
      lowerWithTags(
        '\n<attribute value="a"/>\n',
        { attribute },
        claimAttribute(),
      ),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining(
          "`<attribute>`: missing required attribute `type`",
        ),
        line: 2,
        column: 0,
      }),
    );
  });

  it("still reports an enum violation on a claimed tag", () => {
    expect(() =>
      lowerWithTags(
        '<attribute value="a" type="strng"/>\n',
        { attribute },
        claimAttribute(),
      ),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining('must be one of "string", "enum"'),
        line: 1,
        column: 21,
      }),
    );
  });

  it("still reports an undeclared attribute tag on a claimed tag", () => {
    const declared: CustomTag = {
      ...attribute,
      attributeTags: { field: { repeatable: true } },
    };
    expect(() =>
      lowerWithTags(
        '<attribute value="a" type="string"><@oops/></attribute>\n',
        { attribute: declared },
        claimAttribute(),
      ),
    ).toThrowError(
      expect.objectContaining({ message: expect.stringContaining("oops") }),
    );
  });

  it("keeps today's error when the host does not claim the name", () => {
    expect(() =>
      lowerWithTags(
        '\n<attribute value="a" type="string"/>\n',
        { attribute },
        fakeDeclarations({ isDelegatedTag: (name) => name === "other" }),
      ),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining(
          "`<attribute>`: custom tag has neither a `transform` nor a template file, so a call has nothing to expand to",
        ),
        line: 2,
        column: 0,
      }),
    );
  });

  it("keeps today's error on a host with no isDelegatedTag at all", () => {
    expect(() =>
      lowerWithTags('<attribute value="a" type="string"/>\n', { attribute }),
    ).toThrowError("so a call has nothing to expand to");
  });

  it("runs `analyze` over every call of a claimed contract-only tag", () => {
    const seen: number[] = [];
    const analyzed: CustomTag = {
      attributes: { value: { type: "string" } },
      analyze: (calls) => {
        seen.push(calls.length);
      },
    };
    const ir = lowerWithTags(
      '<attribute value="a"/>\n<attribute value="b"/>\n',
      { attribute: analyzed },
      claimAttribute(),
    );
    expect(seen).toEqual([2]);
    expect(ir.body.filter((node) => node.kind === "DelegatedTag")).toHaveLength(
      2,
    );
  });

  it.each([
    ["an empty definition", {}],
    ["a hooks-only definition", { analyze: () => {} }],
  ] as const)(
    "counts %s on a claimed name as a contract: no attributes, no body rules",
    (_label, definition) => {
      const { tag } = find(
        lowerWithTags(
          "<attribute/>\n",
          { attribute: definition as CustomTag },
          claimAttribute(),
        ).body,
        "DelegatedTag",
      );
      expect(tag.name).toBe("attribute");
    },
  );

  it.each([
    ["an empty definition", {}],
    ["a hooks-only definition", { analyze: () => {} }],
  ] as const)(
    "keeps today's error for %s when the host does not claim the name",
    (_label, definition) => {
      expect(() =>
        lowerWithTags(
          "<attribute/>\n",
          { attribute: definition as CustomTag },
          fakeDeclarations({ isDelegatedTag: (name) => name === "other" }),
        ),
      ).toThrowError("so a call has nothing to expand to");
      expect(() =>
        lowerWithTags("<attribute/>\n", {
          attribute: definition as CustomTag,
        }),
      ).toThrowError("so a call has nothing to expand to");
    },
  );

  it.each([
    ["attributes", { attributes: {} }],
    ["attributeTags", { attributeTags: {} }],
    ["parseOptions", { parseOptions: {} }],
  ] as const)(
    "counts a definition declaring only `%s` as a contract",
    (_key, definition) => {
      const { tag } = find(
        lowerWithTags(
          "<attribute/>\n",
          { attribute: definition as CustomTag },
          claimAttribute(),
        ).body,
        "DelegatedTag",
      );
      expect(tag.name).toBe("attribute");
    },
  );

  it("keeps a whitespace-only body, as an unregistered claimed tag does", () => {
    const source = '<attribute value="a" type="string">  </attribute>\n';
    const registered = find(
      lowerWithTags(source, { attribute }, claimAttribute()).body,
      "DelegatedTag",
    );
    const unregistered = find(
      lowerWithTags(source, {}, claimAttribute()).body,
      "DelegatedTag",
    );
    expect(registered.tag.children).toEqual(unregistered.tag.children);
    expect(registered.tag.children).not.toEqual([]);
  });

  it.each([
    [
      "/var",
      '<attribute/x value="a" type="string"/>\n',
      "`/var` on `<attribute>` is not supported: it has no template, so it has no `<return>` to bind",
    ],
    [
      "tag arguments",
      '<attribute(1) value="a" type="string"/>\n',
      "tag arguments `(...)` on `<attribute>` are not supported in a standalone template",
    ],
    [
      "attributes on an attribute tag",
      '<attribute value="a" type="string"><@field x=1/></attribute>\n',
      "`<attribute>`: attribute tag `<@field>` does not support attributes",
    ],
  ])("rejects %s on a claimed contract-only tag", (_label, source, message) => {
    const declared: CustomTag = {
      ...attribute,
      attributeTags: { field: { repeatable: true } },
    };
    expect(() =>
      lowerWithTags(source, { attribute: declared }, claimAttribute()),
    ).toThrowError(message);
  });

  it("accepts a self-closing call but rejects a body when `openTagOnly` is set", () => {
    const flag: CustomTag = {
      attributes: { a: { type: "string" } },
      parseOptions: { openTagOnly: true },
    };
    const { tag } = find(
      lowerWithTags(
        '<attribute a="1"/>\n',
        { attribute: flag },
        claimAttribute(),
      ).body,
      "DelegatedTag",
    );
    expect(tag.children).toEqual([]);
    expect(() =>
      lowerWithTags(
        '<attribute a="1">hi</attribute>\n',
        { attribute: flag },
        claimAttribute(),
      ),
    ).toThrowError("does not accept content");
  });

  it("rejects retained whitespace under `openTagOnly` for contract and transform tags (decision 141)", () => {
    const parseOptions = { openTagOnly: true };
    expect(() =>
      lowerWithTags(
        '<attribute a="1">  </attribute>\n',
        { attribute: { attributes: { a: { type: "string" } }, parseOptions } },
        claimAttribute(),
      ),
    ).toThrowError("does not accept content");
    expect(() =>
      lowerWithTags(
        '<attribute a="1">  </attribute>\n',
        { attribute: { parseOptions, transform: () => [] } },
        claimAttribute(),
      ),
    ).toThrowError("does not accept content");
  });

  it("accepts dropped newline indentation under `openTagOnly` (decision 141)", () => {
    const parseOptions = { openTagOnly: true };
    for (const definition of [
      { parseOptions, attributes: { a: { type: "string" } } },
      { parseOptions, transform: () => [] },
    ] satisfies CustomTag[]) {
      expect(() =>
        lowerWithTags(
          '<attribute a="1">\n  </attribute>\n',
          { attribute: definition },
          claimAttribute(),
        ),
      ).not.toThrow();
    }
  });

  it("carries span and nameSpan exactly as an unregistered claimed tag does", () => {
    const source =
      'héllo\n<attribute value="é" type="string"><p>x</p></attribute>\n';
    const registered = find(
      lowerWithTags(source, { attribute }, claimAttribute()).body,
      "DelegatedTag",
    ).tag;
    const unregistered = find(
      lowerWithTags(source, {}, claimAttribute()).body,
      "DelegatedTag",
    ).tag;
    expect(registered.span).toBeDefined();
    expect(registered.nameSpan).toBeDefined();
    expect(registered.span).toEqual(unregistered.span);
    expect(registered.nameSpan).toEqual(unregistered.nameSpan);
    const { nameSpan, span } = registered;
    expect(source.slice(nameSpan?.sourceStart, nameSpan?.sourceEnd)).toBe(
      "attribute",
    );
    expect(source.slice(span?.sourceStart, span?.sourceEnd)).toBe(
      '<attribute value="é" type="string"><p>x</p></attribute>',
    );
  });

  it("gives a default attribute the same name span as an unregistered claimed tag", () => {
    const source = '<attribute="title" type="string"/>\n';
    const registered = find(
      lowerWithTags(source, { attribute }, claimAttribute()).body,
      "DelegatedTag",
    ).tag;
    const unregistered = find(
      lowerWithTags(source, {}, claimAttribute()).body,
      "DelegatedTag",
    ).tag;
    expect(named(registered.attrs, "value")).toMatchObject({
      nameSpan: (named(unregistered.attrs, "value") as { nameSpan: unknown })
        .nameSpan,
      valueSpan: (named(unregistered.attrs, "value") as { valueSpan: unknown })
        .valueSpan,
    });
  });

  it("leaves a tag with both a contract and a transform to its transform", () => {
    const both: CustomTag = {
      attributes: { value: { type: "string" } },
      transform: () => [],
    };
    const ir = lowerWithTags(
      '<attribute value="a"/>\n',
      { attribute: both },
      claimAttribute(),
    );
    expect(ir.body.filter((node) => node.kind === "DelegatedTag")).toEqual([]);
  });
});

describe("ctx.build.delegatedTag attributes", () => {
  const declarations = (): Policy =>
    fakeDeclarations({ isDelegatedTag: (name) => name === "boundary" });

  it("carries the attributes it is given", () => {
    const boundary: CustomTag = {
      transform: (call, ctx) => [
        ctx.build.delegatedTag("boundary", [], call.attributeTags, [
          ctx.build.attr("id", "x"),
          ctx.build.booleanAttr("open"),
        ]),
      ],
    };
    const { tag } = find(
      lowerWithTags("<boundary/>\n", { boundary }, declarations()).body,
      "DelegatedTag",
    );
    expect(tag.attrs.map((attr) => (attr as { name: string }).name)).toEqual([
      "id",
      "open",
    ]);
  });

  it("carries none when called as before", () => {
    const boundary: CustomTag = {
      transform: (call, ctx) => [
        ctx.build.delegatedTag("boundary", [], call.attributeTags),
      ],
    };
    const { tag } = find(
      lowerWithTags('<boundary id="x"/>\n', { boundary }, declarations()).body,
      "DelegatedTag",
    );
    expect(tag.attrs).toEqual([]);
  });
});

describe("array and function attribute types (decision 138, E1)", () => {
  const listed: CustomTag = {
    attributes: { values: { type: "array" } },
    transform: () => [],
  };
  const called: CustomTag = {
    attributes: { run: { type: "function" } },
    transform: () => [],
  };
  const strings: CustomTag = {
    attributes: { values: { type: "array", items: "string" } },
    transform: () => [],
  };
  const numbers: CustomTag = {
    attributes: { values: { type: "array", items: "number" } },
    transform: () => [],
  };

  function message(
    source: string,
    customTags: Record<string, CustomTag>,
  ): TranslateError {
    try {
      lowerWithTags(source, customTags);
    } catch (error) {
      if (error instanceof TranslateError) return error;
      throw error;
    }
    throw new Error("expected a TranslateError");
  }

  describe("type: array", () => {
    it("accepts a literal array", () => {
      expect(() =>
        lowerWithTags('\n<listed values=["a", "b"]/>\n', { listed }),
      ).not.toThrow();
      expect(() =>
        lowerWithTags("\n<listed values=[]/>\n", { listed }),
      ).not.toThrow();
    });

    it("rejects a function expression", () => {
      for (const written of ["(x) => x", "x => x", "async () => {}"]) {
        expect(
          message(`\n<listed values=${written}/>\n`, { listed }),
        ).toMatchObject({
          message: expect.stringContaining(
            "`<listed>`: attribute `values` must be array, got function",
          ),
          line: 2,
        });
      }
    });

    it("rejects a string, boolean and number literal", () => {
      for (const [source, got] of [
        ['\n<listed values="a"/>\n', "string"],
        ["\n<listed values/>\n", "boolean"],
        ["\n<listed values=true/>\n", "boolean"],
        ["\n<listed values=3/>\n", "number"],
        ['\n<listed values=("a")/>\n', "string"],
      ] as const) {
        expect(message(source, { listed })).toMatchObject({
          message: expect.stringContaining(
            `\`<listed>\`: attribute \`values\` must be array, got ${got}`,
          ),
          line: 2,
        });
      }
    });

    it("accepts what it cannot know: identifier, call, member, conditional", () => {
      for (const written of [
        "list",
        "make()",
        "data.items",
        'flag ? ["a"] : ["b"]',
      ]) {
        expect(() =>
          lowerWithTags(`\n<listed values=${written}/>\n`, { listed }),
        ).not.toThrow();
      }
    });

    it("rejects an object literal as not an array", () => {
      expect(
        message("\n<listed values={ a: 1 }/>\n", { listed }),
      ).toMatchObject({
        message: expect.stringContaining(
          "`<listed>`: attribute `values` must be array, got object",
        ),
      });
    });

    it("rejects a spread on a closed contract, as for every type", () => {
      expect(message("\n<listed ...rest/>\n", { listed }).message).toContain(
        "spread attributes cannot be checked",
      );
    });
  });

  describe("items", () => {
    it("accepts a literal array whose elements all match", () => {
      expect(() =>
        lowerWithTags('\n<strings values=["a", "b", "c"]/>\n', { strings }),
      ).not.toThrow();
      expect(() =>
        lowerWithTags("\n<numbers values=[1, 2, 3]/>\n", { numbers }),
      ).not.toThrow();
    });

    it("reports the first wrong element, 1-based, at the element", () => {
      const error = message('\n<strings values=["a", 2, 3]/>\n', { strings });
      expect(error.message).toContain(
        "`<strings>`: attribute `values` item 2 must be string, got number",
      );
      expect(error.line).toBe(2);
      // The element, not the attribute: `2` sits after `values=["a", `.
      const attributeColumn = message(
        '\n<strings values=["a"]x/>\n'.replace('["a"]x', "3"),
        { strings },
      ).column;
      expect(error.column).toBeGreaterThan(attributeColumn);
    });

    it("positions an element on its own line", () => {
      const error = message('\n<strings values=[\n  "a",\n  true,\n]/>\n', {
        strings,
      });
      expect(error.message).toContain("item 2 must be string, got boolean");
      expect(error.line).toBe(4);
    });

    it("lets a non-literal element pass", () => {
      expect(() =>
        lowerWithTags('\n<strings values=["a", name, make(), ...rest]/>\n', {
          strings,
        }),
      ).not.toThrow();
    });

    it("treats a negative number as a number element", () => {
      expect(() =>
        lowerWithTags("\n<numbers values=[-1, 2]/>\n", { numbers }),
      ).not.toThrow();
      expect(
        message('\n<numbers values=[-1, "x"]/>\n', { numbers }).message,
      ).toContain("item 2 must be number, got string");
    });

    it("reports a nested array element as an array", () => {
      expect(
        message("\n<strings values=[[1]]/>\n", { strings }).message,
      ).toContain("item 1 must be string, got array");
    });

    it("checks no elements when `items` is not declared", () => {
      expect(() =>
        lowerWithTags("\n<listed values=[1, 'a', true, [2]]/>\n", { listed }),
      ).not.toThrow();
    });

    it("does not check items of a non-literal array", () => {
      expect(() =>
        lowerWithTags("\n<strings values=makeList()/>\n", { strings }),
      ).not.toThrow();
    });

    it("supports boolean items", () => {
      const flags: CustomTag = {
        attributes: { values: { type: "array", items: "boolean" } },
        transform: () => [],
      };
      expect(() =>
        lowerWithTags("\n<flags values=[true, false]/>\n", { flags }),
      ).not.toThrow();
      expect(
        message("\n<flags values=[true, 0]/>\n", { flags }).message,
      ).toContain("item 2 must be boolean, got number");
    });
  });

  describe("type: function", () => {
    // A method shorthand is an attribute method, which core hands to the host
    // (`resolveAttributeMethod`); the data target resolves it, a plain host
    // rejects it before any contract runs.
    const methodHost = fakeDeclarations({ resolveAttributeMethod: () => true });

    it("accepts an arrow function", () => {
      for (const written of ["(x) => x", "async (x) => x"]) {
        expect(() =>
          lowerWithTags(`\n<called run=${written}/>\n`, { called }),
        ).not.toThrow();
      }
    });

    it("accepts the method shorthand", () => {
      for (const written of [
        "run({ post }) { return post }",
        "async run({ post }) { return post }",
        "run=function (x) { return x }",
        "run=function* () {}",
      ]) {
        expect(() =>
          lowerWithTags(`\n<called ${written}/>\n`, { called }, methodHost),
        ).not.toThrow();
      }
    });

    it("rejects a method shorthand under a non-function type", () => {
      expect(
        (() => {
          try {
            lowerWithTags(
              "\n<listed values({ post }) { return post }/>\n",
              { listed },
              methodHost,
            );
          } catch (error) {
            return (error as Error).message;
          }
          return "";
        })(),
      ).toContain("attribute `values` must be array, got function");
    });

    it("rejects a literal array", () => {
      expect(message('\n<called run=["a"]/>\n', { called })).toMatchObject({
        message: expect.stringContaining(
          "`<called>`: attribute `run` must be function, got array",
        ),
        line: 2,
      });
    });

    it("rejects a string, boolean and number literal", () => {
      for (const [source, got] of [
        ['\n<called run="a"/>\n', "string"],
        ["\n<called run/>\n", "boolean"],
        ["\n<called run=3/>\n", "number"],
      ] as const) {
        expect(message(source, { called }).message).toContain(
          `\`<called>\`: attribute \`run\` must be function, got ${got}`,
        );
      }
    });

    it("accepts what it cannot know: identifier, call, member, conditional", () => {
      for (const written of [
        "handler",
        "make()",
        "handlers.run",
        "flag ? a : b",
      ]) {
        expect(() =>
          lowerWithTags(`\n<called run=${written}/>\n`, { called }),
        ).not.toThrow();
      }
    });
  });

  describe("template literals and bound attributes (round 2)", () => {
    it("treats a template literal as a string, plain or interpolated", () => {
      expect(
        message("\n<numbers values=[`x`]/>\n", { numbers }).message,
      ).toContain("item 1 must be number, got string");
      expect(
        message("\n<numbers values=[1, `x$" + "{y}`]/>\n", { numbers }).message,
      ).toContain("item 2 must be number, got string");
      for (const [tag, def] of [
        ["listed", listed],
        ["called", called],
      ] as const) {
        const attr = tag === "listed" ? "values" : "run";
        const type = tag === "listed" ? "array" : "function";
        for (const written of ["`x`", "`x$" + "{y}`"]) {
          expect(
            message(`\n<${tag} ${attr}=${written}/>\n`, { [tag]: def }),
          ).toMatchObject({
            message: expect.stringContaining(
              `attribute \`${attr}\` must be ${type}, got string`,
            ),
            line: 2,
          });
        }
      }
    });

    it("accepts a template literal item under `items: string`", () => {
      expect(() =>
        lowerWithTags("\n<strings values=[`x`, `y$" + "{z}`]/>\n", { strings }),
      ).not.toThrow();
    });

    it("checks a bound attribute's shape", () => {
      const wrongShape = message("\n<listed values:=1/>\n", { listed });
      expect(wrongShape.message).toContain(
        "`<listed>`: attribute `values` must be array, got number",
      );
      expect(wrongShape.line).toBe(2);
      expect(
        message("\n<listed values:=(x) => x/>\n", { listed }).message,
      ).toContain("must be array, got function");
      expect(message("\n<called run:=[1]/>\n", { called }).message).toContain(
        "must be function, got array",
      );
    });

    it("checks a bound array's items, at the element", () => {
      const error = message("\n<strings values:=[1]/>\n", { strings });
      expect(error.message).toContain(
        "`<strings>`: attribute `values` item 1 must be string, got number",
      );
      expect(error.line).toBe(2);
      const second = message('\n<strings values:=["a",\n  2]/>\n', {
        strings,
      });
      expect(second.message).toContain("item 2 must be string, got number");
      expect(second.line).toBe(3);
    });

    it("accepts a bound value it cannot know, and a bound array that matches", () => {
      expect(() =>
        lowerWithTags("\n<strings values:=list/>\n", { strings }),
      ).not.toThrow();
      expect(() =>
        lowerWithTags('\n<strings values:=["a"]/>\n', { strings }),
      ).not.toThrow();
      expect(() =>
        lowerWithTags("\n<called run:=handler/>\n", { called }),
      ).not.toThrow();
    });

    it("leaves the scalar check on a bound attribute as it was", () => {
      const scalar: CustomTag = {
        attributes: { n: { type: "number" } },
        transform: () => [],
      };
      expect(() =>
        lowerWithTags('\n<scalar n:="x"/>\n', { scalar }),
      ).not.toThrow();
    });
  });

  describe("registration", () => {
    function register(customTags: Record<string, CustomTag>): void {
      lowerWithTags("<div/>\n", customTags);
    }

    it("accepts `items` on an array", () => {
      expect(() => register({ strings })).not.toThrow();
    });

    it("rejects `items` without `type: array`", () => {
      for (const attribute of [
        { items: "string" },
        { type: "string", items: "string" },
        { type: "function", items: "string" },
      ] as const) {
        expect(() =>
          register({
            bad: { attributes: { values: attribute }, transform: () => [] },
          } as never),
        ).toThrowError(
          /`items` .*`type: "array"`|`items` requires `type: "array"`/,
        );
      }
    });

    it("rejects an `items` value that is not string, number or boolean", () => {
      expect(() =>
        register({
          bad: {
            attributes: { values: { type: "array", items: "object" } },
            transform: () => [],
          },
        } as never),
      ).toThrowError(/items/);
    });

    it("rejects `enum` together with `array` or `function`", () => {
      for (const type of ["array", "function"] as const) {
        expect(() =>
          register({
            bad: {
              attributes: { values: { type, enum: ["a"] } },
              transform: () => [],
            },
          }),
        ).toThrowError(
          /`enum` cannot be combined with `type: "(array|function)"`/,
        );
      }
    });

    it("names the tag and the attribute in a registration error", () => {
      expect(() =>
        register({
          bad: {
            attributes: { values: { type: "string", items: "string" } },
            transform: () => [],
          },
        } as never),
      ).toThrowError(/"values".*"bad"|"bad".*"values"/);
    });

    it("still rejects a default of type array as a definition error", () => {
      const withDefault: CustomTag = {
        attributes: { values: { type: "array", default: ["a"] } },
        transform: () => [],
      };
      expect(() =>
        lowerWithTags("\n<withDefault/>\n", { withDefault }),
      ).toThrowError(
        /declares a `default` that is not a string, number or boolean/,
      );
    });

    it("keeps an unknown key rejected, listing `items`", () => {
      expect(() =>
        register({
          bad: {
            attributes: { values: { type: "array", itemz: "string" } },
            transform: () => [],
          },
        } as never),
      ).toThrowError(/Unknown key "itemz".*items/);
    });
  });

  describe("with other declarations", () => {
    it("`literalOnly` still accepts an array literal and rejects a call", () => {
      const only: CustomTag = {
        attributes: {
          values: { type: "array", items: "string", literalOnly: true },
        },
        transform: () => [],
      };
      expect(() =>
        lowerWithTags('\n<only values=["a"]/>\n', { only }),
      ).not.toThrow();
      expect(message("\n<only values=make()/>\n", { only }).message).toContain(
        "attribute `values` must be a literal",
      );
    });

    it("`required` still applies", () => {
      const needs: CustomTag = {
        attributes: { values: { type: "array", required: true } },
        transform: () => [],
      };
      expect(message("\n<needs/>\n", { needs }).message).toContain(
        "missing required attribute `values`",
      );
    });

    it("`type: expression` is unchanged", () => {
      const expr: CustomTag = {
        attributes: { value: { type: "expression" } },
        transform: () => [],
      };
      expect(() =>
        lowerWithTags("\n<expr value=[1]/>\n", { expr }),
      ).not.toThrow();
    });

    it("the existing scalar checks keep their messages", () => {
      const scalar: CustomTag = {
        attributes: { n: { type: "number" } },
        transform: () => [],
      };
      expect(message('\n<scalar n="x"/>\n', { scalar }).message).toContain(
        "attribute `n` must be number, got string",
      );
    });
  });
});

// Decision 146 (PR 3): an E1 error on an attribute the sugar made names the
// sugar the author wrote, with the attribute it stands for.
describe("E1 errors name the sugar the author wrote", () => {
  const field: CustomTag = {
    attributes: {
      name: { type: "number" },
      id: { type: "number" },
      class: { type: "number", literalOnly: true },
      title: { type: "string" },
    },
    transform: () => [],
  };
  const closed: CustomTag = {
    attributes: { title: { type: "string" } },
    transform: () => [],
  };
  const messageOf = (source: string, tags: Record<string, CustomTag>) => {
    try {
      lowerWithTags(source, tags);
    } catch (error) {
      return error as { message: string; line: number; column: number };
    }
    throw new Error("expected an error");
  };

  it.each([
    [
      "\n<field :email/>\n",
      "`<field>`: attribute `:email` (`name`) must be number, got string",
    ],
    [
      "\n<field #main/>\n",
      "`<field>`: attribute `#main` (`id`) must be number, got string",
    ],
    [
      '\n<field title="t" :email/>\n',
      "attribute `:email` (`name`) must be number",
    ],
    ["\n<field:email/>\n", "attribute `:email` (`name`) must be number"],
  ])("%j", (source, text) => {
    expect(messageOf(source, { field }).message).toContain(text);
  });

  it("an undeclared sugar attribute is `unknown attribute`, named as written", () => {
    expect(messageOf("\n<closed :email/>\n", { closed }).message).toContain(
      "unknown attribute `:email` (`name`)",
    );
    expect(messageOf("\n<closed #main/>\n", { closed }).message).toContain(
      "unknown attribute `#main` (`id`)",
    );
  });

  it("is positioned at the sugar token", () => {
    const error = messageOf('\n<field title="t" :email/>\n', { field });
    expect(error.line).toBe(2);
    expect(error.column).toBe(17);
  });

  it("an attribute written out keeps the plain wording", () => {
    expect(messageOf('\n<field name="x"/>\n', { field }).message).toContain(
      "attribute `name` must be number",
    );
    expect(messageOf('\n<field name="x"/>\n', { field }).message).not.toContain(
      "`name` (`name`)",
    );
  });
});

// Review (PR 3 round 2), finding 1: an authored literal `class` plus a `.x`
// sugar stays a literal, so the contract checks judge the value it really is
// ("a b"), and the E1 names the sugar. A dynamic authored value keeps the
// template-literal/array form.
describe("E1 on a literal class with a `.x` sugar", () => {
  const en: CustomTag = {
    attributes: { class: { type: "string", enum: ["a b", "b a", "a", "b"] } },
    transform: () => [],
  };
  const enStrict: CustomTag = {
    attributes: { class: { type: "string", enum: ["a", "b"] } },
    transform: () => [],
  };
  const lit: CustomTag = {
    attributes: { class: { type: "string", literalOnly: true } },
    transform: () => [],
  };
  const num: CustomTag = {
    attributes: { class: { type: "number" } },
    transform: () => [],
  };
  const messageOf = (source: string, tags: Record<string, CustomTag>) => {
    try {
      lowerWithTags(source, tags);
    } catch (error) {
      return error as { message: string; line: number; column: number };
    }
    return null;
  };

  it.each([['\n<en class="a" .b/>\n'], ['\n<en .b class="a"/>\n']])(
    "%j: a static class is a static value, no false error",
    (source) => {
      expect(messageOf(source, { en })).toBeNull();
    },
  );

  it.each([['\n<lit class="a" .b/>\n'], ['\n<lit .b class="a"/>\n']])(
    "%j: it is still a literal (`literalOnly` passes)",
    (source) => {
      expect(messageOf(source, { lit })).toBeNull();
    },
  );

  it("an enum miss names the sugar, with the merged value", () => {
    const error = messageOf('\n<enStrict class="a" .b/>\n', { enStrict });
    expect(error?.message).toContain("`.b` (`class`)");
    expect(error?.message).toContain('got "a b"');
    const before = messageOf('\n<enStrict .b class="a"/>\n', { enStrict });
    expect(before?.message).toContain("`.b` (`class`)");
    expect(before?.message).toContain('got "b a"');
  });

  it.each([
    ["\n<num class=1 .b/>\n"],
    ['\n<num class="1" .b/>\n'],
    ['\n<num .b class="1"/>\n'],
  ])("%j: a type mismatch is reported, naming the sugar", (source) => {
    const error = messageOf(source, { num });
    expect(error?.message).toContain("must be number");
    expect(error?.message).toContain("`.b`");
  });

  it("a dynamic authored class keeps the expression form", () => {
    const free: CustomTag = {
      attributes: { class: { type: "string" } },
      transform: () => [],
    };
    expect(() =>
      lowerWithTags("\n<free class=input.c .b/>\n", { free }),
    ).not.toThrow();
    // ...and a contract that needs a static value still rejects it.
    expect(messageOf("\n<en class=input.c .b/>\n", { en })?.message).toContain(
      "must be a static value",
    );
  });
});

// Review (PR 3 round 2), finding 2: a sugar merged onto a tag-adjacent class
// carries a label (`.a .z`) and the error sits on the sugar token, not the tag.
describe("E1 on a sugar merged into a tag-adjacent class", () => {
  const closed: CustomTag = {
    attributes: { title: { type: "string" } },
    transform: () => [],
  };
  const en: CustomTag = {
    attributes: { class: { type: "string", enum: ["a", "b"] } },
    transform: () => [],
  };
  const messageOf = (source: string, tags: Record<string, CustomTag>) => {
    try {
      lowerWithTags(source, tags);
    } catch (error) {
      return error as { message: string; line: number; column: number };
    }
    throw new Error("expected an error");
  };

  it("an unknown attribute names `.a .b` and points at `.b`", () => {
    const error = messageOf("\n<closed.a .b/>\n", { closed });
    expect(error.message).toContain("unknown attribute `.a .b` (`class`)");
    expect([error.line, error.column]).toEqual([2, 10]);
  });

  it("an enum miss names `.a .z` and points at `.z`", () => {
    const error = messageOf("\n<en.a .z/>\n", { en });
    expect(error.message).toContain("`.a .z` (`class`)");
    expect(error.message).toContain('got "a z"');
    expect([error.line, error.column]).toEqual([2, 6]);
  });

  it("a plain tag-adjacent class keeps the plain wording and the tag position", () => {
    const error = messageOf("\n<closed.a/>\n", { closed });
    expect(error.message).toContain("unknown attribute `class`");
    expect([error.line, error.column]).toEqual([2, 0]);
  });
});
