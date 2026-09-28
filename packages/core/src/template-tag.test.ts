import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import { type MxWarning, TranslateError } from "./core.ts";
import type { CustomTag, TagCall } from "./custom-tags.ts";
import type { Policy } from "./declarations.ts";
import type { Ir, IrNode } from "./ir.ts";
import {
  peekTemplateMetadata,
  resetTemplateCache,
  type TemplateBackedTag,
  templateCompileCount,
  touchAndEvict,
} from "./template-tag.ts";

const CALLER = "/tmp/mx-template-test/page.mx";

function declarations(): Policy {
  return {
    tags: {},
    isElement: () => true,
    isComponent: (name, ctx) => ctx.defines.has(name) || ctx.imports.has(name),
  };
}

function template(
  filename: string,
  source: string,
  extra: Partial<CustomTag> = {},
): TemplateBackedTag {
  return { template: { filename, source }, ...extra };
}

function lowerWithTags(
  source: string,
  customTags: Readonly<Record<string, CustomTag>>,
  filename = CALLER,
  warnings: MxWarning[] = [],
  policy: Policy = declarations(),
): Ir {
  let ir: Ir | null = null;
  compileSource(source, filename, policy, {
    customTags,
    warnings,
    tagDiscoveryDirs: [],
    emitIr(lowered) {
      ir = lowered;
      return "";
    },
  });
  if (!ir) throw new Error("lowerer produced no IR");
  return ir;
}

function attrTagsV2(): Policy {
  return { ...declarations(), attrTags: 2 };
}

function components(
  nodes: IrNode[],
): Array<Extract<IrNode, { kind: "Component" }>> {
  const found: Array<Extract<IrNode, { kind: "Component" }>> = [];
  const visit = (list: IrNode[]) => {
    for (const node of list) {
      if (node.kind === "Component") found.push(node);
      if ("children" in node && Array.isArray(node.children)) {
        visit(node.children as IrNode[]);
      }
      if (node.kind === "IfChain") {
        for (const branch of node.branches) visit(branch.children);
      }
    }
  };
  visit(nodes);
  return found;
}

describe("template custom tags as compilation units", () => {
  it.each([
    [
      "missing required attribute tags",
      "<panel/>",
      { item: { required: true } },
      "missing required attribute tag `<@item>`",
    ],
    [
      "repeated non-repeatable attribute tags",
      "<panel><@item/><@item/></panel>",
      { item: {} },
      "attribute tag `<@item>` may not be repeated",
    ],
    [
      "unknown attribute tags",
      "<panel><@other/></panel>",
      { item: {} },
      "unknown attribute tag `<@other>`",
    ],
  ])(
    "enforces sidecar contracts on template tags: %s",
    (_case, source, attributeTags, message) => {
      const panel = template(
        "/tmp/mx-template-test/tags/panel.mx",
        "<${input.item}/>",
        { attributeTags },
      );
      expect(() => lowerWithTags(source, { panel })).toThrowError(message);
    },
  );

  it("routes attributes, spread, body and attribute tags through a component", () => {
    const box = template(
      "/tmp/mx-template-test/tags/box.mx",
      "<section><${input.content}/><${input.head}/></section>",
      { attributeTags: { head: {} } },
    );
    const ir = lowerWithTags(
      '<box title="hello" ...rest><@head>H</@head>body</box>\n',
      { box },
    );

    expect(ir.imports).toHaveLength(1);
    expect(ir.imports[0]?.code).toMatch(
      /^import \$mx_Box\d+ from "\.\/tags\/box\.mx"$/,
    );
    const call = components(ir.body)[0];
    expect(call?.target).toMatchObject({ kind: "name" });
    expect(call?.attrs.map((attr) => attr.kind)).toEqual(["static", "spread"]);
    expect(call?.content).not.toBeNull();
    expect(call?.attributeTags.map((tag) => tag.name)).toEqual(["head"]);
  });

  it("dedupes injected imports by resolved template path", () => {
    const tag = template("/tmp/mx-template-test/tags/icon.mx", "<i/>");
    const ir = lowerWithTags("<icon/><icon/>\n", { icon: tag });
    expect(ir.imports).toHaveLength(1);
    expect(components(ir.body)).toHaveLength(2);
    expect(components(ir.body)[0]?.target).toEqual(
      components(ir.body)[1]?.target,
    );
  });

  it("reuses an authored default import of the same resolved path", () => {
    const tag = template("/tmp/mx-template-test/tags/icon.mx", "<i/>");
    const ir = lowerWithTags('import MyIcon from "./tags/icon.mx"\n<icon/>\n', {
      icon: tag,
    });
    expect(ir.imports).toHaveLength(1);
    expect(ir.imports[0]?.code).toContain("import MyIcon");
    expect(components(ir.body)[0]?.target).toEqual({
      kind: "name",
      name: "MyIcon",
    });
  });

  it("gensyms around caller bindings", () => {
    const tag = template("/tmp/mx-template-test/tags/icon.mx", "<i/>");
    const ir = lowerWithTags('import $mx_Icon1 from "./other.mx"\n<icon/>\n', {
      icon: tag,
    });
    expect(ir.imports[1]?.code).toContain("$mx_Icon2");
  });

  it("mints unique names across a nested unit's own compile", () => {
    // PR #81's regression (`custom-tags-gensym-collision`), carried over to
    // the unit model. Compiling `<outer>`'s template is a *separate* lowering
    // that shares the caller's file-level counter by reference; if it started
    // its own counter at zero, the name minted inside the template and the
    // caller's own next name would collide. The expansion path that test was
    // written against is gone, so the same hazard is asserted through both
    // channels that still mint names: `ctx.gensym`, and the injected imports.
    const names: string[] = [];
    const g: CustomTag = {
      transform(_call, ctx) {
        names.push(ctx.gensym("g"));
        return [];
      },
    };
    const leaf = template("/tmp/mx-template-test/tags/leaf.mx", "<i/>");
    // `outer`'s template calls both `<g/>` and `<leaf/>`, so its compile mints
    // from the shared counter in between the caller's own two calls.
    const outer = template(
      "/tmp/mx-template-test/tags/outer.mx",
      "<span><g/><leaf/></span>",
    );
    const ir = lowerWithTags("<g/><outer/><leaf/>\n", { g, leaf, outer });

    // Two, not three: the `<g/>` written inside `outer.mx` belongs to that
    // unit's own compilation and its `transform` does not run for the caller.
    // What matters is that the serials the caller *did* mint are distinct
    // across the nested compile that ran between them — with the counter
    // unshared both came back `$mx_g_g1`.
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);

    // Every injected import in the caller binds a distinct local, and none
    // collides with a name `ctx.gensym` handed out.
    const bindings = ir.imports.flatMap((node) => node.bindings);
    expect(bindings.length).toBeGreaterThan(0);
    expect(new Set(bindings).size).toBe(bindings.length);
    for (const binding of bindings) expect(names).not.toContain(binding);
  });

  it("compiles a called template unit's own expressions through the real metadata path (core contract C4)", () => {
    // Calling a discovered/imported tag routes through
    // `registerTemplateMetadataCompiler`'s registered callback
    // (`lower.ts:1396`), which runs `parseFragment` + `lower` against the
    // *template's own* `Ctx` (`tag.source`/`tag.filename`) to derive its
    // cached `TemplateMetadata`. This drives that real path — not a
    // hand-rolled stand-in — with a template whose body has expressions at
    // several `exprOf` call sites, proving the `span` guard (`exprSpan`)
    // survives it without producing a `NaN` offset or throwing.
    //
    // `TemplateMetadata` itself only exposes `{ readsContent, attributeTags,
    // returnsValue, returnValueCode }` — the template's own lowered `Ir`
    // (and therefore its `Expr.span`s) is not threaded back to any caller-
    // observable surface, so this cannot assert a specific offset the way
    // `lower.test.ts`'s per-construction-site tests do. What it proves is
    // that the guarded path used in production, not just a direct `lower()`
    // call, is exercised end to end without crashing — and `returnValueCode`
    // pins that the `<return>` expression's `Expr.code` (produced by the
    // same `exprOf` call the span comes from) survived the real path intact,
    // so the test asserts something beyond "did not throw".
    const richTag = template(
      "/tmp/mx-template-test/tags/rich.mx",
      [
        '<div a=input.x by="(p)=>p.id">',
        "${input.y}",
        "<for|item| of=input.items>${item}</for>",
        "</div>",
        "<const/doubled=input.x * 2/>",
        "<return value=doubled/>",
      ].join("\n"),
    );
    expect(() =>
      lowerWithTags('<rich x="1" y="2" items="[]"/>\n', { rich: richTag }),
    ).not.toThrow();
    expect(
      peekTemplateMetadata("/tmp/mx-template-test/tags/rich.mx"),
    ).toMatchObject({
      returnsValue: true,
      returnValueCode: "doubled",
    });
  });

  it("reports openTagOnly content as a positioned MX error", () => {
    const leaf = template("/tmp/mx-template-test/tags/leaf.mx", "<i/>", {
      parseOptions: { openTagOnly: true },
    });
    expect(() => lowerWithTags("\n<leaf>body</leaf>\n", { leaf })).toThrowError(
      expect.objectContaining({
        name: "TranslateError",
        message: expect.stringContaining("`<leaf>`: does not accept content"),
        line: 2,
        column: 0,
      }),
    );
  });

  it("keeps a diagnostic's own file when one is positioned elsewhere", () => {
    // The cross-file position rule (risk 7). A sidecar may report against a
    // position it was handed rather than the call's own — a macro that spliced
    // IR from another file is the case `Position.file` exists for. Dropping
    // the file reports that line and column against the file being compiled,
    // pointing at unrelated source. `metadataForTemplate` annotates an unfiled
    // error with the template's name on its way out, which masks this for a
    // template-nested call, so the discriminating case is a positioned
    // `ctx.fail` in the caller's own compile.
    const elsewhere = "/tmp/mx-template-test/tags/macro-source.mx";
    const tagged: CustomTag = {
      transform(_call: TagCall, ctx): never {
        return ctx.fail("borrowed position", {
          line: 7,
          column: 3,
          file: elsewhere,
        });
      },
    };
    expect(() => lowerWithTags("<tagged/>\n", { tagged })).toThrowError(
      expect.objectContaining({
        name: "TranslateError",
        file: elsewhere,
        line: 7,
        column: 3,
      }),
    );
  });

  it("rejects <@content> at the call site", () => {
    const box = template("/tmp/mx-template-test/tags/box.mx", "<i/>", {
      attributeTags: { content: {} },
    });
    expect(() =>
      lowerWithTags("\n<box><@content>x</@content></box>\n", { box }),
    ).toThrowError(
      expect.objectContaining({
        name: "TranslateError",
        message: expect.stringContaining(
          "`<@content>` is reserved for the body of `<box>`",
        ),
        line: 2,
      }),
    );
  });

  it("caches content metadata and preserves the dropped-body warning", () => {
    resetTemplateCache();
    const warnings: MxWarning[] = [];
    const box = template("/tmp/mx-template-test/tags/box.mx", "<div/>");
    lowerWithTags("<box>one</box><box>two</box>\n", { box }, CALLER, warnings);
    expect(templateCompileCount()).toBe(1);
    expect(warnings).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("body content was dropped"),
      }),
      expect.objectContaining({
        message: expect.stringContaining("body content was dropped"),
      }),
    ]);
  });

  it("records content and attribute-tag metadata from the compiled unit", () => {
    resetTemplateCache();
    const panel = template(
      "/tmp/mx-template-test/tags/panel.mx",
      "<section><if=input.content><${input.content}/></if><${input.head}/></section>",
      { attributeTags: { head: {} } },
    );
    const warnings: MxWarning[] = [];
    lowerWithTags(
      "<panel><@head>H</@head>body</panel>\n",
      { panel },
      CALLER,
      warnings,
    );
    expect(warnings).toEqual([]);
    expect(templateCompileCount()).toBe(1);
  });

  it.each([
    ["optional member: input?.head", "<${input?.head}/>"],
    [
      "optional member on content: input.head?.content",
      "<if=input.head?.content><${input.head?.content}/></if>",
    ],
    ['bracket access: input["head"]', '<${input["head"]}/>'],
    ['optional bracket access: input?.["head"]', '<${input?.["head"]}/>'],
  ])("recognizes an attribute-tag read via %s", (_case, expr) => {
    resetTemplateCache();
    const panel = template(
      "/tmp/mx-template-test/tags/panel-read.mx",
      `<section>${expr}</section>`,
      { attributeTags: { head: {} } },
    );
    const warnings: MxWarning[] = [];
    lowerWithTags(
      "<panel><@head>H</@head></panel>\n",
      { panel },
      CALLER,
      warnings,
    );
    expect(warnings).toEqual([]);
  });

  it("recognizes an attribute-tag read via destructuring: const { head } = input", () => {
    resetTemplateCache();
    const panel = template(
      "/tmp/mx-template-test/tags/panel-destructure.mx",
      "<const/{ head }=input/><section><${head}/></section>",
      { attributeTags: { head: {} } },
    );
    const warnings: MxWarning[] = [];
    lowerWithTags(
      "<panel><@head>H</@head></panel>\n",
      { panel },
      CALLER,
      warnings,
    );
    expect(warnings).toEqual([]);
  });

  it("recognizes a body read via optional chaining: input?.content", () => {
    resetTemplateCache();
    const panel = template(
      "/tmp/mx-template-test/tags/panel-content-optional.mx",
      "<section><${input?.content}/></section>",
    );
    const warnings: MxWarning[] = [];
    lowerWithTags("<panel>body</panel>\n", { panel }, CALLER, warnings);
    expect(warnings).toEqual([]);
  });

  it("recognizes a rest destructure of input as reading everything: const { head, ...rest } = input", () => {
    resetTemplateCache();
    const panel = template(
      "/tmp/mx-template-test/tags/panel-rest.mx",
      "<const/{ head, ...rest }=input/><section>${JSON.stringify(rest)}</section>",
      { attributeTags: { head: {} } },
    );
    const warnings: MxWarning[] = [];
    lowerWithTags(
      "<panel><@head>H</@head>body</panel>\n",
      { panel },
      CALLER,
      warnings,
    );
    expect(warnings).toEqual([]);
  });

  it("recognizes input[dynamicKey] as reading everything", () => {
    resetTemplateCache();
    const panel = template(
      "/tmp/mx-template-test/tags/panel-dynamic-key.mx",
      "static const key = 'head'\n<section><${input[key]}/></section>",
      { attributeTags: { head: {} } },
    );
    const warnings: MxWarning[] = [];
    lowerWithTags(
      "<panel><@head>H</@head></panel>\n",
      { panel },
      CALLER,
      warnings,
    );
    expect(warnings).toEqual([]);
  });

  it.each([
    ["arrow parameter", "[1].map(input => input.head)"],
    ["function parameter", "(function (input) { return input.head; })()"],
  ])(
    "does not count a shadowed local named input as a read: %s",
    (_case, expr) => {
      resetTemplateCache();
      const panel = template(
        "/tmp/mx-template-test/tags/panel-shadowed.mx",
        `<section>\${JSON.stringify(${expr})}</section>`,
        { attributeTags: { head: {} } },
      );
      const warnings: MxWarning[] = [];
      lowerWithTags(
        "<panel><@head>H</@head></panel>\n",
        { panel },
        CALLER,
        warnings,
      );
      expect(warnings).toEqual([
        expect.objectContaining({
          message: expect.stringContaining(
            "`<@head>` was dropped; /tmp/mx-template-test/tags/panel-shadowed.mx does not read `input.head`",
          ),
        }),
      ]);
    },
  );

  it("recognizes a spread of input as reading everything", () => {
    resetTemplateCache();
    const panel = template(
      "/tmp/mx-template-test/tags/panel-spread.mx",
      "static const props = {...input}\n<section>${JSON.stringify(props)}</section>",
      { attributeTags: { head: {} } },
    );
    const warnings: MxWarning[] = [];
    lowerWithTags(
      "<panel><@head>H</@head>body</panel>\n",
      { panel },
      CALLER,
      warnings,
    );
    expect(warnings).toEqual([]);
  });

  it("still warns when a tag truly does not read the attribute tag", () => {
    resetTemplateCache();
    const panel = template(
      "/tmp/mx-template-test/tags/panel-unread.mx",
      "<section>static</section>",
      { attributeTags: { head: {} } },
    );
    const warnings: MxWarning[] = [];
    lowerWithTags(
      "<panel><@head>H</@head></panel>\n",
      { panel },
      CALLER,
      warnings,
    );
    expect(warnings).toEqual([
      expect.objectContaining({
        message: expect.stringContaining(
          "`<@head>` was dropped; /tmp/mx-template-test/tags/panel-unread.mx does not read `input.head`",
        ),
      }),
    ]);
  });

  it("rebuilds a template plan when its sidecar replaces attribute tags", () => {
    const panel = template(
      "/tmp/mx-template-test/tags/filter-panel.mx",
      "<section><${input.item}/></section>",
      {
        attributeTags: { item: {}, other: {} },
        transform(call) {
          return {
            ...call,
            attributeTags: call.attributeTags.filter(
              (tag) => tag.name !== "other",
            ),
          };
        },
      },
    );
    const call = components(
      lowerWithTags("<panel><@item/><@other/></panel>\n", { panel }).body,
    )[0];
    expect(call?.attributeTags.map((tag) => tag.name)).toEqual(["item"]);
    expect(call?.attributeTagTree).toMatchObject([
      { kind: "AttributeTag", tag: { name: "item" } },
    ]);
    expect(call?.attrTagProps.map((prop) => prop.name)).toEqual(["item"]);
  });

  it("preserves control flow when a sidecar copies attribute tags", () => {
    const panel = template(
      "/tmp/mx-template-test/tags/copy-panel.mx",
      "<section><${input.item}/></section>",
      {
        attributeTags: { item: {} },
        transform(call) {
          return { ...call, attributeTags: [...call.attributeTags] };
        },
      },
    );
    const call = components(
      lowerWithTags(
        "<panel><if=input.ok><@item/></if></panel>\n",
        { panel },
        CALLER,
        [],
        attrTagsV2(),
      ).body,
    )[0];
    expect(call?.attributeTagTree).toMatchObject([
      { kind: "AttributeTagIf", branches: [{ nodes: [{}] }] },
    ]);
    expect(call?.attrTagProps[0]).toMatchObject({
      name: "item",
      cardinality: "single",
      source: [{ kind: "AttributeTagIf" }],
    });
  });

  it("removes stale plan entries after an in-place sidecar splice", () => {
    const panel = template(
      "/tmp/mx-template-test/tags/splice-panel.mx",
      "<section><${input.item}/></section>",
      {
        attributeTags: { item: {}, other: {} },
        transform(call) {
          call.attributeTags.splice(1, 1);
          return call;
        },
      },
    );
    const call = components(
      lowerWithTags("<panel><@item/><@other/></panel>\n", { panel }).body,
    )[0];
    expect(call?.attributeTags.map((tag) => tag.name)).toEqual(["item"]);
    expect(call?.attributeTagTree).toMatchObject([
      { kind: "AttributeTag", tag: { name: "item" } },
    ]);
    expect(call?.attrTagProps.map((prop) => prop.name)).toEqual(["item"]);
  });

  it("appends sidecar-created attribute tags as unconditional", () => {
    const panel = template(
      "/tmp/mx-template-test/tags/add-panel.mx",
      "<section><${input.item}/><${input.other}/></section>",
      {
        attributeTags: { item: {}, other: {} },
        transform(call) {
          const first = call.attributeTags[0];
          if (!first) return call;
          const added = { ...first, name: "other" };
          return { ...call, attributeTags: [...call.attributeTags, added] };
        },
      },
    );
    const call = components(
      lowerWithTags(
        "<panel><if=input.ok><@item/></if></panel>\n",
        { panel },
        CALLER,
        [],
        attrTagsV2(),
      ).body,
    )[0];
    expect(call?.attributeTagTree.map((node) => node.kind)).toEqual([
      "AttributeTagIf",
      "AttributeTag",
    ]);
    expect(call?.attrTagProps).toMatchObject([
      { name: "item", cardinality: "single" },
      {
        name: "other",
        cardinality: "single",
        source: [{ kind: "AttributeTag" }],
      },
    ]);
  });

  it("allows non-repeatable attribute tags on mutually exclusive paths", () => {
    const panel = template(
      "/tmp/mx-template-test/tags/exclusive-panel.mx",
      "<section><${input.item}/></section>",
      { attributeTags: { item: {} } },
    );
    expect(() =>
      lowerWithTags(
        "<panel><if=input.ok><@item/></if><else><@item/></else></panel>\n",
        { panel },
        CALLER,
        [],
        attrTagsV2(),
      ),
    ).not.toThrow();
  });

  it("rejects a required attribute tag missing from one conditional path", () => {
    const panel = template(
      "/tmp/mx-template-test/tags/required-panel.mx",
      "<section><${input.item}/></section>",
      { attributeTags: { item: { required: true } } },
    );
    expect(() =>
      lowerWithTags(
        "\n<panel><if=input.ok><@item/></if></panel>\n",
        { panel },
        CALLER,
        [],
        attrTagsV2(),
      ),
    ).toThrowError(
      expect.objectContaining({
        name: "TranslateError",
        message: expect.stringContaining(
          "missing required attribute tag `<@item>`",
        ),
        line: 2,
        column: 0,
      }),
    );
  });

  it("compiles metadata for a template containing static", () => {
    const tag = template(
      "/tmp/mx-template-test/tags/static-tag.mx",
      'static const LABEL = "ok"\n<span>${LABEL}</span>',
    );
    expect(() =>
      lowerWithTags("<static-tag/>\n", { "static-tag": tag }),
    ).not.toThrow();
  });

  it("does not warn about dropped content while a unit is still compiling", () => {
    // The provisional cache entry terminates recursion, and its
    // `readsContent: false` is a placeholder rather than an answer. Two things
    // keep it from becoming a false "body content was dropped": a nested
    // unit's warnings go to a sink that is discarded (`lower.ts`), and the
    // entry is marked `pending` so the warning is not raised at all. The
    // second is the one asserted here, because the first is a property of the
    // caller and would not survive that sink being forwarded.
    //
    // `tree.mx` both recurses with a body and renders `input.content`, so a
    // warning here would be accusing a template that does place the body.
    resetTemplateCache();
    const warnings: MxWarning[] = [];
    const recursive = template(
      "/tmp/mx-template-test/tags/tree.mx",
      "<li><${input.content}/><if=input.next><tree next=input.next.next>deeper</tree></if></li>",
    );
    lowerWithTags(
      "<tree next=input.root>top</tree>\n",
      { tree: recursive },
      CALLER,
      warnings,
    );
    expect(warnings).toEqual([]);
  });

  it("marks a unit's metadata pending only while it is being compiled", () => {
    // The provisional entry is what terminates recursion, and `pending` is
    // what stops a caller reading its placeholder as an answer. Asserted from
    // inside the unit's own compile, which is the only moment the flag is set:
    // `<host>` calls `<probe>`, whose transform runs while `host.mx` is still
    // being compiled for its metadata.
    resetTemplateCache();
    const seen: Array<boolean | undefined> = [];
    const host = template(
      "/tmp/mx-template-test/tags/host.mx",
      "<div><${input.content}/><probe/></div>",
    );
    const probe: CustomTag = {
      transform(): [] {
        seen.push(peekTemplateMetadata(host.template.filename)?.pending);
        return [];
      },
    };
    lowerWithTags("<host>body</host>\n", { host, probe });

    // Read from inside the unit's own compile: not an answer yet.
    expect(seen).toEqual([true]);
    // Read once it finished: the real answer, no longer pending.
    const after = peekTemplateMetadata(host.template.filename);
    expect(after?.pending).toBeUndefined();
    expect(after?.readsContent).toBe(true);
  });

  it("allows a template to call its own discovered name", () => {
    const recursive = template(
      "/tmp/mx-template-test/tags/tree.mx",
      "<if=input.next><tree next=input.next.next/></if>",
    );
    expect(() =>
      lowerWithTags("<tree next=input.root/>\n", { tree: recursive }),
    ).not.toThrow();
  });

  it("lets a sidecar rewrite the call before routing to its template", () => {
    const tagged = template("/tmp/mx-template-test/tags/tagged.mx", "<i/>", {
      transform(call: TagCall): TagCall {
        return { ...call, attrs: [] };
      },
    });
    const ir = lowerWithTags('<tagged title="removed"/>\n', { tagged });
    expect(components(ir.body)[0]?.attrs).toEqual([]);
  });

  it("keeps template diagnostics attached to the template file", () => {
    const broken = template(
      "/tmp/mx-template-test/tags/broken.mx",
      "<Missing/>",
    );
    try {
      lowerWithTags("<broken/>\n", { broken });
      expect.unreachable("template compilation should fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TranslateError);
      expect((error as TranslateError).file).toBe(broken.template.filename);
    }
  });
});

describe("touchAndEvict", () => {
  it("moves a refreshed key to most-recent, evicting the oldest OTHER entry", () => {
    const cache = new Map<string, string>([
      ["a", "a1"],
      ["b", "b1"],
      ["c", "c1"],
    ]);
    // Refresh "a": naive `set` without `delete` would leave it at its
    // original ordinal, so an insertion-order eviction would drop "a" (the
    // just-refreshed entry) instead of "b" (the true oldest).
    touchAndEvict(cache, "a", "a2", 2);
    expect(cache.has("a")).toBe(true);
    expect(cache.get("a")).toBe("a2");
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
  });

  it("never evicts the key just written, even at exactly max + 1", () => {
    const cache = new Map<string, string>([
      ["a", "a1"],
      ["b", "b1"],
    ]);
    touchAndEvict(cache, "new", "new1", 2);
    expect(cache.size).toBe(2);
    expect(cache.has("new")).toBe(true);
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
  });

  it("evicts the oldest entry on a normal insert over the bound", () => {
    const cache = new Map<string, string>([
      ["a", "a1"],
      ["b", "b1"],
      ["c", "c1"],
    ]);
    touchAndEvict(cache, "d", "d1", 3);
    expect(cache.size).toBe(3);
    expect(cache.has("a")).toBe(false);
    expect([...cache.keys()]).toEqual(["b", "c", "d"]);
  });

  it("still refuses to evict the just-written key when max is 0, leaving it alone above the bound", () => {
    const cache = new Map<string, string>([["a", "a1"]]);
    touchAndEvict(cache, "b", "b1", 0);
    expect(cache.size).toBe(1);
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
  });
});
