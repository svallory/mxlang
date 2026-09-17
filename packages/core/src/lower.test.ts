import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import type { Ctx, Node } from "./core.ts";
import { DYNAMIC_TAG, expr, newCtx } from "./core.ts";
import type { Policy } from "./declarations.ts";
import type { Ir, IrNode } from "./ir.ts";
import { exprOf, lower } from "./lower.ts";

/**
 * The lowerer (decision 79): one fixture per IR kind, plus the error cases.
 *
 * These are the tests that keep the IR honest. `compileSource`'s own emitted
 * output is asserted elsewhere (`@mxlang/html`'s suite and both
 * oracles); what is asserted *here* is the shape the core hands a host —
 * because a host's emitter is written against this tree and nothing else, so a
 * silently changed node kind, a dropped child or a lost position is a break no
 * string comparison downstream would localize.
 *
 * Positions are asserted alongside the structure rather than in a separate
 * test: a node whose `loc` is wrong is as broken as one whose `kind` is wrong
 * — a host reports diagnostics from these, and `@mxlang/language-server` turns
 * them into editor squiggles.
 */

/**
 * A minimal host: every tag is an element, and a component is whatever a
 * `<define>` bound.
 *
 * `isComponent` consults `ctx.defines` because every real host does — a
 * `<define>`'s name has to route to a component call for the define to be
 * callable at all. A fake that answered a flat `false` would make
 * `<Row('a')/>` an unbound capitalized tag, which is a property of the fake
 * rather than of the lowerer.
 */
function fakeDeclarations(overrides: Partial<Policy> = {}): Policy {
  return {
    tags: {},
    isElement: () => true,
    isComponent: (name, ctx) => ctx.defines.has(name),
    ...overrides,
  };
}

/**
 * Lowers `source` to an IR, through the real Marko parse.
 *
 * `compileSource` is driven for its parse and its taglib lookup, and the
 * translate visitor is hijacked to lower rather than emit — the lowerer has
 * to see exactly the nodes a real compile produces, not a hand-built tree.
 */
function lowerSource(source: string, policy = fakeDeclarations()): Ir {
  let ir: Ir | null = null;
  let thrown: unknown = null;

  // This helper needs `lower` over the compiler's real parsed body.
  // `newCtx` plus the compiler's parse is the seam: a
  // translator whose Program visitor lowers instead of emitting.
  const translator = {
    taglibs: [] as Array<[string, unknown]>,
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
          );
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
  const compiler = require("@marko/compiler");
  compiler.compileSync(source, "/tmp/mx-core-test/lower.mx", {
    translator,
    output: "html",
    writeVersionComment: false,
  });
  if (thrown) throw thrown;
  if (!ir) throw new Error("lowerer produced no IR");
  return ir;
}

import { createRequire } from "node:module";

function printExpression(node: unknown): string {
  const require = createRequire(import.meta.url);
  const { generator } = require("@marko/compiler/internal/babel");
  return generator(node, { concise: true }).code;
}

/** The first node of a kind, anywhere in the tree. */
function find<K extends IrNode["kind"]>(
  nodes: IrNode[],
  kind: K,
): Extract<IrNode, { kind: K }> {
  for (const node of nodes) {
    if (node.kind === kind) return node as Extract<IrNode, { kind: K }>;
    for (const key of ["children", "body"] as const) {
      const nested = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(nested)) {
        const hit = tryFind(nested as IrNode[], kind);
        if (hit) return hit;
      }
    }
    if (node.kind === "IfChain") {
      for (const branch of node.branches) {
        const hit = tryFind(branch.children, kind);
        if (hit) return hit;
      }
    }
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

describe("one fixture per IR kind", () => {
  it("Text carries the value Marko already normalized", () => {
    const ir = lowerSource("<p>hello</p>\n");
    const text = find(ir.body, "Text");
    expect(text.value).toBe("hello");
    // Decision 33 is Marko's own `onText`, applied before the lowerer sees
    // the node; a second normalization here would collapse twice.
    expect(text.loc.line).toBe(1);
  });

  it("`-- ${expr}` is a text placeholder, not a dynamic tag", () => {
    // A concise-position `${expr}` line is the dynamic-tag shape (see below);
    // `--` is the escape hatch that keeps it text — Marko's own rule.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    const ir = lowerSource("-- ${input.a}\n");
    expect(find(ir.body, "Interpolation")).toMatchObject({
      escaped: true,
      expr: { code: "input.a" },
    });
  });

  it("Interpolation records escaped and raw placeholders apart", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    const escaped = lowerSource("<p>${input.a}</p>\n");
    expect(find(escaped.body, "Interpolation")).toMatchObject({
      escaped: true,
      expr: { code: "input.a" },
    });

    const raw = lowerSource("<p>$!{input.a}</p>\n");
    expect(find(raw.body, "Interpolation").escaped).toBe(false);
  });

  it("Element carries its name, attrs and children", () => {
    const ir = lowerSource('<div class="card" hidden>x</div>\n');
    const element = find(ir.body, "Element");
    expect(element.name).toBe("div");
    expect(element.void).toBe(false);
    expect(element.attrs).toMatchObject([
      { kind: "static", name: "class", value: "card" },
      { kind: "boolean", name: "hidden" },
    ]);
    expect(find(element.children, "Text").value).toBe("x");
  });

  it("Element marks a void tag and takes no children", () => {
    const ir = lowerSource("<input>\n");
    const element = find(ir.body, "Element");
    expect(element.void).toBe(true);
    expect(element.children).toEqual([]);
  });

  it("Attr separates static, dynamic, bound and spread", () => {
    const ir = lowerSource('<div id="a" title=input.t ...input.rest>x</div>\n');
    expect(find(ir.body, "Element").attrs).toMatchObject([
      { kind: "static", name: "id", value: "a" },
      { kind: "dynamic", name: "title", value: { code: "input.t" } },
      { kind: "spread", value: { code: "input.rest" } },
    ]);
  });

  it("Expr records its parsed value shape during resolution", () => {
    const ir = lowerSource(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
      '<div object={active: true} array=[1] other=input.value>${"text"}</div>\n',
    );
    const element = find(ir.body, "Element");
    expect(element.attrs).toMatchObject([
      { kind: "dynamic", value: { shape: "object" } },
      { kind: "dynamic", value: { shape: "array" } },
      { kind: "dynamic", value: { shape: "other" } },
    ]);
    expect(find(element.children, "Interpolation").expr.shape).toBe("string");
  });

  it("lets the host order attributes before they enter the IR", () => {
    const calls: Array<[string, string]> = [];
    const ir = lowerSource(
      '<input type="text" value=input.value disabled>\n',
      fakeDeclarations({
        orderAttrs(name, attrs, on) {
          calls.push([name, on]);
          const value = attrs.find(
            (attr) => attr.kind !== "spread" && attr.name === "value",
          );
          return value
            ? [value, ...attrs.filter((attr) => attr !== value)]
            : attrs;
        },
      }),
    );
    expect(calls).toEqual([["input", "element"]]);
    expect(
      find(ir.body, "Element").attrs.map((attr) =>
        attr.kind === "spread" ? "..." : attr.name,
      ),
    ).toEqual(["value", "type", "disabled"]);
  });

  it("IfChain groups every branch, with a null condition for else", () => {
    const ir = lowerSource(
      [
        "<if=input.a>",
        "  <p>a</p>",
        "</if>",
        "<else if=input.b>",
        "  <p>b</p>",
        "</else>",
        "<else>",
        "  <p>c</p>",
        "</else>",
        "",
      ].join("\n"),
    );
    const chain = find(ir.body, "IfChain");
    expect(chain.branches).toHaveLength(3);
    expect(chain.branches[0]?.condition?.code).toBe("input.a");
    expect(chain.branches[1]?.condition?.code).toBe("input.b");
    // The trailing `<else>` is the branch with no condition — the whole reason
    // the chain is one node rather than three siblings a host must re-scan.
    expect(chain.branches[2]?.condition).toBeNull();
  });

  it("For normalizes `of=`, with params and their bindings", () => {
    const ir = lowerSource(
      '<for|item, i| of=input.xs by="id"><p>x</p></for>\n',
    );
    const loop = find(ir.body, "For");
    expect(loop.source).toMatchObject({
      kind: "of",
      list: { code: "input.xs" },
    });
    expect(loop.params).toEqual(["item", "i"]);
    expect(
      loop.paramNodes.map((param) => ({
        start: param.loc?.start,
        end: param.loc?.end,
      })),
    ).toEqual([
      {
        start: expect.objectContaining({ line: 1, column: 5 }),
        end: expect.objectContaining({ line: 1, column: 9 }),
      },
      {
        start: expect.objectContaining({ line: 1, column: 11 }),
        end: expect.objectContaining({ line: 1, column: 12 }),
      },
    ]);
    expect(loop.bindings).toEqual(["item", "i"]);
    expect(loop.key).toMatchObject({ code: '"id"', shape: "string" });
  });

  it("For normalizes `in=`", () => {
    const ir = lowerSource("<for|k, v| in=input.obj><p>x</p></for>\n");
    expect(find(ir.body, "For").source).toMatchObject({
      kind: "in",
      object: { code: "input.obj" },
    });
  });

  it("For normalizes the inclusive and exclusive ranges apart", () => {
    const inclusive = lowerSource(
      "<for|n| from=1 to=5 step=2><p>x</p></for>\n",
    );
    expect(find(inclusive.body, "For").source).toMatchObject({
      kind: "range",
      inclusive: true,
      from: { code: "1" },
      bound: { code: "5" },
      step: { code: "2" },
    });

    const exclusive = lowerSource("<for|n| until=5><p>x</p></for>\n");
    expect(find(exclusive.body, "For").source).toMatchObject({
      kind: "range",
      inclusive: false,
      // `from=` omitted is the range's own default, recorded as null rather
      // than invented as a literal the author never wrote.
      from: null,
      bound: { code: "5" },
      step: null,
    });
  });

  it("Define carries its name, params and body", () => {
    const ir = lowerSource(
      "<define/Row|item|><li>x</li></define>\n<Row('a')/>\n",
    );
    const define = find(ir.body, "Define");
    expect(define.name).toBe("Row");
    expect(define.params).toEqual(["item"]);
    expect(find(define.children, "Element").name).toBe("li");
  });

  it("Const carries the declared name and its initializer", () => {
    const ir = lowerSource("<const/doubled=input.n * 2/>\n<p>x</p>\n");
    expect(find(ir.body, "Const")).toMatchObject({
      name: "doubled",
      init: { code: "input.n * 2" },
    });
  });

  it("Import and Static are lifted out of the body to module scope", () => {
    const ir = lowerSource(
      'import Panel from "./panel.marko"\nstatic const G = 1\n<p>x</p>\n',
    );
    expect(ir.imports).toMatchObject([
      {
        kind: "Import",
        code: 'import Panel from "./panel.marko"',
        loc: { line: 1, column: 0 },
        end: { line: 1, column: 33 },
      },
    ]);
    expect(ir.hoisted).toMatchObject([
      {
        kind: "Static",
        code: "const G = 1",
        loc: { line: 2, column: 0 },
        end: { line: 2, column: 18 },
      },
    ]);
    // Lifted, not left behind: a host reads them from `Ir`'s own fields rather
    // than filtering the body for statement nodes.
    expect(tryFind(ir.body, "Import")).toBeNull();
    expect(tryFind(ir.body, "Static")).toBeNull();
  });

  it("Export hoists verbatim and InputInterface is kept apart", () => {
    const ir = lowerSource(
      "export interface Input { n: number }\nexport const prerender = true;\n<p>x</p>\n",
    );
    expect(ir.inputInterface).toMatchObject({
      kind: "InputInterface",
      code: "export interface Input { n: number }",
      loc: { line: 1, column: 0 },
      end: { line: 1, column: 36 },
    });
    expect(ir.hoisted).toMatchObject([
      {
        kind: "Export",
        code: "export const prerender = true;",
        loc: { line: 2, column: 0 },
        end: { line: 2, column: 30 },
      },
    ]);
  });

  it("DocumentType keeps the value with its delimiters stripped", () => {
    const ir = lowerSource("<!doctype html>\n<p>x</p>\n");
    expect(find(ir.body, "DocumentType").value).toBe("doctype html");
  });

  it("Comment records whether the source spelled an HTML comment", () => {
    const ir = lowerSource("<!-- keep -->\n<p>x</p>\n");
    const comment = find(ir.body, "Comment");
    // Marko strips the delimiters, so only the source can tell an HTML comment
    // from a `//` line comment — the lowerer reads it back rather than
    // guessing from the value.
    expect(comment.html).toBe(true);
    expect(comment.value).toBe(" keep ");
  });

  it("Component resolves an import binding as its target", () => {
    const ir = lowerSource(
      'import Panel from "./panel.marko"\n<Panel title="t">body</Panel>\n',
      fakeDeclarations({ isComponent: (name) => name === "Panel" }),
    );
    const component = find(ir.body, "Component");
    expect(component.target).toMatchObject({ kind: "name", name: "Panel" });
    expect(component.attrs).toMatchObject([
      { kind: "static", name: "title", value: "t" },
    ]);
    expect(component.content).not.toBeNull();
  });

  it("Component collects attribute tags as props, in source order", () => {
    const ir = lowerSource(
      [
        'import Panel from "./panel.marko"',
        "<Panel>",
        "  <@header>H</@header>",
        "  <@footer|year|>F</@footer>",
        "</Panel>",
        "",
      ].join("\n"),
      fakeDeclarations({ isComponent: (name) => name === "Panel" }),
    );
    const component = find(ir.body, "Component");
    expect(component.attributeTags.map((t) => t.name)).toEqual([
      "header",
      "footer",
    ]);
    // A block's own params travel with it: a host with a render-prop form uses
    // them, and a host without one rejects them by name.
    expect(component.attributeTags[1]?.block.params).toEqual(["year"]);
  });

  it("Component records a define target with its declared params", () => {
    const ir = lowerSource(
      "<define/Row|item|><li>x</li></define>\n<Row('a')/>\n",
      fakeDeclarations({ isComponent: (name) => name === "Row" }),
    );
    const component = find(ir.body, "Component");
    expect(component.target).toMatchObject({
      kind: "define",
      name: "Row",
      params: ["item"],
    });
    // Marko's generator prints the author's own quoting back, so a
    // single-quoted argument stays single-quoted.
    expect(component.args.map((a) => a.code)).toEqual(["'a'"]);
  });

  it("HostTag hands a claimed tag over with its parts lowered", () => {
    const ir = lowerSource(
      "<signal/count=1>body</signal>\n",
      fakeDeclarations({
        claimsTag: (name) => name === "signal",
        resolveHostTag: (name) => ({ seen: name }),
      }),
    );
    const hosted = find(ir.body, "HostTag").tag;
    expect(hosted.name).toBe("signal");
    expect(hosted.var).toBe("count");
    expect(hosted.attrs).toMatchObject([{ kind: "dynamic", name: "value" }]);
    expect(find(hosted.children, "Text").value).toBe("body");
    // The opaque slot the host filled at lower time, so its emitter never
    // re-inspects a Marko node to recover its own decision.
    expect(hosted.data).toEqual({ seen: "signal" });
  });

  it("Hoisted lands ahead of the construct that produced it", () => {
    const ir = lowerSource(
      "<if=input.on>\n  <signal/count=7/>\n</if>\n<p>x</p>\n",
      fakeDeclarations({
        claimsTag: (name) => name === "signal",
        resolveHostTag: (_name, node, ctx) => {
          ctx.hoist(`const ${node.var.name} = 7;`, node);
          return null;
        },
      }),
    );
    // The declaration outlives the block it was written in, which is the whole
    // point of decision 70's hoist hook.
    expect(ir.prelude).toMatchObject([
      {
        kind: "Hoisted",
        code: "const count = 7;",
        loc: { line: 2, column: 2 },
        end: { line: 2, column: 19 },
      },
    ]);
  });

  it("an inert tag is accepted and contributes nothing", () => {
    const ir = lowerSource(
      "<p>a</p>\n<mytag/>\n",
      fakeDeclarations({
        tags: {
          mytag: { kind: "inert", reason: "inert", body: "none" },
        },
      }),
    );
    // Accepted, with no output: the node is empty text rather than absent, so
    // the body's shape still matches the source's.
    expect(ir.body.some((n) => n.kind === "Element" && n.name === "p")).toBe(
      true,
    );
  });
});

/**
 * A bare `${expr}` line and `<${expr}/>` parse to the same Marko node (no
 * attrs, no body) — see the "four Marko facts" in `AGENTS.md`. `claimsTag`'s
 * `shape` argument is the only signal that lets a host tell them apart.
 */
describe("a dynamic tag's bare shape", () => {
  it("lowers to a dynamic Component when a host claims DYNAMIC_TAG only for the tagged shape", () => {
    const ir = lowerSource(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
      "${input.tag}\n",
      fakeDeclarations({
        claimsTag: (name, _ctx, shape) =>
          name === DYNAMIC_TAG && shape !== "bare",
      }),
    );
    expect(find(ir.body, "Component")).toMatchObject({
      target: { kind: "dynamic", expr: { code: "input.tag" } },
    });
  });

  it("reaches the host when it has attributes, even under a bare-excluding claim", () => {
    const ir = lowerSource(
      "<${input.tag} a=1/>\n",
      fakeDeclarations({
        claimsTag: (name, _ctx, shape) =>
          name === DYNAMIC_TAG && shape !== "bare",
        resolveHostTag: () => ({ seen: true }),
      }),
    );
    const hosted = find(ir.body, "HostTag").tag;
    expect(hosted.name).toBe(DYNAMIC_TAG);
    expect(hosted.attrs).toMatchObject([{ kind: "dynamic", name: "a" }]);
    expect(hosted.data).toEqual({ seen: true });
  });

  it("reaches the host for the bare shape when the host claims it explicitly", () => {
    const ir = lowerSource(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
      "${input.tag}\n",
      fakeDeclarations({
        claimsTag: (name) => name === DYNAMIC_TAG,
        resolveHostTag: () => ({ seen: true }),
      }),
    );
    const hosted = find(ir.body, "HostTag").tag;
    expect(hosted.name).toBe(DYNAMIC_TAG);
    expect(hosted.data).toEqual({ seen: true });
  });

  it("lowers the tagged shape to a dynamic Component when no host claims it", () => {
    const ir = lowerSource("<${input.tag} a=1/>\n", fakeDeclarations({}));
    expect(find(ir.body, "Component")).toMatchObject({
      target: { kind: "dynamic", expr: { code: "input.tag" } },
      attrs: [{ kind: "dynamic", name: "a" }],
    });
  });
});

describe("positions", () => {
  it("records a 1-based line and 0-based column on every node", () => {
    const ir = lowerSource("<p>a</p>\n<div>b</div>\n");
    const first = ir.body.find(
      (n) => n.kind === "Element" && n.name === "p",
    ) as Extract<IrNode, { kind: "Element" }>;
    const second = ir.body.find(
      (n) => n.kind === "Element" && n.name === "div",
    ) as Extract<IrNode, { kind: "Element" }>;
    expect(first.loc).toEqual({ line: 1, column: 0 });
    expect(second.loc).toEqual({ line: 2, column: 0 });
  });

  it("records the position of a nested node, not its parent's", () => {
    const ir = lowerSource("<div>\n  <span>x</span>\n</div>\n");
    const span = find(find(ir.body, "Element").children, "Element");
    expect(span.loc).toEqual({ line: 2, column: 2 });
  });
});

describe("errors keep their message and position", () => {
  /**
   * Every message here is asserted verbatim elsewhere too — the translator's
   * own suite, its error fixtures, or the oracle's error class — so a reworded
   * message is a behaviour change even when the construct is still rejected.
   */
  it.each([
    [
      "<if> with no condition",
      "<if>\n  <p>x</p>\n</if>\n",
      /`<if>` without a condition/,
    ],
    [
      "<for> with no params",
      "<for of=input.xs><p>x</p></for>\n",
      /`<for>` needs tag params/,
    ],
    [
      "<for> with no iterable",
      "<for|x|><p>y</p></for>\n",
      /`<for>` requires `of=`, `in=`, or `from=`\/`to=`\/`until=`/,
    ],
    [
      "a stray <else>",
      "<else>\n  <p>x</p>\n</else>\n",
      /`<else>` without a preceding `<if>`/,
    ],
    [
      "<const> with no value",
      "<const/x/>\n<p>y</p>\n",
      /`<const>` without a value/,
    ],
    [
      "<define> with no name",
      "<define><p>x</p></define>\n",
      /`<define>` without a name/,
    ],
    [
      "an attribute tag outside a component",
      "<div><@header>x</@header></div>\n",
      /attribute tag `@header`/,
    ],
    ["tag params on an element", "<div|a|>x</div>\n", /tag params/],
    ["a scriptlet", "$ const x = 1\n<p>y</p>\n", /scriptlets/],
  ])("rejects %s", (_what, source, message) => {
    expect(() => lowerSource(source)).toThrow(message);
  });

  it("rejects an unknown lowercase tag rather than emitting it literally", () => {
    expect(() =>
      lowerSource(
        "<mystery>x</mystery>\n",
        fakeDeclarations({ isElement: () => false }),
      ),
    ).toThrow(/unknown tag `<mystery>`/);
  });

  it("rejects an unbound capitalized tag as a missing component", () => {
    expect(() =>
      lowerSource(
        "<Missing>x</Missing>\n",
        fakeDeclarations({ isElement: () => false }),
      ),
    ).toThrow(/a capitalized tag is always a component call/);
  });

  it("reports an error's position, not just its message", () => {
    let caught: { line?: number; column?: number } | null = null;
    try {
      lowerSource("<p>a</p>\n<for of=input.xs><li>x</li></for>\n");
    } catch (error) {
      caught = error as { line?: number; column?: number };
    }
    // Second line of the source, which is what an editor squiggle needs.
    expect(caught?.line).toBe(2);
  });

  it("raises a host's error disposition by name", () => {
    expect(() =>
      lowerSource(
        "<await>x</await>\n",
        fakeDeclarations({
          tags: { await: { kind: "error", reason: "`<await>` suspends" } },
        }),
      ),
    ).toThrow(/`<await>` suspends/);
  });

  it("checkBinding sees a render-scope binding, and not a tag param", () => {
    const seen: string[] = [];
    const declarations = fakeDeclarations({
      checkBinding: (target: Node) => {
        seen.push(target.name);
      },
    });

    lowerSource("<const/ok=1/>\n<p>x</p>\n", declarations);
    expect(seen).toEqual(["ok"]);

    // A tag param opens a nested scope where an ordinary JS shadow is correct,
    // so it is deliberately not offered to `checkBinding` — Marko draws the
    // same line, rendering `<for|input|>` while rejecting `<let/input>`.
    seen.length = 0;
    lowerSource("<for|item| of=input.xs><p>x</p></for>\n", declarations);
    expect(seen).toEqual([]);
  });
});

describe("the lowerer runs under the real front door", () => {
  it("requires and drives a host emitter after resolving", () => {
    const { code } = compileSource(
      "<p>hi</p>\n",
      "/tmp/mx-core-test/probe.mx",
      fakeDeclarations(),
      {
        emitIr: (ir) => {
          const first = ir.body[0];
          return first?.kind === "Element" ? first.name : "missing";
        },
      },
    );
    expect(code).toBe("p");
  });

  it("names the export after the file", () => {
    const { code } = compileSource(
      "<p>hi</p>\n",
      "/tmp/mx-core-test/table-of.mx",
      fakeDeclarations(),
      { emitIr: (ir) => ir.exportName ?? "missing" },
    );
    expect(code).toBe("TableOf");
  });

  it("re-mints the export name against a real binding in the file", () => {
    // The synthetic `taken` set in `export-name.test.ts` proves the re-mint
    // logic; this proves the *wiring* — that `lower` passes the file's own
    // bindings to it. `import Probe from …` puts `Probe` in `ctx.imports`,
    // which is exactly the name `probe.mx` would otherwise take.
    const { code } = compileSource(
      'import Probe from "./other.ts"\n<p>hi</p>\n',
      "/tmp/mx-core-test/probe.mx",
      fakeDeclarations(),
      { emitIr: (ir) => ir.exportName ?? "missing" },
    );
    expect(code).toBe("Probe2");
  });

  it("leaves the export name unset when the compilation is not a module", () => {
    // `lowerSource` never sets `Ctx.emitsModule`, which is the shape of a
    // `.solid.mx` region: an expression spliced into someone else's module,
    // declaring nothing. No name is what makes a self-call a positioned
    // error rather than a reference to a binding that does not exist.
    expect(lowerSource("<p>hi</p>\n").exportName).toBeUndefined();
  });
});

/**
 * The placeholder inside the *last* top-level element.
 *
 * These fixtures end with `<p>${count}</p>`, so the interpolation under test
 * is a child of that element rather than a body-level node — filtering
 * `ir.body` for `Interpolation` finds nothing at all.
 */
function trailingInterpolation(
  body: IrNode[],
): Extract<IrNode, { kind: "Interpolation" }> {
  const elements = body.filter(
    (n): n is Extract<IrNode, { kind: "Element" }> => n.kind === "Element",
  );
  const last = elements.at(-1);
  if (!last) throw new Error("no trailing element in the IR body");
  return find(last.children, "Interpolation");
}

describe("binding scopes are per JS block", () => {
  /**
   * A host whose state is a getter registers a rewrite; a `<const>` of the
   * same name shadows it for the rest of *its own block*, and no further.
   *
   * The emitted JS scopes a `const` to the block it sits in, so the registry
   * has to scope the same way. Before this was fixed, a `<const/count>` inside
   * an `<if>` branch unregistered the name permanently, and every later
   * `${count}` outside the branch silently stopped using the host's rewrite —
   * wrong output from a successful compile.
   */
  const signalPolicy = fakeDeclarations({
    claimsTag: (name) => name === "signal",
    resolveHostTag: (_name, node, ctx) => {
      ctx.hoist(`const ${node.var.name} = () => 0;`, node);
      ctx.bindings.register(node.var.name, (ref) => `${ref}()`);
      return null;
    },
  });

  it("restores a name shadowed inside an <if> branch after the branch", () => {
    const ir = lowerSource(
      [
        "<signal/count=1/>",
        "<if=input.on>",
        "  <const/count=2/>",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
        "  <p>${count}</p>",
        "</if>",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
        "<p>${count}</p>",
        "",
      ].join("\n"),
      signalPolicy,
    );

    const chain = find(ir.body, "IfChain");
    const inside = find(chain.branches[0]?.children ?? [], "Interpolation");
    // Inside the branch the `<const>` is what `count` means, so it prints bare.
    expect(inside.expr.code).toBe("count");

    // After the branch the host's binding is back, so it prints the call. The
    // placeholder sits inside the trailing `<p>`, not at body level.
    expect(trailingInterpolation(ir.body).expr.code).toBe("count()");
  });

  it("restores a name shadowed inside a <for> body after the loop", () => {
    const ir = lowerSource(
      [
        "<signal/count=1/>",
        "<for|item| of=input.xs>",
        "  <const/count=item/>",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
        "  <p>${count}</p>",
        "</for>",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
        "<p>${count}</p>",
        "",
      ].join("\n"),
      signalPolicy,
    );

    const loop = find(ir.body, "For");
    expect(find(loop.children, "Interpolation").expr.code).toBe("count");

    expect(trailingInterpolation(ir.body).expr.code).toBe("count()");
  });

  describe("type arguments survive the non-empty binding registry path", () => {
    /**
     * `expr()` slices source text only when `ctx.bindings.size === 0`
     * (packages/core/src/core.ts). Any other name in an expression alongside a
     * registered one puts the registry in scope for the whole expression, and
     * `rewriteReferencesSource` (not the node-cloning `rewriteReferences`) does
     * the splice — this is the path a `resolveHostTag` binding (e.g. `<signal>`)
     * takes for every interpolation once any binding is registered.
     *
     * No shipping host calls `ctx.bindings.register` today — `@mxlang/preact`'s
     * `<let>` and `@mxlang/solid`'s equivalent are both hard compile errors
     * (`packages/hosts/preact/src/emitter.ts`, `packages/hosts/solid/README.md`)
     * — so this path is presently exercised only here, through the
     * `fakeDeclarations`-built `signalPolicy` fixture below, not by any real
     * host's own tests.
     */
    it("keeps a generic call's type arguments when rewriting a registered identifier", () => {
      const ir = lowerSource(
        [
          "<signal/count=1/>",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
          "<p>${pick<string>(count)}</p>",
          "",
        ].join("\n"),
        signalPolicy,
      );

      expect(trailingInterpolation(ir.body).expr.code).toBe(
        "pick<string>(count())",
      );
    });

    /** The identifier being rewritten is itself the one carrying type arguments as a callee. */
    it("keeps type arguments when the registered identifier is not itself rewritten", () => {
      const ir = lowerSource(
        [
          "<signal/count=1/>",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
          "<p>${pick<string>(other)}</p>",
          "",
        ].join("\n"),
        signalPolicy,
      );

      expect(trailingInterpolation(ir.body).expr.code).toBe(
        "pick<string>(other)",
      );
    });

    /**
     * A positioned expression whose matched, registered, unshadowed
     * identifier has no position of its own (synthetic within an otherwise
     * real tree — not producible through any MX construct today, but nothing
     * in `rewriteReferencesSource` prevents one structurally) must not
     * silently keep that one reference un-rewritten in the spliced output.
     * `expr()` falls back to the whole-node AST print instead.
     */
    it("falls back to the AST print rather than silently dropping a position-less matched reference", () => {
      const require = createRequire(import.meta.url);
      const { parseExpression } = require("@marko/compiler/internal/babel");
      const source = "pick<string>(count)";
      const node = parseExpression(source, { plugins: [["typescript", {}]] });
      // Strip the argument's own position (and its `loc`, which `expr()` also
      // consults) while leaving the outer call's `start`/`end` intact, so
      // `expr()` takes the real-positioned branch and only
      // `rewriteReferencesSource`'s inner walk discovers the gap.
      const arg = node.arguments[0];
      arg.start = undefined;
      arg.end = undefined;
      arg.loc = undefined;

      const ctx = newCtx(
        source,
        printExpression,
        fakeDeclarations(),
        undefined,
        "test.mx",
      );
      ctx.bindings.register("count", (name: string) => `${name}()`);

      // This node was parsed directly (not through `@marko/compiler`'s own
      // `stripTypes` pass, which only runs on a whole-file compile), so its
      // `typeParameters` are still present and the AST-print fallback keeps
      // them; what this test pins is that `count` is rewritten to `count()`
      // rather than silently kept as `count` by a partial splice.
      expect(expr(ctx, node)).toBe("pick<string>(count())");
    });
  });
});

describe("a claimed tag's children are lowered exactly once", () => {
  /**
   * `resolveHostTag` receives children the core has *already* lowered. A host
   * that walked the Marko nodes again replayed every lowerer side effect —
   * each `ctx.hoist` ran twice — and nested tags lowered exponentially.
   */
  it("hoists once for a <const>-like host tag inside a claimed tag's body", () => {
    let hoists = 0;
    const ir = lowerSource(
      [
        "<dyn>",
        "  <signal/inner=1/>",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
        "  <p>${inner}</p>",
        "</dyn>",
        "",
      ].join("\n"),
      fakeDeclarations({
        claimsTag: (name) => name === "dyn" || name === "signal",
        resolveHostTag: (name, node, ctx) => {
          if (name !== "signal") return null;
          hoists++;
          ctx.hoist(`const ${node.var.name} = 1;`, node);
          return null;
        },
      }),
    );

    expect(hoists).toBe(1);
    expect(ir.prelude).toMatchObject([
      {
        kind: "Hoisted",
        code: "const inner = 1;",
        loc: { line: 2, column: 2 },
        end: { line: 2, column: 19 },
      },
    ]);
  });
});

/**
 * `<return>`: the unit's value channel (design §3.3, acceptance C1).
 *
 * The grammar is Marko's, ported from `translator/core/return.ts`; each error
 * case below names the Marko fixture it came from so the mapping stays
 * checkable. The one deliberate subtraction is `valueChange` — Marko accepts
 * it, MX 1 ships a value only — so it is rejected by name rather than silently
 * accepted and dropped, which is the failure class (S8) the field guard
 * exists to close.
 *
 * Every case is validated in the *tag's own* compilation, which is what makes
 * the `{ value, output }` signature a single shape rather than `T | undefined`
 * per path (invariant §7.5-5): a unit cannot see its callers, so no call site
 * can widen it.
 */
describe("<return>", () => {
  it("lifts the value onto the IR rather than into the body", () => {
    const ir = lowerSource("<p>hi</p>\n<return value=input.count/>\n");

    expect(ir.returnValue?.code).toBe("input.count");
    // Not a rendered node: the value is part of the unit's signature, so a
    // host emits it in the return statement, never in document order. The
    // body is the `<p>` and the empty text the tag lowers to, and nothing
    // in it carries the expression.
    expect(JSON.stringify(ir.body)).not.toContain("input.count");
  });

  it("reports the value in the metadata a caller reads", () => {
    const ir = lowerSource("<return value=1 + 1/>\n");

    expect(ir.tagMetadata.returnsValue).toBe(true);
    expect(ir.tagMetadata.returnValueCode).toBe("1 + 1");
  });

  it("leaves a unit without one reporting no value", () => {
    const ir = lowerSource("<p>hi</p>\n");

    expect(ir.returnValue).toBeNull();
    // Absent rather than `false`: every entry cached before `<return>`
    // shipped reads the same way.
    expect(ir.tagMetadata.returnsValue).toBeUndefined();
  });

  it("accepts the shorthand value form", () => {
    expect(lowerSource("<return=input.x/>\n").returnValue?.code).toBe(
      "input.x",
    );
  });

  it.each([
    // Marko `error-return-multiple/`
    [
      "more than one per template",
      "<return value=1/>\n<return value=2/>\n",
      /multiple `<return>` tags/,
    ],
    // Marko `error-return-if-else/`
    [
      "one under a control-flow tag",
      "<if=true>\n  <return value=1/>\n</if>\n",
      /must be at the top level/,
    ],
    // Marko `error-return-if-else/`, the `<for>` half of unconditionality
    [
      "one inside a loop",
      "<for|x| of=[1]>\n  <return value=x/>\n</for>\n",
      /must be at the top level/,
    ],
    // Marko `error-return-in-native-tag/`
    [
      "one inside a native tag",
      "<div>\n  <return value=1/>\n</div>\n",
      /must be at the top level/,
    ],
    // Marko `error-return-no-default-value/`
    ["one with no value", "<return/>\n", /requires a `value=` attribute/],
    // Marko `error-return-duplicate-value/`
    [
      "a duplicate value attribute",
      "<return value=1 value=2/>\n",
      /duplicate `value` attribute/,
    ],
    // Marko `error-return-args/`
    ["arguments", "<return('a') value=1/>\n", /tag arguments/],
    // Marko `error-return-params/`
    ["params", "<return|a| value=1></return>\n", /tag params/],
    // Marko `error-return-var/`
    ["a tag variable", "<return/x value=1/>\n", /tag variable/],
    // Marko `error-return-spread-attr/`
    [
      "spread attributes",
      "<return ...rest value=1/>\n",
      /does not support spread attributes/,
    ],
    // Marko `error-return-extra-attr/`
    [
      "an unknown attribute",
      "<return value=1 y=2/>\n",
      /does not support the `y` attribute/,
    ],
    // Marko `error-return-body-content/`
    [
      "body content",
      "<return value=1>x</return>\n",
      /does not support body content/,
    ],
  ])("rejects %s", (_what, source, message) => {
    expect(() => lowerSource(source)).toThrow(message);
  });

  it("rejects `valueChange` by name: MX returns a value only", () => {
    expect(() => lowerSource("<return value=x valueChange=setX/>\n")).toThrow(
      /`valueChange`.*value only/,
    );
  });

  it("positions the error at the offending tag", () => {
    expect(() =>
      lowerSource("<p>a</p>\n<return value=1/>\n<return value=2/>\n"),
    ).toThrow(expect.objectContaining({ line: 3 }));
  });
});

/**
 * `Expr.span` (core contract C4): file-absolute byte offsets, filled by
 * `exprOf` for every construction site, absent for a synthesized expr.
 *
 * One test per distinct `exprOf` caller family (`notes/investigations/
 * angular-c4-expr-span.md` §2's seventeen-site table), each asserting
 * `source.slice(span.sourceStart, span.sourceEnd)` equals the authored
 * expression text — the only assertion that catches an off-by-one.
 */
function slice(
  source: string,
  expr: { span?: { sourceStart: number; sourceEnd: number } },
): string {
  if (!expr.span) throw new Error("expected a span");
  return source.slice(expr.span.sourceStart, expr.span.sourceEnd);
}

describe("Expr.span", () => {
  it("dynamic attribute value", () => {
    const source = "<div a=x.y>x</div>\n";
    const ir = lowerSource(source);
    const [attr] = find(ir.body, "Element").attrs;
    if (attr?.kind !== "dynamic") throw new Error("expected dynamic attr");
    expect(slice(source, attr.value)).toBe("x.y");
  });

  it("spread attribute", () => {
    const source = "<div ...s.o>x</div>\n";
    const ir = lowerSource(source);
    const [attr] = find(ir.body, "Element").attrs;
    if (attr?.kind !== "spread") throw new Error("expected spread attr");
    expect(slice(source, attr.value)).toBe("s.o");
  });

  it("bound (`:=`) attribute", () => {
    const source = "<div v:=b.v>x</div>\n";
    const ir = lowerSource(source);
    const [attr] = find(ir.body, "Element").attrs;
    if (attr?.kind !== "bound") throw new Error("expected bound attr");
    expect(slice(source, attr.value)).toBe("b.v");
  });

  it("modifier attribute resolved to a host's own name (e.g. `class:foo=`)", () => {
    const source = "<div class:foo=m.v>x</div>\n";
    const ir = lowerSource(
      source,
      fakeDeclarations({
        resolveModifier: (attr) => `${attr.name}-${attr.modifier}`,
      }),
    );
    const [attr] = find(ir.body, "Element").attrs;
    if (attr?.kind !== "dynamic") throw new Error("expected dynamic attr");
    expect(slice(source, attr.value)).toBe("m.v");
  });

  it("placeholder/interpolation", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    const source = "<div>${x.y}</div>\n";
    const ir = lowerSource(source);
    const interpolation = find(
      find(ir.body, "Element").children,
      "Interpolation",
    );
    expect(slice(source, interpolation.expr)).toBe("x.y");
  });

  it("control-flow test expression (`<if>`/`<else-if>`)", () => {
    const source =
      "<if=a.b>\n  <p>a</p>\n</if>\n<else if=c.d>\n  <p>b</p>\n</else>\n";
    const ir = lowerSource(source);
    const chain = find(ir.body, "IfChain");
    expect(slice(source, chain.branches[0]?.condition ?? {})).toBe("a.b");
    expect(slice(source, chain.branches[1]?.condition ?? {})).toBe("c.d");
  });

  it("`<for>` source and `by=` key", () => {
    const source = '<for|item| of=list.items by="(p)=>p.id"><p>x</p></for>\n';
    const ir = lowerSource(source);
    const loop = find(ir.body, "For");
    if (loop.source.kind !== "of") throw new Error("expected of-source");
    expect(slice(source, loop.source.list)).toBe("list.items");
    expect(slice(source, loop.key ?? {})).toBe('"(p)=>p.id"');
  });

  it("`<for in=>` source", () => {
    const source = "<for|k, v| in=obj.entries><p>x</p></for>\n";
    const ir = lowerSource(source);
    const loop = find(ir.body, "For");
    if (loop.source.kind !== "in") throw new Error("expected in-source");
    expect(slice(source, loop.source.object)).toBe("obj.entries");
  });

  it("`<for>` range bounds (`from=`/`to=`/`step=`)", () => {
    const source = "<for|n| from=1 to=5 step=2><p>x</p></for>\n";
    const ir = lowerSource(source);
    const loop = find(ir.body, "For");
    if (loop.source.kind !== "range") throw new Error("expected range-source");
    expect(slice(source, loop.source.from ?? {})).toBe("1");
    expect(slice(source, loop.source.bound ?? {})).toBe("5");
    expect(slice(source, loop.source.step ?? {})).toBe("2");
  });

  it("`<const>` initializer", () => {
    const source = "<const/c=1 + two.v/>\n<p>x</p>\n";
    const ir = lowerSource(source);
    expect(slice(source, find(ir.body, "Const").init)).toBe("1 + two.v");
  });

  it("`<return>` value", () => {
    const source = "<return value=v.x/>\n";
    const ir = lowerSource(source);
    if (!ir.returnValue) throw new Error("expected a return value");
    expect(slice(source, ir.returnValue)).toBe("v.x");
  });

  it("component call arguments, distinct spans", () => {
    const source =
      "<define/Row|item|><li>x</li></define>\n<Row(a.one, a.two)/>\n";
    const ir = lowerSource(
      source,
      fakeDeclarations({ isComponent: (name) => name === "Row" }),
    );
    const component = find(ir.body, "Component");
    expect(component.args.map((a) => slice(source, a))).toEqual([
      "a.one",
      "a.two",
    ]);
    expect(component.args[0]?.span?.sourceStart).not.toBe(
      component.args[1]?.span?.sourceStart,
    );
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in the test title
  it("a bare `${expr}` tag (concise mode's dynamic-tag shape)", () => {
    // A top-level `${expr}` with no attributes and no body parses as a
    // `MarkoTag` whose `name` is the expression — concise mode's only shape
    // for it — and lowers to a dynamic-target `Component` through the same
    // `exprOf` call a tagged dynamic tag name would use.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    const source = "<${dyn.tag}/>\n";
    const ir = lowerSource(source);
    const component = find(ir.body, "Component");
    expect(component.target.kind).toBe("dynamic");
    expect(
      component.target.kind === "dynamic"
        ? slice(source, component.target.expr)
        : null,
    ).toBe("dyn.tag");
  });

  it("sibling-sharing case: four byte-identical exprs get four distinct spans", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    const source = "<div a=x.y b=x.y>${x.y}${x.y}</div>\n";
    const ir = lowerSource(source);
    const element = find(ir.body, "Element");
    const attrExprs = element.attrs.map((attr) =>
      attr.kind === "dynamic" || attr.kind === "bound" || attr.kind === "spread"
        ? attr.value
        : null,
    );
    const interpolations = element.children.filter(
      (child) => child.kind === "Interpolation",
    );
    const exprs = [...attrExprs, ...interpolations.map((i) => i.expr)].filter(
      (e): e is NonNullable<typeof e> => e !== null,
    );
    expect(exprs).toHaveLength(4);
    for (const e of exprs) expect(slice(source, e)).toBe("x.y");
    const starts = exprs.map((e) => e.span?.sourceStart);
    expect(new Set(starts).size).toBe(4);
  });

  it("a span computed under a distinct ctx.source is absolute in that source", () => {
    // This mirrors the *shape* of `registerTemplateMetadataCompiler`'s own
    // callback (`lower.ts:1396`) — a `lower()` call against a `Ctx` built
    // from a template's own `tag.source`/`tag.filename` rather than the
    // caller's — using `lowerSource` directly rather than going through a
    // real caller/tag-unit compile.
    //
    // It does NOT exercise `Expr.file`: nothing in `packages/core` sets that
    // field today (see `ir.ts`'s comment on it), and a tag unit does not
    // need it to get an absolute span — its own `ctx.source` already *is*
    // its own file, so offsets computed against it are correct with no
    // shifting. `template-tag.test.ts`'s "compiles a called template unit's
    // own expressions through the real metadata path" test drives the actual
    // production callsite end to end; this test only pins that a `Ctx` whose
    // `source` differs from some other file's does not need special-casing
    // for its own spans to be correct.
    const templateSource = "<const/doubled=tpl.n * 2/>\n<p>x</p>\n";
    const ir = lowerSource(templateSource);
    const constNode = find(ir.body, "Const");
    expect(slice(templateSource, constNode.init)).toBe("tpl.n * 2");
    expect(constNode.init.span).toBeDefined();
  });

  it("a loc-less node produces no span, not a NaN one", () => {
    const source = "<p>x</p>\n";
    const ir = lowerSource(source);
    const ctx = newCtx(
      source,
      printExpression,
      fakeDeclarations(),
      undefined,
      "test.mx",
    );
    const synthetic = { type: "NumericLiteral", value: 1 };
    const result = exprOf(ctx, synthetic);
    expect(result.span).toBeUndefined();
    expect(result.code).toBe("1");
    // Sanity: the guard is specific to a loc-less node, not to every call.
    expect(find(ir.body, "Text").value).toBe("x");
  });

  it("a node with a numeric start/end but no loc still produces no span", () => {
    // Round 2: `exprSpan`'s guard used to admit this shape (`node?.start` is
    // a number, so the old `!node?.loc && typeof node?.start !== "number"`
    // check passed it through to `nodeSpan`), which then fed the raw number
    // `7` to `offsetOf` as if it were a `{line, column}` position — reading
    // `.column` off a number is `undefined`, producing `NaN`. `offsetOf`
    // only ever reads position-shaped values from `loc.start`/`loc.end`, so
    // `loc` alone is the correct — and only correct — gate.
    const source = "<p>x</p>\n";
    const ctx = newCtx(
      source,
      printExpression,
      fakeDeclarations(),
      undefined,
      "test.mx",
    );
    const synthetic = { type: "Id", start: 7, end: 10 };
    const result = exprOf(ctx, synthetic);
    expect(result.span).toBeUndefined();
  });
});
