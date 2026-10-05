import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { printExpression } from "./compile.ts";
import { type Ctx, type Node, newCtx, TranslateError } from "./core.ts";
import { type CustomTag, customTagTaglib } from "./custom-tags.ts";
import type {
  DefaultTagParent,
  HostDeclarations,
  Policy,
} from "./declarations.ts";
import { parseFragment } from "./fragment.ts";
import type { Attr, Ir, IrNode } from "./ir.ts";
import { lower, lowerChildren } from "./lower.ts";
import { lookup } from "./test-targets.ts";

type Resolver = NonNullable<HostDeclarations["resolveDefaultTag"]>;
type Call = { node: Node; parents: readonly DefaultTagParent[] };

function declarations(resolveDefaultTag?: Resolver): Policy {
  return {
    tags: {},
    isElement: () => true,
    isComponent: (name, ctx) => ctx.defines.has(name),
    ...(resolveDefaultTag ? { resolveDefaultTag } : {}),
  };
}

/** Lowers through the node core really receives: Marko's parse, then `lower`. */
function lowerSource(
  source: string,
  policy: Policy,
  customTags?: Readonly<Record<string, CustomTag>>,
  defaultTag?: string,
): Ir {
  let ir: Ir | null = null;
  let thrown: unknown = null;
  const translator = {
    taglibs: [...(customTags ? [customTagTaglib(customTags)] : [])].filter(
      (entry): entry is [string, unknown] => entry !== null,
    ),
    tagDiscoveryDirs: [] as string[],
    translate: {
      Program: {
        exit(path: { node: { body: Node[] } }) {
          const ctx: Ctx = newCtx(
            source,
            printExpression,
            policy,
            undefined,
            "test.mx",
            lookup,
          );
          ctx.customTags = customTags;
          if (defaultTag !== undefined) ctx.defaultTag = defaultTag;
          try {
            ir = lower(ctx, path.node.body);
          } catch (error) {
            thrown = error;
          }
          path.node.body = [];
        },
      },
    },
  };
  const require = createRequire(import.meta.url);
  require("@marko/compiler").compileSync(source, "/tmp/mx-core-test/dt.mx", {
    translator,
    output: "html",
    writeVersionComment: false,
  });
  if (thrown) throw thrown;
  if (!ir) throw new Error("no IR");
  return ir;
}

function recording(name = "div"): { resolver: Resolver; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    resolver: (node, parents) => {
      calls.push({ node, parents });
      return name;
    },
  };
}

function elements(
  nodes: readonly IrNode[],
): Array<IrNode & { kind: "Element" }> {
  const found: Array<IrNode & { kind: "Element" }> = [];
  const walk = (list: readonly IrNode[]) => {
    for (const node of list) {
      if (node.kind === "Element") found.push(node);
      const children = (node as { children?: IrNode[] }).children;
      if (children) walk(children);
    }
  };
  walk(nodes);
  return found;
}

const attr = (attrs: Attr[], name: string) =>
  attrs.find((a) => (a as { name?: string }).name === name);

describe("unnamed tag resolves through resolveDefaultTag", () => {
  it.each([
    ["<#a/>", 1],
    ["<.a.b/>", 1],
    ["<#a.b/>", 1],
    ["#a.b\n", 1],
    [".x\n", 1],
    ["<.${x}/>", 1],
    ["<#${x}/>", 1],
    ["<#outer><.inner/></>", 2],
    ["<.a>\n  <.b>\n    <#c/>\n  </>\n</>\n", 3],
  ])(
    "%j calls the resolver %i time(s) and lowers to its name",
    (src, count) => {
      const { resolver, calls } = recording("section");
      const ir = lowerSource(src, declarations(resolver));
      expect(calls).toHaveLength(count);
      const els = elements(ir.body);
      expect(els).toHaveLength(count);
      expect(els.every((e) => e.name === "section")).toBe(true);
    },
  );

  it("receives the node whose name span is empty, multi-line included", () => {
    const { resolver, calls } = recording();
    lowerSource("<p>\n  <.a/>\n</p>\n.x\n", declarations(resolver));
    expect(calls).toHaveLength(2);
    for (const { node } of calls) {
      const { start, end } = node.name.loc;
      expect(start.line).toBe(end.line);
      expect(start.column).toBe(end.column);
    }
    expect(calls[0]?.node.name.loc.start.line).toBe(2);
    expect(calls[1]?.node.name.loc.start.line).toBe(4);
  });

  it("keeps #id and .class lowering and the class= merge", () => {
    const { resolver } = recording("span");
    const ir = lowerSource('<#x.a.b class="c"/>', declarations(resolver));
    const [el] = elements(ir.body);
    expect(el?.name).toBe("span");
    const plain = lowerSource(
      '<span#x.a.b class="c"/>',
      declarations(recording().resolver),
    );
    // Positions differ with the source text; everything else must not.
    const bare = (attrs: unknown) =>
      JSON.stringify(attrs, (key, value) =>
        /span|loc/i.test(key) ? undefined : value,
      );
    expect(bare(el?.attrs)).toBe(bare(elements(plain.body)[0]?.attrs));
    expect(attr(el?.attrs ?? [], "id")).toBeDefined();
  });

  it("a resolver returning a custom tag name lowers to that custom tag", () => {
    const ir = lowerSource('<#x.a class="b"/>', {
      ...declarations(() => "my-card"),
      isElement: (name) => name !== "my-card",
      isComponent: (name) => name === "my-card",
    });
    const [node] = ir.body;
    expect(node?.kind).toBe("Component");
    const target = (node as { target: { kind: string; name?: string } }).target;
    expect(target.name).toBe("my-card");
    const authored = lowerSource('<my-card#x.a class="b"/>', {
      ...declarations(() => "unused"),
      isElement: (name) => name !== "my-card",
      isComponent: (name) => name === "my-card",
    });
    const bare = (value: unknown) =>
      JSON.stringify(value, (key, v) =>
        /span|loc/i.test(key) ? undefined : v,
      );
    expect(bare(ir.body)).toBe(bare(authored.body));
  });

  it("gives the parent chain, nearest first", () => {
    const { resolver, calls } = recording();
    lowerSource("<a><b><.z/></b></a>", declarations(resolver));
    expect(calls[0]?.parents.map((p) => p.name)).toEqual(["b", "a"]);
    expect(calls[0]?.parents.every((p) => p.attributeTag === false)).toBe(true);
    expect(calls[0]?.parents[0]?.node.name.value).toBe("b");
  });

  it("an unnamed ancestor appears under its resolved name", () => {
    const calls: Call[] = [];
    lowerSource("<#o><.i/></>", {
      ...declarations((node, parents) => {
        calls.push({ node, parents });
        return calls.length === 1 ? "outer" : "inner";
      }),
    });
    expect(calls[1]?.parents.map((p) => p.name)).toEqual(["outer"]);
  });

  it("marks attribute-tag parents", () => {
    const { resolver, calls } = recording();
    lowerSource("<x><@y><.z/></@y></x>", {
      ...declarations(resolver),
      isElement: (name) => name !== "x",
      isComponent: (name) => name === "x",
    });
    const parents = calls[0]?.parents ?? [];
    expect(parents.map((p) => p.name)).toEqual(["@y", "x"]);
    expect(parents.map((p) => p.attributeTag)).toEqual([true, false]);
  });

  it("passes through control flow", () => {
    const { resolver, calls } = recording();
    lowerSource(
      "<ul><if=x><.a/></if><else><.b/></else><for|i| of=xs><.c/></for></ul>",
      declarations(resolver),
    );
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.parents.map((p) => p.name).at(-1)).toBe("ul");
    }
    expect(calls[0]?.parents.map((p) => p.name)).toEqual(["if", "ul"]);
    expect(calls[2]?.parents.map((p) => p.name)).toEqual(["for", "ul"]);
  });

  it("never calls the resolver for a named or dynamic-named tag", () => {
    const { resolver, calls } = recording();
    lowerSource("<div#a/><div.b/><${x}.a/>\n<p/>", declarations(resolver));
    expect(calls).toHaveLength(0);
  });
});

describe("no resolver", () => {
  it.each(["<#a/>", "<.a.b/>", "#a.b\n", ".x\n", "<.${x}/>"])(
    "%j raises a positioned error naming no host",
    (src) => {
      let error: unknown;
      try {
        lowerSource(src, declarations());
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(TranslateError);
      const e = error as TranslateError;
      expect(e.message).toMatch(/no default tag/i);
      expect(e.message).not.toMatch(/\bhost\b|\btarget\b/i);
      expect(e.line).toBe(1);
    },
  );

  it("positions the error at the shorthand tag", () => {
    let error: unknown;
    try {
      lowerSource("<p>\n  <.a/>\n</p>", declarations());
    } catch (e) {
      error = e;
    }
    expect((error as TranslateError).line).toBe(2);
  });

  it("compiles as before when no shorthand is used", () => {
    const ir = lowerSource('<div#a class="b"/><${x}.c/>', declarations());
    const [first, second] = ir.body;
    expect(first?.kind).toBe("Element");
    expect((first as { name: string }).name).toBe("div");
    const names = (first as { attrs: Attr[] }).attrs.map(
      (a) => (a as { name?: string }).name,
    );
    expect(names).toEqual(expect.arrayContaining(["id", "class"]));
    expect(second?.kind).toBe("Component");
  });
});

describe("lowerChildren as an external entry", () => {
  function childrenCtx(policy: Policy, source: string): Ctx {
    const ctx = newCtx(
      source,
      printExpression,
      policy,
      undefined,
      "/tmp/mx-core-test/dt.mx",
      lookup,
    );
    return ctx;
  }

  it("with no resolver and a shorthand gives the positioned error", () => {
    const source = "<p>\n  <.a/>\n</p>";
    let error: unknown;
    try {
      lowerChildren(
        childrenCtx(declarations(), source),
        parseFragment(source).body,
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TranslateError);
    expect((error as TranslateError).message).toMatch(/no default tag/i);
    expect((error as TranslateError).line).toBe(2);
  });

  it("with a resolver calls it once per unnamed tag", () => {
    const { resolver, calls } = recording("section");
    const source = "<#a><.b/></>\n<p><#c/></p>";
    const nodes = lowerChildren(
      childrenCtx(declarations(resolver), source),
      parseFragment(source).body,
    );
    expect(calls).toHaveLength(3);
    expect(elements(nodes).map((e) => e.name)).toEqual([
      "section",
      "section",
      "p",
      "section",
    ]);
  });
});

describe("lower() calls the resolver once per unnamed tag", () => {
  it("in a plain file", () => {
    const { resolver, calls } = recording();
    lowerSource("<#a><.b><#c/></></>", declarations(resolver));
    expect(calls).toHaveLength(3);
  });

  it("including under a custom tag with an analyze hook", () => {
    const { resolver, calls } = recording();
    const tag: CustomTag = {
      analyze() {},
      transform: (call) => call.content?.children ?? [],
    };
    lowerSource(
      "<marker><#a><.b/></></marker>\n<.c/>",
      declarations(resolver),
      { marker: tag },
    );
    expect(calls).toHaveLength(3);
  });
});

describe("the resolver's context", () => {
  it("carries the configured name and the custom tags of this compile", () => {
    const seen: Array<{ configured?: string; tags: string[] }> = [];
    const policy = declarations((_node, _parents, context) => {
      seen.push({
        ...(context.configured === undefined
          ? {}
          : { configured: context.configured }),
        tags: Object.keys(context.customTags ?? {}),
      });
      return context.configured ?? "section";
    });
    const tag: CustomTag = {
      transform: (call) => call.content?.children ?? [],
    };
    lowerSource("<.a/>", policy, { marker: tag }, "my-card");
    expect(seen).toEqual([{ configured: "my-card", tags: ["marker"] }]);
  });

  it("has no configured name when the compile carries none", () => {
    let configured: string | undefined = "unset";
    lowerSource(
      "<.a/>",
      declarations((_n, _p, context) => {
        configured = context.configured;
        return "div";
      }),
    );
    expect(configured).toBeUndefined();
  });
});
