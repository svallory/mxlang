import { describe, expect, it, vi } from "vitest";
import { compileSource } from "./compile.ts";
import { TranslateError } from "./core.ts";
import type { CustomTag, TagCall } from "./custom-tags.ts";
import type { Policy } from "./declarations.ts";
import type { Attr, Ir, IrNode } from "./ir.ts";
import { resetTemplateCache } from "./template-tag.ts";

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
    expect(tryFind(ir.body, "HostTag")).toBeNull();
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

  it("rejects `/var` on a template-backed custom tag call", () => {
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
          "`/var` on `<box>` is not supported yet; a tag returns a value with `<return>` (planned)",
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
          "`/var` on `<icon>` is not supported yet; a tag returns a value with `<return>` (planned)",
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
        ctx.build.hostTag(
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
        claimsTag: (name) => name === "boundary",
        resolveHostTag: (name) => ({ name }),
      },
    );
    expect(find(ir.body, "HostTag").tag).toMatchObject({
      name: "boundary",
      data: { name: "boundary" },
    });
  });

  it("refuses a host primitive the active host does not claim", () => {
    const tag: CustomTag = {
      transform: (_call, ctx) => [ctx.build.hostTag("missing", [], [])],
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

  it("refuses ctx.build.hostTag in finalize", () => {
    const tag: CustomTag = {
      transform: () => [],
      finalize: (ctx) => [ctx.build.hostTag("try", [], [])],
    };
    expect(() => lowerWithTags("<tag/>\n", { tag })).toThrowError(
      "`<tag>`: `ctx.build.hostTag` is not available in `finalize`",
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
    claimsTag: (name) => name === "try",
    resolveHostTag: (name) => ({ name }),
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
    const hostTag = find(ir.body, "HostTag");
    expect(hostTag.tag).toMatchObject({ name: "try" });
    expect(hostTag.tag.attributeTags).toEqual([]);
  });

  it("passes `<@catch>`/`<@placeholder>` through as the host tag's attribute tags", () => {
    const ir = lowerWithTags(
      "<try><p>x</p><@catch|e|><p>${e}</p></@catch><@placeholder>wait</@placeholder></try>\n",
      {},
      tryDeclarations,
    );
    const hostTag = find(ir.body, "HostTag");
    expect(hostTag.tag.attributeTags.map((tag) => tag.name).sort()).toEqual([
      "catch",
      "placeholder",
    ]);
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

  // Round 1 item 1: `hasContent` treats whitespace-only body text as no
  // content, the right default for a template-authored tag deciding what an
  // empty call means. `<try>` is a structural pass-through, not a template —
  // its body must reach the host unchanged, the way `lowerHostTag` always
  // lowered `node.body?.body ?? []` unconditionally. `lowerCustomTag`'s
  // `isBuiltin` flag skips the `hasContent` gate for built-ins.
  it("preserves a whitespace-only `<try>` body rather than dropping it", () => {
    const ir = lowerWithTags("<try>  </try>\n", {}, tryDeclarations);
    const hostTag = find(ir.body, "HostTag");
    expect(hostTag.tag.children).toEqual([
      expect.objectContaining({ kind: "Text", value: " " }),
    ]);
  });

  it("preserves markup mixed with text in a `<try>` body", () => {
    const ir = lowerWithTags("<try>a <b>c</b></try>\n", {}, tryDeclarations);
    const hostTag = find(ir.body, "HostTag");
    expect(hostTag.tag.children).toMatchObject([
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
// lives in `packages/hosts/html/src/translate.test.ts`'s "import precedence
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

  // The `!fileLocalBinding && claimsTag(...)` branch (lower.ts, gating a
  // host claim on the absence of a file-local binding) is currently
  // unreachable by any real host: every host that claims tags beyond `try`
  // and the dynamic-tag sentinel (only `@mxlang/html`, for `let`/`server`/
  // `html-comment`/`html-script`/`html-style`/`style`) claims exclusively
  // lowercase names, and the casing gate above means `fileLocalBinding` is
  // never true for a lowercase name in the first place — so on every real
  // host the `!fileLocalBinding &&` in front of `claimsTag` never changes
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
        claimsTag: (name) => name === "Boundary",
        resolveHostTag: (name) => ({ name }),
      },
    );
    expect(find(ir.body, "Component").target).toMatchObject({
      kind: "name",
      name: "Boundary",
    });
  });
});
