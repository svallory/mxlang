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
): Ir {
  let ir: Ir | null = null;
  compileSource(source, filename, declarations(), {
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
