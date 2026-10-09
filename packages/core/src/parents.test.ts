import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileSource } from "./compile.ts";
import { type Node, newCtx, TranslateError } from "./core.ts";
import type { CustomTag } from "./custom-tags.ts";
import type { HostDeclarations } from "./declarations.ts";
import { parseFragment } from "./fragment.ts";
import type { Ir } from "./ir.ts";
import { lowerChildren } from "./lower.ts";
import { getCustomTags } from "./scan-cache.ts";
import type { TemplateBackedTag } from "./template-tag.ts";
import { lookup } from "./test-targets.ts";

const declarations: HostDeclarations = {
  tags: {},
  isElement: () => true,
  isComponent: () => false,
};

const passthrough: CustomTag = {
  transform: (call) => call.content?.children ?? [],
};

// Measure the parsed authored tree independently of the implementation under test.
// An attribute tag is an authored container too, not its eventual emitted prop:
// in the MX AST it is an `MxAttributeTag` child in its parent's body, named
// `@<name>` here as Marko named it.
function authoredParents(
  nodes: readonly Node[],
  ancestors: string[] = [],
): string[] {
  const result: string[] = [];
  for (const node of nodes) {
    let name: string | undefined;
    if (node.type === "MxTag") {
      name = node.name.kind === "static" ? node.name.value : undefined;
    } else if (node.type === "MxAttributeTag") {
      name = `@${node.name.value}`;
    } else {
      continue;
    }
    if (name === "attribute") result.push(ancestors.at(-1) ?? "#root");
    const transparent = ["if", "else-if", "else", "for"].includes(name ?? "");
    result.push(
      ...authoredParents(
        node.body ?? [],
        transparent ? ancestors : [...ancestors, name ?? "#dynamic"],
      ),
    );
  }
  return result;
}

const cases = [
  [
    "direct child",
    "<attributes><attribute/></attributes>",
    "attributes",
    "page.mx",
  ],
  [
    "branches",
    "<attributes><if=input.a><attribute/></if><else-if=input.b><attribute/></else-if><else><attribute/></else></attributes>",
    "attributes",
    "page.mx",
  ],
  [
    "for",
    "<attributes><for|x| of=input.xs><attribute/></for></attributes>",
    "attributes",
    "page.mx",
  ],
  [
    "intervening element",
    "<attributes><div><attribute/></div></attributes>",
    "div",
    "page.mx",
  ],
  ["file top level", "<attribute/>", "#root", "page.mx"],
  ["template own top level", "<attribute/>", "#root", "attributes.mx"],
  [
    "attribute-tag body",
    "<attributes><@row><attribute/></@row></attributes>",
    "@row",
    "page.mx",
  ],
  ["recursion in own template", "<attribute/>", "#root", "attribute.mx"],
] as const;

describe("authored parents step 0 measurement (decision 138 E3)", () => {
  it.each(cases)(
    "measures %s before enforcing parents",
    (label, source, parent, basename) => {
      const filename = `/tmp/mx-parents-test/${basename}`;
      const { body } = parseFragment(source, { filename });
      const measured = authoredParents(body);
      console.log(`STEP 0 ${label}: ${measured.join(", ")}`);
      expect(measured.length).toBeGreaterThan(0);
      expect(measured.every((actual) => actual === parent)).toBe(true);

      const attribute: CustomTag = {
        ...passthrough,
        parents: ["wrong-parent"],
      };
      try {
        compileSource(source, filename, declarations, {
          targets: lookup,
          customTags: {
            attributes: { ...passthrough, attributeTags: { row: {} } },
            attribute,
          },
          tagDiscoveryDirs: [],
          warnings: [],
          emitIr: () => "",
        });
        throw new Error("expected parents contract failure");
      } catch (error) {
        expect(error).toBeInstanceOf(TranslateError);
        expect(error).toMatchObject({
          message:
            "`<attribute>` must be inside `<wrong-parent>`; " +
            (parent === "#root"
              ? "found at the top level"
              : `found inside \`<${parent}>\``),
          line: 1,
          column: source.indexOf("<attribute/"),
        });
      }
    },
  );
});

function compile(
  source: string,
  tags: Record<string, CustomTag>,
  filename = "/tmp/mx-parents-test/page.mx",
  policy = declarations,
): Ir {
  let result: Ir | undefined;
  compileSource(source, filename, policy, {
    targets: lookup,
    customTags: tags,
    tagDiscoveryDirs: [],
    warnings: [],
    emitIr(ir) {
      result = ir;
      return "";
    },
  });
  if (!result) throw new Error("no IR");
  return result;
}

function fails(
  source: string,
  tags: Record<string, CustomTag>,
  message: string,
  line: number,
  column: number,
) {
  try {
    compile(source, tags);
    throw new Error("expected contract failure");
  } catch (error) {
    expect(error).toBeInstanceOf(TranslateError);
    expect(error).toMatchObject({ message, line, column });
  }
}

function withScratch(run: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "mx-parent-contract-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const restricted: Record<string, CustomTag> = {
  attributes: passthrough,
  attribute: { ...passthrough, parents: ["attributes"] },
};

describe("allowed authored parents (decision 138 E3)", () => {
  it("keeps omitted parents open and rejects an empty list", () => {
    expect(() =>
      compile("<div><attribute/></div><attribute/>", {
        attribute: passthrough,
      }),
    ).not.toThrow();
    fails(
      "<attribute/>",
      { attribute: { ...passthrough, parents: [] } },
      "`<attribute>` must be inside an allowed parent (none declared); found at the top level",
      1,
      0,
    );
  });
  it.each(cases)(
    "accepts the measured parent: %s",
    (_label, source, parent, basename) => {
      expect(() =>
        compile(
          source,
          {
            attributes: { ...passthrough, attributeTags: { row: {} } },
            attribute: { ...passthrough, parents: [parent] },
          },
          `/tmp/mx-parents-test/${basename}`,
        ),
      ).not.toThrow();
    },
  );
  it("sees through nested for/if and <else if>, with layout between branches", () => {
    expect(() =>
      compile(
        "<attributes><for|x| of=input.xs><if=x><attribute/></if>\n<!-- gap --><else if=input.b><attribute/></else><else><attribute/></else></for></attributes>",
        restricted,
      ),
    ).not.toThrow();
  });
  it("breaks the chain at an unregistered element and positions the first error", () => {
    fails(
      "<attributes>\n  <div>\n    <attribute/>\n    <attribute/>\n  </div>\n</attributes>",
      restricted,
      "`<attribute>` must be inside `<attributes>`; found inside `<div>`",
      3,
      4,
    );
    fails(
      "\n<attribute/>",
      restricted,
      "`<attribute>` must be inside `<attributes>`; found at the top level",
      2,
      0,
    );
  });
  it("does not let a preceding sibling leak onto the stack", () => {
    fails(
      "<attributes><attribute/></attributes>\n<attribute/>",
      restricted,
      "`<attribute>` must be inside `<attributes>`; found at the top level",
      2,
      0,
    );
  });
  it("uses authored names rather than transform output", () => {
    expect(() =>
      compile("<attributes><attribute/></attributes>", {
        ...restricted,
        attributes: {
          transform: (call, ctx) => [
            ctx.build.element("div", [], call.content?.children ?? []),
          ],
        },
      }),
    ).not.toThrow();
  });
  it("allows #root alone or with named parents, including under root control flow", () => {
    const tags = { attribute: { ...passthrough, parents: ["#root"] } };
    expect(() =>
      compile(
        "<if=input.a><attribute/></if><else><for|x| of=input.xs><attribute/></for></else>",
        tags,
      ),
    ).not.toThrow();
    fails(
      "<div><attribute/></div>",
      tags,
      "`<attribute>` must be at the top level; found inside `<div>`",
      1,
      5,
    );
    const mixed = {
      attribute: { ...passthrough, parents: ["attributes", "other", "#root"] },
    };
    expect(() =>
      compile("<attribute/><other><attribute/></other>", mixed),
    ).not.toThrow();
    fails(
      "<div><attribute/></div>",
      mixed,
      "`<attribute>` must be inside `<attributes>`, `<other>` or at the top level; found inside `<div>`",
      1,
      5,
    );
  });
  it("an attribute-tag body has @row as parent, also through control flow and nested attribute tags", () => {
    const owner: CustomTag = { ...passthrough, attributeTags: { row: {} } };
    const source =
      "<attributes><@row><if=input.a><for|x| of=input.xs><attribute/></for></if></@row></attributes>";
    expect(() =>
      compile(source, {
        attributes: owner,
        attribute: { ...passthrough, parents: ["@row"] },
      }),
    ).not.toThrow();
    fails(
      source,
      { ...restricted, attributes: owner },
      "`<attribute>` must be inside `<attributes>`; found inside `<@row>`",
      1,
      source.indexOf("<attribute/"),
    );
    const nested =
      "<attributes><@row><@inner><attribute/></@inner></@row></attributes>";
    expect(() =>
      compile(
        nested,
        {
          attributes: {
            template: {
              filename: "/tmp/mx-parents-test/owner.mx",
              source: "<div/>",
            },
            attributeTags: { row: {} },
          } as TemplateBackedTag,
          attribute: { ...passthrough, parents: ["@inner"] },
        },
        undefined,
        { ...declarations, attrTags: 2 },
      ),
    ).not.toThrow();
  });
  it("checks parent before the body lowers or a transform/analyze hook runs", () => {
    const transform = vi.fn(() => []);
    const analyze = vi.fn();
    fails(
      "<attribute><Bad/></attribute>",
      { attribute: { parents: ["attributes"], transform, analyze } },
      "`<attribute>` must be inside `<attributes>`; found at the top level",
      1,
      0,
    );
    expect(transform).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
  });
  it("enforces parents-only delegated contracts and leaves generated IR unchecked", () => {
    const policy = { ...declarations, isDelegatedTag: () => true };
    expect(
      compile(
        "<attributes><attribute/></attributes>",
        { attribute: { parents: ["attributes"] } },
        undefined,
        policy,
      ).body[0],
    ).toMatchObject({
      kind: "DelegatedTag",
      tag: {
        name: "attributes",
        children: [{ kind: "DelegatedTag", tag: { name: "attribute" } }],
      },
    });
    expect(() =>
      compile(
        "<attribute/>",
        { attribute: { parents: ["attributes"] } },
        undefined,
        policy,
      ),
    ).toThrowError("found at the top level");
    expect(() =>
      compile("<maker/>", {
        maker: { transform: (_call, ctx) => [ctx.build.element("attribute")] },
        attribute: { parents: ["attributes"], ...passthrough },
      }),
    ).not.toThrow();
  });
  it("cross-checks children and parents at registration in both front doors", () => {
    const tags: Record<string, CustomTag> = {
      attributes: { children: { attribute: {} }, ...passthrough },
      attribute: { parents: ["other", "#root"], ...passthrough },
    };
    const message =
      "`<attributes>`: child `<attribute>` declares `parents` without `<attributes>`; add `<attributes>` to `<attribute>`'s `parents`, or remove `<attribute>` from `<attributes>`'s `children`";
    fails("<div/>", tags, message, 0, 0);
    expect(() => parseFragment("<div/>", { customTags: tags })).toThrowError(
      message,
    );
    expect(() =>
      compile("<div/>", {
        ...tags,
        attribute: { ...passthrough, parents: ["attributes"] },
      }),
    ).not.toThrow();
    expect(() =>
      compile("<div/>", { ...tags, attribute: passthrough }),
    ).not.toThrow();
    expect(() =>
      compile("<div/>", {
        attributes: {
          ...passthrough,
          children: { unregistered: {}, "#text": {} },
        },
      }),
    ).not.toThrow();
  });
  it.each([false, true])(
    "cross-checks a child's parents against closed children before parsing (child first: %s)",
    (childFirst) => {
      const parent: CustomTag = { ...passthrough, children: { other: {} } };
      const child: CustomTag = { ...passthrough, parents: ["attributes"] };
      const tags = childFirst
        ? { attribute: child, attributes: parent }
        : { attributes: parent, attribute: child };
      const message =
        "`<attribute>`: parent `<attributes>` declares `children` without `<attribute>`; add `<attribute>` to `<attributes>`'s `children`, or remove `<attributes>` from `<attribute>`'s `parents`";
      fails("<div/>", tags, message, 0, 0);
      expect(() => parseFragment("<div/>", { customTags: tags })).toThrowError(
        message,
      );
      // An empty children declaration is closed too.
      fails(
        "<div/>",
        { ...tags, attributes: { ...passthrough, children: {} } },
        message,
        0,
        0,
      );
      expect(() =>
        compile("<div/>", {
          ...tags,
          attributes: { ...passthrough, children: { attribute: {} } },
        }),
      ).not.toThrow();
      expect(() =>
        compile("<div/>", { ...tags, attributes: passthrough }),
      ).not.toThrow();
      expect(() =>
        compile("<div/>", {
          attribute: { ...child, parents: ["unknown", "#root", "@row"] },
        }),
      ).not.toThrow();
    },
  );
  it("define is an authored parent and dynamic parents never match a parents list", () => {
    const define = "<attributes><define/Row><attribute/></define></attributes>";
    fails(
      define,
      restricted,
      "`<attribute>` must be inside `<attributes>`; found inside `<define>`",
      1,
      define.indexOf("<attribute/"),
    );
    expect(() =>
      compile(define, {
        ...restricted,
        attribute: { ...passthrough, parents: ["define"] },
      }),
    ).not.toThrow();
    const dynamic = `<\${input.tag}><attribute/></>`;
    fails(
      dynamic,
      restricted,
      `\`<attribute>\` must be inside \`<attributes>\`; found inside \`<\${…}>\``,
      1,
      dynamic.indexOf("<attribute/"),
    );
    // Even spelling the printed diagnostic placeholder is not a way to allow a dynamic parent.
    fails(
      dynamic,
      { attribute: { ...passthrough, parents: [`\${…}`, "#root"] } },
      `\`<attribute>\` must be inside \`<\${…}>\` or at the top level; found inside \`<\${…}>\``,
      1,
      dynamic.indexOf("<attribute/"),
    );
  });
  it.each(["specification.md", "custom-tags/sidecars.md"])(
    "documents define and dynamic parent boundaries in %s",
    (path) => {
      const text = readFileSync(
        new URL(`../../../apps/docs/docs/${path}`, import.meta.url),
        "utf8",
      );
      expect(text.includes("parent `define`")).toBe(true);
      expect(text.includes("never matches a `parents` list")).toBe(true);
    },
  );
  it("checks a discovered declaration-only template sidecar and a parents-only sidecar", () =>
    withScratch((directory) => {
      mkdirSync(join(directory, "tags"));
      writeFileSync(
        join(directory, "package.json"),
        '{"name":"parents-fixture"}',
      );
      writeFileSync(join(directory, "tags", "attribute.mx"), "<div/>");
      writeFileSync(
        join(directory, "tags", "attribute.tag.ts"),
        'export default { parents: ["attributes"] };',
      );
      writeFileSync(
        join(directory, "tags", "item.tag.ts"),
        'export default { parents: ["attributes"] };',
      );
      const filename = join(directory, "page.mx");
      const tags = getCustomTags(filename, { targets: lookup });
      expect(tags.attribute?.parents).toEqual(["attributes"]);
      expect(() =>
        compile("<attributes><attribute/></attributes>", tags, filename),
      ).not.toThrow();
      expect(() => compile("<attribute/>", tags, filename)).toThrowError(
        "found at the top level",
      );
      const policy = { ...declarations, isDelegatedTag: () => true };
      expect(
        compile("<attributes><item/></attributes>", tags, filename, policy)
          .body[0]?.kind,
      ).toBe("DelegatedTag");
      expect(() => compile("<item/>", tags, filename, policy)).toThrowError(
        "found at the top level",
      );
    }));
  it("a template's own top level is #root, never its caller's enclosing tag", () =>
    withScratch((directory) => {
      const filename = join(directory, "box.mx");
      const source = "<attribute/>";
      writeFileSync(filename, source);
      const box: TemplateBackedTag = {
        template: { filename, source },
        parents: ["attributes"],
      };
      const tags = {
        attributes: passthrough,
        box,
        attribute: { ...passthrough, parents: ["#root"] },
      };
      expect(() =>
        compile("<attributes><box/></attributes>", tags),
      ).not.toThrow();
      // Change source so metadata is freshly compiled instead of reusing the valid entry.
      const bad: TemplateBackedTag = {
        ...box,
        template: { filename, source: "\n<attribute/>" },
      };
      expect(() =>
        compile("<attributes><box/></attributes>", {
          ...tags,
          box: bad,
          attribute: { ...passthrough, parents: ["attributes"] },
        }),
      ).toThrowError("found at the top level");
    }));
  it("a recursive call is checked in its own unit's root or authored wrapper", () =>
    withScratch((directory) => {
      const filename = join(directory, "attribute.mx");
      const source = "<if=input.more><attribute/></if>";
      writeFileSync(filename, source);
      const attribute: TemplateBackedTag = {
        template: { filename, source },
        parents: ["#root"],
      };
      const ir = compile(source, { attribute }, filename);
      expect(ir.imports).toEqual([]);
      expect(() =>
        compile(
          source,
          { attribute: { ...attribute, parents: ["attribute"] } },
          filename,
        ),
      ).toThrowError("found at the top level");
      const wrapped = "<attributes><attribute/></attributes>";
      const nested: TemplateBackedTag = {
        template: { filename, source: wrapped },
        parents: ["attributes"],
      };
      expect(() =>
        compile(
          wrapped,
          { attributes: passthrough, attribute: nested },
          filename,
        ),
      ).not.toThrow();
    }));
  it("unwinds the stack on failure and can reuse the context", () => {
    const source = "<div><attribute/></div>";
    const ctx = newCtx(
      source,
      () => "",
      declarations,
      undefined,
      "/tmp/mx-parents-test/page.mx",
      lookup,
    );
    ctx.customTags = restricted;
    expect(() => lowerChildren(ctx, parseFragment(source).body)).toThrowError(
      "found inside `<div>`",
    );
    expect(ctx.authoredAncestors).toEqual([]);
    ctx.customTags = { attribute: { ...passthrough, parents: ["#root"] } };
    expect(() =>
      lowerChildren(ctx, parseFragment("<attribute/>").body),
    ).not.toThrow();
    expect(ctx.authoredAncestors).toEqual([]);
  });
});
