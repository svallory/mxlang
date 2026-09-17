import { describe, expect, it, vi } from "vitest";
import { compileSource } from "./compile.ts";
import { TranslateError } from "./core.ts";
import type { CustomTag } from "./custom-tags.ts";
import type { Policy } from "./declarations.ts";
import type { Ir, IrNode } from "./ir.ts";
import {
  resetTemplateCache,
  type TemplateBackedTag,
  templateCompileCount,
} from "./template-tag.ts";

function declarations(overrides: Partial<Policy> = {}): Policy {
  return {
    tags: {},
    isElement: () => true,
    isComponent: (name, ctx) => ctx.defines.has(name),
    ...overrides,
  };
}

const CALLER = "/tmp/mx-template-test/page.mx";

function lowerWithTags(
  source: string,
  customTags: Readonly<Record<string, CustomTag>>,
  filename = CALLER,
): Ir {
  let ir: Ir | null = null;
  compileSource(source, filename, declarations(), {
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

function template(
  filename: string,
  source: string,
  extra: Partial<CustomTag> = {},
): TemplateBackedTag {
  return { template: { filename, source }, ...extra };
}

/** Every node in the tree, flattened, so an assertion can search the whole IR. */
function flatten(nodes: IrNode[]): IrNode[] {
  const out: IrNode[] = [];
  const visit = (list: IrNode[]) => {
    for (const node of list) {
      out.push(node);
      if ("children" in node && Array.isArray(node.children)) {
        visit(node.children as IrNode[]);
      }
      if (node.kind === "IfChain") {
        for (const branch of node.branches) visit(branch.children);
      }
      if (node.kind === "Component") {
        if (node.content) visit(node.content.children);
        for (const tag of node.attributeTags) visit(tag.block.children);
      }
    }
  };
  visit(nodes);
  return out;
}

function texts(ir: Ir): string[] {
  return flatten(ir.body)
    .filter(
      (node): node is Extract<IrNode, { kind: "Text" }> => node.kind === "Text",
    )
    .map((node) => node.value)
    .filter((value) => value.trim() !== "");
}

function interpolations(ir: Ir): string[] {
  return flatten(ir.body)
    .filter((node) => node.kind === "Interpolation")
    .map(
      (node) => (node as Extract<IrNode, { kind: "Interpolation" }>).expr.code,
    );
}

function elements(ir: Ir): string[] {
  return flatten(ir.body)
    .filter((node) => node.kind === "Element")
    .map((node) => (node as Extract<IrNode, { kind: "Element" }>).name);
}

describe("template custom tags", () => {
  it("inlines a template at the call site", () => {
    const ir = lowerWithTags("<box/>\n", {
      box: template("/tags/box.mx", "<div><span>hi</span></div>"),
    });
    expect(elements(ir)).toEqual(["div", "span"]);
    expect(texts(ir)).toEqual(["hi"]);
  });

  it("substitutes the call's attributes into the template's `input` reads", () => {
    const ir = lowerWithTags('<box title="hello" count=2/>\n', {
      box: template("/tags/box.mx", "<div>${input.title}${input.count}</div>"),
    });
    expect(interpolations(ir)).toEqual(['"hello"', "2"]);
    // No binding is emitted at all: a `Const` is a statement, and four of the
    // six hosts emit a template body as a single JSX expression, where a
    // statement cannot go.
    expect(ir.body.filter((node) => node.kind === "Const")).toEqual([]);
  });

  it("parenthesizes a substituted expression so precedence survives", () => {
    const ir = lowerWithTags("<box size=a ?? b/>\n", {
      box: template("/tags/box.mx", "<div>${input.size ?? 24}</div>"),
    });
    expect(interpolations(ir)).toEqual(["(a ?? b) ?? 24"]);
  });

  it("resolves a read the call supplies no attribute for to `undefined`", () => {
    const ir = lowerWithTags("<box/>\n", {
      box: template("/tags/box.mx", "<div>${input.size ?? 24}</div>"),
    });
    expect(interpolations(ir)).toEqual(["undefined ?? 24"]);
  });

  it("refuses a spread attribute, whose keys are not known at compile time", () => {
    expect(() =>
      lowerWithTags("<box ...rest/>\n", {
        box: template("/tags/box.mx", "<div>${input.a}</div>"),
      }),
    ).toThrowError(
      "a spread attribute cannot be passed to a tag template, whose `input` reads are substituted at compile time",
    );
  });

  it("substitutes each call site's own attributes", () => {
    const ir = lowerWithTags('<box a="1"/><box a="2"/>\n', {
      box: template("/tags/box.mx", "<div>${input.a}</div>"),
    });
    expect(interpolations(ir)).toEqual(['"1"', '"2"']);
  });

  it("splices body content at `<${input.content}/>`", () => {
    const ir = lowerWithTags("<box><em>body</em></box>\n", {
      box: template("/tags/box.mx", "<section><${input.content}/></section>"),
    });
    expect(elements(ir)).toEqual(["section", "em"]);
    expect(texts(ir)).toEqual(["body"]);
  });

  it("splices attribute tags, preserving repeats", () => {
    const ir = lowerWithTags(
      "<list><@item>one</@item><@item>two</@item></list>\n",
      {
        list: template("/tags/list.mx", "<ul><${input.item.content}/></ul>"),
      },
    );
    expect(texts(ir)).toEqual(["one", "two"]);
  });

  it("scopes placeholder params through the block's own params", () => {
    const ir = lowerWithTags("<box|row|>${row}</box>\n", {
      box: template("/tags/box.mx", "<div><${input.content}/></div>"),
    });
    // The param is the block's; the splice is structural, so the body's
    // reference resolves to the caller's own param rather than to anything
    // the template introduced.
    const codes = flatten(ir.body)
      .filter((node) => node.kind === "Interpolation")
      .map(
        (node) =>
          (node as Extract<IrNode, { kind: "Interpolation" }>).expr.code,
      );
    expect(codes).toEqual(["row"]);
  });

  it("carries the template's module statements to the caller's module", () => {
    const ir = lowerWithTags("<box/>\n", {
      box: template(
        "/tags/box.mx",
        'import helper from "./helper.ts"\n<div>${helper()}</div>',
      ),
    });
    expect(ir.imports.map((node) => node.code)).toEqual([
      'import helper from "./helper.ts"',
    ]);
  });

  it("does not let a template introduce a binding the caller can see", () => {
    // The template declares `secret` at its own render scope and reads it.
    // Expanded into the caller, a binding by that name would be a `const
    // secret` the caller's own `${secret}` would silently pick up.
    const ir = lowerWithTags("<box/>${secret}\n", {
      box: template("/tags/box.mx", "<const/secret=1/><div>${secret}</div>"),
    });
    const names = flatten(ir.body)
      .filter((node) => node.kind === "Const")
      .map((node) => (node as Extract<IrNode, { kind: "Const" }>).name);
    // Renamed, so nothing the caller wrote can reach it.
    expect(names).toHaveLength(1);
    expect(names[0]).not.toBe("secret");
    expect(names[0]).toMatch(/^\$mx_box_secret_/);

    // The template's own read follows the rename; the caller's does not.
    const reads = interpolations(ir);
    expect(reads).toEqual([names[0], "secret"]);
  });
});

describe("template custom tags: expression rewriting", () => {
  /**
   * Every case here was produced wrong by the regex passes this replaced, and
   * all of them are ordinary MX expressions. The `?:` rows are the worst: the
   * consequent kept the *caller's* binding, which is the leak hygiene exists
   * to prevent.
   */
  it.each([
    ["ternary, all three arms", "${n}${n ? n : n}"],
    ["ternary with spaces", "${n}${cond ? n : other}"],
    ["string literal beside a reference", "${n}${'n' + n}"],
    ["template literal", "${n}${`size ${n}`}"],
    ["object shorthand", "${n}${JSON.stringify({ n })}"],
    ["member property of the same name", "${n}${obj.n}"],
    ["non-shorthand object key", "${n}${JSON.stringify({ n: n })}"],
  ])("renames only real references: %s", (_name, body) => {
    const ir = lowerWithTags("<box/>\n", {
      box: template("/tags/box.mx", `<const/n=1/><div>${body}</div>`),
    });
    const renamed = flatten(ir.body)
      .filter((node) => node.kind === "Const")
      .map((node) => (node as Extract<IrNode, { kind: "Const" }>).name)[0];
    expect(renamed).toMatch(/^\$mx_/);

    const codes = interpolations(ir);
    // The bare read is renamed in every case, which proves the pass ran.
    expect(codes[0]).toBe(renamed);
  });

  it.each([
    ["string literal", `\${"n" + n}`, `"n" + `],
    ["member property", "${obj.n}", "obj.n"],
    ["non-shorthand key", "${({ n: 1 }).n}", "n: 1"],
  ])("leaves a non-reference position alone: %s", (_name, body, intact) => {
    const ir = lowerWithTags("<box/>\n", {
      box: template("/tags/box.mx", `<const/n=1/><div>${body}</div>`),
    });
    // The text that is not a reference survives verbatim; only a real
    // reference may carry the renamed name.
    expect(interpolations(ir)[0]).toContain(intact);
  });

  it("renames every arm of a ternary", () => {
    const ir = lowerWithTags("<box/>\n", {
      box: template("/tags/box.mx", "<const/n=1/><div>${n ? n : n}</div>"),
    });
    const name = (
      flatten(ir.body).find((node) => node.kind === "Const") as Extract<
        IrNode,
        { kind: "Const" }
      >
    ).name;
    // The regex gave `XX?n:n` here: the consequent and alternate kept the
    // caller's `n`.
    expect(interpolations(ir)[0]).toBe(`${name} ? ${name} : ${name}`);
  });

  it("leaves a string literal that happens to spell the name", () => {
    const ir = lowerWithTags("<box/>\n", {
      box: template("/tags/box.mx", `<const/n=1/><div>\${"n" + n}</div>`),
    });
    const name = (
      flatten(ir.body).find((node) => node.kind === "Const") as Extract<
        IrNode,
        { kind: "Const" }
      >
    ).name;
    expect(interpolations(ir)[0]).toBe(`"n" + ${name}`);
  });

  it("does not rename a name an inner scope rebinds", () => {
    const ir = lowerWithTags("<box/>\n", {
      box: template(
        "/tags/box.mx",
        "<const/n=1/><div>${xs.map(n => n + 1)}</div>",
      ),
    });
    const name = (
      flatten(ir.body).find((node) => node.kind === "Const") as Extract<
        IrNode,
        { kind: "Const" }
      >
    ).name;
    // The arrow parameter shadows the template's binding, so neither the
    // parameter nor its body reference may be renamed.
    expect(interpolations(ir)[0]).not.toContain(name);
    expect(interpolations(ir)[0]).toContain("n => n + 1");
  });

  it("does not rename a `<for>` param that shadows a template binding", () => {
    const ir = lowerWithTags("<box/>\n", {
      box: template(
        "/tags/box.mx",
        "<const/n=1/><for|n| of=xs><p>${n}</p></for>",
      ),
    });
    // The loop param is its own binding; the body's read is the param's.
    const inLoop = flatten(ir.body)
      .filter((node) => node.kind === "Interpolation")
      .map(
        (node) =>
          (node as Extract<IrNode, { kind: "Interpolation" }>).expr.code,
      );
    expect(inLoop).toEqual(["n"]);
  });

  it("does not rename a `<const>` nested in an `<if>` that shadows it", () => {
    const ir = lowerWithTags("<box/>\n", {
      box: template(
        "/tags/box.mx",
        "<const/x=1/><if=true><const/x=2/><i>${x}</i></if>",
      ),
    });
    const names = flatten(ir.body)
      .filter((node) => node.kind === "Const")
      .map((node) => (node as Extract<IrNode, { kind: "Const" }>).name);
    // The outer declaration is renamed for hygiene; the inner one is the
    // author's own block-scoped binding and keeps its name.
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^\$mx_box_x_/);
    expect(names[1]).toBe("x");
    // And the read after it resolves to the inner binding. Before this was
    // fixed the inner `const` was emitted dead and the read pointed at the
    // renamed outer one, rendering 1 where the author wrote 2.
    expect(interpolations(ir)).toEqual(["x"]);
  });

  it("does not rename a `<const>` nested in a `<for>` that shadows it", () => {
    const ir = lowerWithTags("<box/>\n", {
      box: template(
        "/tags/box.mx",
        "<const/x=1/><for|i| of=xs><const/x=2/><i>${x}</i></for>",
      ),
    });
    const names = flatten(ir.body)
      .filter((node) => node.kind === "Const")
      .map((node) => (node as Extract<IrNode, { kind: "Const" }>).name);
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^\$mx_box_x_/);
    expect(names[1]).toBe("x");
    expect(interpolations(ir)).toEqual(["x"]);
  });

  it("still renames a read before the shadowing declaration", () => {
    const ir = lowerWithTags("<box/>\n", {
      box: template(
        "/tags/box.mx",
        "<const/x=1/><if=true><i>${x}</i><const/x=2/></if>",
      ),
    });
    const outer = (
      flatten(ir.body).find((node) => node.kind === "Const") as Extract<
        IrNode,
        { kind: "Const" }
      >
    ).name;
    // A declaration binds for the siblings that follow it, not before it, so
    // this read is still the template's outer binding.
    expect(interpolations(ir)).toEqual([outer]);
  });

  it("does not rename a class method of the same name", () => {
    const ir = lowerWithTags("<box/>\n", {
      box: template(
        "/tags/box.mx",
        "<const/n=1/><div>${(class X { n() {} }).name}</div>",
      ),
    });
    expect(interpolations(ir)[0]).toContain("n() {}");
  });

  it("does not substitute inside a string that spells an input read", () => {
    const ir = lowerWithTags("<box size=3/>\n", {
      box: template("/tags/box.mx", `<div>\${"input.size"}</div>`),
    });
    // The regex turned this literal into `"(3)"`.
    expect(interpolations(ir)[0]).toBe('"input.size"');
  });

  it("substitutes a computed read written with a string key", () => {
    const ir = lowerWithTags("<box size=3/>\n", {
      box: template("/tags/box.mx", '<div>${input["size"]}</div>'),
    });
    expect(interpolations(ir)[0]).toBe("3");
  });
});

describe("template custom tags: `input` as a value", () => {
  // Each of these reads `input` in a position substitution cannot resolve.
  // Left alone they emit an unbound identifier and fail at run time with no
  // diagnostic, which is the silent class this codebase guards against.
  it.each([
    ["bare", "${input}"],
    ["optional chain", "${input?.size}"],
    ["typeof", "${typeof input}"],
    ["destructured", "${(() => { const { size } = input; return size; })()}"],
    ["spread into a call", "${Object.assign({}, ...[input])}"],
  ])("is a positioned error: %s", (_name, body) => {
    expect(() =>
      lowerWithTags("<box/>\n", {
        box: template("/tags/box.mx", `<div>${body}</div>`),
      }),
    ).toThrowError(
      "`input` can only be read as `input.<name>` inside a tag template",
    );
  });

  it("is a positioned error when passed as an attribute value", () => {
    expect(() =>
      lowerWithTags("<box/>\n", {
        box: template("/tags/box.mx", "<child foo=input/>"),
      }),
    ).toThrowError(
      "`input` can only be read as `input.<name>` inside a tag template",
    );
  });

  it("carries the template's own file", () => {
    let caught: TranslateError | null = null;
    try {
      lowerWithTags("<div>\n  <box/>\n</div>\n", {
        box: template("/tags/box.mx", "<div>${input}</div>"),
      });
    } catch (error) {
      caught = error as TranslateError;
    }
    expect(caught?.file).toBe("/tags/box.mx");
  });
});

describe("template custom tags: reserved attribute names", () => {
  it("refuses an attribute named `content`", () => {
    expect(() =>
      lowerWithTags('<box content="hi"/>\n', {
        box: template("/tags/box.mx", "<div><${input.content}/></div>"),
      }),
    ).toThrowError(
      "`content` is reserved on a template tag; it names the body slot",
    );
  });

  it("leaves an attribute-tag collision to the upstream check", () => {
    // Refused before a template is involved, by `validateAttributeTagShape`,
    // and in Marko's own terms. Asserted so a future `checkReservedAttrs` that
    // tried to own this case would be caught replacing a better message.
    expect(() =>
      lowerWithTags('<box header="hi"><@header>x</@header></box>\n', {
        box: template("/tags/box.mx", "<div><${input.header.content}/></div>"),
      }),
    ).toThrowError("attribute tag `@header` collides with attribute `header`");
  });
});

describe("template custom tags: N reads are N evaluations", () => {
  it("substitutes the same expression once per read", () => {
    const ir = lowerWithTags("<box size=next()/>\n", {
      box: template("/tags/box.mx", "<div>${input.size}${input.size}</div>"),
    });
    // Pinned deliberately: substitution inlines the expression at each read,
    // so a side-effecting attribute read twice runs twice. This is the one
    // inherent limit of the strategy (documented in the spec, the README and
    // AGENTS.md); a future change that binds instead must change this test on
    // purpose rather than silently.
    expect(interpolations(ir)).toEqual(["next()", "next()"]);
  });
});

describe("template custom tags: module imports", () => {
  it("hoists one import for many call sites", () => {
    const ir = lowerWithTags("<box/><box/><box/>\n", {
      box: template(
        "/tags/box.mx",
        'import helper from "./helper.ts"\n<div>${helper()}</div>',
      ),
    });
    expect(ir.imports.map((node) => node.code)).toEqual([
      'import helper from "./helper.ts"',
    ]);
  });

  it("does not duplicate an import the caller already wrote", () => {
    const ir = lowerWithTags('import helper from "./helper.ts"\n<box/>\n', {
      box: template(
        "/tags/box.mx",
        'import helper from "./helper.ts"\n<div>${helper()}</div>',
      ),
    });
    expect(ir.imports).toHaveLength(1);
  });

  it("refuses two templates importing different modules as one name", () => {
    expect(() =>
      lowerWithTags("<a/><b/>\n", {
        a: template(
          "/tags/a.mx",
          'import z from "./one.ts"\n<div>${z()}</div>',
        ),
        b: template(
          "/tags/b.mx",
          'import z from "./two.ts"\n<div>${z()}</div>',
        ),
      }),
    ).toThrowError(
      /imports `z` from a different module than `\/tags\/a\.mx` already did/,
    );
  });

  it("names the calling file when the collision is with the caller's import", () => {
    expect(() =>
      lowerWithTags('import z from "./one.ts"\n<b/>\n', {
        b: template(
          "/tags/b.mx",
          'import z from "./two.ts"\n<div>${z()}</div>',
        ),
      }),
    ).toThrowError(/different module than the calling file already did/);
  });
});

describe("template custom tags: composition with a sidecar", () => {
  it("expands a declaration-only sidecar's template, validated", () => {
    const tag = template("/tags/box.mx", "<div>${input.size}</div>", {
      attributes: { size: { type: "number", default: 8 } },
    });
    const ir = lowerWithTags("<box/>\n", { box: tag });
    // The declared default reached the template through `input`.
    expect(interpolations(ir)).toEqual(["8"]);

    // And the declaration is enforced, which is the whole point of pairing a
    // sidecar with a template that could not check anything itself.
    expect(() => lowerWithTags('<box size="big"/>\n', { box: tag })).toThrow(
      "attribute `size` must be number, got string",
    );
  });

  it("lets a sidecar's transform expand the template as raw material", () => {
    const tag: TemplateBackedTag = {
      template: { filename: "/tags/box.mx", source: "<div>inner</div>" },
      transform(call, ctx) {
        return [ctx.build.element("aside", [], ctx.build.template(call))];
      },
    };
    const ir = lowerWithTags("<box/>\n", { box: tag });
    expect(elements(ir)).toEqual(["aside", "div"]);
  });

  it("lets a sidecar's transform ignore the template entirely", () => {
    const tag: TemplateBackedTag = {
      template: { filename: "/tags/box.mx", source: "<div>ignored</div>" },
      transform(_call, ctx) {
        return [ctx.build.element("hr", [], [], { void: true })];
      },
    };
    const ir = lowerWithTags("<box/>\n", { box: tag });
    expect(elements(ir)).toEqual(["hr"]);
    expect(texts(ir)).toEqual([]);
  });

  it("refuses `ctx.build.template` on a tag with no template", () => {
    const tag: CustomTag = {
      transform(call, ctx) {
        return ctx.build.template(call);
      },
    };
    expect(() => lowerWithTags("<box/>\n", { box: tag })).toThrowError(
      "`<box>`: this tag has no template file, so `ctx.build.template(call)` has nothing to expand",
    );
  });
});

describe("template custom tags: positions", () => {
  it("points a diagnostic inside a template into that file", () => {
    let caught: TranslateError | null = null;
    try {
      lowerWithTags("<div>\n  <box/>\n</div>\n", {
        // `<else>` with no preceding `<if>` — an error raised while lowering
        // the template, on the template's own third line.
        box: template("/tags/box.mx", "<div>\n</div>\n<else>oops</else>\n"),
      });
    } catch (error) {
      caught = error as TranslateError;
    }
    expect(caught).toBeInstanceOf(TranslateError);
    expect(caught?.message).toContain("`<else>` without a preceding `<if>`");
    // The template's own line, and the template's own file — not the caller's
    // line 2, where the call sits.
    expect(caught?.file).toBe("/tags/box.mx");
    expect(caught?.line).toBe(3);
  });

  it("keeps a call-site error on the caller", () => {
    let caught: TranslateError | null = null;
    try {
      lowerWithTags("<div>\n  <box bad=1/>\n</div>\n", {
        box: template("/tags/box.mx", "<div>ok</div>", {
          attributes: { good: { type: "string" } },
        }),
      });
    } catch (error) {
      caught = error as TranslateError;
    }
    expect(caught).toBeInstanceOf(TranslateError);
    expect(caught?.message).toContain("unknown attribute `bad`");
    // Raised before the template is lowered at all, so it carries no file and
    // means "the file being compiled".
    expect(caught?.file).toBeUndefined();
    expect(caught?.line).toBe(2);
  });

  it("stamps template-originated IR positions with the template file", () => {
    const ir = lowerWithTags("<div>\n  <box/>\n</div>\n", {
      box: template("/tags/box.mx", "<span>x</span>"),
    });
    const span = flatten(ir.body).find(
      (node) => node.kind === "Element" && node.name === "span",
    );
    expect(span?.loc.file).toBe("/tags/box.mx");

    // The caller's own nodes are untouched: no file means the file being
    // compiled, which is what every position meant before templates existed.
    const div = ir.body.find(
      (node) => node.kind === "Element" && node.name === "div",
    );
    expect(div?.loc.file).toBeUndefined();
  });

  it("keeps a renamed template binding on the template's own position", () => {
    const ir = lowerWithTags("<div>\n  <box/>\n</div>\n", {
      box: template("/tags/box.mx", "<const/n=1/><span>${n}</span>"),
    });
    const binding = flatten(ir.body).find(
      (node) => node.kind === "Const",
    ) as Extract<IrNode, { kind: "Const" }>;
    // Renamed for hygiene, but still the template's own declaration, so it
    // keeps the template's file rather than taking the call site.
    expect(binding.name).not.toBe("n");
    expect(binding.loc.file).toBe("/tags/box.mx");
  });
});

describe("template custom tags: gensym sharing", () => {
  it("mints unique names for sibling calls even when one is nested inside a template", () => {
    // Repro (TODO.md `custom-tags-gensym-collision`): `outer`'s template
    // itself calls `<g/>`, and the caller calls `<g/>` again on either
    // side. If each context started its own counter at zero, the template's
    // `<g/>` and the caller's first `<g/>` would both mint serial 1.
    const names: string[] = [];
    const g: CustomTag = {
      transform(_call, ctx) {
        names.push(ctx.gensym("g"));
        return [];
      },
    };
    const outer: TemplateBackedTag = template("/tags/outer.mx", "<g/>");
    lowerWithTags("<g/><outer/><g/>\n", { g, outer });
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);
  });
});

describe("template custom tags: cycles and recursion", () => {
  it("errors on a cycle, naming it", () => {
    const tags: Record<string, CustomTag> = {
      a: template("/tags/a.mx", "<div><b/></div>"),
      b: template("/tags/b.mx", "<span><a/></span>"),
    };
    expect(() => lowerWithTags("<a/>\n", tags)).toThrowError(
      "custom tag templates form a cycle: /tags/a.mx -> /tags/b.mx -> /tags/a.mx",
    );
  });

  it("errors on a self-cycle", () => {
    expect(() =>
      lowerWithTags("<a/>\n", {
        a: template("/tags/a.mx", "<div><a/></div>"),
      }),
    ).toThrowError(
      "custom tag templates form a cycle: /tags/a.mx -> /tags/a.mx",
    );
  });

  it("expands a tag called from another tag's template", () => {
    const ir = lowerWithTags("<outer/>\n", {
      outer: template("/tags/outer.mx", "<section><inner/></section>"),
      inner: template("/tags/inner.mx", "<em>deep</em>"),
    });
    expect(elements(ir)).toEqual(["section", "em"]);
    expect(texts(ir)).toEqual(["deep"]);
  });
});

describe("template custom tags: cache", () => {
  it("compiles a tag file once for two call sites", () => {
    resetTemplateCache();
    const tag = template("/tags/box.mx", "<div>x</div>");
    lowerWithTags("<box/><box/><box/>\n", { box: tag });
    expect(templateCompileCount()).toBe(1);
  });

  it("recompiles when the template's mtime changes", () => {
    resetTemplateCache();
    const first: TemplateBackedTag = {
      template: {
        filename: "/tags/box.mx",
        source: "<div>x</div>",
        mtimeMs: 1,
      },
    };
    lowerWithTags("<box/>\n", { box: first });
    expect(templateCompileCount()).toBe(1);

    const second: TemplateBackedTag = {
      template: {
        filename: "/tags/box.mx",
        source: "<div>y</div>",
        mtimeMs: 2,
      },
    };
    const ir = lowerWithTags("<box/>\n", { box: second });
    expect(templateCompileCount()).toBe(2);
    expect(texts(ir)).toEqual(["y"]);
  });

  it("recompiles an unsaved buffer whose text changed without an mtime", () => {
    resetTemplateCache();
    lowerWithTags("<box/>\n", {
      box: template("/tags/box.mx", "<div>x</div>"),
    });
    const ir = lowerWithTags("<box/>\n", {
      box: template("/tags/box.mx", "<div>z</div>"),
    });
    expect(templateCompileCount()).toBe(2);
    expect(texts(ir)).toEqual(["z"]);
  });

  it("does not let one call site's splice reach another's", () => {
    resetTemplateCache();
    const tag = template("/tags/box.mx", "<div><${input.content}/></div>");
    const ir = lowerWithTags("<box>one</box><box>two</box>\n", { box: tag });
    expect(templateCompileCount()).toBe(1);
    expect(texts(ir)).toEqual(["one", "two"]);
  });
});

describe("template custom tags: silent-drop guards", () => {
  it("warns when a template has no placeholder for the body it was handed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      lowerWithTags("<box>dropped</box>\n", {
        box: template("/tags/box.mx", "<div>no slot</div>"),
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("body content was dropped"),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("/tags/box.mx"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("warns when an attribute tag has no placeholder", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      lowerWithTags("<box><@extra>x</@extra></box>\n", {
        box: template("/tags/box.mx", "<div><${input.content}/></div>"),
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("`<@extra>` was dropped"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("stays quiet when every slot is placed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      lowerWithTags("<box><@extra>x</@extra>body</box>\n", {
        box: template(
          "/tags/box.mx",
          "<div><${input.content}/><${input.extra.content}/></div>",
        ),
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
