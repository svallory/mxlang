import { describe, expect, it } from "vitest";
import {
  type AttrTagDecl,
  type CalleeInput,
  readCalleeInput,
  readOwnInput,
} from "./callee-input.ts";
import { compileSource } from "./compile.ts";
import type { Ctx, MxWarning, Node } from "./core.ts";
import { DYNAMIC_TAG, expr, newCtx } from "./core.ts";
import { type CustomTag, customTagTaglib } from "./custom-tags.ts";
import type { Policy } from "./declarations.ts";
import type { AttributeTag, Ir, IrNode } from "./ir.ts";
import { exprOf, exprSpan, lower, paramSpansOf } from "./lower.ts";
import { lookup } from "./test-targets.ts";

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
function lowerSource(
  source: string,
  policy = fakeDeclarations(),
  calleeInput?:
    | CalleeInput
    | ((target: import("./ir.ts").ComponentTarget) => CalleeInput),
  ownInput?: CalleeInput,
  customTags?: Readonly<Record<string, CustomTag>>,
): Ir {
  let ir: Ir | null = null;
  let thrown: unknown = null;

  // This helper needs `lower` over the compiler's real parsed body.
  // `newCtx` plus the compiler's parse is the seam: a
  // translator whose Program visitor lowers instead of emitting.
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
          if (calleeInput) {
            ctx.calleeInputFor =
              typeof calleeInput === "function"
                ? calleeInput
                : () => calleeInput;
          }
          ctx.ownInput = ownInput;
          ctx.customTags = customTags;
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

/**
 * Lowers `source` with a warnings sink attached, returning both.
 *
 * `warn` prints to the console when no sink is collecting, so a test that
 * asserts a warning has to supply one — and asserting the *position* is the
 * point: the language server turns these into editor squiggles on the
 * attribute name, so a warning that compiles but lands on the wrong line is a
 * silent regression a message-only assertion would miss.
 */
function lowerWithWarnings(
  source: string,
  policy = fakeDeclarations(),
): { ir: Ir; warnings: MxWarning[] } {
  const warnings: MxWarning[] = [];
  let ir: Ir | null = null;
  let thrown: unknown = null;

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
            lookup,
          );
          ctx.warnings = warnings;
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
  return { ir, warnings };
}

function attrTagDecl(overrides: Partial<AttrTagDecl> = {}): AttrTagDecl {
  return {
    cardinality: "optional",
    as: "renderable",
    hasAttrs: false,
    hasParams: false,
    nested: new Map(),
    nestedOpen: false,
    span: { sourceStart: 0, sourceEnd: 0 },
    ...overrides,
  };
}

function declaredInput(
  attrTags: Record<string, AttrTagDecl>,
  otherProps: string[] = [],
  open = false,
): CalleeInput {
  return {
    kind: "declared",
    path: "/fixtures/Panel.mx",
    attrTags: new Map(Object.entries(attrTags)),
    otherProps: new Set(otherProps),
    open,
  };
}

function invalidInput(
  errors: Array<[string, string]> = [
    ["x", "declare this attribute tag's config literally"],
  ],
): CalleeInput {
  return {
    kind: "invalid",
    path: "callee.ts",
    errors: new Map(
      errors.map(([name, message]) => [
        name,
        {
          message,
          span: { file: "callee.ts", sourceStart: 0, sourceEnd: 1 },
        },
      ]),
    ),
  };
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

  it("allows a define call mixing tag-argument form with an attribute tag, matching Marko's lenient dynamic-tag rule", () => {
    const ir = lowerSource(
      "<define/Card|title, head|><h1>${title}</h1>${head}</define>\n<Card('a')><@head>H</@head></Card>\n",
    );
    const component = find(ir.body, "Component");
    expect(component.target).toMatchObject({ kind: "define", name: "Card" });
    expect(component.args).toMatchObject([{ code: "'a'" }]);
    expect(component.attributeTags).toHaveLength(1);
  });

  it("allows a define call mixing tag-argument form with a body, matching Marko's lenient dynamic-tag rule", () => {
    const ir = lowerSource(
      "<define/Card|title|><h1>${title}</h1>${input.content}</define>\n<Card('a')>body</Card>\n",
    );
    const component = find(ir.body, "Component");
    expect(component.target).toMatchObject({ kind: "define", name: "Card" });
    expect(component.args).toMatchObject([{ code: "'a'" }]);
    expect(component.content).not.toBeNull();
  });

  it("still rejects a define call mixing tag-argument form with a plain attribute", () => {
    let error: unknown;
    try {
      lowerSource(
        "<define/Card|title|><h1>${title}</h1></define>\n<Card('a') foo=\"bar\"/>\n",
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Tag does not support arguments when attributes present.",
    );
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

  it("decision 116: a .ts default import routes to a dynamic Component target, not a name call", () => {
    // Only a `.marko`/`.mx` default import is Marko's own statically
    // resolved component case; a `.ts`/`.js` value import lowers as a
    // dynamic tag (matching Marko's `_dynamic_tag` runtime dispatch), with
    // `valueImportBinding` carrying the binding name for typed
    // attribute-tag resolution (`readCalleeInput`) and diagnostics
    // (`targetName`).
    const ir = lowerSource(
      'import Comp from "./comp.ts"\n<Comp name="1">body</Comp>\n',
      fakeDeclarations({ isComponent: (name) => name === "Comp" }),
    );
    const component = find(ir.body, "Component");
    expect(component.target).toMatchObject({
      kind: "dynamic",
      expr: { code: "Comp" },
      valueImportBinding: "Comp",
    });
    expect(component.attrs).toMatchObject([
      { kind: "static", name: "name", value: "1" },
    ]);
    expect(component.content).not.toBeNull();
  });

  it("decision 116: a .marko default import still routes to a name Component target", () => {
    const ir = lowerSource(
      'import Panel from "./panel.marko"\n<Panel/>\n',
      fakeDeclarations({ isComponent: (name) => name === "Panel" }),
    );
    const component = find(ir.body, "Component");
    expect(component.target).toMatchObject({ kind: "name", name: "Panel" });
  });

  it("decision 116: a .mx default import still routes to a name Component target", () => {
    const ir = lowerSource(
      'import Panel from "./panel.mx"\n<Panel/>\n',
      fakeDeclarations({ isComponent: (name) => name === "Panel" }),
    );
    const component = find(ir.body, "Component");
    expect(component.target).toMatchObject({ kind: "name", name: "Panel" });
  });

  it("decision 116: a named (non-default) .marko import still routes as a dynamic tag", () => {
    // `Panel` here is a *named* import, not `.marko`'s statically-resolved
    // default-import case — Marko itself only special-cases the default
    // export of a `.marko` file, so a named import of the same file is
    // still routed dynamically.
    const ir = lowerSource(
      'import { Panel } from "./panel.marko"\n<Panel/>\n',
      fakeDeclarations({ isComponent: (name) => name === "Panel" }),
    );
    const component = find(ir.body, "Component");
    expect(component.target).toMatchObject({
      kind: "dynamic",
      valueImportBinding: "Panel",
    });
  });

  it("local-value-as-tag: a static function declaration stays a direct call", () => {
    const ir = lowerSource(
      'static function Foo() {\n  return "x";\n}\n<Foo/>\n',
    );
    const component = find(ir.body, "Component");
    expect(component.target).toMatchObject({ kind: "name", name: "Foo" });
  });

  it("local-value-as-tag: a static class declaration stays a direct call", () => {
    const ir = lowerSource("static class Foo {}\n<Foo/>\n");
    const component = find(ir.body, "Component");
    expect(component.target).toMatchObject({ kind: "name", name: "Foo" });
  });

  it("local-value-as-tag: a static arrow-function const stays a direct call", () => {
    const ir = lowerSource('static const Foo = () => "x";\n<Foo/>\n');
    const component = find(ir.body, "Component");
    expect(component.target).toMatchObject({ kind: "name", name: "Foo" });
  });

  it("local-value-as-tag: a static const string is unknown and lowers dynamic", () => {
    const ir = lowerSource('static const Foo = "hello";\n<Foo/>\n');
    const component = find(ir.body, "Component");
    expect(component.target).toMatchObject({
      kind: "dynamic",
      expr: { code: "Foo" },
      valueImportBinding: "Foo",
    });
  });

  it("local-value-as-tag: a static const call result (lazy/createComponent-style) is unknown and lowers dynamic", () => {
    const ir = lowerSource(
      'static const Foo = lazy(() => import("./x"));\n<Foo/>\n',
    );
    const component = find(ir.body, "Component");
    expect(component.target).toMatchObject({
      kind: "dynamic",
      valueImportBinding: "Foo",
    });
  });

  it("local-value-as-tag: a <const> bound to an arrow-function component stays a direct call", () => {
    const ir = lowerSource('<const/Foo=() => "x"/>\n<Foo/>\n');
    const component = find(ir.body, "Component");
    expect(component.target).toMatchObject({ kind: "name", name: "Foo" });
  });

  it("local-value-as-tag: a <const> bound to a conditional string-or-component is unknown and lowers dynamic", () => {
    const ir = lowerSource(
      'static function A() { return "a"; }\nstatic function B() { return "b"; }\n<const/Foo=cond ? A : B/>\n<Foo/>\n',
    );
    const component = find(ir.body, "Component");
    expect(component.target).toMatchObject({
      kind: "dynamic",
      valueImportBinding: "Foo",
    });
  });

  it("local-value-as-tag: a tag param is always unknown and lowers dynamic", () => {
    const ir = lowerSource(
      "<define/Wrapper|Row|>\n  <Row/>\n</define>\n",
      fakeDeclarations({
        isComponent: (name, ctx) => ctx.defines.has(name),
      }),
    );
    const wrapper = find(ir.body, "Define");
    const component = find(wrapper.children, "Component");
    expect(component.target).toMatchObject({
      kind: "dynamic",
      valueImportBinding: "Row",
    });
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

  // Decision 109 relaxed the dynamic-tag/`<define>` rule; a named custom
  // tag (`target.kind === "name"`) stays on Marko's strict
  // `assertAttributesOrSingleArg`-equivalent rule, unaffected. Regression
  // coverage for that boundary: before this test, every existing assertion
  // of "Tag does not support arguments..." exercised the dynamic-tag path
  // only, so nothing pinned the named-tag branch staying strict.
  it.each([
    [
      "an attribute tag",
      'import Panel from "./panel.marko"\n<Panel("a")>\n  <@header>H</@header>\n</Panel>\n',
    ],
    ["a body", 'import Panel from "./panel.marko"\n<Panel("a")>body</Panel>\n'],
  ])(
    "still rejects a named custom tag mixing tag-argument form with %s",
    (_case, source) => {
      let error: unknown;
      try {
        lowerSource(
          source,
          fakeDeclarations({ isComponent: (name) => name === "Panel" }),
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "Tag does not support arguments when attributes or body present.",
      );
    },
  );

  // attribute-tag-silent-drops B1/B2: the IR itself already carries every
  // repeated `<@name>` (a flat array, never last-wins) and forwards
  // `attributeTags` on a `DelegatedTag` too — the bugs found by the spec backfill
  // were emitter-only (Solid's JSX-prop-per-tag last-wins for a repeat;
  // html's dynamic-tag path building its own synthetic `Component` with a
  // hardcoded `attributeTags: []`), not a core lowering gap. These tests
  // pin the core contract those fixes rely on.
  it("Component keeps every repeated attribute tag, not just the last", () => {
    const ir = lowerSource(
      [
        'import Layout from "./layout.marko"',
        "<Layout>",
        "  <@item>1</@item>",
        "  <@item>2</@item>",
        "</Layout>",
        "",
      ].join("\n"),
      fakeDeclarations({ isComponent: (name) => name === "Layout" }),
    );
    const component = find(ir.body, "Component");
    expect(component.attributeTags.map((t) => t.name)).toEqual([
      "item",
      "item",
    ]);
  });

  describe("attribute-tag v2 IR and validation", () => {
    const v2 = () =>
      fakeDeclarations({
        name: "TestHost",
        attrTags: 2,
        isComponent: (name) => name === "Panel",
      });

    it("records attrs, body state, nested tree and recursive plans", () => {
      const icon = attrTagDecl({ as: "renderable" });
      const tab = attrTagDecl({
        cardinality: "array",
        as: "data",
        hasAttrs: true,
        nested: new Map([["icon", icon]]),
      });
      const ir = lowerSource(
        '<Panel><@tab title="A"><@icon>I</@icon>Body</@tab></Panel>',
        v2(),
        declaredInput({ tab }),
      );
      const component = find(ir.body, "Component");
      const outer = component.attributeTags[0];
      expect(outer).toMatchObject({
        name: "tab",
        hasBody: true,
        attrs: [{ kind: "static", name: "title", value: "A" }],
        attributeTags: [{ name: "icon", hasBody: true }],
        attrTagProps: [
          { name: "icon", cardinality: "single", as: "renderable" },
        ],
      });
      expect(component.attributeTagTree[0]?.kind).toBe("AttributeTag");
      expect(component.attrTagProps).toMatchObject([
        { name: "tab", cardinality: "array", as: "data" },
      ]);
    });

    it.each([
      ["component", "<Panel><@x/></Panel>", v2(), undefined],
      [
        "host tag",
        "<signal><@x/></signal>",
        fakeDeclarations({
          name: "TestHost",
          attrTags: 2,
          isDelegatedTag: (name) => name === "signal",
        }),
        undefined,
      ],
      [
        "discovered template tag",
        "<panel><@x/></panel>",
        v2(),
        {
          panel: {
            template: {
              filename: "/tmp/mx-core-test/tags/panel.mx",
              source: "<div/>",
            },
          } as CustomTag,
        },
      ],
    ])(
      "raises an invalid Input at a used tag for a %s",
      (_case, source, policy, customTags) => {
        expect(() =>
          lowerSource(source, policy, invalidInput(), undefined, customTags),
        ).toThrowError(
          "can't read `<" +
            (_case === "component"
              ? "Panel"
              : _case === "host tag"
                ? "signal"
                : "panel") +
            ">`'s declaration of `x` (callee.ts:1); declare this attribute tag's config literally",
        );
      },
    );

    it("raises only invalid declarations used at this call", () => {
      expect(() =>
        lowerSource(
          "<Panel><@y/></Panel>",
          v2(),
          invalidInput([["x", "bad x"]]),
        ),
      ).not.toThrow();
      expect(() =>
        lowerSource(
          "<Panel><@x/></Panel>",
          v2(),
          invalidInput([["x", "bad x"]]),
        ),
      ).toThrowError("declaration of `x` (callee.ts:1); bad x");
    });

    it("applies a whole-file parse error to every used attribute tag", () => {
      expect(() =>
        lowerSource(
          "<Panel><@y/></Panel>",
          v2(),
          invalidInput([["<parse>", "Unexpected token (1:1)"]]),
        ),
      ).toThrowError(
        // The named position is 1-based (ruling #227), like `mx-tsc`'s
        // `file(line,column)`: a span at offset 1 of line 1 is column 2.
        "can't read `<Panel>`'s Input (callee.ts:1:2): Unexpected token",
      );
    });

    it("keeps multi-line static aliases in own Input, including self calls", () => {
      const aux = ["type Cfg = {", '  as: "data";', "};"].join("\n");
      const inputCode = "export interface Input { x?: AttrTag<Cfg> }";
      const ctx = newCtx(
        `${aux}\n${inputCode}`,
        printExpression,
        v2(),
        undefined,
        "test.mx",
        lookup,
      );
      const ownInput = readOwnInput(ctx, inputCode, [aux]);
      expect(() =>
        lowerSource("<${input.x}/>", v2(), undefined, ownInput),
      ).toThrowError("is a data attribute tag");
      const renderable = readOwnInput(
        newCtx(
          `${aux.replace('"data"', '"renderable"')}\n${inputCode}`,
          printExpression,
          v2(),
          undefined,
          "test.mx",
          lookup,
        ),
        inputCode,
        [aux.replace('"data"', '"renderable"')],
      );
      const recursiveCtx = newCtx(
        "<Test><@x/><@x/></Test>",
        printExpression,
        v2(),
        undefined,
        "test.mx",
        lookup,
      );
      recursiveCtx.exportName = "Test";
      recursiveCtx.ownInput = renderable;
      expect(
        readCalleeInput({ kind: "name", name: "Test" }, recursiveCtx).input,
      ).toBe(renderable);
      expect(() =>
        lowerSource(
          "<Test><@x/><@x/></Test>",
          fakeDeclarations({
            name: "TestHost",
            attrTags: 2,
            isComponent: (name) => name === "Test",
          }),
          renderable,
        ),
      ).toThrowError("`<@x>` may appear at most once");
    });

    it("raises a component's own invalid Input at its declaration", () => {
      let error: unknown;
      try {
        lowerSource(
          "export interface Input { x?: AttrTag<{ as: string }> }\n<div/>",
          v2(),
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "can't read this component's declaration of `x` (test.mx:1); declare this attribute tag's config literally",
      );
      expect(error).toMatchObject({ line: 1, column: 29 });
    });

    it("keeps mutually-exclusive optional singular tags in one if plan", () => {
      const ir = lowerSource(
        "<Panel><if=input.ok><@head>A</@head></if><else><@head>B</@head></else></Panel>",
        v2(),
        declaredInput({ head: attrTagDecl() }),
      );
      const component = find(ir.body, "Component");
      expect(component.attributeTags.map((tag) => tag.name)).toEqual([
        "head",
        "head",
      ]);
      expect(component.attributeTagTree).toMatchObject([
        {
          kind: "AttributeTagIf",
          branches: [{ nodes: [{}] }, { nodes: [{}] }],
        },
      ]);
      expect(component.content).toBeNull();
    });

    it("discovers @-named children in an imported component's control body", () => {
      const ir = lowerSource(
        [
          'import Panel from "./panel.ts"',
          "<Panel><for|item| of=input.items><@row id=item/></for></Panel>",
        ].join("\n"),
        v2(),
        declaredInput({
          row: attrTagDecl({
            cardinality: "array",
            as: "data",
            hasAttrs: true,
          }),
        }),
      );
      const component = find(ir.body, "Component");
      expect(component.attributeTags.map((tag) => tag.name)).toEqual(["row"]);
      expect(component.attributeTagTree).toMatchObject([
        { kind: "AttributeTagFor", nodes: [{ kind: "AttributeTag" }] },
      ]);
      expect(component.content).toBeNull();
    });

    it("groups control flow stored among attributeTags through its siblings", () => {
      const ir = lowerSource(
        [
          'import Panel from "./panel.ts"',
          "<Panel>",
          "  <if=input.a><@head>A</@head></if>",
          "  <else-if=input.b><@head>B</@head></else-if>",
          "  <else><@head>C</@head></else>",
          "</Panel>",
        ].join("\n"),
        v2(),
        declaredInput({ head: attrTagDecl() }),
      );
      const component = find(ir.body, "Component");
      expect(component.attributeTags.map((tag) => tag.name)).toEqual([
        "head",
        "head",
        "head",
      ]);
      expect(component.attributeTagTree).toMatchObject([
        {
          kind: "AttributeTagIf",
          branches: [
            { test: {}, nodes: [{}] },
            { test: {}, nodes: [{}] },
            { nodes: [{}] },
          ],
        },
      ]);
      expect(component.content).toBeNull();
    });

    it("keeps sibling content while extracting attribute-tag controls", () => {
      const input = declaredInput({
        h: attrTagDecl(),
        item: attrTagDecl({ cardinality: "array" }),
      });
      const conditional = find(
        lowerSource(
          "<Panel><if=input.a><@h/></if><p>body</p></Panel>",
          v2(),
          input,
        ).body,
        "Component",
      );
      const loop = find(
        lowerSource(
          "<Panel><for|x| of=input.xs><@item/></for><p>body</p></Panel>",
          v2(),
          input,
        ).body,
        "Component",
      );
      expect(find(conditional.content?.children ?? [], "Element").name).toBe(
        "p",
      );
      expect(find(loop.content?.children ?? [], "Element").name).toBe("p");
    });

    it.each([
      [
        "else content",
        "<Panel><if=input.a><@h/></if><else><p>dropped</p></else></Panel>",
        35,
      ],
      [
        "else-if content",
        "<Panel><if=input.a><@h/></if><else-if=input.b>text</else-if></Panel>",
        46,
      ],
      [
        "reverse branch order",
        "<Panel><if=input.a><p>x</p></if><else><@h/></else></Panel>",
        19,
      ],
      [
        "nested chain",
        "<Panel><@tab><if=input.a><@h/></if><else><p>dropped</p></else></@tab></Panel>",
        41,
      ],
    ])(
      "rejects attribute tags mixed with %s across an if chain",
      (_case, source, column) => {
        let error: unknown;
        try {
          lowerSource(source, v2());
        } catch (caught) {
          error = caught;
        }
        expect(error).toMatchObject({
          message:
            "Cannot have attribute tags and body content under a control flow tag.",
          line: 1,
          column,
        });
      },
    );

    it("leaves a second else after an unconditional else to the ordinary stray-else error", () => {
      let error: unknown;
      try {
        lowerSource(
          "<Panel><if=input.a><@h/></if><else><@h/></else><else><@h/></else></Panel>",
          v2(),
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        message: "`<else>` without a preceding `<if>`",
        line: 1,
        column: 47,
      });
    });

    it("uses the owner component's attributes for collisions through controls", () => {
      expect(() =>
        lowerSource(
          '<Panel title="x"><if=input.a><@title/></if></Panel>',
          v2(),
        ),
      ).toThrowError("attribute tag `@title` collides with attribute `title`");
      expect(() =>
        lowerSource("<Panel><if=input.a><@value/></if></Panel>", v2()),
      ).not.toThrow();
      expect(() =>
        lowerSource(
          "<Panel><for|x| of=input.xs by='id'><@of/><@by/></for></Panel>",
          v2(),
        ),
      ).not.toThrow();
    });

    it("keeps conditional fallback plans singular, including else-if chains", () => {
      const one = find(
        lowerSource("<Panel><if=input.a><@h/></if></Panel>", v2()).body,
        "Component",
      );
      const chain = find(
        lowerSource(
          "<Panel><if=input.a><@h/></if><else-if=input.b><@h/></else-if><else><@h/></else></Panel>",
          v2(),
        ).body,
        "Component",
      );
      expect(one.attrTagProps).toMatchObject([
        { name: "h", cardinality: "single" },
      ]);
      expect(chain.attrTagProps).toMatchObject([
        { name: "h", cardinality: "single" },
      ]);
      expect(chain.attributeTagTree[0]).toMatchObject({
        kind: "AttributeTagIf",
        branches: [{}, {}, {}],
      });
    });

    it("merges a static tag and a for tag in authored order", () => {
      const ir = lowerSource(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
        "<Panel><@item>S</@item><for|x| of=input.xs><@item>${x}</@item></for></Panel>",
        v2(),
        declaredInput({ item: attrTagDecl({ cardinality: "array" }) }),
      );
      const component = find(ir.body, "Component");
      expect(component.attributeTagTree.map((node) => node.kind)).toEqual([
        "AttributeTag",
        "AttributeTagFor",
      ]);
      expect(component.attributeTags).toHaveLength(2);
      expect(component.attrTagProps[0]).toMatchObject({
        name: "item",
        cardinality: "array",
      });
    });

    it.each([
      [
        "repeated singular",
        "<Panel><@head>A</@head><@head>B</@head></Panel>",
        declaredInput({ head: attrTagDecl() }),
        "may appear at most once",
        25,
      ],
      [
        "singular in for",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
        "<Panel><for|x| of=input.xs><@head>${x}</@head></for></Panel>",
        declaredInput({ head: attrTagDecl() }),
        "may not appear inside `<for>`",
        7,
      ],
      [
        "params present when undeclared",
        "<Panel><@row|value|/></Panel>",
        declaredInput({ row: attrTagDecl() }),
        "declares no params in `<Panel>`; remove `|…|`",
        8,
      ],
      [
        "missing required",
        "<Panel/>",
        declaredInput({ head: attrTagDecl({ cardinality: "required" }) }),
        "missing required attribute tag `<@head>`",
        1,
      ],
      [
        "required conditional",
        "<Panel><if=input.ok><@head>A</@head></if></Panel>",
        declaredInput({ head: attrTagDecl({ cardinality: "required" }) }),
        "required but not provided on every `<if>` path",
        7,
      ],
      [
        "closed Input",
        "<Panel><@other/></Panel>",
        declaredInput({}),
        "declares no attribute tag `other`",
        8,
      ],
      [
        "plain prop",
        "<Panel><@head/></Panel>",
        declaredInput({}, ["head"]),
        "declared as a plain prop",
        8,
      ],
      [
        "params missing",
        "<Panel><@row/></Panel>",
        declaredInput({ row: attrTagDecl({ hasParams: true }) }),
        "declares params in `<Panel>`; add `|…|`",
        8,
      ],
    ])(
      "rejects %s with a positioned message",
      (_case, source, input, message, column) => {
        let error: unknown;
        try {
          lowerSource(source, v2(), input);
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(message);
        expect(error).toHaveProperty("line", 1);
        expect(error).toHaveProperty("column", column);
      },
    );

    it("uses Marko's exact control-flow mixing error", () => {
      expect(() =>
        lowerSource("<Panel><if=input.ok><@head/> <p>x</p></if></Panel>", v2()),
      ).toThrowError(
        "Cannot have attribute tags and body content under a control flow tag.",
      );
    });

    it("reserves content on an attribute tag", () => {
      expect(() =>
        lowerSource('<Panel><@head content="x"/></Panel>', v2()),
      ).toThrowError("`content` is reserved on an attribute tag");
    });

    it("rejects attrs and nested tags on a declared renderable", () => {
      expect(() =>
        lowerSource(
          '<Panel><@head class="x"/></Panel>',
          v2(),
          declaredInput({ head: attrTagDecl() }),
        ),
      ).toThrowError("is renderable in `<Panel>`; it can't take attributes");
      expect(() =>
        lowerSource(
          "<Panel><@head><@icon/></@head></Panel>",
          v2(),
          declaredInput({
            head: attrTagDecl({
              nested: new Map([["icon", attrTagDecl()]]),
            }),
          }),
        ),
      ).toThrowError("can't take attributes or nested attribute tags");
    });

    it("sets body-only fallback shapes to renderable without changing cardinality", () => {
      const single = find(
        lowerSource("<Panel><@head/></Panel>", v2()).body,
        "Component",
      );
      const repeated = find(
        lowerSource("<Panel><@head/><@head/></Panel>", v2()).body,
        "Component",
      );
      const parameterized = find(
        lowerSource("<Panel><@head|value|>${value}</@head></Panel>", v2()).body,
        "Component",
      );
      expect(single.attrTagProps).toMatchObject([
        { name: "head", cardinality: "single", as: "renderable" },
      ]);
      expect(repeated.attrTagProps).toMatchObject([
        { name: "head", cardinality: "array", as: "renderable" },
      ]);
      expect(parameterized.attrTagProps).toMatchObject([
        { name: "head", cardinality: "single", as: "renderable" },
      ]);
    });

    it("uses one data fallback shape when any occurrence has attributes", () => {
      const component = find(
        lowerSource(
          '<Panel><if=input.ok><@head/></if><else><@head label="x"/></else></Panel>',
          v2(),
        ).body,
        "Component",
      );
      expect(component.attrTagProps).toMatchObject([
        { name: "head", cardinality: "single", as: "data" },
      ]);
    });

    it("uses a data fallback shape when an occurrence has nested tags", () => {
      const component = find(
        lowerSource("<Panel><@head><@icon/></@head></Panel>", v2()).body,
        "Component",
      );
      expect(component.attrTagProps).toMatchObject([
        { name: "head", cardinality: "single", as: "data" },
      ]);
      expect(component.attributeTags[0]?.attrTagProps).toMatchObject([
        { name: "icon", cardinality: "single", as: "renderable" },
      ]);
    });

    it("keeps a declared data shape for a body-only tag", () => {
      const component = find(
        lowerSource(
          "<Panel><@head>H</@head></Panel>",
          v2(),
          declaredInput({ head: attrTagDecl({ as: "data" }) }),
        ).body,
        "Component",
      );
      expect(component.attrTagProps).toMatchObject([
        { name: "head", cardinality: "single", as: "data" },
      ]);
    });

    it.each([
      [
        "`<@head>`: attributes on attribute tags aren't",
        '<Panel><@head class="x"/></Panel>',
      ],
      [
        "attribute tags inside `<if>` aren't",
        "<Panel><if=input.ok><@head/></if></Panel>",
      ],
      [
        "`<@head>`: nested attribute tags aren't",
        "<Panel><@head><@icon/></@head></Panel>",
      ],
      [
        "attribute tags inside `<for>` aren't",
        "<Panel><for|x| of=input.xs><@head/></for></Panel>",
      ],
    ])("gates %s for an unported host", (construct, source) => {
      expect(() =>
        lowerSource(
          source,
          fakeDeclarations({
            name: "LegacyHost",
            isComponent: (name) => name === "Panel",
          }),
        ),
      ).toThrowError(`${construct} supported by LegacyHost yet`);
    });

    it("gates a zero-occurrence declared array on a legacy host", () => {
      let error: unknown;
      try {
        lowerSource(
          "<Panel/>",
          fakeDeclarations({
            name: "@mxlang/legacy",
            isComponent: (name) => name === "Panel",
          }),
          declaredInput({ items: attrTagDecl({ cardinality: "array" }) }),
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "the declared shape of `<@items>` isn't supported by @mxlang/legacy yet",
      );
      expect(error).toHaveProperty("line", 1);
      expect(error).toHaveProperty("column", 1);
    });

    it("gates control-flow attribute tags on a claimed dynamic DelegatedTag", () => {
      expect(() =>
        lowerSource(
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag syntax in template source
          "<${input.tag}><if=input.ok><@head/></if></>",
          fakeDeclarations({
            name: "@mxlang/legacy",
            isDelegatedTag: (name) => name === DYNAMIC_TAG,
          }),
        ),
      ).toThrowError(
        "attribute tags inside `<if>` aren't supported by @mxlang/legacy yet",
      );
    });

    it("validates nested cardinality and records nested fallback plans", () => {
      const item = attrTagDecl({
        as: "data",
        nested: new Map([["icon", attrTagDecl()]]),
      });
      expect(() =>
        lowerSource(
          "<Panel><@item><@icon/><@icon/></@item></Panel>",
          v2(),
          declaredInput({ item }),
        ),
      ).toThrowError("`<@icon>` may appear at most once");

      const component = find(
        lowerSource(
          "<Panel><@item><if=input.ok><@note/></if></@item></Panel>",
          v2(),
          declaredInput({
            item: attrTagDecl({ as: "data", nestedOpen: true }),
          }),
        ).body,
        "Component",
      );
      expect(component.attributeTags[0]?.attrTagProps).toMatchObject([
        { name: "note", cardinality: "single" },
      ]);
    });

    it("unifies nested fallback shape across parent branches and repeats", () => {
      const conditional = find(
        lowerSource(
          '<Panel><if=input.c><@tab><@icon>I</@icon>T</@tab></if><else><@tab><@icon k="1">J</@icon>U</@tab></else></Panel>',
          v2(),
        ).body,
        "Component",
      );
      expect(
        conditional.attributeTags.map((tab) => tab.attrTagProps),
      ).toMatchObject([
        [{ name: "icon", cardinality: "single", as: "data" }],
        [{ name: "icon", cardinality: "single", as: "data" }],
      ]);

      const repeated = find(
        lowerSource(
          '<Panel><@tab><@icon>I</@icon></@tab><@tab><@icon k="1">J</@icon></@tab></Panel>',
          v2(),
        ).body,
        "Component",
      );
      expect(
        repeated.attributeTags.map((tab) => tab.attrTagProps),
      ).toMatchObject([
        [{ name: "icon", cardinality: "single", as: "data" }],
        [{ name: "icon", cardinality: "single", as: "data" }],
      ]);
    });

    it("unifies nested fallback cardinality across parent occurrences", () => {
      const component = find(
        lowerSource(
          "<Panel><@tab><@icon>I</@icon></@tab><@tab><@icon>J</@icon><@icon>K</@icon></@tab></Panel>",
          v2(),
        ).body,
        "Component",
      );
      expect(
        component.attributeTags.map((tab) => tab.attrTagProps),
      ).toMatchObject([
        [{ name: "icon", cardinality: "array", as: "renderable" }],
        [{ name: "icon", cardinality: "array", as: "renderable" }],
      ]);
    });

    it("keeps nested fallback plans isolated between sibling parent names", () => {
      const shape = find(
        lowerSource(
          '<Panel><@tab><@icon>I</@icon></@tab><@card><@icon k="1">J</@icon></@card></Panel>',
          v2(),
        ).body,
        "Component",
      );
      expect(
        shape.attributeTags.map((parent) => parent.attrTagProps),
      ).toMatchObject([
        [{ name: "icon", cardinality: "single", as: "renderable" }],
        [{ name: "icon", cardinality: "single", as: "data" }],
      ]);

      const cardinality = find(
        lowerSource(
          "<Panel><@tab><@icon>I</@icon></@tab><@card><@icon>J</@icon><@icon>K</@icon></@card></Panel>",
          v2(),
        ).body,
        "Component",
      );
      expect(
        cardinality.attributeTags.map((parent) => parent.attrTagProps),
      ).toMatchObject([
        [{ name: "icon", cardinality: "single", as: "renderable" }],
        [{ name: "icon", cardinality: "array", as: "renderable" }],
      ]);

      const names = find(
        lowerSource(
          "<Panel><@tab><@icon>I</@icon></@tab><@card><@badge>B</@badge></@card></Panel>",
          v2(),
        ).body,
        "Component",
      );
      expect(
        names.attributeTags.map((parent) => parent.attrTagProps),
      ).toMatchObject([
        [{ name: "icon", cardinality: "single", as: "renderable" }],
        [{ name: "badge", cardinality: "single", as: "renderable" }],
      ]);
    });

    it("does not leak a declared nested plan into an undeclared sibling parent", () => {
      const tab = attrTagDecl({
        as: "data",
        nested: new Map([["icon", attrTagDecl({ as: "renderable" })]]),
      });
      const component = find(
        lowerSource(
          '<Panel><@tab><@icon>I</@icon></@tab><@card><@icon k="1">J</@icon></@card></Panel>',
          v2(),
          declaredInput({ tab }, [], true),
        ).body,
        "Component",
      );
      expect(component.attributeTags[0]?.attrTagProps).toMatchObject([
        {
          name: "icon",
          cardinality: "single",
          as: "renderable",
          declared: true,
        },
      ]);
      expect(component.attributeTags[1]?.attrTagProps).toMatchObject([
        { name: "icon", cardinality: "single", as: "data" },
      ]);
      expect(component.attributeTags[1]?.attrTagProps[0]).not.toHaveProperty(
        "declared",
      );
    });

    it("unifies fallback shape recursively below the second level", () => {
      const component = find(
        lowerSource(
          '<Panel><@tab><@group><@icon>I</@icon></@group></@tab><@tab><@group><@icon k="1">J</@icon></@group></@tab></Panel>',
          v2(),
        ).body,
        "Component",
      );
      const groups = component.attributeTags.map(
        (tab) => tab.attributeTags[0] as AttributeTag,
      );
      expect(groups.map((group) => group.attrTagProps)).toMatchObject([
        [{ name: "icon", cardinality: "single", as: "data" }],
        [{ name: "icon", cardinality: "single", as: "data" }],
      ]);
    });

    it("keeps a declared nested plan authoritative across parent occurrences", () => {
      const tab = attrTagDecl({
        cardinality: "array",
        as: "data",
        nested: new Map([
          ["icon", attrTagDecl({ cardinality: "array", as: "renderable" })],
        ]),
      });
      const component = find(
        lowerSource(
          "<Panel><@tab><@icon>I</@icon></@tab><@tab><@icon>J</@icon><@icon>K</@icon></@tab></Panel>",
          v2(),
          declaredInput({ tab }),
        ).body,
        "Component",
      );
      for (const occurrence of component.attributeTags) {
        expect(occurrence.attrTagProps[0]).toMatchObject({
          name: "icon",
          cardinality: "array",
          as: "renderable",
          declared: true,
        });
      }
    });

    it("gates a declared data shape and diagnoses data rendering in the callee", () => {
      const input = declaredInput({ head: attrTagDecl({ as: "data" }) });
      expect(() =>
        lowerSource(
          "<Panel><@head/></Panel>",
          fakeDeclarations({
            name: "LegacyHost",
            isComponent: (name) => name === "Panel",
          }),
          input,
        ),
      ).toThrowError("declared shape of `<@head>`");
      expect(() =>
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag syntax in template source
        lowerSource("<${input.head}/>", v2(), undefined, input),
      ).toThrowError(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: diagnostic intentionally quotes Marko syntax
        "`input.head` is a data attribute tag; render its body with `<${input.head.content}/>`",
      );
    });

    it("rejects a declared parameterized tag used without arguments", () => {
      const input = declaredInput({
        data: attrTagDecl({ as: "data", hasParams: true }),
        renderable: attrTagDecl({ as: "renderable", hasParams: true }),
      });
      expect(() =>
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag syntax in template source
        lowerSource("<${input.data.content}/>", v2(), undefined, input),
      ).toThrowError(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: diagnostic intentionally quotes Marko syntax
        "`input.data.content` is a parameterized attribute tag; pass its arguments with `<${input.data.content(/* arguments */)}/>`",
      );
      expect(() =>
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag syntax in template source
        lowerSource("<${input.renderable}/>", v2(), undefined, input),
      ).toThrowError(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: diagnostic intentionally quotes Marko syntax
        "`input.renderable` is a parameterized attribute tag; pass its arguments with `<${input.renderable(/* arguments */)}/>`",
      );
      expect(() =>
        lowerSource(
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag syntax in template source
          '<${input.data.content}("d")/><${input.renderable}("r")/>',
          v2(),
          undefined,
          input,
        ),
      ).not.toThrow();
    });

    it.each([
      ["data content", "input.data.content"],
      ["renderable", "input.renderable"],
    ])(
      "rejects a declared parameterized %s placeholder used without arguments",
      (_shape, expression) => {
        const input = declaredInput({
          data: attrTagDecl({ as: "data", hasParams: true }),
          renderable: attrTagDecl({ as: "renderable", hasParams: true }),
        });
        let error: unknown;
        try {
          lowerSource(`<div>\${${expression}}</div>`, v2(), undefined, input);
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
          `\`${expression}\` is a parameterized attribute tag; pass its arguments with \`<\${${expression}(/* arguments */)}/>\``,
        );
        expect(error).toMatchObject({ line: 1, column: 7 });
      },
    );

    it("marks an unimported AttrTag reference for a host type import", () => {
      expect(
        lowerSource("export interface Input { head?: AttrTag }\n<p>x</p>", v2())
          .needsAttrTagImport,
      ).toBe(true);
      expect(
        lowerSource(
          'import type { AttrTag } from "@mxlang/core"\nexport interface Input { head?: AttrTag }\n<p>x</p>',
          v2(),
        ).needsAttrTagImport,
      ).toBe(false);
    });

    it.each([
      [
        "local declaration",
        "static type AttrTag = unknown\nexport interface Input { head?: AttrTag }",
        false,
      ],
      [
        "HTML comment",
        "<!-- import { AttrTag } from '@mxlang/core' -->\nexport interface Input { head?: AttrTag }",
        true,
      ],
      [
        "aliased import",
        "import type { AttrTag as T } from '@mxlang/core'\nexport interface Input { one?: T; two?: AttrTag }",
        true,
      ],
      [
        "local imported binding",
        "import type { Other as AttrTag } from './types'\nexport interface Input { head?: AttrTag }",
        false,
      ],
      ["prefixed name", "export interface Input { head?: MyAttrTag }", false],
      ["qualified name", "export interface Input { head?: x.AttrTag }", false],
      [
        "local class",
        "static class AttrTag {}\nexport interface Input { head?: AttrTag }",
        false,
      ],
      [
        "local enum",
        "static enum AttrTag { One }\nexport interface Input { head?: AttrTag }",
        false,
      ],
      ["interface heritage", "export interface Input extends AttrTag {}", true],
      [
        "decorated static parse failure",
        "static @dec class A {}\nexport interface Input { head?: AttrTag }",
        true,
      ],
      [
        "duplicate static const parse failure",
        "static const x = 1\nstatic const x = 2\nexport interface Input { head?: AttrTag }",
        true,
      ],
      [
        "duplicate static declarations parse failure",
        "static let y = 1\nstatic var y = 2\nexport interface Input { head?: AttrTag }",
        true,
      ],
    ])(
      "derives AttrTag imports from parsed type references: %s",
      (_case, source, expected) => {
        expect(lowerSource(source, v2()).needsAttrTagImport).toBe(expected);
      },
    );

    it("resolves discovered template-tag plans by resolved path", () => {
      const filename = "/tmp/mx-core-test/tags/panel.mx";
      let target: import("./ir.ts").ComponentTarget | undefined;
      const input = declaredInput({ h: attrTagDecl() });
      const templateTag: CustomTag = {
        template: {
          filename,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag syntax in template source
          source: "<${input.h}/>",
        },
      } as CustomTag;
      const ir = lowerSource(
        "<panel><if=input.ok><@h/></if></panel>",
        v2(),
        (resolvedTarget) => {
          target = resolvedTarget;
          return input;
        },
        undefined,
        { panel: templateTag },
      );
      const component = find(ir.body, "Component");
      expect(component.attributeTagTree[0]?.kind).toBe("AttributeTagIf");
      expect(component.attrTagProps).toMatchObject([
        { name: "h", cardinality: "single", as: "renderable" },
      ]);
      // The seam is invoked with the discovered unit's path, not only its
      // generated import binding. Task 1a consumes this target shape.
      expect(target).toEqual({
        kind: "name",
        name: "panel",
        resolvedPath: filename,
      });
    });

    it("enforces template sidecar repeatability before Input cardinality", () => {
      const templateTag: CustomTag = {
        attributeTags: { item: {} },
        template: {
          filename: "/tmp/mx-core-test/tags/list.mx",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag syntax in template source
          source: "<${input.item}/>",
        },
      } as CustomTag;
      expect(() =>
        lowerSource(
          "<list><@item/><@item/></list>",
          v2(),
          declaredInput({
            item: attrTagDecl({ cardinality: "array" }),
          }),
          undefined,
          { list: templateTag },
        ),
      ).toThrowError("attribute tag `<@item>` may not be repeated");
    });
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

  it("DelegatedTag hands a claimed tag over with its parts lowered", () => {
    const ir = lowerSource(
      "<signal/count=1>body</signal>\n",
      fakeDeclarations({
        isDelegatedTag: (name) => name === "signal",
        resolveDelegatedTag: (name) => ({ seen: name }),
      }),
    );
    const hosted = find(ir.body, "DelegatedTag").tag;
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
        isDelegatedTag: (name) => name === "signal",
        resolveDelegatedTag: (_name, node, ctx) => {
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
 * attrs, no body) — see the "four Marko facts" in `AGENTS.md`. `isDelegatedTag`'s
 * `shape` argument is the only signal that lets a host tell them apart.
 */
describe("a dynamic tag's bare shape", () => {
  it("rejects arguments combined with a plain attribute with a positioned diagnostic (Marko's own rule, MX's own wording)", () => {
    let error: unknown;
    try {
      lowerSource(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag syntax in template source
        '<${input.fn}("A") foo="bar"/>',
        fakeDeclarations({ attrTags: 2 }),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Tag does not support arguments when attributes present.",
    );
    expect(error).toMatchObject({ line: 1, column: 3 });
  });

  it.each([
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag syntax in template source
    ["attribute tags", '<${input.fn}("A")><@x>X</@x></>'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag syntax in template source
    ["body", '<${input.fn}("A")>body</>'],
  ])(
    "allows arguments combined with %s, matching Marko's lenient dynamic-tag rule",
    (_case, source) => {
      const ir = lowerSource(source, fakeDeclarations({ attrTags: 2 }));
      const component = find(ir.body, "Component");
      expect(component.target).toMatchObject({ kind: "dynamic" });
      expect(component.args).toMatchObject([{ code: '"A"' }]);
    },
  );

  it("retains arguments on a claimed dynamic DelegatedTag", () => {
    const ir = lowerSource(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag syntax in template source
      '<${input.fn}("A", input.n)/>',
      fakeDeclarations({
        isDelegatedTag: (name) => name === DYNAMIC_TAG,
        resolveDelegatedTag: () => ({ seen: true }),
      }),
    );
    expect(find(ir.body, "DelegatedTag").tag.args).toMatchObject([
      { code: '"A"' },
      { code: "input.n" },
    ]);
  });

  it("lowers to a dynamic Component when a host claims DYNAMIC_TAG only for the tagged shape", () => {
    const ir = lowerSource(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
      "${input.tag}\n",
      fakeDeclarations({
        isDelegatedTag: (name, _ctx, shape) =>
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
        isDelegatedTag: (name, _ctx, shape) =>
          name === DYNAMIC_TAG && shape !== "bare",
        resolveDelegatedTag: () => ({ seen: true }),
      }),
    );
    const hosted = find(ir.body, "DelegatedTag").tag;
    expect(hosted.name).toBe(DYNAMIC_TAG);
    expect(hosted.attrs).toMatchObject([{ kind: "dynamic", name: "a" }]);
    expect(hosted.data).toEqual({ seen: true });
  });

  // attribute-tag-silent-drops B2: html's dynamic-tag path claims
  // DYNAMIC_TAG and gets a `DelegatedTag`, not a `Component` — its emitter used to
  // build its own synthetic `Component` with a hardcoded `attributeTags: []`
  // instead of this field, dropping every attribute tag on the call. The
  // core side of the contract (this field is populated) was never the bug,
  // but is pinned here so a future regression is caught before it reaches an
  // emitter.
  it("a claimed dynamic tag's DelegatedTag carries its attribute tags", () => {
    const ir = lowerSource(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag syntax in template source
      "<${input.comp}><@header>hi</@header></>\n",
      fakeDeclarations({
        isDelegatedTag: (name) => name === DYNAMIC_TAG,
        resolveDelegatedTag: () => ({ seen: true }),
      }),
    );
    const hosted = find(ir.body, "DelegatedTag").tag;
    expect(hosted.name).toBe(DYNAMIC_TAG);
    expect(hosted.attributeTags.map((t) => t.name)).toEqual(["header"]);
  });

  it("reaches the host for the bare shape when the host claims it explicitly", () => {
    const ir = lowerSource(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
      "${input.tag}\n",
      fakeDeclarations({
        isDelegatedTag: (name) => name === DYNAMIC_TAG,
        resolveDelegatedTag: () => ({ seen: true }),
      }),
    );
    const hosted = find(ir.body, "DelegatedTag").tag;
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
    [
      "an attribute tag under a top-level if",
      "<if=input.ok><@h/></if>\n",
      /attribute tag `@h` on `<if>`; attribute tags are props of components/,
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

describe("CDATA sections and XML declarations (decision 139)", () => {
  /**
   * Marko's parser makes two node kinds out of `<![CDATA[…]]>` and `<?…?>`:
   * `MarkoCDATA` and `MarkoDeclaration`. Core's IR has no node for either, so
   * `lowerChildren`' switch fell through both of them and dropped them on the
   * floor — wrong output and a green build, on every target. Marko 6.3.51
   * rejects both (`runtime-tags/src/translator/visitors/cdata.ts`,
   * `visitors/declaration.ts`, fixture `__tests__/fixtures/cdata` snapshots
   * the error at 1:31 — the `<`), and so does MX, in MX's wording.
   */
  // biome-ignore-start lint/suspicious/noTemplateCurlyInString: the message quotes MX placeholder syntax, not a JS template
  const CDATA_MESSAGE =
    '`<![CDATA[…]]>` is not supported: write the text inline, as `${"…"}` when it must stay raw, or in an attribute value';
  const DECLARATION_MESSAGE =
    "`<?…?>` (an XML declaration or processing instruction) is not supported: remove it";
  // biome-ignore-end lint/suspicious/noTemplateCurlyInString: the message quotes MX placeholder syntax, not a JS template

  /** The error, so the message *and* the position can be asserted. */
  function lowerError(source: string, policy = fakeDeclarations()) {
    try {
      lowerSource(source, policy);
    } catch (error) {
      return error as { message?: string; line?: number; column?: number };
    }
    throw new Error(`expected \`${source}\` to be rejected`);
  }

  it.each([
    ["at top level", "<![CDATA[ x ]]>\n"],
    ["inside an element", "<div><![CDATA[ x ]]></div>\n"],
    [
      "inside an element body with siblings",
      "<div>\n  a<![CDATA[ x ]]>b\n</div>\n",
    ],
    ["inside an `<if>` branch", "<if=input.ok><![CDATA[ x ]]></if>\n"],
    ["inside a `<for>` body", "<for|i| of=input.xs><![CDATA[ x ]]></for>\n"],
  ])("rejects a CDATA section %s", (_where, source) => {
    expect(() => lowerSource(source)).toThrowError(CDATA_MESSAGE);
  });

  it.each([
    ["at top level", '<?xml version="1.0"?>\n'],
    ["inside an element", "<div><?target data?></div>\n"],
    ["inside an `<if>` branch", "<if=input.ok><?target data?></if>\n"],
  ])("rejects an XML declaration %s", (_where, source) => {
    expect(() => lowerSource(source)).toThrowError(DECLARATION_MESSAGE);
  });

  it("rejects one inside an attribute tag body", () => {
    const component = fakeDeclarations({
      name: "TestHost",
      attrTags: 2,
      isComponent: (name) => name === "Panel",
    });
    expect(() =>
      lowerSource("<Panel><@x><![CDATA[ y ]]></@x></Panel>\n", component),
    ).toThrowError(CDATA_MESSAGE);
  });

  it("rejects one in concise mode", () => {
    // Concise: the CDATA is a child of the indented body, not a tag.
    expect(() => lowerSource("div\n  <![CDATA[ x ]]>\n")).toThrowError(
      CDATA_MESSAGE,
    );
    expect(() => lowerSource("div\n  <?target data?>\n")).toThrowError(
      DECLARATION_MESSAGE,
    );
  });

  it("stops at the first one, like every other core error", () => {
    expect(() =>
      lowerSource("<div><![CDATA[ a ]]><![CDATA[ b ]]></div>\n"),
    ).toThrowError(CDATA_MESSAGE);
  });

  it("reports the position of the construct's `<`", () => {
    // Second line, after the element's own text: the `<` of `<![CDATA[`.
    const error = lowerError("<div>\n  a<![CDATA[ x ]]>b\n</div>\n");
    expect(error.message).toBe(CDATA_MESSAGE);
    expect(error.line).toBe(2);
    expect(error.column).toBe(3);
  });

  it("counts a preceding emoji as two UTF-16 code units", () => {
    // `<div>` is five, `😀` is two, the space is one: the `<` sits at
    // column 8 — a byte or code-point count would say 7 or 6.
    const error = lowerError("<div>😀 <![CDATA[ x ]]></div>\n");
    expect(error.line).toBe(1);
    expect(error.column).toBe(8);
  });

  it("counts a CRLF line break as one line", () => {
    const error = lowerError("<div>\r\n  <![CDATA[ x ]]>\r\n</div>\r\n");
    expect(error.line).toBe(2);
    expect(error.column).toBe(2);
  });

  it("rejects a declaration at its own position", () => {
    const error = lowerError("<div>\n  a<?target data?>b\n</div>\n");
    expect(error.message).toBe(DECLARATION_MESSAGE);
    expect(error.line).toBe(2);
    expect(error.column).toBe(3);
  });

  it("leaves the same text alone inside a raw-text body", () => {
    // Marko's parser reads a raw-text element's body as `MarkoText`, so there
    // is no CDATA node to reject: `<script>`/`<style>` bodies are the one
    // place `<![CDATA[…]]>` means plain text. Probed, not assumed — see
    // `cdata.test.ts` in the html host, which pins the output.
    const ir = lowerSource("<script>if (a < b) { x() }</script>\n");
    const script = ir.body[0];
    expect(script?.kind).toBe("Element");
    if (script?.kind !== "Element") throw new Error("expected an element");
    expect(script.children).toEqual([
      expect.objectContaining({ kind: "Text", value: "if (a < b) { x() }" }),
    ]);
  });

  it("does not reject a CDATA-looking string in an attribute value", () => {
    const ir = lowerSource('<div a="<![CDATA[ x ]]>"/>\n');
    expect(ir.body[0]?.kind).toBe("Element");
  });
});

describe("the lowerer runs under the real front door", () => {
  it("requires and drives a host emitter after resolving", () => {
    const { code } = compileSource(
      "<p>hi</p>\n",
      "/tmp/mx-core-test/probe.mx",
      fakeDeclarations(),
      {
        targets: lookup,
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
      { targets: lookup, emitIr: (ir) => ir.exportName ?? "missing" },
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
      { targets: lookup, emitIr: (ir) => ir.exportName ?? "missing" },
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
    isDelegatedTag: (name) => name === "signal",
    resolveDelegatedTag: (_name, node, ctx) => {
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
     * the splice — this is the path a `resolveDelegatedTag` binding (e.g. `<signal>`)
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
        lookup,
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
   * `resolveDelegatedTag` receives children the core has *already* lowered. A host
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
        isDelegatedTag: (name) => name === "dyn" || name === "signal",
        resolveDelegatedTag: (name, node, ctx) => {
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
      /Invalid duplicate value attribute\./,
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
      lookup,
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
      lookup,
    );
    const synthetic = { type: "Id", start: 7, end: 10 };
    const result = exprOf(ctx, synthetic);
    expect(result.span).toBeUndefined();
  });
});

/**
 * `Define.nameSpan`/`paramSpans` and `For.paramSpans` (ref
 * `ir-define-for-spans`): file-absolute byte spans, same convention as
 * `Expr.span`, filled at `lowerDefine`/`lowerFor`. Every other
 * source-derived IR run already carries a span; these were the gap. A
 * component call's own tag-name span is asserted here too, via the
 * pre-existing `Component.nameSpan` — not a new `ComponentTarget` field;
 * see the tests below for why.
 */
function spanSlice(
  source: string,
  span: { sourceStart: number; sourceEnd: number } | undefined,
): string {
  if (!span) throw new Error("expected a span");
  return source.slice(span.sourceStart, span.sourceEnd);
}

describe("Define/For param and name spans", () => {
  it("`<define>` name span", () => {
    const source = "<define/Row><li>x</li></define>\n";
    const ir = lowerSource(source);
    const define = find(ir.body, "Define");
    expect(spanSlice(source, define.nameSpan)).toBe("Row");
  });

  it("`<define>` param spans: plain params", () => {
    const source = "<define/Row|k, v|><li>x</li></define>\n";
    const ir = lowerSource(source);
    const define = find(ir.body, "Define");
    expect(define.params).toEqual(["k", "v"]);
    expect((define.paramSpans ?? []).map((s) => spanSlice(source, s))).toEqual([
      "k",
      "v",
    ]);
  });

  it("`<define>` param spans: destructured param", () => {
    const source = "<define/Row|{ id, name }|><li>x</li></define>\n";
    const ir = lowerSource(source);
    const define = find(ir.body, "Define");
    expect((define.paramSpans ?? []).map((s) => spanSlice(source, s))).toEqual([
      "{ id, name }",
    ]);
  });

  it("`<for>` param spans: single param", () => {
    const source = "<for|item| of=list.items><p>x</p></for>\n";
    const ir = lowerSource(source);
    const loop = find(ir.body, "For");
    expect((loop.paramSpans ?? []).map((s) => spanSlice(source, s))).toEqual([
      "item",
    ]);
  });

  it("`<for>` param spans: index param (`|item, i|`)", () => {
    const source = "<for|item, i| of=list.items><p>x</p></for>\n";
    const ir = lowerSource(source);
    const loop = find(ir.body, "For");
    expect((loop.paramSpans ?? []).map((s) => spanSlice(source, s))).toEqual([
      "item",
      "i",
    ]);
  });

  it("`<for>` param spans: destructured param", () => {
    const source = "<for|{ id, name }| of=list.items><p>x</p></for>\n";
    const ir = lowerSource(source);
    const loop = find(ir.body, "For");
    expect((loop.paramSpans ?? []).map((s) => spanSlice(source, s))).toEqual([
      "{ id, name }",
    ]);
  });

  it('component call target name span (`kind: "define"`), via `Component.nameSpan`', () => {
    // `ComponentTarget` carries no `nameSpan` of its own: `Component.nameSpan`
    // (computed from the same `node.name`) already covers the call's tag
    // name, for every target kind — see `ir.ts`'s comment on `ComponentTarget`.
    const source = "<define/Row|item|><li>x</li></define>\n<Row/>\n";
    const ir = lowerSource(
      source,
      fakeDeclarations({ isComponent: (name, ctx) => ctx.defines.has(name) }),
    );
    const component = find(ir.body, "Component");
    expect(component.target).toEqual({
      kind: "define",
      name: "Row",
      params: ["item"],
    });
    expect(spanSlice(source, component.nameSpan ?? undefined)).toBe("Row");
  });

  it('component call target name span (`kind: "name"`), via `Component.nameSpan`', () => {
    const source = "<Row/>\n";
    const ir = lowerSource(
      source,
      fakeDeclarations({ isComponent: (name) => name === "Row" }),
    );
    const component = find(ir.body, "Component");
    expect(component.target).toEqual({ kind: "name", name: "Row" });
    expect(spanSlice(source, component.nameSpan ?? undefined)).toBe("Row");
  });

  it("`paramSpansOf` on a node with no-loc params yields undefined entries, not NaN ones", () => {
    // Direct unit test of the actual call site (mutation-proved gap: a test
    // that only calls `exprOf` on a synthetic node never exercises
    // `paramSpansOf`'s own `node.body.params` traversal, so an unguarded
    // `nodeSpan` swapped in for `exprSpan` there would still pass). Mirrors
    // the `Expr.span` no-loc tests' node shapes.
    const source = "<p>x</p>\n";
    const ctx = newCtx(
      source,
      printExpression,
      fakeDeclarations(),
      undefined,
      "test.mx",
      lookup,
    );
    const node = {
      body: {
        params: [
          { type: "Identifier", name: "item" },
          { type: "Id", start: 7, end: 10 },
        ],
      },
    };
    expect(paramSpansOf(ctx, node)).toEqual([undefined, undefined]);
  });

  it("`Define.nameSpan` is undefined for a no-loc `node.var`, not NaN", () => {
    // Drives the real `lowerDefine` call site end to end: a `<define>` whose
    // name node carries no `loc` (Marko's own parse always attaches one for
    // real source, so this exercises the guard the same way a template-tag
    // synthesized node would).
    const source = "<define/Row><li>x</li></define>\n";
    const ir = lowerSource(source);
    const define = find(ir.body, "Define");
    expect(define.nameSpan).toBeDefined();

    const ctx = newCtx(
      source,
      printExpression,
      fakeDeclarations(),
      undefined,
      "test.mx",
      lookup,
    );
    const noLocVar = { type: "Identifier", name: "Row" };
    expect(exprSpan(ctx, noLocVar)).toBeUndefined();
  });
});

/**
 * Event attributes (decision 101).
 *
 * The rule under test is a *contract*, not an emission: core resolves one DOM
 * event name from two source spellings and hands it to every host, so the
 * assertions here are about `kind`, `event` and position. What each host then
 * emits is phase B, and is asserted by that host's own suite and the oracles.
 */
describe("event attributes", () => {
  it("lowers `on<Name>` on an element to an event attr carrying the DOM name", () => {
    const ir = lowerSource("<button onClick=f>x</button>\n");
    expect(find(ir.body, "Element").attrs).toMatchObject([
      { kind: "event", name: "onClick", event: "click", value: { code: "f" } },
    ]);
  });

  it("resolves the three `dblclick` spellings to one DOM name", () => {
    // The portability claim, made checkable: two of these are correct MX and
    // collapse to the same event, so every host emits the same binding from
    // either. `onDoubleClick` is the React spelling and is *not* an alias —
    // it lowers to what it literally says (below).
    const ir = lowerSource(
      "<button onDblClick=f>x</button>\n<button on-dblclick=f>y</button>\n",
    );
    const [first, second] = ir.body.filter(
      (node): node is Extract<IrNode, { kind: "Element" }> =>
        node.kind === "Element",
    );
    expect(first?.attrs).toMatchObject([
      { kind: "event", name: "onDblClick", event: "dblclick" },
    ]);
    expect(second?.attrs).toMatchObject([
      { kind: "event", name: "on-dblclick", event: "dblclick" },
    ]);
  });

  it("golden: the IR of the three `dblclick`-ish spellings", () => {
    // The whole contract in one table: what each source spelling hands a host.
    // Two are correct MX and collapse onto `dblclick`, so every host emits the
    // same binding from either; the React spelling lowers to what it literally
    // says. A change to any cell here is a change to the cross-host contract
    // and must be a deliberate edit of this golden.
    const ir = lowerSource(
      "<button onDblClick=f>a</button>\n" +
        "<button on-dblclick=f>b</button>\n" +
        "<button onDoubleClick=f>c</button>\n",
      fakeDeclarations(),
    );
    const events = ir.body
      .filter(
        (node): node is Extract<IrNode, { kind: "Element" }> =>
          node.kind === "Element",
      )
      .flatMap((element) => element.attrs)
      .map((attr) =>
        attr.kind === "event"
          ? { name: attr.name, kind: attr.kind, event: attr.event }
          : { name: "?", kind: attr.kind, event: "?" },
      );
    expect(events).toEqual([
      { name: "onDblClick", kind: "event", event: "dblclick" },
      { name: "on-dblclick", kind: "event", event: "dblclick" },
      { name: "onDoubleClick", kind: "event", event: "doubleclick" },
    ]);
  });

  it("carries `on-<exact>` through verbatim for a custom event", () => {
    const ir = lowerSource("<div on-my-event=f>x</div>\n");
    expect(find(ir.body, "Element").attrs).toMatchObject([
      { kind: "event", name: "on-my-event", event: "my-event" },
    ]);
  });

  it("lowers a React spelling literally and warns instead of rewriting", () => {
    // No aliases: the emitted event stays `doubleclick`, which is what the
    // author wrote and what no element fires. Rewriting it to `dblclick` would
    // make one spelling silently mean another.
    const { ir, warnings } = lowerWithWarnings(
      "<button onDoubleClick=f>x</button>\n",
    );
    expect(find(ir.body, "Element").attrs).toMatchObject([
      { kind: "event", name: "onDoubleClick", event: "doubleclick" },
    ]);
    expect(warnings).toEqual([
      {
        message:
          "`onDoubleClick` is not a DOM event; did you mean `onDblclick`",
        line: 1,
        column: 8,
        file: "test.mx",
      },
    ]);
  });

  describe("a <define> with several params called without arguments", () => {
    const def = "<define/Card|title, head|><div>${title}</div></define>\n";
    const message =
      "`<Card>` has 2 params, but only the first parameter receives the attributes object; destructure it (`|{ a, b }|`) instead of reading one param per attribute";

    it.each([
      ["an attribute", '<Card title="a"/>'],
      ["a body", "<Card>text</Card>"],
      ["an attribute tag", "<Card><@head>H</@head></Card>"],
    ])("warns at the tag name for %s", (_name, call) => {
      const { warnings } = lowerWithWarnings(def + call);
      expect(warnings).toEqual([
        { message, line: 2, column: 1, file: "test.mx" },
      ]);
    });

    it("stays silent for tag arguments, a bare call, one param or no params", () => {
      for (const source of [
        `${def}<Card("a")/>`,
        `${def}<Card/>`,
        "<define/Card|p|><div>${p.n}</div></define>\n<Card n=1/>",
        "<define/Card><div/></define>\n<Card n=1/>",
      ]) {
        expect(lowerWithWarnings(source).warnings).toEqual([]);
      }
    });
  });

  it("does not warn on a camelCase spelling whose lowercase is the DOM name", () => {
    // `onKeyDown`, `onMouseEnter`, `onPointerDown` and the rest of the React
    // surface lowercase to real DOM events (`keydown`, `mouseenter`,
    // `pointerdown`), so they are correct MX and must stay silent — a table
    // that warned on them would fire on correct code.
    const { warnings } = lowerWithWarnings(
      "<div onKeyDown=f onMouseEnter=g onPointerDown=h onFocusIn=i>x</div>\n",
    );
    expect(warnings).toEqual([]);
  });

  it("leaves a bare `onClick` a boolean attribute", () => {
    // Round 1: the event branch used to precede the boolean/static checks, so
    // `<div onClick>` became `event{value: true}` and rendered as
    // `<div onClick="true">` on html — real output drift. The kind is derived
    // only when the value is an expression.
    const ir = lowerSource("<div onClick>x</div>\n");
    expect(find(ir.body, "Element").attrs).toMatchObject([
      { kind: "boolean", name: "onClick" },
    ]);
  });

  it("leaves a string-valued `onClick` a static attribute", () => {
    // An inline handler string is an ordinary HTML attribute on every host, as
    // in Marko. MX does not invent a policy against them; it only stops
    // *creating* one from a function. (Phase B decides the html story.)
    const ir = lowerSource('<button onClick="alert(1)">x</button>\n');
    expect(find(ir.body, "Element").attrs).toMatchObject([
      { kind: "static", name: "onClick", value: "alert(1)" },
    ]);
  });

  it("rejects a bare `on-` with no event name", () => {
    expect(() => lowerSource("<div on-=f>x</div>\n")).toThrow(
      "`on-` needs an event name (`on-<event>`)",
    );
  });

  it("records a nameSpan covering the attribute name", () => {
    const source = "<button onClick=f>x</button>\n";
    const ir = lowerSource(source);
    const attr = find(ir.body, "Element").attrs[0];
    if (attr?.kind !== "event") throw new Error("expected an event attr");
    expect(
      source.slice(attr.nameSpan.sourceStart, attr.nameSpan.sourceEnd),
    ).toBe("onClick");
  });

  it("lowers an attribute method on an element to an event with an arrow value", () => {
    // A host with no runtime rejects the method form outright; this rule is
    // about the shape the *runtime* hosts receive, so the fake allows it as
    // Solid/Preact do.
    const ir = lowerSource(
      "<button onClick() { go() }>x</button>\n",
      fakeDeclarations({ resolveAttributeMethod: () => true }),
    );
    const attr = find(ir.body, "Element").attrs[0];
    expect(attr).toMatchObject({
      kind: "event",
      name: "onClick",
      event: "click",
    });
    if (attr?.kind !== "event") throw new Error("expected an event attr");
    expect(attr.value.code).toContain("go()");
  });
});

/**
 * The `isElement` gate: `on*` is a DOM event only on a native element.
 *
 * Everywhere else it is the callee's own prop contract — a component's
 * `onSelect` is a prop its author declared, exactly as `class` is not renamed
 * on a component call — so it must stay `dynamic`. Each case below is a
 * distinct lowering path, which is why they are not one parameterised test.
 */
describe("`on*` outside a native element stays a prop", () => {
  it("stays dynamic on a component call", () => {
    const ir = lowerSource(
      "<define/Row>x</define>\n<Row onClick=f/>\n",
      fakeDeclarations({ isElement: (name) => name !== "Row" }),
    );
    expect(find(ir.body, "Component").attrs).toMatchObject([
      { kind: "dynamic", name: "onClick" },
    ]);
  });

  it("stays dynamic on a `<define>` call", () => {
    const ir = lowerSource(
      "<define/Card>x</define>\n<Card onClick=f/>\n",
      fakeDeclarations({ isElement: (name) => name !== "Card" }),
    );
    expect(find(ir.body, "Component").attrs).toMatchObject([
      { kind: "dynamic", name: "onClick" },
    ]);
  });

  it("stays dynamic on a host tag", () => {
    // The gap the design note found by reading the call sites: `lowerAttrs`
    // defaults `on` to `"element"`, and a `DelegatedTag` took that default — so a
    // gate keyed on `on` alone would wrongly make `<try onClick=f>` an event.
    const ir = lowerSource(
      "<signal onClick=f>body</signal>\n",
      fakeDeclarations({
        isDelegatedTag: (name) => name === "signal",
        resolveDelegatedTag: (name) => ({ seen: name }),
      }),
    );
    expect(find(ir.body, "DelegatedTag").tag.attrs).toMatchObject([
      { kind: "dynamic", name: "onClick" },
    ]);
  });
});

/**
 * Native `on:*` is reserved (decision 101b); lowercase `oncapture:*` is an
 * ordinary colon name in Marko, not an event or a capture-mode alias.
 */
describe("reserved `on:` and ordinary `oncapture:`", () => {
  it("hands only on: to resolveModifier, with no event lowering or warning", () => {
    const seen: Array<{ name: string; modifier: string }> = [];
    const { ir, warnings } = lowerWithWarnings(
      "<button on:click=f oncapture:focus=g>x</button>\n",
      fakeDeclarations({
        resolveModifier: (attr) => {
          const node = attr as unknown as { name: string; modifier: string };
          seen.push({ name: node.name, modifier: node.modifier });
          return `${node.name}:${node.modifier}`;
        },
      }),
    );
    expect(seen).toEqual([{ name: "on", modifier: "click" }]);
    expect(find(ir.body, "Element").attrs).toMatchObject([
      { kind: "dynamic", name: "on:click" },
      { kind: "dynamic", name: "oncapture:focus" },
    ]);
    expect(warnings).toEqual([]);
  });
});

// `by=` runs once, before the loop, so a read of the tag's own params is an
// error (Marko 6.3.51 `findLoopParamRead`). Driven through `lowerSource`: the
// walk is private to `lowerForHead`.
describe("<for by=> loop-param scope", () => {
  // `§` marks where the error must land; it is stripped before lowering.
  const fails = (marked: string, name: string): void => {
    const column = marked.indexOf("§");
    const source = marked.replace("§", "");
    expect(() => lowerSource(source)).toThrow(
      expect.objectContaining({
        message: expect.stringContaining(`\`${name}\` is not in scope`),
        line: 1,
        column,
      }),
    );
  };
  const ok = (source: string): void => {
    expect(() => lowerSource(source)).not.toThrow();
  };

  it("rejects a direct read, at the name", () => {
    fails("<for|x| of=xs by=§x><p/></for>", "x");
  });

  it("rejects a nested member read, at the root identifier", () => {
    fails("<for|x| of=xs by=§x.a.b><p/></for>", "x");
    fails("<for|x| of=xs by=§x?.a><p/></for>", "x");
    fails("<for|x| of=xs by=o[§x.k]><p/></for>", "x");
  });

  it("rejects a read in a call argument, a conditional and a template", () => {
    fails("<for|x| of=xs by=f(§x)><p/></for>", "x");
    fails("<for|x| of=xs by=c ? §x.a : 1><p/></for>", "x");
    fails("<for|x| of=xs by=`k${§x.a}`><p/></for>", "x");
  });

  it("allows a read inside an arrow body (not evaluated at `by=` time)", () => {
    ok("<for|x| of=xs by=(y) => x.id><p/></for>");
    ok("<for|x| of=xs by=(y) => y.id + x.id><p/></for>");
  });

  it("allows an arrow whose own param shadows the loop param", () => {
    ok("<for|x| of=xs by=(x) => x.id><p/></for>");
    ok("<for|x, i| of=xs by=(x, i) => `${i}${x.id}`><p/></for>");
  });

  it("treats a member property named like the param as a name, not a read", () => {
    ok("<for|x| of=xs by=o.x><p/></for>");
    ok("<for|x| of=xs by=o?.x><p/></for>");
  });

  it("treats an object key as a read only when shorthand or computed", () => {
    ok("<for|x| of=xs by={x: 1}><p/></for>");
    fails("<for|x| of=xs by={§x}><p/></for>", "x");
    fails("<for|x| of=xs by={[§x]: 1}><p/></for>", "x");
  });

  it("allows an outer variable or function that shares no param name", () => {
    ok("<for|x| of=xs by=id><p/></for>");
    ok("<for|x| of=xs by=someFn><p/></for>");
    ok('<for|x| of=xs by="id"><p/></for>');
  });

  it("rejects each name a destructured param binds", () => {
    fails("<for|{ id }| of=xs by=§id><p/></for>", "id");
    fails("<for|{ a: { id } }| of=xs by=§id><p/></for>", "id");
    fails("<for|[a, b]| of=xs by=§b><p/></for>", "b");
    fails("<for|{ id: k }| of=xs by=§k><p/></for>", "k");
    ok("<for|{ id: k }| of=xs by=id><p/></for>");
  });

  it("rejects the second (index) param too", () => {
    fails("<for|x, i| of=xs by=§i><p/></for>", "i");
  });

  it("applies to every loop form", () => {
    fails("<for|i| to=3 by=§i><p/></for>", "i");
    fails("<for|i| until=3 by=§i><p/></for>", "i");
    fails("<for|k, v| in=o by=§v><p/></for>", "v");
  });

  it("lets an inner loop read the outer param, but not its own", () => {
    ok("<for|a| of=as><for|b| of=bs by=a.id><p/></for></for>");
    ok("<for|a| of=as><for|b| of=bs by=(b) => a.id><p/></for></for>");
    fails("<for|a| of=as><for|b| of=bs by=§b.id><p/></for></for>", "b");
  });

  it("lets a nested loop in the body reuse the name", () => {
    ok('<for|x| of=xs by=(x) => x.id><for|x| of=x.ys by="id"><p/></for></for>');
  });
});

/**
 * Decision 135: a repeated attribute name on one tag resolves to its LAST
 * occurrence, in core, so the IR carries one attribute per resolved name and no
 * host or delegated-tag consumer ever sees a duplicate. The earlier ones get a
 * decision-133 warning each. Marko 6.3.51 is the reference: `class="a" id="x"
 * class="b"` compiles to `<div id=x class=b>` (the survivor keeps its own
 * position), the dropped value is never evaluated, and `class`/`style` do not
 * merge.
 */
describe("duplicate attributes resolve last-wins (decision 135)", () => {
  const panel = fakeDeclarations({
    name: "TestHost",
    attrTags: 2,
    isComponent: (name) => name === "Panel",
  });

  it("keeps only the last occurrence, at its own position, with its own spans", () => {
    const source = '<div class="a" id="x" class="b">hi</div>\n';
    const { ir, warnings } = lowerWithWarnings(source);
    const { attrs } = find(ir.body, "Element");
    expect(attrs).toMatchObject([
      { kind: "static", name: "id", value: "x" },
      { kind: "static", name: "class", value: "b" },
    ]);
    const survivor = attrs[1];
    if (survivor?.kind !== "static") throw new Error("expected a static attr");
    expect(survivor.nameSpan.sourceStart).toBe(source.indexOf("class", 20));
    expect(warnings).toEqual([
      {
        message:
          "duplicate attribute `class`: the later one at 1:23 wins, so this one is dropped",
        line: 1,
        column: 5,
        file: "test.mx",
      },
    ]);
  });

  it("warns once per dropped occurrence, each naming the survivor", () => {
    const { ir, warnings } = lowerWithWarnings(
      '<div a="1" a="2" a="3">x</div>\n',
    );
    expect(find(ir.body, "Element").attrs).toMatchObject([
      { name: "a", value: "3" },
    ]);
    expect(warnings.map((w) => [w.message, w.column])).toEqual([
      [
        "duplicate attribute `a`: the later one at 1:18 wins, so this one is dropped",
        5,
      ],
      [
        "duplicate attribute `a`: the later one at 1:18 wins, so this one is dropped",
        11,
      ],
    ]);
  });

  it("does not merge or evaluate a dropped dynamic value", () => {
    const { ir } = lowerWithWarnings("<div title=f() title=g()>x</div>\n");
    expect(find(ir.body, "Element").attrs).toMatchObject([
      { kind: "dynamic", name: "title", value: { code: "g()" } },
    ]);
  });

  it("drops an earlier attribute across a spread, and keeps a lone one before it", () => {
    // Marko: `a=1 ...x a=2` -> `a=2` wins over `x.a`; `a=1 ...x` is no duplicate.
    const dup = lowerWithWarnings("<div a=1 ...x a=2>x</div>\n");
    expect(find(dup.ir.body, "Element").attrs).toMatchObject([
      { kind: "spread" },
      { kind: "dynamic", name: "a", value: { code: "2" } },
    ]);
    expect(dup.warnings).toHaveLength(1);
    const lone = lowerWithWarnings("<div a=1 ...x>x</div>\n");
    expect(find(lone.ir.body, "Element").attrs).toMatchObject([
      { name: "a" },
      { kind: "spread" },
    ]);
    expect(lone.warnings).toEqual([]);
    const two = lowerWithWarnings("<div ...x a=1 ...y a=2>x</div>\n");
    expect(find(two.ir.body, "Element").attrs).toMatchObject([
      { kind: "spread" },
      { kind: "spread" },
      { name: "a", value: { code: "2" } },
    ]);
  });

  it("resolves names case-sensitively: `class` and `Class` are distinct", () => {
    const { ir, warnings } = lowerWithWarnings('<div class="a" Class="b"/>\n');
    expect(
      find(ir.body, "Element").attrs.map((a) => a.kind !== "spread" && a.name),
    ).toEqual(["class", "Class"]);
    expect(warnings).toEqual([]);
  });

  it("resolves a handler written twice to the last; `onClick` and `on-click` are distinct", () => {
    const twice = lowerWithWarnings(
      "<button on-click=f on-click=g>x</button>\n",
    );
    expect(find(twice.ir.body, "Element").attrs).toMatchObject([
      { kind: "event", name: "on-click", value: { code: "g" } },
    ]);
    expect(twice.warnings).toHaveLength(1);
    // Marko registers both handlers here, so both survive.
    const mixed = lowerWithWarnings(
      "<button on-click=f onClick=g>x</button>\n",
    );
    expect(find(mixed.ir.body, "Element").attrs).toMatchObject([
      { name: "on-click" },
      { name: "onClick" },
    ]);
    expect(mixed.warnings).toEqual([]);
  });

  it("resolves a default attribute to `value`, so a later `value` wins", () => {
    // Marko: `<input="a" value="b">` -> `<input value=b>`.
    const { ir, warnings } = lowerWithWarnings('<input="a" value="b"/>\n');
    expect(find(ir.body, "Element").attrs).toMatchObject([
      { kind: "static", name: "value", value: "b" },
    ]);
    expect(warnings).toHaveLength(1);
  });

  it("hands a component call and an attribute tag one attribute per name", () => {
    // Marko: `<Card a=1 a=2/>` receives `{a: 2}`; `<@x a=1 a=2>` -> `{a: 2}`.
    const { ir, warnings } = lowerWithWarnings(
      'import Panel from "./panel.marko"\n<Panel a=1 a=2><@x b=1 b=2/></Panel>\n',
      panel,
    );
    const component = find(ir.body, "Component");
    expect(component.attrs).toMatchObject([
      { name: "a", value: { code: "2" } },
    ]);
    expect(component.attributeTags[0]?.attrs).toMatchObject([
      { name: "b", value: { code: "2" } },
    ]);
    expect(
      warnings.filter((w) => w.message.startsWith("duplicate attribute")),
    ).toHaveLength(2);
  });
});

/**
 * Marko 6.3.51 gives two spellings to `<for>` its own errors, and MX was
 * silent on both (`runtime-tags/src/translator/core/for.ts`):
 *
 * - a **string** `by=` is the property-name shorthand, and only `of` has one:
 *   `in`/`to`/`until` call `by` as a function, so Marko refuses the string at
 *   compile time ("only supports a string `by` key with `of`") instead of
 *   letting it die at render;
 * - `key=` is the React/Vue habit and is redirected to `by=` ("keys items with
 *   the `by=` attribute, not `key=`"), before the allowed-attribute check.
 *
 * Both are reported where Marko reports them: the string `by` at its **value**
 * (the quoted key it refuses), `key=` at the attribute. `by="id"` on `of` is
 * the one form that stays legal, so the check cannot be "reject a string `by`".
 */
describe("<for> by=/key= (Marko parity)", () => {
  // `§` marks where the error must land; it is stripped before lowering.
  const fails = (marked: string, message: string): void => {
    const column = marked.indexOf("§");
    const source = marked.replace("§", "");
    expect(() => lowerSource(source)).toThrow(
      expect.objectContaining({
        message: expect.stringContaining(message),
        line: 1,
        column,
      }),
    );
  };

  it("refuses a string `by=` on `in`, at the quoted key", () => {
    fails(
      '<for|k, v| in=o by=§"id"><p/></for>',
      "only supports a string `by` key with `of`; use a `by=(key, value) => ...` function for `<for in>`",
    );
  });

  it("refuses a string `by=` on `to` and `until`, naming the index form", () => {
    fails(
      '<for|i| to=3 by=§"id"><p/></for>',
      "only supports a string `by` key with `of`; use a `by=(index) => ...` function for `<for to>`",
    );
    fails(
      '<for|i| until=3 by=§"id"><p/></for>',
      "only supports a string `by` key with `of`; use a `by=(index) => ...` function for `<for until>`",
    );
  });

  it("redirects `key=` to `by=`, at the attribute, for every loop form", () => {
    fails(
      '<for|x| of=xs §key="id"><p/></for>',
      'keys items with the `by=` attribute, not `key=`. Use `by="propName"` or `by=(item, index) => key`',
    );
    fails(
      '<for|k, v| in=o §key="id"><p/></for>',
      "keys items with the `by=` attribute, not `key=`. Use `by=(key, value) => key`",
    );
    fails(
      '<for|i| to=3 §key="id"><p/></for>',
      "keys items with the `by=` attribute, not `key=`. Use `by=(num) => key`",
    );
    fails(
      '<for|i| from=1 until=9 §key="id"><p/></for>',
      "keys items with the `by=` attribute, not `key=`. Use `by=(num) => key`",
    );
  });

  it("refuses `key=` however it is spelled", () => {
    for (const source of [
      "<for|x| of=xs §key>x</for>",
      "<for|x| of=xs §key=id>x</for>",
      "<for|x| of=xs §key=(x) => x.id>x</for>",
    ]) {
      fails(source, "keys items with the `by=` attribute, not `key=`");
    }
  });

  it("reports `key=` before the string-`by` check, as Marko does", () => {
    // Marko redirects `key=` first (it is the React habit), so a tag carrying
    // both is told about `key=`, not about the string.
    fails(
      '<for|k, v| in=o §key="id" by="id"><p/></for>',
      "keys items with the `by=` attribute, not `key=`",
    );
  });

  it("keeps the string shorthand on `of`, and a function `by=` elsewhere", () => {
    expect(() => lowerSource('<for|x| of=xs by="id"><p/></for>')).not.toThrow();
    expect(() =>
      lowerSource("<for|k, v| in=o by=(k) => k><p/></for>"),
    ).not.toThrow();
    expect(() =>
      lowerSource("<for|i| to=3 by=(i) => i><p/></for>"),
    ).not.toThrow();
    expect(() =>
      lowerSource("<for|i| until=3 by=(i) => i><p/></for>"),
    ).not.toThrow();
  });
});

/**
 * Marko's parser (`babel-plugin/parser.js`, `onAttrName`) splits an attribute
 * name at its **last** `:`; an empty head is not an error but the `value`
 * attribute, so `<div :foo="y"/>` is `value` with modifier `foo` and compiles
 * to `<div value:foo=y>` (`<div :foo/>` to `<div value:foo>`). The native
 * taglib reserves only `class:`, `style:` and `on:` prefixes; every other
 * colon name is ordinary, including `x:foo`, `data:x` and empty suffixes.
 *
 * Both spellings are the same attribute in Marko (`<div value:foo="y"/>`
 * compiles identically), and `attr.default` is the flag its parser sets for
 * the `:foo` spelling, so neither can keep going to the modifier hooks.
 *
 * Decision 146 changed the bare spelling: `:foo` is now `name="foo"` sugar
 * (`name-sugar.test.ts`), so these rows write the explicit `value:foo`, which
 * is still Marko's attribute.
 */
describe("`:modifier` is Marko's `value:modifier` attribute, not a modifier", () => {
  it("lowers the shorthand to an ordinary attribute named `value:foo`", () => {
    const ir = lowerSource('<div value:foo=y id="z"/>\n');
    expect(find(ir.body, "Element").attrs).toMatchObject([
      { kind: "dynamic", name: "value:foo", value: { code: "y" } },
      { kind: "static", name: "id", value: "z" },
    ]);
  });

  it("keeps the value kind each other attribute gets", () => {
    expect(
      find(lowerSource('<div value:foo="lit"/>').body, "Element").attrs,
    ).toMatchObject([{ kind: "static", name: "value:foo", value: "lit" }]);
    // `<div value:foo/>` is HTML's valueless attribute — present with an empty
    // value — which is what Marko emits (`<div value:foo>`). It is NOT the
    // `boolean` kind: a host handed `true` renders React's non-boolean
    // warning and drops the attribute, Hono writes `value:foo="true"`.
    expect(
      find(lowerSource("<div value:foo/>").body, "Element").attrs,
    ).toMatchObject([{ kind: "static", name: "value:foo", value: "" }]);
    // Every other valueless attribute stays `boolean` — only this one means
    // an empty value, because only this one is not a flag-shaped name.
    expect(find(lowerSource("<div foo/>").body, "Element").attrs).toMatchObject(
      [{ kind: "boolean", name: "foo" }],
    );
  });

  it("gives the valueless modifier a zero-width valueSpan at the end of its name", () => {
    // A consumer that slices `valueSpan` (the data tree) needs a span, even
    // for an empty value; the Mesh bug was an invariant failure on its absence.
    expect(
      find(lowerSource("<div value:foo/>").body, "Element").attrs,
    ).toMatchObject([
      { kind: "static", valueSpan: { sourceStart: 14, sourceEnd: 14 } },
    ]);
    expect(find(lowerSource("<div x:/>").body, "Element").attrs).toMatchObject([
      { kind: "static", valueSpan: { sourceStart: 7, sourceEnd: 7 } },
    ]);
  });

  it.each([
    ["<div value:/>", "value:", 5, 11],
    ["<div x:/>", "x:", 5, 7],
    ['<div x: = "s"/>', "x:", 5, 7],
    ['<div value:foo:bar="y"/>', "value:foo:bar", 5, 18],
    ["<div value:foo:bar/>", "value:foo:bar", 5, 18],
    ['<div value:foo="y"/>', "value:foo", 5, 14],
  ])(
    "preserves Marko's full colon name and authored span: %s",
    (source, name, start, end) => {
      expect(find(lowerSource(source).body, "Element").attrs).toMatchObject([
        {
          kind: "static",
          name,
          nameSpan: { sourceStart: start, sourceEnd: end },
        },
      ]);
    },
  );

  it.each([
    ['<div :="x"/>', 1, 7],
    ['<div\n  :="x"/>', 2, 4],
    ['<div :foo:="x"/>', 1, 11],
    ["<div value:=f()/>", 1, 12],
    ["<div value:=42/>", 1, 12],
  ])("rejects an invalid binding at its value: %s", (source, line, column) => {
    expect(() => lowerSource(source)).toThrow(
      expect.objectContaining({
        message:
          "Attributes may only be bound to identifiers or member expressions",
        line,
        column,
      }),
    );
  });

  it.each([
    ['<${t} value:="x"/>', 1, 13],
    ['<for|i| of=o value:="x">y</for>', 1, 20],
    ['<for|k| in=o value:="x">y</for>', 1, 20],
    ['<for|i| to=3 value:="x">y</for>', 1, 20],
    ['<if=c value:="x">y</if>', 1, 13],
    ['<if=c>y</if><else value:="x">n</else>', 1, 25],
    ['<if=c>y</if><else if=d value:="x">n</else>', 1, 30],
    ['<if=c>y</if><else-if=d value:="x">n</else-if>', 1, 30],
    ['<define/Row value:="x">y</define>', 1, 19],
    ['<define/Row|value|>${value}</define><Row value:="x"/>', 1, 48],
    ['<const/c=1 value:="x"/>', 1, 18],
    ['<return value:="x"/>', 1, 15],
    ['<try value:="x">y</try>', 1, 12],
    ['import Child from "./child.marko"\n<Child value:="x"/>', 2, 14],
    ['<${t}\n  value:="x"/>', 2, 9],
    ['<${t}><for|i| of=o value:="x"><@item/></for></>', 1, 26],
    ['<${t}><if=c value:="x"><@item/></if></>', 1, 19],
    ['<${t}><if=c><@item/></if><else value:="x"><@item/></else></>', 1, 38],
    ['<${t}><@item value:="x"/></>', 1, 20],
    ['<${t}><@item><@nested value:="x"/></@item></>', 1, 29],
  ])(
    "rejects a non-contract binding before it can be discarded: %s",
    (source, line, column) => {
      expect(() =>
        lowerSource(source, fakeDeclarations({ attrTags: 2 })),
      ).toThrow(
        expect.objectContaining({
          message:
            "Attributes may only be bound to identifiers or member expressions",
          line,
          column,
        }),
      );
    },
  );

  it("exempts only the registered contract, not an import shadowing its name", () => {
    const customTags: Record<string, CustomTag> = {
      Card: { attributes: { value: { type: "string" } }, transform: () => [] },
    };
    expect(() =>
      lowerSource(
        '<Card value:="x"/>',
        fakeDeclarations(),
        undefined,
        undefined,
        customTags,
      ),
    ).not.toThrow();
    expect(() =>
      lowerSource(
        'import Card from "./card.marko"\n<Card value:="x"/>',
        fakeDeclarations(),
        undefined,
        undefined,
        customTags,
      ),
    ).toThrow(
      expect.objectContaining({
        message:
          "Attributes may only be bound to identifiers or member expressions",
        line: 2,
        column: 13,
      }),
    );
  });

  it.each([
    "x:foo",
    "data:x",
    "prop:x",
    "attr:x",
    "bool:x",
    "use:x",
    "oncapture:click",
    "x:foo:bar",
    "classy:foo",
    "stylex:on",
  ])(
    "preserves every ordinary colon name without invoking a modifier hook: %s",
    (name) => {
      for (const [suffix, expected] of [
        ["", { kind: "static", value: "" }],
        ['="y"', { kind: "static", value: "y" }],
        ["=input.x", { kind: "dynamic", value: { code: "input.x" } }],
      ] as const) {
        const ir = lowerSource(
          `<div ${name}${suffix}/>`,
          fakeDeclarations({
            resolveModifier: () => {
              throw new Error("ordinary name reached modifier hook");
            },
          }),
        );
        expect(find(ir.body, "Element").attrs).toMatchObject([
          {
            ...expected,
            name,
            nameSpan: { sourceStart: 5, sourceEnd: 5 + name.length },
          },
        ]);
      }
    },
  );

  it.each(["class:foo:bar", "style:foo:bar", "on:foo:bar"])(
    "keeps the complete reserved native prefix on the modifier path: %s",
    (name) => {
      expect(() => lowerSource(`<div ${name}="y"/>`)).toThrow(
        "attribute modifier",
      );
    },
  );

  it.each([
    "x:foo",
    "class:active",
    "style:color",
    "on:click",
    "class:foo:bar",
  ])("preserves nonempty-suffix component props and methods: %s", (name) => {
    for (const authored of [`${name}="y"`, `${name}() {}`]) {
      const ir = lowerSource(
        `import Card from "./card.marko"\n<Card ${authored}/>`,
        fakeDeclarations({ resolveAttributeMethod: () => true }),
      );
      expect(find(ir.body, "Component").attrs).toMatchObject([{ name }]);
    }
  });

  it.each([
    ["<div x:() {}/>", "x:", 1, 5],
    ["<div value:foo() {}/>", "value:foo", 1, 5],
    ["<div x:foo() {}/>", "x:foo", 1, 5],
    ["<div\n  x:foo() {}\n/>", "x:foo", 2, 2],
    ["<div x:foo=(function(){})/>", "x:foo", 1, 5],
    ["<div x:foo=(() => {})/>", "x:foo", 1, 5],
    ["<div x:foo=function fn() {}/>", "x:foo", 1, 5],
    ["<div x:foo()=(() => {})/>", "x:foo", 1, 5],
    ["<div\n  x:foo=(function(){})\n/>", "x:foo", 2, 2],
  ])(
    "rejects an ordinary colon-name function with Marko's exact text and position: %s",
    (source, name, line, column) => {
      expect(() =>
        lowerSource(
          source,
          fakeDeclarations({ resolveAttributeMethod: () => true }),
        ),
      ).toThrow(
        expect.objectContaining({
          message: `The \`${name}\` attribute cannot be a function.`,
          line,
          column,
        }),
      );
    },
  );

  it("preserves an empty modifier's dynamic value and does not rewrite a spread", () => {
    expect(
      find(lowerSource('<div x: = input.x ...{"x:": "s"}/>').body, "Element")
        .attrs,
    ).toMatchObject([
      { kind: "dynamic", name: "x:", value: { code: "input.x" } },
      { kind: "spread" },
    ]);
  });

  it.each(["x", "class", "style", "on"])(
    "preserves empty-suffix %s: as a component prop, including methods",
    (name) => {
      for (const authored of [`${name}: = input.x`, `${name}:() {}`]) {
        const ir = lowerSource(
          `import Card from "./card.marko"\n<Card ${authored}/>`,
          fakeDeclarations({ resolveAttributeMethod: () => true }),
        );
        expect(find(ir.body, "Component").attrs).toMatchObject([
          { kind: "dynamic", name: `${name}:` },
        ]);
      }
    },
  );

  it.each(["class", "style"])("keeps %s: on the modifier hook", (name) => {
    expect(() => lowerSource(`<div ${name}:/>`)).toThrow(
      `attribute modifier \`${name}:\``,
    );
  });

  it("rejects reserved on: with Marko's positioned error", () => {
    expect(() => lowerSource("<div on:/>")).toThrow(
      expect.objectContaining({
        message: "`on:` is not a valid attribute, did you mean `on`?",
        line: 1,
        column: 5,
      }),
    );
  });

  it("keeps an empty suffix on an event, including a handler method", () => {
    for (const source of ["<div onClick: = fn/>", "<div onClick:() {} />"]) {
      expect(
        find(
          lowerSource(
            source,
            fakeDeclarations({ resolveAttributeMethod: () => true }),
          ).body,
          "Element",
        ).attrs,
      ).toMatchObject([{ kind: "event", name: "onClick:", event: "click:" }]);
    }
  });

  it.each(["x", "input.x", "input?.x", "input[key]"])(
    "keeps a valid binding target: %s",
    (value) => {
      expect(
        find(lowerSource(`<div value:=${value}/>`).body, "Element").attrs,
      ).toMatchObject([
        { kind: "bound", name: "value", value: { code: value } },
      ]);
    },
  );

  it.each([
    ['<div value:foo()="y"/>', "value:foo", 1, 5],
    ['<div\n  value:foo()="y"/>', "value:foo", 2, 2],
    ['<div value:foo:bar()="y"/>', "value:foo:bar", 1, 5],
    ['<div x:foo()="y"/>', "x:foo", 1, 5],
    ['<div x:()="y"/>', "x:", 1, 5],
    ['<div\n  x:foo()="y"\n/>', "x:foo", 2, 2],
  ])(
    "names the full attribute in Marko's method error: %s",
    (source, name, line, column) => {
      expect(() =>
        lowerSource(
          source,
          fakeDeclarations({ resolveAttributeMethod: () => true }),
        ),
      ).toThrow(
        expect.objectContaining({
          message: `Unsupported arguments on the \`${name}\` attribute.`,
          line,
          column,
        }),
      );
    },
  );

  it("accepts the explicit `value:foo` spelling with the same meaning", () => {
    expect(
      find(lowerSource('<div value:foo="lit"/>').body, "Element").attrs,
    ).toMatchObject([{ kind: "static", name: "value:foo", value: "lit" }]);
  });

  it("carries a component call's `:foo` as the prop `value:foo`", () => {
    const ir = lowerSource(
      'import Card from "./card.marko"\n<Card value:foo=y/>\n',
      fakeDeclarations({ isElement: (name) => name !== "Card" }),
    );
    expect(find(ir.body, "Component").attrs).toMatchObject([
      { name: "value:foo", value: { code: "y" } },
    ]);
  });

  it("keeps the position of the name it was authored at", () => {
    const attr = find(lowerSource("<div value:foo=y/>\n").body, "Element")
      .attrs[0];
    expect(attr?.kind).toBe("dynamic");
    expect(attr?.kind === "dynamic" ? attr.nameSpan : null).toMatchObject({
      // `value:foo` — the name as authored — starts at column 5.
      sourceStart: 5,
      sourceEnd: 14,
    });
  });

  it("hands a reserved native modifier to the host's hook, untouched", () => {
    const seen: Array<{ name: string; modifier: string }> = [];
    // The core's own rejection follows the hook (the hook only rewords it), so
    // the throw is expected — what matters is that `class:active` still
    // arrives as a modifier, with `value`/`foo` never invented.
    expect(() =>
      lowerSource(
        "<div class:active=c/>\n",
        fakeDeclarations({
          resolveModifier: (attr) => {
            const node = attr as unknown as { name: string; modifier: string };
            seen.push({ name: node.name, modifier: node.modifier });
            return undefined;
          },
          rejectModifier: () => {},
        }),
      ),
    ).toThrow("attribute modifier `class:active`");
    expect(seen).toEqual([{ name: "class", modifier: "active" }]);
  });

  it("never sends an ordinary colon name to a host's modifier hook", () => {
    const seen: Array<{ name: string; modifier: string }> = [];
    expect(() =>
      lowerSource(
        "<div value:foo=y/>\n",
        fakeDeclarations({
          acceptsForeignAttrNames: true,
          rejectModifier: () => {},
          resolveModifier: (attr) => {
            const node = attr as unknown as { name: string; modifier: string };
            seen.push({ name: node.name, modifier: node.modifier });
            return "value:foo";
          },
        }),
      ),
    ).not.toThrow();
    expect(seen).toEqual([]);
  });
});

/**
 * `<button (click)="go()">` parses as tag arguments `(click)` plus a default
 * attribute value, and Marko reports "Tag does not support arguments." at the
 * **argument** (`assertNoArgs`: `args[0].loc.start`, 0-based column 9 for
 * `<button (click)=…`) — not at the tag. MX reported at the tag's own start
 * (1:0), which points at `<button` for an error about `(click)`.
 */
describe("tag arguments are reported at the argument", () => {
  const fails = (marked: string): void => {
    const column = marked.indexOf("§");
    const source = marked.replace("§", "");
    expect(() => lowerSource(source)).toThrow(
      expect.objectContaining({
        message: expect.stringContaining("tag arguments `(...)`"),
        line: 1,
        column,
      }),
    );
  };

  it("points at the argument, not the tag", () => {
    fails('<div (§click)="f()"/>');
    fails('<button (§click)="go()">x</button>');
    fails('<button (§keyup)="save()">x</button>');
  });

  it("points at the first argument of several", () => {
    fails("<button (§a, b)>x</button>");
  });

  it("points at a non-identifier argument too", () => {
    fails("<button (§a.b)>x</button>");
    fails("<button (§1)>x</button>");
  });
});
