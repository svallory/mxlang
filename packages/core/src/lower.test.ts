import type { MxChild } from "@mxlang/babel/mx-ast";
import { describe, expect, expectTypeOf, it } from "vitest";
import { strippedMethodTypeParams } from "./attr-fields.ts";
import {
  type AttrTagDecl,
  type CalleeInput,
  readCalleeInput,
  readOwnInput,
} from "./callee-input.ts";
import { compileSource } from "./compile.ts";
import type { Ctx, MxWarning, Node } from "./core.ts";
import {
  assertPositioned,
  DYNAMIC_TAG,
  expr,
  fail,
  firstAttributeTag,
  newCtx,
  positionError,
  rejectUnsupportedFields,
  TranslateError,
} from "./core.ts";
import { STATEMENT_TAGLIB, STATEMENT_TAGLIB_ID } from "./core-taglib.ts";
import { type CustomTag, customTagTaglib } from "./custom-tags.ts";
import type { Policy } from "./declarations.ts";
import type { AttributeTag, Ir, IrNode } from "./ir.ts";
import {
  exprOf,
  exprSpan,
  lower,
  lowerChildren,
  paramSpansOf,
} from "./lower.ts";
import { lookup } from "./test-targets.ts";

/**
 * The lowerer (decision 79): one fixture per IR kind, plus the error cases.
 *
 * These are the tests that keep the IR honest. `compileSource`'s own emitted
 * output is asserted elsewhere (`@mxlang/target-html`'s suite and both
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
  reshape?: (body: Node[], ctx: Ctx) => void,
): Ir {
  let ir: Ir | null = null;
  let thrown: unknown = null;

  // This helper needs `lower` over the compiler's real parsed body.
  // `newCtx` plus the compiler's parse is the seam: a
  // translator whose Program visitor lowers instead of emitting.
  const translator = {
    taglibs: [
      [STATEMENT_TAGLIB_ID, STATEMENT_TAGLIB],
      ...(customTags ? [customTagTaglib(customTags)] : []),
    ].filter((entry): entry is [string, unknown] => entry !== null),
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
          reshape?.(path.node.body, ctx);
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
    taglibs: [[STATEMENT_TAGLIB_ID, STATEMENT_TAGLIB]] as Array<
      [string, unknown]
    >,
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
    const ir = lowerSource("-- ${input.a}\n");
    expect(find(ir.body, "Interpolation")).toMatchObject({
      escaped: true,
      expr: { code: "input.a" },
    });
  });

  it("Interpolation records escaped and raw placeholders apart", () => {
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
      'import Panel from "./panel.mx"\nstatic const G = 1\n<p>x</p>\n',
    );
    expect(ir.imports).toMatchObject([
      {
        kind: "Import",
        code: 'import Panel from "./panel.mx"',
        loc: { line: 1, column: 0 },
        end: { line: 1, column: 30 },
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
      'import Panel from "./panel.mx"\n<Panel title="t">body</Panel>\n',
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

  it("decision 116: a .mx default import still routes to a name Component target", () => {
    const ir = lowerSource(
      'import Panel from "./panel.mx"\n<Panel/>\n',
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
        'import Panel from "./panel.mx"',
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
      'import Panel from "./panel.mx"\n<Panel("a")>\n  <@header>H</@header>\n</Panel>\n',
    ],
    ["a body", 'import Panel from "./panel.mx"\n<Panel("a")>body</Panel>\n'],
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
        'import Layout from "./layout.mx"',
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

    it("positions nested attribute-tag error at the first nested tag", () => {
      let error: unknown;
      try {
        lowerSource(
          "<Panel><@item><@icon/></@item></Panel>",
          fakeDeclarations({
            name: "@mxlang/legacy",
            isComponent: (name) => name === "Panel",
          }),
        );
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(TranslateError);
      const err = error as TranslateError;
      expect(err.message).toContain("nested attribute tags");
      expect(err.line).toBe(1);
      expect(err.column).toBe(14); // <@icon> at column 14 (0-indexed)
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
        lowerSource("<${input.head}/>", v2(), undefined, input),
      ).toThrowError(
        "`input.head` is a data attribute tag; render its body with `<${input.head.content}/>`",
      );
    });

    it("rejects a declared parameterized tag used without arguments", () => {
      const input = declaredInput({
        data: attrTagDecl({ as: "data", hasParams: true }),
        renderable: attrTagDecl({ as: "renderable", hasParams: true }),
      });
      expect(() =>
        lowerSource("<${input.data.content}/>", v2(), undefined, input),
      ).toThrowError(
        "`input.data.content` is a parameterized attribute tag; pass its arguments with `<${input.data.content(/* arguments */)}/>`",
      );
      expect(() =>
        lowerSource("<${input.renderable}/>", v2(), undefined, input),
      ).toThrowError(
        "`input.renderable` is a parameterized attribute tag; pass its arguments with `<${input.renderable(/* arguments */)}/>`",
      );
      expect(() =>
        lowerSource(
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
      // A decorator in a `static` is Marko's own syntax error since #395 r2, so the
      // old "decorated static parse failure" row can no longer reach this derivation.
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
    ["attribute tags", '<${input.fn}("A")><@x>X</@x></>'],
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

  it.each([
    ["&title", "<div>\n  <&title/>\n</div>\n", 3],
    ["a!b", "<div><a!b/></div>\n", 6],
    ["a@b", "<div><a@b/></div>\n", 6],
  ])(
    "rejects the tag name `%s` outside Marko's name charset",
    (name, source, column) => {
      let caught: { message: string; line?: number; column?: number } | null =
        null;
      try {
        lowerSource(source);
      } catch (error) {
        caught = error as { message: string; line?: number; column?: number };
      }
      expect(caught?.message).toContain(
        `Invalid tag name \`${name}\` — a tag name may use letters (any script), digits and \`-._:$\``,
      );
      expect(caught?.column).toBe(column);
    },
  );

  it.each(["a-b", "a.b", "a:b", "a_b", "a$b", "h1", "é", "日本", "ünï-tag"])(
    "keeps the tag name `%s` inside the charset",
    (name) => {
      expect(() =>
        lowerSource(`<div><${name}/></div>\n`, fakeDeclarations()),
      ).not.toThrow(/Invalid tag name/);
    },
  );

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
        "  <p>${count}</p>",
        "</if>",
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
        "  <p>${count}</p>",
        "</for>",
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
     * No shipping host calls `ctx.bindings.register` today — `@mxlang/host-preact`'s
     * `<let>` and `@mxlang/host-solid`'s equivalent are both hard compile errors
     * (`packages/hosts/preact/src/emitter.ts`, `packages/hosts/solid/README.md`)
     * — so this path is presently exercised only here, through the
     * `fakeDeclarations`-built `signalPolicy` fixture below, not by any real
     * host's own tests.
     */
    it("keeps a generic call's type arguments when rewriting a registered identifier", () => {
      const ir = lowerSource(
        ["<signal/count=1/>", "<p>${pick<string>(count)}</p>", ""].join("\n"),
        signalPolicy,
      );

      expect(trailingInterpolation(ir.body).expr.code).toBe(
        "pick<string>(count())",
      );
    });

    /** The identifier being rewritten is itself the one carrying type arguments as a callee. */
    it("keeps type arguments when the registered identifier is not itself rewritten", () => {
      const ir = lowerSource(
        ["<signal/count=1/>", "<p>${pick<string>(other)}</p>", ""].join("\n"),
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
      ["<dyn>", "  <signal/inner=1/>", "  <p>${inner}</p>", "</dyn>", ""].join(
        "\n",
      ),
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
    ["arguments", "<return('a') value=1/>\n", /Tag does not support arguments/],
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

  it("a bare `${expr}` tag (concise mode's dynamic-tag shape)", () => {
    // A top-level `${expr}` with no attributes and no body parses as a
    // `MarkoTag` whose `name` is the expression — concise mode's only shape
    // for it — and lowers to a dynamic-target `Component` through the same
    // `exprOf` call a tagged dynamic tag name would use.
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
          "`onDoubleClick` is not a DOM event; did you mean `onDblClick`",
        line: 1,
        column: 8,
        file: "test.mx",
      },
    ]);
  });

  describe("a <define> with several params called without arguments", () => {
    const def = "<define/Card|title, head|><div>${title}</div></define>\n";
    const flagged = () => fakeDeclarations({ defineCallPassesAttrs: true });
    const message =
      "`<Card>` has 2 params, but only the first parameter receives the attributes object; destructure it (`|{ a, b }|`) instead of reading one param per attribute";

    it.each([
      ["an attribute", '<Card title="a"/>'],
      ["a body", "<Card>text</Card>"],
      ["an attribute tag", "<Card><@head>H</@head></Card>"],
    ])("warns at the tag name for %s", (_name, call) => {
      const { warnings } = lowerWithWarnings(def + call, flagged());
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
        // The warning's own recommended fix is one param, so it stays silent.
        '<define/Card|{ title, head }|><div>${title}</div></define>\n<Card title="a"/>',
      ]) {
        expect(lowerWithWarnings(source, flagged()).warnings).toEqual([]);
      }
    });

    it("stays silent on a host that does not set defineCallPassesAttrs (Solid, Angular)", () => {
      for (const call of [
        '<Card title="a"/>',
        "<Card>text</Card>",
        "<Card><@head>H</@head></Card>",
      ]) {
        expect(lowerWithWarnings(def + call).warnings).toEqual([]);
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
      'import Panel from "./panel.mx"\n<Panel a=1 a=2><@x b=1 b=2/></Panel>\n',
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

  const REFINEMENT_ERROR =
    "Bound attribute refinement shorthand must be a valid JavaScript identifier.";

  it.each([
    ["<div x::=q/>", 1, 7],
    ["<div v:no-update:=q/>", 1, 7],
    ["<div v:class:=q/>", 1, 7],
    ["<div v:1a:=q/>", 1, 7],
    ["<div v:a.b:=q/>", 1, 7],
    ["<div v:await:=q/>", 1, 7],
    ["<div v:let:=q/>", 1, 7],
    ["<div a=1\n  v:no-update:=q/>", 2, 4],
    ["<Foo a=1 v:no-update:=q/>", 1, 11],
    ["<${t} v:no-update:=q/>", 1, 8],
    ["<if=c v:no-update:=q>x</if>", 1, 8],
    ["<for|i| of=o v:no-update:=q>x</for>", 1, 15],
  ])(
    "rejects a refinement that is no identifier, at the modifier, with Marko's text: %s",
    (source, line, column) => {
      expect(() =>
        lowerSource(source, fakeDeclarations({ isElement: () => false })),
      ).toThrow(
        expect.objectContaining({ message: REFINEMENT_ERROR, line, column }),
      );
    },
  );

  // A call to a custom tag registered with a contract skips the generic
  // binding validation, and its attribute tags have a contract too; the
  // refinement check still runs on both.
  const card: Record<string, CustomTag> = {
    card: {
      attributes: { v: { type: "string" } },
      attributeTags: { row: { attributes: { v: { type: "string" } } } },
      transform: () => [],
    },
  };
  it.each([
    ["<card v:no-update:=q/>", 1, 8],
    ["<card><@row v:no-update:=q/></card>", 1, 14],
    ["<card>\n  <@row a=1 v:no-update:=q/>\n</card>", 2, 14],
  ])(
    "rejects a refinement that is no identifier on a contracted tag: %s",
    (source, line, column) => {
      expect(() =>
        lowerSource(source, fakeDeclarations(), undefined, undefined, card),
      ).toThrow(
        expect.objectContaining({ message: REFINEMENT_ERROR, line, column }),
      );
    },
  );

  it.each([
    ["<div v:fn:=q/>", "v", "fn", 7],
    ["<div v:a:b:=q/>", "v:a", "b", 9],
    ["<div is:raw:=x/>", "is", "raw", 8],
    ["<div v:$a:=q/>", "v", "$a", 7],
    ["<div v:ünï:=q/>", "v", "ünï", 7],
  ])(
    "lowers %s to a bound attribute carrying its refinement",
    (source, name, modifier, at) => {
      const attr = find(
        lowerSource(source, fakeDeclarations({ isElement: () => true })).body,
        "Element",
      ).attrs[0];
      if (attr?.kind !== "bound") throw new Error("expected a bound attr");
      expect(attr.name).toBe(name);
      expect(attr.refinement).toMatchObject({
        code: modifier,
        shape: "other",
        node: null,
        span: { sourceStart: at, sourceEnd: at + modifier.length },
      });
      expect(
        source.slice(
          attr.refinement?.span?.sourceStart,
          attr.refinement?.span?.sourceEnd,
        ),
      ).toBe(modifier);
    },
  );

  it("gives a bound attribute with no modifier no refinement", () => {
    for (const source of ["<div v:=q/>"]) {
      const attr = find(
        lowerSource(source, fakeDeclarations({ isElement: () => true })).body,
        "Element",
      ).attrs[0];
      expect(attr).toMatchObject({ kind: "bound" });
      expect(attr).not.toHaveProperty("refinement");
    }
  });

  // Marko accepts an optional-chain target, refined or not: core lowers both
  // as a bound attribute whose value is `q?.a`, and only the refinement differs.
  it.each([
    ["<div v:=q?.a/>", undefined],
    ["<div v:fn:=q?.a/>", "fn"],
  ])("lowers %s with an optional-chain target", (source, modifier) => {
    const attr = find(
      lowerSource(source, fakeDeclarations({ isElement: () => true })).body,
      "Element",
    ).attrs[0];
    expect(attr).toMatchObject({
      kind: "bound",
      name: "v",
      value: { code: "q?.a" },
    });
    if (modifier === undefined) {
      expect(attr).not.toHaveProperty("refinement");
    } else {
      expect(attr).toMatchObject({
        refinement: { code: modifier, shape: "other" },
      });
    }
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
    ['import Child from "./child.mx"\n<Child value:="x"/>', 2, 14],
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
        'import Card from "./card.mx"\n<Card value:="x"/>',
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
        `import Card from "./card.mx"\n<Card ${authored}/>`,
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
          `import Card from "./card.mx"\n<Card ${authored}/>`,
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
      'import Card from "./card.mx"\n<Card value:foo=y/>\n',
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
        message: expect.stringContaining("Tag does not support arguments."),
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

/**
 * Decision 183: the tag-argument rejection is Marko 6.4.3's own message,
 * verbatim (probed against stock marko 6.4.3), so the two languages never
 * diverge on the same construct. The event-handler hint stays, as a second
 * sentence after Marko's exact text.
 */
describe("tag-argument messages are Marko 6.4.3's own", () => {
  const messageOf = (source: string, policy = fakeDeclarations()): string => {
    try {
      lowerSource(source, policy);
    } catch (cause) {
      return (cause as Error).message;
    }
    throw new Error(`expected ${JSON.stringify(source)} to fail`);
  };

  it.each([
    [
      "<if(x)>a</if>",
      "Tag does not support arguments. Write the condition as a value attribute instead: `<if=condition>`.",
    ],
    [
      "<if=c></if><else-if(x)/>",
      "Tag does not support arguments. Write the condition as a value attribute instead: `<else-if=condition>`.",
    ],
    [
      "<if=c></if><else(x)></else>",
      "Tag does not support arguments. Write the condition as an attribute instead: `<else if=condition>`.",
    ],
    ["<const/foo(x)/>", "Tag does not support arguments."],
    ['<button (click)="go()"/>', "Tag does not support arguments."],
  ])("%j", (source, message) => {
    expect(messageOf(source)).toBe(message);
  });

  it("appends the event-handler hint as a second sentence on a host that resolves attribute methods", () => {
    expect(
      messageOf(
        '<button (click)="go()"/>',
        fakeDeclarations({ resolveAttributeMethod: () => true }),
      ),
    ).toBe(
      "Tag does not support arguments. For an event handler write `onClick=go`",
    );
  });
});

describe("a /var a host cannot bind is reported at the /var", () => {
  // The refusal's text is `rejectUnsupportedFields`'s (a dynamic tag has no
  // return shape the core can read). This pins the *position*: it used to sit
  // at the tag, leaving the author to find the `/var` themselves — the same
  // report-at-the-thing rule the tag-arguments refusals above follow.
  const fails = (marked: string): void => {
    const line = marked.split("\n").findIndex((l) => l.includes("§")) + 1;
    const markedLine = marked.split("\n")[line - 1] ?? "";
    const column = markedLine.indexOf("§");
    const source = marked.replace("§", "");
    expect(() => lowerSource(source)).toThrow(
      expect.objectContaining({
        message: expect.stringContaining("tag variable `/n`"),
        line,
        column,
      }),
    );
  };

  it("points at the /var on a dynamic tag, not the tag", () => {
    fails("<div>\n  <${C}/§n/>\n</div>");
  });

  it("points at the /var with no other content on the line", () => {
    fails("<div>\n<${C}/§n/>\n</div>");
  });
});

describe("a host that binds a dynamic tag's /var opts in", () => {
  // `HostDeclarations.bindsDynamicTagVar`: the host's dynamic dispatch reaches
  // a returning unit's render path (decision 155), so core lets the binding
  // through to the IR instead of refusing it. Without the flag the refusal
  // above stands.
  const policy = (): Policy => ({
    ...fakeDeclarations(),
    bindsDynamicTagVar: true,
  });

  it("carries the /var on the Component node", () => {
    const ir = lowerSource("<${C}/n start=1/>", policy());
    const component = ir.body[0] as Extract<IrNode, { kind: "Component" }>;
    expect(component.kind).toBe("Component");
    expect(component.target).toMatchObject({ kind: "dynamic" });
    expect(component.var).toBe("n");
    expect(component.returnsValue).toBeUndefined();
  });

  it("still refuses /var on a dynamic tag without the opt-in", () => {
    expect(() => lowerSource("<${C}/n start=1/>")).toThrow(
      /tag variable `\/n` on `<dynamic tag>`/,
    );
  });
});

/**
 * The real Marko parse, reshaped into the MX AST as far as `lower()` reads it
 * so far (PR 4 slices 1 to 3), so its hybrid paths run until the MX front
 * end feeds `lower()` (PR 5).
 *
 * - Slice 1: each tag's `attributeTags` move back into its body as the MX AST
 *   has them, one child list (an array, `MxTagFields.body`) in source order;
 *   each `<@name>` is an `MxAttributeTag` whose `name` is `{ value, span }`,
 *   `@` dropped from `value` and kept inside `span` (ast §3.7).
 * - Slice 2: every node of a kind slice 2 retyped gets its MX `type` and
 *   offsets (`start`/`end`, `valueSpan`) and loses `loc`: text, placeholder,
 *   comment, doctype, CDATA, declaration, scriptlet and attribute tag.
 *
 * - Slice 3: every tag becomes an `MxTag` (`MxReturn` for `<return>`): the
 *   `MxTagName` field shape (static, dynamic with its `${…}` span, unnamed
 *   for Marko's empty-span `div`), `var`/`args`/`params`/`typeArgs`/
 *   `typeParams` as expression containers around Marko's Babel payloads, and
 *   `body` as the child array, attribute tags merged in source order.
 *
 * - Slice 5: a placeholder's expression is an `MxExpression` container and a
 *   scriptlet's statements an `MxStatements` one (`node` the Babel payload,
 *   `error: null`, document offsets), with Marko's `value`/`body` gone; a
 *   comment's `kind` comes from its delimiter.
 *
 * Fields a later slice retypes stay Marko-shaped: a tag's attributes and
 * shorthand fields (slice 4).
 *
 * - Slice 6: a statement tag becomes an `MxModuleStatement`.
 */
function toMxShape(source: string): (body: Node[]) => void {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") lineStarts.push(i + 1);
  }
  const at = (position: { line: number; column: number }): number =>
    (lineStarts[position.line - 1] ?? 0) + position.column;
  const startOf = (node: Node): number =>
    typeof node.start === "number" ? node.start : at(node.loc.start);
  const offsets = (node: Node) => ({
    start: at(node.loc.start),
    end: at(node.loc.end),
  });
  const container = (
    type: string,
    payload: Node,
    inner: { start: number; end: number },
    outer: { start: number; end: number },
  ): Node => ({
    type,
    source: source.slice(inner.start, inner.end),
    outer,
    node: payload,
    error: null,
    atoms: [],
    ...inner,
  });
  const leaf = (node: Node): Node => {
    const { start, end } = offsets(node);
    switch (node.type) {
      case "MarkoText":
        return {
          type: "MxText",
          value: node.value,
          raw: source.slice(start, end),
          valueSpan: { start, end },
          start,
          end,
        };
      case "MarkoPlaceholder": {
        const { loc: _loc, value, ...rest } = node;
        const inner = offsets(value);
        return {
          ...rest,
          type: "MxPlaceholder",
          expression: container("MxExpression", value, inner, { start, end }),
          start,
          end,
        };
      }
      case "MarkoComment":
      case "MarkoDocumentType":
      case "MarkoCDATA":
      case "MarkoDeclaration":
        return {
          type: {
            MarkoComment: "MxComment",
            MarkoDocumentType: "MxDoctype",
            MarkoCDATA: "MxCDATA",
            MarkoDeclaration: "MxDeclaration",
          }[node.type as string],
          ...(node.type === "MarkoComment"
            ? {
                kind: source.startsWith("<!--", start)
                  ? "html"
                  : source.startsWith("//", start)
                    ? "line"
                    : "block",
              }
            : {}),
          value: node.value,
          valueSpan: { start, end },
          start,
          end,
        };
      case "MarkoScriptlet": {
        const { loc: _loc, body, ...rest } = node;
        // The statements run from after `$` (and a block's `{`) to the end.
        const head = /^\$\s*\{?\s*/.exec(source.slice(start, end))?.[0] ?? "";
        const inner = {
          start: start + head.length,
          end: source[end - 1] === "}" && head.includes("{") ? end - 1 : end,
        };
        return {
          ...rest,
          type: "MxScriptlet",
          block: head.includes("{"),
          code: {
            ...container("MxStatements", body, inner, { start, end }),
            directives: [],
            innerComments: [],
          },
          start,
          end,
        };
      }
      default:
        return node;
    }
  };
  /** A tag field's container around Marko's payload, its span over `nodes`. */
  const wrap = (type: string, payload: Node, nodes: Node[]): Node => {
    const located = nodes.filter((each) => each?.loc);
    const first = located[0];
    const last = located[located.length - 1];
    const inner = {
      start: first ? at(first.loc.start) : 0,
      end: last ? at(last.loc.end) : 0,
    };
    return container(type, payload, inner, inner);
  };
  /** The offset of the `)` closing the `(` at `open`, depth-counted. */
  const closeParen = (open: number): number => {
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")" && --depth === 0) return i;
    }
    return -1;
  };
  /** Marko's method `FunctionExpression`, as the `MxMethod` it was parsed from. */
  const method = (fn: Node): Node => {
    const { start, end } = offsets(fn);
    const open = source.indexOf("(", start);
    const close = closeParen(open);
    const inner = offsets(fn.body);
    // Marko's `typeParameters: null` is a written list `stripTypes` dropped,
    // which `stripMxTypes` records the same way on the MX path.
    const stripped = fn.typeParameters === null;
    const shaped: Node = {
      type: "MxMethod",
      start,
      end,
      async: fn.async,
      typeParams: fn.typeParameters
        ? container(
            "MxTypeParameters",
            fn.typeParameters,
            { start: start + 1, end: open - 1 },
            { start, end: open },
          )
        : null,
      params: container(
        "MxParameterList",
        fn.params,
        { start: open + 1, end: close },
        { start: open, end: close + 1 },
      ),
      body: {
        ...container("MxStatements", fn.body.body, inner, {
          start: inner.start - 1,
          end: inner.end + 1,
        }),
        directives: fn.body.directives,
        innerComments: fn.body.innerComments ?? [],
      },
      source: source.slice(start, end),
    };
    if (stripped) strippedMethodTypeParams.add(shaped);
    return shaped;
  };
  /**
   * Slice 4: a named or spread attribute as the MX front end builds it
   * (`MxAttribute`, `MxSpreadAttribute`; probed): the value in a container,
   * a method as `MxMethod`, the default value named `null`, `:=` as
   * `operator`. Name sugar (`#x`, `.x`, `:x`) and the tag's own shorthand
   * stay Marko-shaped.
   */
  /**
   * Slice 4, family 3: name sugar as the MX front end splits it (probed):
   * a chain of `.`/`#`/`:` tokens read from the source, each an
   * `MxShorthand`; a `${…}` part is dynamic, its payloads Marko's own nodes
   * found by offset in the value Marko merged them into.
   */
  const babelAt = new Map<string, Node>();
  const index = (node: Node): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const each of node) index(each);
      return;
    }
    // Marko's template part has no `loc` of its own; its quasis do.
    const quasis = node.type === "TemplateLiteral" ? node.quasis : undefined;
    const range = node.loc
      ? offsets(node)
      : quasis?.[0]?.loc
        ? {
            start: offsets(quasis[0]).start,
            end: offsets(quasis[quasis.length - 1]).end,
          }
        : undefined;
    if (range && typeof node.type === "string") {
      const key = `${range.start}-${range.end}`;
      if (!babelAt.has(key)) babelAt.set(key, node);
      if (quasis) babelAt.set(`template@${range.start}`, node);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== "loc" && key !== "extra") index(value);
    }
  };
  const payloadAt = (span: { start: number; end: number }): Node => {
    // A template part is parsed with its backticks around it.
    const node =
      babelAt.get(`${span.start}-${span.end}`) ??
      babelAt.get(`${span.start - 1}-${span.end + 1}`);
    const template = babelAt.get(`template@${span.start}`);
    if (!node && template) {
      // `.c${x}:b` is one Marko part; the front end's part stops before
      // the `:b`, which is a shorthand of its own.
      const part = structuredClone(template);
      const tail = part.quasis[part.quasis.length - 1];
      const colon = tail.value.raw.indexOf(":");
      tail.value.raw = tail.value.raw.slice(0, colon);
      tail.value.cooked = tail.value.raw;
      tail.loc.end = positionAt(span.end);
      return part;
    }
    // Marko turns `${"s"}` into a one-quasi template; the front end keeps
    // the string literal.
    if (
      node?.type === "TemplateLiteral" &&
      node.expressions.length === 0 &&
      /^["'`]/.test(source[span.start] ?? "")
    ) {
      return { type: "StringLiteral", value: node.quasis[0].value.cooked };
    }
    return node;
  };
  const positionAt = (offset: number) => {
    let line = lineStarts.length;
    while ((lineStarts[line - 1] ?? 0) > offset) line--;
    return {
      line,
      column: offset - (lineStarts[line - 1] ?? 0),
      index: offset,
    };
  };
  const expression = (span: { start: number; end: number }): Node =>
    container("MxExpression", payloadAt(span), span, span);
  const scanChain = (from: number, position: "tag" | "attribute") => {
    const tokens: Node[] = [];
    let pos = from;
    // `:=` is the bound operator, not a `:name`.
    while (
      ".#:".includes(source[pos] ?? "x") &&
      source.slice(pos, pos + 2) !== ":="
    ) {
      const start = pos++;
      const wordStart = pos;
      const quasis: { start: number; end: number }[] = [];
      const expressions: { start: number; end: number }[] = [];
      let quasiStart = pos;
      while (pos < source.length) {
        const char = source[pos] as string;
        if (char === "$" && source[pos + 1] === "{") {
          quasis.push({ start: quasiStart, end: pos });
          let depth = 0;
          let close = pos + 1;
          for (; close < source.length; close++) {
            if (source[close] === "{") depth++;
            else if (source[close] === "}" && --depth === 0) break;
          }
          expressions.push({ start: pos + 2, end: close });
          pos = close + 1;
          quasiStart = pos;
          continue;
        }
        if (/[.#:\s/>=(|<,]/.test(char)) break;
        pos++;
      }
      const span = { start: wordStart, end: pos };
      let value: Node;
      if (expressions.length === 0) {
        value = { kind: "static", value: source.slice(start + 1, pos), span };
      } else {
        quasis.push({ start: quasiStart, end: pos });
        const bare =
          expressions.length === 1 &&
          quasis.every((quasi) => quasi.start === quasi.end);
        value = {
          kind: "dynamic",
          template: expression(bare ? (expressions[0] as typeof span) : span),
          quasis,
          expressions: expressions.map(expression),
          span,
        };
      }
      tokens.push({
        type: "MxShorthand",
        sigil: source[start],
        position,
        value,
        operator: null,
        default: null,
        args: null,
        start,
        end: pos,
      });
    }
    return tokens;
  };
  const isSugarAttr = (attr: Node): boolean =>
    attr.type === "MarkoAttribute" &&
    Boolean(attr.loc) &&
    (/^[#.]/.test(attr.name) || (attr.default && Boolean(attr.modifier)));
  /** An attribute-position sugar run, its value on the last token. */
  const sugarRun = (attr: Node): Node[] => {
    index(attr.value);
    const tokens = scanChain(offsets(attr).start, "attribute");
    const last = tokens[tokens.length - 1] as Node;
    const value: Node = attr.value;
    if (value?.type === "FunctionExpression") last.default = method(value);
    else if (value?.loc) {
      last.operator = attr.bound ? ":=" : "=";
      last.default = wrap("MxExpression", value, [value]);
    }
    if (attr.arguments) {
      last.args = wrap("MxArguments", attr.arguments, attr.arguments);
    }
    return tokens;
  };
  /**
   * The tag head: the name before any sugar, the shorthand tokens after it,
   * and the attribute list without what Marko's parser added for them (the
   * loc-less `class`/`id`, the shorthand merged into an authored `class`).
   */
  const sugarHead = (node: Node) => {
    const name = node.name;
    if (
      name?.type !== "StringLiteral" ||
      !name.loc ||
      String(name.value).startsWith("@")
    ) {
      return undefined;
    }
    const nameStart = offsets(name).start;
    let nameEnd = nameStart;
    while (
      nameEnd < source.length &&
      !/[.#:\s/>=(|<,]/.test(source[nameEnd] as string)
    ) {
      nameEnd++;
    }
    for (const attr of node.attributes ?? []) index(attr.value);
    const shorthands = scanChain(nameEnd, "tag");
    if (shorthands.length === 0) return undefined;
    const attributes: Node[] = [];
    for (const attr of node.attributes ?? []) {
      if (!attr.loc) continue;
      if (attr.type === "MarkoAttribute" && attr.name === "class") {
        const attrStart = offsets(attr).start;
        const before = (each: Node) =>
          each?.loc ? offsets(each).start < attrStart : true;
        const value: Node = attr.value;
        if (
          value?.type === "TemplateLiteral" &&
          value.expressions.length === 2 &&
          value.quasis[1]?.value.raw === " " &&
          before(value.expressions[0])
        ) {
          attributes.push({ ...attr, value: value.expressions[1] });
          continue;
        }
        if (value?.type === "ArrayExpression" && before(value.elements[0])) {
          const rest = value.elements.filter((each: Node) => !before(each));
          // An authored array was flattened into Marko's; rebuild it.
          const open = source.indexOf("[", attrStart);
          attributes.push({
            ...attr,
            value:
              rest.length === 1
                ? rest[0]
                : {
                    type: "ArrayExpression",
                    elements: rest,
                    loc: {
                      start: positionAt(open),
                      end: positionAt(offsets(attr).end),
                    },
                  },
          });
          continue;
        }
      }
      attributes.push(attr);
    }
    return {
      name:
        nameEnd > nameStart
          ? {
              kind: "static",
              value: source.slice(nameStart, nameEnd),
              span: { start: nameStart, end: nameEnd },
            }
          : { kind: "unnamed", span: { start: nameStart, end: nameStart } },
      shorthands,
      attributes,
    };
  };
  const attribute = (attr: Node): Node | Node[] => {
    if (!attr.loc) return attr;
    if (isSugarAttr(attr)) return sugarRun(attr);
    const { start, end } = offsets(attr);
    if (attr.type === "MarkoSpreadAttribute") {
      return {
        type: "MxSpreadAttribute",
        value: wrap("MxExpression", attr.value, [attr.value]),
        start,
        end,
      };
    }
    if (
      attr.type !== "MarkoAttribute" ||
      /^[#.]/.test(attr.name) ||
      (attr.default && attr.modifier != null)
    ) {
      return attr;
    }
    const value: Node = attr.value;
    const isMethod = value?.type === "FunctionExpression";
    const name: string | null = attr.default ? null : attr.name;
    const nameStart =
      name !== null ? start : isMethod ? source.indexOf("(", start) : start;
    const nameEnd = nameStart + (name?.length ?? 0);
    const modifierStart = nameEnd + 1;
    return {
      type: "MxAttribute",
      name,
      nameSpan: { start: nameStart, end: nameEnd },
      modifier: attr.modifier ?? null,
      modifierSpan:
        attr.modifier != null
          ? { start: modifierStart, end: modifierStart + attr.modifier.length }
          : null,
      operator: attr.bound ? ":=" : value?.loc && !isMethod ? "=" : null,
      value: isMethod
        ? method(value)
        : value?.loc
          ? wrap("MxExpression", value, [value])
          : null,
      args: attr.arguments
        ? wrap("MxArguments", attr.arguments, attr.arguments)
        : null,
      start,
      end,
    };
  };
  const tagName = (node: Node): Node => {
    const name = node.name;
    if (name?.type === "StringLiteral") {
      const span = offsets(name);
      // Marko writes `div` into an unnamed tag's empty-span name node.
      return span.start === span.end
        ? { kind: "unnamed", span }
        : { kind: "static", value: name.value, span };
    }
    const expression = wrap("MxExpression", name, [name]);
    return {
      kind: "dynamic",
      expression,
      span: { start: expression.start - 2, end: expression.end + 1 },
    };
  };
  /**
   * A tag Marko parsed as a statement (`rawValue`) is an `MxModuleStatement`:
   * `end` the trimmed extent, `untrimmedEnd` Marko's range end, `code` the
   * text after the keyword (`static`/`server`/`client`) or the whole line.
   * Lowering reads the statement's text, never `code.node`, so the payload
   * is the text Marko kept.
   */
  const statement = (node: Node): Node => {
    const { start, end: untrimmedEnd } = offsets(node);
    let end = untrimmedEnd;
    while (end > start && /\s/.test(source[end - 1] as string)) end--;
    const keyword = String(node.name.value);
    const head = ["static", "server", "client"].includes(keyword)
      ? (new RegExp(`^${keyword}\\s*`).exec(source.slice(start, end))?.[0] ??
        "")
      : "";
    const inner = { start: start + head.length, end };
    return {
      type: "MxModuleStatement",
      keyword,
      code: {
        ...container("MxStatements", node.rawValue, inner, inner),
        directives: [],
        innerComments: [],
      },
      start,
      end,
      untrimmedEnd,
    };
  };
  const visit = (node: Node): Node => {
    if (node?.type !== "MarkoTag") return leaf(node);
    if (typeof node.rawValue === "string") return statement(node);
    const children: Node[] = (node.body?.body ?? []).map(visit);
    const tags: Node[] = (node.attributeTags ?? []).map(visit);
    const body = [...children, ...tags].sort((a, b) => startOf(a) - startOf(b));
    const params: Node[] = node.body?.params ?? [];
    const {
      loc: _loc,
      name: _name,
      arguments: args,
      var: pattern,
      typeArguments,
      attributeTags: _attributeTags,
      body: _body,
      ...rest
    } = node;
    const { start, end } = offsets(node);
    const head = sugarHead(node);
    const fields = {
      ...rest,
      typeArgs: typeArguments
        ? wrap("MxTypeArguments", typeArguments, [typeArguments])
        : null,
      var: pattern ? wrap("MxPattern", pattern, [pattern]) : null,
      args: args ? wrap("MxArguments", args, args) : null,
      typeParams: node.body?.typeParameters
        ? wrap("MxTypeParameters", node.body.typeParameters, [
            node.body.typeParameters,
          ])
        : null,
      params: params.length ? wrap("MxParameterList", params, params) : null,
      attributes: (head?.attributes ?? node.attributes ?? []).flatMap(
        attribute,
      ),
      shorthands: head?.shorthands ?? [],
      body,
      start,
      end,
    };
    const name = String(node.name?.value ?? "");
    if (name.startsWith("@")) {
      return {
        ...fields,
        type: "MxAttributeTag",
        name: {
          value: name.slice(1),
          span: { start: start + 1, end: start + 1 + name.length },
        },
      };
    }
    return {
      ...fields,
      type: name === "return" ? "MxReturn" : "MxTag",
      name: head?.name ?? tagName(node),
    };
  };
  return (body) => {
    body.splice(0, body.length, ...body.map(visit));
  };
}

describe("hybrid attribute tags, MX-shaped (PR 4 slice 1)", () => {
  const panel = (overrides: Partial<Policy> = {}) =>
    fakeDeclarations({
      attrTags: 2,
      isComponent: (name) => name === "Panel",
      ...overrides,
    });
  const mx = (source: string, policy: Policy) =>
    lowerSource(
      source,
      policy,
      undefined,
      undefined,
      undefined,
      toMxShape(source),
    );

  it("reshapes the parse into MxAttributeTag children", () => {
    const source = "<Panel><@item/></Panel>";
    let seen: Node[] = [];
    lowerSource(source, panel(), undefined, undefined, undefined, (body) => {
      toMxShape(source)(body);
      seen = body;
    });
    const tag = seen.find((node) => node.type === "MxTag");
    expect(tag.attributeTags).toBeUndefined();
    expect(tag.body).toEqual([
      expect.objectContaining({
        type: "MxAttributeTag",
        // The MX front end's own shape for this input (probe in PR 433's review).
        name: { value: "item", span: { start: 8, end: 13 } },
      }),
    ]);
  });

  it("puts an attribute tag's nameSpan on the name after the `@`", () => {
    const source = "<Panel><@item/></Panel>";
    const ir = mx(source, panel());
    const component = ir.body.find((node) => node.kind === "Component");
    if (component?.kind !== "Component") throw new Error("no Component");
    const span = component.attributeTags[0]?.nameSpan;
    expect(span).toEqual({ sourceStart: 9, sourceEnd: 13 });
    expect(source.slice(span?.sourceStart, span?.sourceEnd)).toBe("item");
  });

  it.each([
    ["one attribute tag", "<Panel><@item>A</@item></Panel>"],
    [
      "attribute tags mixed with content, in source order",
      "<Panel>\n  lead\n  <@a>A</@a>\n  <span>mid</span>\n  <@b>B</@b>\n  tail\n</Panel>",
    ],
    [
      "nested attribute tags",
      "<Panel><@item><@icon>I</@icon>T</@item></Panel>",
    ],
    [
      "attribute tags under <if>/<else>",
      "<Panel><if=x><@a>A</@a></if><else><@b>B</@b></else></Panel>",
    ],
    [
      "an attribute tag under <for>",
      "<Panel><for|i| of=xs><@row>${i}</@row></for></Panel>",
    ],
    [
      "a comment before an attribute tag",
      "<Panel>\n  <!-- note -->\n  <@a>A</@a>\n</Panel>",
    ],
  ])("lowers %s to the IR the Marko shape lowers to", (_label, source) => {
    expect(mx(source, panel())).toEqual(lowerSource(source, panel()));
  });

  it("positions the nested-attribute-tag gate at the nested tag", () => {
    const source = "<Panel><@item><@icon/></@item></Panel>";
    const legacy = panel({ attrTags: undefined, name: "@mxlang/legacy" });
    let error: unknown;
    try {
      mx(source, legacy);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TranslateError);
    const err = error as TranslateError;
    expect(err.message).toContain("nested attribute tags");
    expect([err.line, err.column]).toEqual([1, 14]);
  });

  it("hands an element's hook its first attribute tag", () => {
    const source = "<div><@a/></div>";
    const seen: Node[] = [];
    const policy = fakeDeclarations({
      rejectElementAttributeTags: (_name, node) => {
        const first = firstAttributeTag(node);
        if (first) seen.push(first);
      },
    });
    // The hook only records; core's own field guard then rejects the tag.
    // Hooks see the Marko-shaped view of the MX node (decision 163 addendum,
    // `markoViewOf`), so the first attribute tag reads as Marko's.
    expect(() => mx(source, policy)).toThrowError(/attribute tag `@a`/);
    expect(seen.map((node) => [node.type, node.name.value])).toEqual([
      ["MarkoTag", "@a"],
    ]);
  });

  it("rejects an element's attribute tag when the host has no hook", () => {
    const source = "<div><@a/></div>";
    expect(() => mx(source, fakeDeclarations())).toThrowError(
      lowerSourceError(source, fakeDeclarations()),
    );
  });
});

function lowerSourceError(source: string, policy: Policy): string {
  try {
    lowerSource(source, policy);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`${source} lowered without an error`);
}

describe("hybrid node kinds and spans, MX-shaped (PR 4 slice 2)", () => {
  const mx = (source: string, policy = fakeDeclarations()) =>
    lowerSource(
      source,
      policy,
      undefined,
      undefined,
      undefined,
      toMxShape(source),
    );
  /** The error `run` throws, as the fields a reporter reads. */
  const thrown = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      const e = error as TranslateError;
      return { message: e.message, line: e.line, column: e.column, e };
    }
    throw new Error("no error thrown");
  };
  const ctxFor = (source: string) =>
    newCtx(
      source,
      printExpression,
      fakeDeclarations(),
      undefined,
      "test.mx",
      lookup,
    );

  it("reshapes leaf nodes into MX kinds with offsets and no loc", () => {
    const source = "<!-- c -->\n<div>hi ${x}</div>";
    let seen: Node[] = [];
    lowerSource(source, undefined, undefined, undefined, undefined, (body) => {
      toMxShape(source)(body);
      seen = body;
    });
    expect(seen[0]).toEqual({
      type: "MxComment",
      kind: "html",
      value: " c ",
      valueSpan: { start: 0, end: 10 },
      start: 0,
      end: 10,
    });
    const div = seen.find((node) => node.type === "MxTag");
    expect(div.body.map((n: Node) => [n.type, n.start, n.end])).toEqual([
      ["MxText", 16, 19],
      ["MxPlaceholder", 19, 23],
    ]);
    expect(div.body.some((n: Node) => "loc" in n)).toBe(false);
  });

  it.each([
    ["text and placeholders", "<div>hi ${x} and $!{y}</div>"],
    [
      "an HTML and a line comment",
      "<!-- top -->\n<div>\n  // line\n  <span/>\n</div>",
    ],
    ["a doctype", "<!doctype html>\n<html><body>x</body></html>"],
    ["CRLF lines", "<div>\r\n  a\r\n  ${b}\r\n  <!-- c -->\r\n</div>"],
    ["UTF-16 surrogate pairs", "<p>\u{1F600} ${x} \u{1F600}</p>"],
    [
      "an if chain with layout between branches",
      "<if=a>A</if>\n<!-- c -->\n<else-if=b>B</else-if>\n<else>C</else>",
    ],
    ["a for body", "<ul><for|i| of=xs><li>${i}</li></for></ul>"],
  ])("lowers %s to the IR the Marko shape lowers to", (_label, source) => {
    expect(mx(source)).toEqual(lowerSource(source));
  });

  it.each([
    ["CDATA", "<div>\n  <![CDATA[ x ]]>\n</div>", 8],
    ["a declaration", "<div/>\n<?xml version='1.0'?>", 7],
    ["a scriptlet", "<div>\n  $ const a = 1;\n</div>", 8],
  ])("positions the %s error as the Marko shape does", (_label, source, at) => {
    const { e: _marko, ...marko } = thrown(() => lowerSource(source));
    const { e, ...mxError } = thrown(() => mx(source));
    expect(mxError).toEqual(marko);
    // The MX node's offsets stay on the error after the boundary resolved them.
    expect(e.span?.sourceStart).toBe(at);
  });

  it("positions an MX-node error in the recovering walk (decision 162)", () => {
    const source = "<div>\n  <![CDATA[ x ]]>\n</div>\n<?xml?>";
    let errors: TranslateError[] = [];
    const { e } = thrown(() =>
      lowerSource(
        source,
        undefined,
        undefined,
        undefined,
        undefined,
        (b, c) => {
          toMxShape(source)(b);
          c.errors = [];
          errors = c.errors;
        },
      ),
    );
    expect(errors.map((each) => [each.line, each.column])).toEqual([
      [2, 2],
      [4, 0],
    ]);
    expect(e.errors?.map((each) => each.span?.sourceStart)).toEqual([8, 31]);
  });

  it("positions an MX-node error through the exported lowerChildren", () => {
    const source = "a\n  <![CDATA[ x ]]>";
    const cdata = {
      type: "MxCDATA",
      value: " x ",
      valueSpan: { start: 4, end: 19 },
      start: 4,
      end: 19,
    };
    expect(thrown(() => lowerChildren(ctxFor(source), [cdata]))).toMatchObject({
      line: 2,
      column: 2,
    });
  });

  it("rejects an MxAttributeTag outside a component call, positioned", () => {
    const source = "<div>\n  <@a/>\n</div>";
    const tag = {
      type: "MxAttributeTag",
      name: { value: "a", span: { start: 9, end: 11 } },
      body: null,
      attributes: [],
      start: 8,
      end: 13,
    };
    expect(thrown(() => lowerChildren(ctxFor(source), [tag]))).toMatchObject({
      message:
        "attribute tag `<@a>` is only valid directly inside a component call",
      line: 2,
      column: 2,
    });
  });

  it("positions a host hook's fail on an MX node at the boundary", () => {
    const source = "<div>\n  <@a/>\n</div>";
    const policy = fakeDeclarations({
      rejectElementAttributeTags: (_name, node) =>
        fail("no attribute tags here", firstAttributeTag(node)),
    });
    expect(thrown(() => mx(source, policy))).toMatchObject({
      message: "no attribute tags here",
      line: 2,
      column: 2,
    });
  });

  it("refuses an MX-node error that left the boundary unpositioned", () => {
    const source = "ab\ncd";
    let error: unknown;
    try {
      fail("oops", { type: "MxText", start: 4, end: 5 });
    } catch (e) {
      error = e;
    }
    expect(() => assertPositioned(error)).toThrowError(
      "an error left the lowering without a source position (not yours: an internal bug): oops",
    );
    positionError(ctxFor(source), error);
    expect(() => assertPositioned(error)).not.toThrow();
    expect(error).toMatchObject({
      line: 2,
      column: 1,
      span: { sourceStart: 4, sourceEnd: 5 },
    });
  });

  it("leaves a no-loc node that is not an MX node unpositioned", () => {
    const ctx = ctxFor("abcdefghijk");
    expect(exprSpan(ctx, { type: "Id", start: 7, end: 10 })).toBeUndefined();
    expect(exprSpan(ctx, { type: "MxText", start: 7, end: 10 })).toEqual({
      sourceStart: 7,
      sourceEnd: 10,
    });
  });
});

describe("hybrid text, placeholders, comments and payloads, MX-shaped (PR 4 slice 5)", () => {
  const mx = (source: string, policy = fakeDeclarations()) =>
    lowerSource(
      source,
      policy,
      undefined,
      undefined,
      undefined,
      toMxShape(source),
    );
  const thrown = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      const e = error as TranslateError;
      return { message: e.message, line: e.line, column: e.column };
    }
    throw new Error("no error thrown");
  };
  const ctxFor = (source: string) =>
    newCtx(
      source,
      printExpression,
      fakeDeclarations(),
      undefined,
      "test.mx",
      lookup,
    );
  /** An `MxExpression` the way the MX front end builds one (probe, slice 5). */
  const expression = (fields: Partial<Record<string, unknown>>): Node => ({
    type: "MxExpression",
    source: "",
    outer: { start: 0, end: 0 },
    node: null,
    error: null,
    atoms: [],
    start: 0,
    end: 0,
    ...fields,
  });
  const parseError = (start: number, message = "Unexpected token") => ({
    type: "MxParseError",
    code: "BABEL_UnexpectedToken",
    origin: "expression",
    message,
    context: null,
    start,
    end: start,
  });

  it("reshapes placeholders and scriptlets into containers, without Marko's fields", () => {
    const source = "<div>${x}</div>\n$ const a = 1;";
    let seen: Node[] = [];
    try {
      lowerSource(source, undefined, undefined, undefined, undefined, (b) => {
        toMxShape(source)(b);
        seen = b;
      });
    } catch {
      // The scriptlet is refused; the reshaped body is what is checked.
    }
    const placeholder = seen[0].body[0];
    expect(placeholder).not.toHaveProperty("value");
    expect(placeholder.expression).toMatchObject({
      type: "MxExpression",
      source: "x",
      outer: { start: 5, end: 9 },
      start: 7,
      end: 8,
      error: null,
      node: { type: "Identifier", name: "x" },
    });
    const scriptlet = seen[1];
    expect(scriptlet).not.toHaveProperty("body");
    expect(scriptlet).toMatchObject({ type: "MxScriptlet", block: false });
    expect(scriptlet.code).toMatchObject({
      type: "MxStatements",
      source: "const a = 1;",
      start: 18,
      error: null,
      node: [{ type: "VariableDeclaration", kind: "const" }],
    });
  });

  it.each([
    ["an escaped and an unescaped placeholder", "<p>${a} $!{b}</p>"],
    ["a placeholder at the top level", "${a}\n<p/>"],
    [
      "placeholder shapes (object, array, string)",
      "<p>${{ a }}${[1]}${`t`}</p>",
    ],
    ["a placeholder in an attribute tag", "<Panel><@item>${x}</@item></Panel>"],
    ["a placeholder in an if chain", "<if=a>${b}</if><else>${c}</else>"],
    [
      "html, line and block comments",
      "<!-- h -->\n<div>\n  // l\n  /* b */\n  <span/>\n</div>",
    ],
    ["a comment beside text and a placeholder", "<p>a <!-- c --> ${b}</p>"],
  ])("lowers %s to the IR the Marko shape lowers to", (_label, source) => {
    const policy = fakeDeclarations({
      attrTags: 2,
      isComponent: (name) => name === "Panel",
    });
    expect(mx(source, policy)).toEqual(lowerSource(source, policy));
  });

  it.each([
    ["a const", "<div>\n  $ const a = 1;\n</div>"],
    ["a let", "$ let b = f()\n<p/>"],
    ["a block", "$ { const c = 1 }\n<p/>"],
    ["a call (no hint)", "$ f()\n<p/>"],
    ["two statements (no hint)", "$ const a = 1; const b = 2;\n<p/>"],
  ])(
    "refuses a scriptlet declaring %s as the Marko shape does",
    (_l, source) => {
      expect(thrown(() => mx(source))).toEqual(
        thrown(() => lowerSource(source)),
      );
    },
  );

  it("reads a comment's kind, not its source, on the MX path", () => {
    // The source says HTML comment; `kind` says line. MX's field decides.
    const source = "<!-- c -->";
    const comment = {
      type: "MxComment",
      kind: "line",
      value: " c ",
      valueSpan: { start: 4, end: 7 },
      start: 0,
      end: 10,
    };
    const [node] = lowerChildren(ctxFor(source), [comment]);
    expect(node).toMatchObject({ kind: "Comment", html: false });
    const [html] = lowerChildren(ctxFor("// c"), [
      { ...comment, kind: "html", end: 4 },
    ]);
    expect(html).toMatchObject({ kind: "Comment", html: true });
  });

  it("fails an unparsed placeholder at its MxParseError", () => {
    const source = "<div>\n  ${a +}</div>";
    const placeholder = {
      type: "MxPlaceholder",
      escape: true,
      expression: expression({
        source: "a +",
        outer: { start: 8, end: 14 },
        start: 10,
        end: 13,
        error: parseError(13),
      }),
      start: 8,
      end: 14,
    };
    expect(thrown(() => lowerChildren(ctxFor(source), [placeholder]))).toEqual({
      message: "Unexpected token",
      line: 2,
      column: 7,
    });
  });

  it("records an unparsed placeholder and lowers its siblings (decision 162)", () => {
    const source = "${a +}b";
    const ctx = ctxFor(source);
    ctx.errors = [];
    const placeholder = {
      type: "MxPlaceholder",
      escape: true,
      expression: expression({ error: parseError(4), start: 2, end: 5 }),
      start: 0,
      end: 6,
    };
    const text = {
      type: "MxText",
      value: "b",
      raw: "b",
      valueSpan: { start: 6, end: 7 },
      start: 6,
      end: 7,
    };
    const out = lowerChildren(ctx, [placeholder, text]);
    expect(out).toMatchObject([{ kind: "Text", value: "b" }]);
    expect(ctx.errors.map((e) => [e.message, e.line, e.column])).toEqual([
      ["Unexpected token", 1, 4],
    ]);
  });

  it("refuses a placeholder's expression trigger (decision 182 seam)", () => {
    const source = "<p>${&status}</p>";
    const trigger = {
      type: "MxTrigger",
      id: "status",
      position: "expression",
      text: "&status",
      value: null,
      start: 5,
      end: 12,
    };
    const placeholder = {
      type: "MxPlaceholder",
      escape: true,
      expression: expression({
        node: { type: "Identifier", name: "status", start: 6, end: 12 },
        triggers: [trigger],
        start: 5,
        end: 12,
      }),
      start: 3,
      end: 13,
    };
    expect(thrown(() => lowerChildren(ctxFor(source), [placeholder]))).toEqual({
      message: "`status` trigger has no lowering yet",
      line: 1,
      column: 5,
    });
  });

  it("keeps an unparsed MX scriptlet's source for the hint, as Marko's", () => {
    const source = "$ const a = (\n<p/>";
    const scriptlet = {
      type: "MxScriptlet",
      block: false,
      code: {
        ...expression({
          source: "const a = (",
          error: parseError(13),
          start: 2,
          end: 13,
        }),
        type: "MxStatements",
        directives: [],
        innerComments: [],
      },
      start: 0,
      end: 13,
    };
    const parsed = thrown(() => mx("$ const a = 1\n<p/>"));
    expect(thrown(() => lowerChildren(ctxFor(source), [scriptlet]))).toEqual({
      ...parsed,
      line: 1,
      column: 0,
    });
    expect(parsed.message).toMatch(/scriptlets .*; /);
  });
});

describe("hybrid tags, MX-shaped (PR 4 slice 3)", () => {
  const reshaped =
    (source: string, extra?: (body: Node[]) => void) => (body: Node[]) => {
      toMxShape(source)(body);
      extra?.(body);
    };
  /** What a lowering produced: its IR, or the error as a reporter reads it. */
  const outcome = (run: () => Ir) => {
    try {
      return { ir: run() };
    } catch (error) {
      const e = error as TranslateError;
      return { message: e.message, line: e.line, column: e.column };
    }
  };
  const both = (source: string, policy = fakeDeclarations()) => [
    outcome(() =>
      lowerSource(
        source,
        policy,
        undefined,
        undefined,
        undefined,
        reshaped(source),
      ),
    ),
    outcome(() => lowerSource(source, policy)),
  ];

  it("reshapes tags into MxTag/MxReturn with containers and no loc", () => {
    const source = "<${C}/v(a, b)|p|>t</>\n<return=1/>";
    let seen: Node[] = [];
    try {
      lowerSource(source, undefined, undefined, undefined, undefined, (b) => {
        toMxShape(source)(b);
        seen = [...b];
      });
    } catch {
      // Only the shape matters here.
    }
    const [tag] = seen;
    const ret = seen.find((node) => node.type === "MxReturn");
    expect(tag).toMatchObject({
      type: "MxTag",
      // The MX front end's own spans for this input.
      name: {
        kind: "dynamic",
        expression: { type: "MxExpression", start: 3, end: 4 },
        span: { start: 1, end: 5 },
      },
      var: { type: "MxPattern", start: 6, end: 7 },
      args: { type: "MxArguments", start: 8, end: 12 },
      params: { type: "MxParameterList", start: 14, end: 15 },
      body: [expect.objectContaining({ type: "MxText" })],
    });
    expect("loc" in tag).toBe(false);
    expect(ret).toMatchObject({
      type: "MxReturn",
      name: { kind: "static", value: "return", span: { start: 23, end: 29 } },
    });
  });

  it.each([
    ["a static element with a body", "<div><span>a</span></div>"],
    ["a self-closed element", "<input/>\n<br/>"],
    ["a dynamic tag", "<${input.as} x=1>y</>"],
    ["a dynamic tag with a body only", "<${input.as}>y</>"],
    [
      "<const> with a tag variable",
      "<const/doubled=input.n * 2/>\n<p>${doubled}</p>",
    ],
    ["<let> with a tag variable", "<let/count=0/>\n<p>${count}</p>"],
    ["a destructured <const>", "<const/{ a, b }=input/>\n<p>${a}${b}</p>"],
    [
      "<define> with params, called with args",
      "<define/Row|item|><li>${item}</li></define>\n<Row('a')/>",
    ],
    [
      "a <for> with params",
      "<ul><for|item, i| of=input.xs><li>${i}</li></for></ul>",
    ],
    [
      "an <if>/<else-if>/<else> chain",
      "<if=input.a>A</if><else-if=input.b>B</else-if><else>C</else>",
    ],
    ["<return>", "<return=1/>"],
    ["an attribute tag with params", "<Panel><@row|r|>${r}</@row></Panel>"],
    ["arguments on an element (refused)", "<div\n  (x)/>"],
    ["arguments and attributes on a tag", "<Panel(a) b=1/>"],
    ["a tag variable on an element (refused)", "<div/x/>"],
    ["params on an element (refused)", "<div|x|>y</div>"],
    [
      "typed params on an element (refused for the params)",
      "<div<T>|x: T|>y</div>",
    ],
    ["a /var on a dynamic tag (refused)", "<${C}/n start=1/>"],
  ])("lowers %s as the Marko shape does", (_label, source) => {
    const policy = fakeDeclarations({
      attrTags: 2,
      isComponent: (name) => name === "Panel",
    });
    const [mx, marko] = both(source, policy);
    expect(mx).toEqual(marko);
  });

  it("refuses an unnamed tag with no default tag as the Marko shape does", () => {
    const [mx, marko] = both("<div>\n  <.c/>\n</div>");
    expect(marko).toMatchObject({ message: /no default tag is declared/ });
    expect(mx).toEqual(marko);
  });

  it("resolves an unnamed tag's default tag as the Marko shape does", () => {
    const policy = fakeDeclarations({ resolveDefaultTag: () => "span" });
    const [mx, marko] = both("<div><.c>x</></div>", policy);
    expect(marko).toHaveProperty("ir");
    expect(mx).toEqual(marko);
  });

  it("drops a comment in the attribute list, as Marko never had one", () => {
    const source = "<input x=1/>";
    const comment = {
      type: "MxComment",
      kind: "block",
      value: " c ",
      valueSpan: { start: 9, end: 12 },
      start: 7,
      end: 14,
    };
    const ir = outcome(() =>
      lowerSource(
        source,
        undefined,
        undefined,
        undefined,
        undefined,
        reshaped(source, (body) => {
          body[0].attributes = [comment, ...body[0].attributes];
        }),
      ),
    );
    expect(ir).toEqual(outcome(() => lowerSource(source)));
  });

  it("fails a tag variable container's parse error at the error", () => {
    const source = "<const/[=1/>";
    const error = {
      type: "MxParseError",
      code: "INVALID_EXPRESSION",
      origin: "expression",
      message: "bad pattern",
      context: null,
      start: 7,
      end: 8,
    };
    const run = () =>
      lowerSource(
        "<const/x=1/>",
        undefined,
        undefined,
        undefined,
        undefined,
        reshaped("<const/x=1/>", (body) => {
          body[0].var = { ...body[0].var, node: null, error };
        }),
      );
    expect(outcome(run)).toMatchObject({
      message: "bad pattern",
      line: 1,
      column: 7,
    });
    expect(source.slice(error.start, error.end)).toBe("[");
  });

  it.each([
    ["a <for> param", "<for|__mxA| of=input.xs>${__mxA}</for>"],
    ["a <define> param", "<define/Row|__mxP|>${__mxP}</define>\n<Row/>"],
    ["an attribute tag param", "<Panel><@row|__mxR|>${__mxR}</@row></Panel>"],
    ["a tag variable (control)", "<let/__mxB=1/>"],
  ])(
    "refuses a reserved name in %s as the Marko shape does",
    (_label, source) => {
      const policy = fakeDeclarations({
        attrTags: 2,
        isComponent: (name) => name === "Panel",
      });
      const [mx, marko] = both(source, policy);
      expect(marko).toMatchObject({ message: /"__mx" are reserved/ });
      expect(mx).toEqual(marko);
    },
  );

  describe("refuses MX type arguments and type parameters", () => {
    const policy = fakeDeclarations({
      attrTags: 2,
      isComponent: (name) => name === "Panel",
    });
    const typeArgs = {
      type: "MxTypeArguments",
      node: { type: "TSTypeParameterInstantiation", params: [] },
      error: null,
      atoms: [],
      start: 1,
      end: 2,
    };
    const typeParams = { ...typeArgs, type: "MxTypeParameters" };
    it.each([
      ["typeArgs", "an element", "<div/>", "`<div>`"],
      ["typeArgs", "a component", "<Panel/>", "`<Panel>`"],
      ["typeArgs", "a control tag", "<for|i| of=input.xs>${i}</for>", "for"],
      ["typeParams", "an element", "<div>x</div>", "`<div>`"],
      ["typeParams", "a component", "<Panel>x</Panel>", "`<Panel>`"],
      ["typeParams", "a control tag", "<for|i| of=input.xs>${i}</for>", "for"],
    ])("%s on %s", (field, _label, source, what) => {
      const container = field === "typeArgs" ? typeArgs : typeParams;
      const run = () =>
        lowerSource(
          source,
          policy,
          undefined,
          undefined,
          undefined,
          reshaped(source, (body) => {
            body[0][field] = container;
          }),
        );
      expect(() => run()).toThrowError(
        new RegExp(`type arguments on .*${what}.* are not supported`),
      );
      // The same source with no container lowers.
      expect(both(source, policy)[0]).toHaveProperty("ir");
    });
  });

  it("keeps an unnamed MX tag's name as parsed after resolving it", () => {
    const source = "<div><.c>x</></div>";
    const policy = fakeDeclarations({ resolveDefaultTag: () => "span" });
    let seen: Node[] = [];
    lowerSource(
      source,
      policy,
      undefined,
      undefined,
      undefined,
      reshaped(source, (body) => {
        seen = body;
      }),
    );
    expect(seen[0].body[0].name).toEqual({
      kind: "unnamed",
      span: expect.any(Object),
    });
  });

  it("names the written tag in the arguments refusal from the MX name span", () => {
    const source = "<if=input.a>A</if><else-if(input.b)>B</else-if>";
    const messages: string[] = [];
    const refuse = (body: Node[], ctx: Ctx) => {
      try {
        rejectUnsupportedFields(ctx, body[1], "this tag");
      } catch (error) {
        messages.push((error as Error).message);
      }
      throw new Error("stop");
    };
    const stop = (reshape: (body: Node[], ctx: Ctx) => void) =>
      expect(() =>
        lowerSource(
          source,
          undefined,
          undefined,
          undefined,
          undefined,
          reshape,
        ),
      ).toThrow("stop");
    stop(refuse);
    stop((body, ctx) => {
      toMxShape(source)(body);
      // A parsed name that differs from the source: only the span names it.
      body[1].name = { ...body[1].name, value: "zz" };
      refuse(body, ctx);
    });
    expect(messages[0]).toContain("<else-if=condition>");
    expect(messages[1]).toEqual(messages[0]);
  });
});

describe("hybrid attributes, MX-shaped (PR 4 slice 4)", () => {
  const reshaped =
    (source: string, extra?: (body: Node[]) => void) => (body: Node[]) => {
      toMxShape(source)(body);
      extra?.(body);
    };
  /** What a lowering produced: its IR, or the error as a reporter reads it. */
  const outcome = (run: () => Ir) => {
    try {
      return { ir: run() };
    } catch (error) {
      const e = error as TranslateError;
      return { message: e.message, line: e.line, column: e.column };
    }
  };
  const mx = (
    source: string,
    policy = fakeDeclarations(),
    extra?: (body: Node[]) => void,
  ) =>
    outcome(() =>
      lowerSource(
        source,
        policy,
        undefined,
        undefined,
        undefined,
        reshaped(source, extra),
      ),
    );
  const marko = (source: string, policy = fakeDeclarations()) =>
    outcome(() => lowerSource(source, policy));
  const components = (overrides: Partial<Policy> = {}) =>
    fakeDeclarations({
      isComponent: (name) => name === "Foo",
      ...overrides,
    });
  const methods = (overrides: Partial<Policy> = {}) =>
    components({ resolveAttributeMethod: () => true, ...overrides });
  /** The first tag's attributes after the reshape. */
  const attributesOf = (source: string): Node[] => {
    let seen: Node[] = [];
    try {
      lowerSource(source, undefined, undefined, undefined, undefined, (b) => {
        toMxShape(source)(b);
        seen = b[0].attributes;
      });
    } catch {
      // Only the shape matters here.
    }
    return seen;
  };

  it("reshapes attributes as the MX front end parses them", () => {
    // The front end's own parse of this input (probed; containers trimmed).
    expect(attributesOf("<div a=1 b:=x c(){} ...s/>")).toMatchObject([
      {
        type: "MxAttribute",
        start: 5,
        end: 8,
        name: "a",
        nameSpan: { start: 5, end: 6 },
        modifier: null,
        modifierSpan: null,
        operator: "=",
        value: { type: "MxExpression", start: 7, end: 8, source: "1" },
        args: null,
      },
      {
        type: "MxAttribute",
        start: 9,
        end: 13,
        name: "b",
        nameSpan: { start: 9, end: 10 },
        operator: ":=",
        value: { type: "MxExpression", start: 12, end: 13, source: "x" },
      },
      {
        type: "MxAttribute",
        start: 14,
        end: 19,
        name: "c",
        nameSpan: { start: 14, end: 15 },
        operator: null,
        value: {
          type: "MxMethod",
          start: 15,
          end: 19,
          async: false,
          typeParams: null,
          params: {
            type: "MxParameterList",
            start: 16,
            end: 16,
            outer: { start: 15, end: 17 },
            node: [],
          },
          body: {
            type: "MxStatements",
            start: 18,
            end: 18,
            outer: { start: 17, end: 19 },
            node: [],
            directives: [],
            innerComments: [],
          },
          source: "(){}",
        },
        args: null,
      },
      {
        type: "MxSpreadAttribute",
        start: 20,
        end: 24,
        value: { type: "MxExpression", start: 23, end: 24, source: "s" },
      },
    ]);
  });

  it("reshapes a modifier and the default value", () => {
    const [modified] = attributesOf("<div class:x=1/>");
    expect(modified).toMatchObject({
      name: "class",
      nameSpan: { start: 5, end: 10 },
      modifier: "x",
      modifierSpan: { start: 11, end: 12 },
    });
    const [value] = attributesOf("<Foo=1/>");
    expect(value).toMatchObject({ name: null, value: { source: "1" } });
  });

  it.each([
    ["static, dynamic and boolean values", "<div a=1 b=x c='s' download/>"],
    ["an ordinary colon name", "<div value:foo:bar=1 x:=y/>"],
    ["bound attributes", "<Foo v:=q w:fn:=r/>"],
    ["event attributes", "<div onClick=fn on-my-event=g/>"],
    ["an event's string and boolean forms", "<div onClick onclick='x()'/>"],
    ["spreads", "<div ...s a=1/><Foo ...t/>"],
    ["the default value", "<Foo=1/><Foo=x b=2/>"],
    ["a whole-value atom", "<Foo mode=:strict/>"],
    ["an if chain", "<if=a>A</if><else-if=b>B</else-if><else>C</else>"],
    ["a for of with a string by", '<for|x| of=xs by="id">${x}</for>'],
    ["a for range", "<for|i| from=0 to=3 step=1>${i}</for>"],
    ["a for in with a by function", "<for|k| in=o by=(k) => k>${k}</for>"],
    ["a const", "<const/x=1/>${x}"],
    ["a return", "<return=1/>"],
    ["a return spelled value=", "<return value=1/>"],
  ])("lowers %s to the IR the Marko shape lowers to", (_label, source) => {
    const policy = components();
    const ir = marko(source, policy);
    expect(ir).toHaveProperty("ir");
    expect(mx(source, policy)).toEqual(ir);
  });

  it.each([
    ["an element method", "<div onClick(e){ go(e) }/>"],
    ["a component method", "<Foo render(x) { return x }/>"],
    ["a default method", "<Foo(x){ y }/>"],
    ["an async default method", "<Foo async(x){ await x }/>"],
    ["a method with type parameters", "<Foo m<T>(a: T) { a }/>"],
    ["a comment-only body", "<Foo m(a) { /* c */ }/>"],
    ["a directive", "<Foo m(a) { 'use strict'; a }/>"],
    ["a multi-line method", "<Foo\n  m(a,\n    b) {\n    a(b)\n  }/>"],
  ])(
    "lowers %s to the same IR, function and body span included",
    (_label, source) => {
      const ir = marko(source, methods());
      expect(ir).toHaveProperty("ir");
      expect(mx(source, methods())).toEqual(ir);
    },
  );

  it.each([
    ["a modifier with no host resolution", "<div class:x=1/>"],
    ["a bad refinement", "<Foo v:no-update:=q/>"],
    ["a bound non-identifier", "<Foo v:=a + b/>"],
    ["`on:`", "<div on:/>"],
    ["a refused element method", "<div onClick(e){ go(e) }/>"],
    ["refused arguments", "<div c(x)/>"],
    ["a function on a colon name", "<div data:x(e){ e }/>"],
    ["arguments on a colon name", "<div data:x(a)/>"],
    ["an invalid name", "<div a{b}=1/>"],
    ["a valueless for of", "<for of>x</for>"],
    ["a method for of", "<for of(x){ x }>x</for>"],
    ["arguments on for by", "<for|x| of=xs by(a)>x</for>"],
    ["a string by on a range", '<for|i| to=3 by="id">${i}</for>'],
    ["a duplicate let value", "<let/x=1 value=2/>"],
    ["a return extra", "<return=1 extra=2/>"],
    ["a return valueChange", "<return=1 valueChange=f/>"],
    ["an extra const attribute", "<const/x=1 y=2/>"],
    ["a trailing colon", "<div data:=1 x:/>"],
    ["a valueless if", "<if>A</if>"],
  ])("fails %s as the Marko shape does", (_label, source) => {
    const policy = components();
    const error = marko(source, policy);
    expect(error).toHaveProperty("message");
    expect(mx(source, policy)).toEqual(error);
  });

  it("hands a host hook the default value as `value`", () => {
    const names: string[] = [];
    const policy = components({
      resolveAttributeMethod: () => false,
      rejectAttributeMethod: (attr) => {
        names.push(String(attr.name));
      },
    });
    const source = "<Foo(x){ y }/>";
    const error = marko(source, policy);
    expect(mx(source, policy)).toEqual(error);
    expect(error).toMatchObject({
      message: expect.stringContaining("attribute method `value(...)`"),
    });
    expect(names).toEqual(["value", "value"]);
  });

  it("rebuilds a method as Marko's FunctionExpression", () => {
    const source = "<Foo m<T>(a: T) { /* c */ }/>";
    const fn = (shape: "marko" | "mx") => {
      const result =
        shape === "mx" ? mx(source, methods()) : marko(source, methods());
      const component = (result as { ir: Ir }).ir.body[0] as Extract<
        IrNode,
        { kind: "Component" }
      >;
      const attr = component.attrs[0] as { value: { node: Node } };
      return attr.value.node;
    };
    const rebuilt = fn("mx");
    expect(rebuilt).toEqual(fn("marko"));
    expect(rebuilt).toMatchObject({
      type: "FunctionExpression",
      typeParameters: null,
      body: { innerComments: [{ type: "CommentBlock", value: " c " }] },
    });
  });

  it("fails an unparsed attribute value at its MxParseError", () => {
    const source = "<div a=x b=y/>";
    const result = mx(source, components(), (body) => {
      const [, b] = body[0].attributes;
      b.value = {
        ...b.value,
        node: null,
        error: {
          type: "MxParseError",
          code: "BABEL_UnexpectedToken",
          origin: "expression",
          message: "Unexpected token",
          context: null,
          start: 11,
          end: 11,
        },
      };
    });
    expect(result).toEqual({
      message: "Unexpected token",
      line: 1,
      column: 11,
    });
  });

  it("refuses a trigger in an attribute value (decision 182 seam)", () => {
    const source = "<div a=x/>";
    const result = mx(source, components(), (body) => {
      body[0].attributes[0].value.triggers = [
        { type: "MxTrigger", id: "fmt", start: 7, end: 8 },
      ];
    });
    expect(result).toEqual({
      message: "`fmt` trigger has no lowering yet",
      line: 1,
      column: 7,
    });
  });

  it("fails an unparsed spread value at its MxParseError", () => {
    const source = "<div ...s/>";
    const result = mx(source, components(), (body) => {
      const [spread] = body[0].attributes;
      spread.value = {
        ...spread.value,
        node: null,
        error: {
          type: "MxParseError",
          code: "BABEL_UnexpectedToken",
          origin: "expression",
          message: "Unexpected token",
          context: null,
          start: 8,
          end: 8,
        },
      };
    });
    expect(result).toEqual({ message: "Unexpected token", line: 1, column: 8 });
  });
});

/**
 * Every source of `name-sugar.test.ts` the MX front end accepts (121 of 178;
 * the other 57 fail there at token level, before lowering, with an
 * `MX_SUGAR_*`/`MX_SECOND_NAME`/`MX_SHORTHAND_INVALID`/`MX_COLON_BEFORE_DYNAMIC`
 * code).
 */
const SUGAR_SOURCES: readonly string[] = [
  "<input:email/>",
  "<a.c:b/>",
  "<a#d:b.c/>",
  "<a.c:b#d/>",
  "<a:b.c#d/>",
  "<a:b#d/>",
  "<a.hover:x/>",
  "<a.c.d:b/>",
  "<a.c:b.d/>",
  "<a.c-d:first-name/>",
  "<:email/>",
  "<:b.c/>",
  "<:b#d.c/>",
  "<a.${x}:b/>",
  "<a.c${x}/>",
  "<a.c.${x}:b/>",
  "<${x}:b/>",
  "<a :b/>",
  "<a x=1 :b/>",
  "<a x=1 ? y : z :b/>",
  "<a #b/>",
  "<a x=1 #b/>",
  "<a .b/>",
  "<a x=a.b .c/>",
  "<a x=(a.b .c)/>",
  "<a .b .c/>",
  "<a.d .b/>",
  "<a.d.e .b .c/>",
  "<a .b:c/>",
  "<a #b:c/>",
  "<div.a #m .b/>",
  "<div.a.b#m/>",
  "<div.a class={a: true} .b/>",
  "<div.a.b class={a: true}/>",
  "<div.${y} class=x .d/>",
  "<div.${y}.d class=x/>",
  "<a class=x .b/>",
  "<a #b #c/>",
  "<a :b :c/>",
  "<a#d #e/>",
  "<a:b :c/>",
  "<a x:foo/>",
  "<a value:foo/>",
  "<a value:/>",
  "<div #ref/>",
  "<svg:rect/>",
  "<div#x/>",
  "<div.b/>",
  "<div .b/>",
  "<div :b/>",
  "<a#d:b/>",
  "<a.c #m .b/>",
  "<div #1a/>",
  "<div#1a/>",
  "<div .2xl/>",
  "<div.2xl/>",
  "<div .\u00e9/>",
  "<div.\u00e9/>",
  "<div .a@b/>",
  "<div.a@b/>",
  "<div .a+b/>",
  "<div.a+b/>",
  "<div #a-b_c$d/>",
  "<div#a-b_c$d/>",
  "<div .c.d/>",
  "<div.c.d/>",
  "<div .c#m.d/>",
  "<div.c#m.d/>",
  "<div.a${x}/>",
  "<div x:/>",
  "<field #a #b/>",
  "<input :a :b/>",
  "<div><@svg:rect/></div>",
  "<div.b class=false/>",
  "<div class=false .b/>",
  "<div class=0 .b/>",
  "<div.b class=0/>",
  "<div class=null .b/>",
  "<div.b class=null/>",
  "<div class=undefined .b/>",
  "<div.b class=undefined/>",
  "<div .b class=false/>",
  "<div .b class=0/>",
  "<div class=1 .b/>",
  "<div class=true .b/>",
  "<div .b class=1/>",
  "<div .b class=true/>",
  "<a #x=1/>",
  "<a :x=input.y/>",
  "<a .c=1/>",
  "<a x=1 #y=2/>",
  "<a #x=1 y=2/>",
  "<a:x=1/>",
  "<a#x=1/>",
  "<a.c=1/>",
  "<kind #name(p){b}/>",
  "<kind (p){b} #name/>",
  "<a #x=input.y/>",
  "<if=input.a #x=1>y</if>",
  "<a #x=1 #y=2/>",
  "<a value=1 #x=2/>",
  "<a:x=1 #y=2/>",
  "<a=input.o .c/>",
  "<input value=1 value=2 #r=x/>",
  "<input :n=1/>",
  "<input value=1 :n=2/>",
  "<a value:=y #x=1/>",
  "<a #x=1 value:=y/>",
  "<a value:=y :n=1/>",
  "<input\n  value=1\n  #x=2/>",
  "<a#x=1 value=2/> is decision 135's warning, not the double-default error",
  "<a#x=1 value=2/>",
  "<a #x:=y/>",
  "<div.bg-[#fff]/>",
  "<div .bg-[#fff]/>",
  "<div.w-1.5/>",
  "<div .w-1.5/>",
  "<div.2xl.3xl/>",
  "<div.hover:bg-red/>",
  "<div.a.b#c/>",
  "<div.w-1/>",
];

/**
 * Shapes the corpus does not reach: a templated part with a `:name`,
 * attribute tags (sugar on one, in one), a method after a sugar, a comment
 * between sugars, merged arrays, default-value order, a control-flow body.
 */
const SUGAR_EDGE_SOURCES: readonly string[] = [
  "<a.c${x}:b/>",
  "<a.c${x}d:b/>",
  "<Panel><@row .x/></Panel>",
  "<Panel><@row.x/></Panel>",
  "<Panel><@row><div.a/></@row></Panel>",
  "<Panel><@row><:email/></@row></Panel>",
  "<a .c(p){ p }/>",
  "<a :n(p){ p }/>",
  "<div#x id=y/>",
  '<div.a class="b" .c #d/>',
  "<if=x><div.a :b/></if>",
  "<for|i| of=input.xs><li.item:row #r/></for>",
  "<div.a/* c */ .b/>",
  "<div.a.b class=[x, y]/>",
  "<div .a=1 value=2/>",
  "<div value=1 .a=2/>",
  "<a .c=x .d=y/>",
  "<a #x .y :z/>",
  "<Foo:bar.baz/>",
];

describe("hybrid name sugar, MX-shaped (PR 4 slice 4, family 3)", () => {
  const reshaped =
    (source: string, extra?: (body: Node[]) => void) => (body: Node[]) => {
      toMxShape(source)(body);
      extra?.(body);
    };
  const outcome = (run: () => Ir) => {
    try {
      return { ir: run() };
    } catch (error) {
      const e = error as TranslateError;
      return { message: e.message, line: e.line, column: e.column };
    }
  };
  const sugar = (overrides: Partial<Policy> = {}) =>
    fakeDeclarations({ resolveDefaultTag: () => "input", ...overrides });
  const angular = sugar({
    acceptsForeignAttrNames: true,
    claimsAttributeHash: true,
  });
  const both = (
    source: string,
    policy: Policy,
    extra?: (body: Node[]) => void,
  ) => [
    outcome(() =>
      lowerSource(
        source,
        policy,
        undefined,
        undefined,
        undefined,
        reshaped(source, extra),
      ),
    ),
    outcome(() => lowerSource(source, policy)),
  ];

  it.each([...SUGAR_SOURCES, ...SUGAR_EDGE_SOURCES])(
    "lowers %j as the Marko shape does",
    (source) => {
      const [mx, marko] = both(source, sugar());
      expect(mx).toEqual(marko);
    },
  );

  it.each([...SUGAR_SOURCES, ...SUGAR_EDGE_SOURCES])(
    "lowers %j as the Marko shape does on a host claiming `#`",
    (source) => {
      const [mx, marko] = both(source, angular);
      expect(mx).toEqual(marko);
    },
  );

  it.each([
    "<Panel><@row .x/></Panel>",
    "<Panel><@row.x :y/></Panel>",
    "<Panel><@row><div.a :b/></@row></Panel>",
    "<Panel><@row><:email/></@row></Panel>",
  ])("lowers %j inside a component's attribute tags", (source) => {
    const policy = sugar({
      attrTags: 2,
      isComponent: (name) => name === "Panel",
    });
    const [mx, marko] = both(source, policy);
    expect(marko).toHaveProperty("ir");
    expect(mx).toEqual(marko);
  });

  it.each([
    "<div.a.b#m class=x .c :n/>",
    '<div.a class="b" .c=1/>',
    "<a.${x}:b/>",
    "<a.c${x}:b/>",
    "<a value=1 #i/>",
  ])("leaves the MX tree of %j as parsed", (source) => {
    let before = "";
    let tree: Node[] = [];
    const run = () =>
      lowerSource(
        source,
        sugar(),
        undefined,
        undefined,
        undefined,
        reshaped(source, (body) => {
          tree = body;
          before = JSON.stringify(body);
        }),
      );
    expect(outcome(run)).toEqual(outcome(() => lowerSource(source, sugar())));
    expect(JSON.stringify(tree)).toBe(before);
  });

  it("reshapes sugar as the front end splits it", () => {
    const shapes = (source: string) => {
      const body: Node[] = [];
      // Only the reshape is under test; whatever lowering makes of it.
      outcome(() =>
        lowerSource(source, sugar(), undefined, undefined, undefined, (b) => {
          toMxShape(source)(b);
          body.push(...b);
        }),
      );
      const tag = body[0];
      const brief = (each: Node) => ({
        sigil: each.sigil,
        position: each.position,
        value: each.value.kind === "static" ? each.value.value : "dynamic",
        start: each.start,
        end: each.end,
        operator: each.operator,
      });
      return {
        name: tag.name,
        shorthands: tag.shorthands.map(brief),
        attributes: tag.attributes.map((each: Node) =>
          each.type === "MxShorthand" ? brief(each) : each.type,
        ),
      };
    };
    // The front end's own split, probed (see the PR 4 report's table).
    expect(shapes("<input:email/>")).toMatchObject({
      name: { kind: "static", value: "input", span: { start: 1, end: 6 } },
      shorthands: [{ sigil: ":", position: "tag", start: 6, end: 12 }],
      attributes: [],
    });
    expect(shapes("<:title/>")).toMatchObject({
      name: { kind: "unnamed", span: { start: 1, end: 1 } },
      shorthands: [{ sigil: ":", value: "title", start: 1, end: 7 }],
    });
    expect(shapes("<a.c:b#d/>").shorthands).toEqual([
      {
        sigil: ".",
        position: "tag",
        value: "c",
        start: 2,
        end: 4,
        operator: null,
      },
      {
        sigil: ":",
        position: "tag",
        value: "b",
        start: 4,
        end: 6,
        operator: null,
      },
      {
        sigil: "#",
        position: "tag",
        value: "d",
        start: 6,
        end: 8,
        operator: null,
      },
    ]);
    expect(shapes('<div.a .b class="c"/>')).toMatchObject({
      shorthands: [{ sigil: ".", value: "a", start: 4, end: 6 }],
      attributes: [
        { sigil: ".", position: "attribute", value: "b", start: 7, end: 9 },
        "MxAttribute",
      ],
    });
    expect(shapes("<Foo .c=x/>").attributes).toEqual([
      {
        sigil: ".",
        position: "attribute",
        value: "c",
        start: 5,
        end: 7,
        operator: "=",
      },
    ]);
    expect(shapes("<div.${x}/>").shorthands).toEqual([
      {
        sigil: ".",
        position: "tag",
        value: "dynamic",
        start: 4,
        end: 9,
        operator: null,
      },
    ]);
  });
});

describe("hybrid module statements and the signature, MX-shaped (PR 4 slice 6)", () => {
  /** What a lowering produced: its IR, or the error as a reporter reads it. */
  const outcome = (run: () => Ir) => {
    try {
      return { ir: run() };
    } catch (error) {
      const e = error as TranslateError;
      return { message: e.message, line: e.line, column: e.column };
    }
  };
  const both = (source: string, policy = fakeDeclarations()) => [
    outcome(() =>
      lowerSource(
        source,
        policy,
        undefined,
        undefined,
        undefined,
        toMxShape(source),
      ),
    ),
    outcome(() => lowerSource(source, policy)),
  ];
  const thrown = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      const e = error as TranslateError;
      return { message: e.message, line: e.line, column: e.column, e };
    }
    throw new Error("no error thrown");
  };
  const ctxFor = (source: string) =>
    newCtx(
      source,
      printExpression,
      fakeDeclarations(),
      undefined,
      "test.mx",
      lookup,
    );

  it("takes the MX AST, published as Node until PR 5", () => {
    // Ruling B: the internal walk is typed `readonly MxChild[]` straight from
    // `@mxlang/babel/mx-ast` (one declaration, so no drift to pin); the
    // published entries stay `readonly Node[]` because the .d.ts may not name
    // the private package. PR 5 narrows these two.
    expectTypeOf(lower).parameter(1).toEqualTypeOf<readonly Node[]>();
    expectTypeOf(lowerChildren).parameter(1).toEqualTypeOf<readonly Node[]>();
    expectTypeOf<readonly MxChild[]>().toExtend<Parameters<typeof lower>[1]>();
  });

  it("reshapes a statement tag into an MxModuleStatement", () => {
    const source = "static const x = 1;   \n<div/>";
    let seen: Node[] = [];
    lowerSource(source, undefined, undefined, undefined, undefined, (b) => {
      toMxShape(source)(b);
      seen = b;
    });
    expect(seen[0]).toMatchObject({
      type: "MxModuleStatement",
      keyword: "static",
      code: { type: "MxStatements", start: 7, end: 19 },
      start: 0,
      end: 19,
      untrimmedEnd: 22,
    });
    expect(seen[0]).not.toHaveProperty("loc");
  });

  const sources = [
    'import a from "./a"\n<div/>',
    'import { b, type C } from "./b"\n<div>${b}</div>',
    'import Card from "./card.mx"\n<Card/>',
    "import * as ns from 'ns'\n\n\n<p>${ns.x}</p>",
    "static const x = 1;   \n<div>${x}</div>",
    "static function f(a: number) {\n  return a;\n}\n<p>${f(1)}</p>",
    "export interface Input { a: string }\n<p>${input.a}</p>",
    "export type Input = { a: string }\n<p/>",
    "export const y = 1\n<p/>",
    "server const y = 1\n<p/>",
    "client foo()\n<p/>",
    "class {}\n<p/>",
    "static const = 1\n<p/>",
    "static const x = <div/>\n<p/>",
    "import a from 'a'\nimport a from 'b'\n<p/>",
    "static const input = 1\n<p/>",
    'import Foo from "./foo"\n<Foo/x/>\n<p>${x}</p>',
    "<p/>\nstatic let n = 0\n<p>${n}</p>",
  ];
  for (const source of sources) {
    it(`same IR or error on Marko and MX: ${JSON.stringify(source)}`, () => {
      const [mx, marko] = both(source);
      expect(mx).toEqual(marko);
    });
  }

  it("lowers an import's IR span, start and untrimmed end", () => {
    const source = "import a from 'a'   \n<p/>";
    const [mx] = both(source);
    expect(mx?.ir?.imports[0]).toMatchObject({
      kind: "Import",
      code: "import a from 'a'",
      loc: { line: 1, column: 0 },
      end: { line: 1, column: 20 },
      span: { sourceStart: 0, sourceEnd: 17 },
    });
  });

  it("lowers an MxModuleStatement through the exported lowerChildren", () => {
    const source = "import a from 'a';\n";
    const statement = {
      type: "MxModuleStatement",
      keyword: "import",
      code: { type: "MxStatements", start: 0, end: 18, node: [], error: null },
      start: 0,
      end: 18,
      untrimmedEnd: 19,
    };
    expect(lowerChildren(ctxFor(source), [statement])).toMatchObject([
      { kind: "Import", code: "import a from 'a';", bindings: ["a"] },
    ]);
  });

  it("refuses a statement keyword the front end read as a tag", () => {
    const source = "<import a/>";
    const tag = {
      type: "MxTag",
      name: { kind: "static", value: "import", span: { start: 1, end: 7 } },
      attributes: [],
      shorthands: [],
      typeArgs: null,
      var: null,
      args: null,
      typeParams: null,
      params: null,
      body: null,
      start: 0,
      end: 11,
    };
    expect(thrown(() => lowerChildren(ctxFor(source), [tag]))).toMatchObject({
      message: expect.stringContaining(
        "`import` was parsed as a tag with attributes",
      ),
      line: 1,
      column: 0,
    });
  });

  it("checks a server statement's text by node kind", () => {
    const source = "<p/>\nserver const = 1";
    const statement = {
      type: "MxModuleStatement",
      keyword: "server",
      code: { type: "MxStatements", start: 12, end: 21, node: null },
      start: 5,
      end: 21,
      untrimmedEnd: 21,
    };
    expect(
      thrown(() => lowerChildren(ctxFor(source), [statement])),
    ).toMatchObject({ line: 2, column: 13 });
  });

  it("names a syntax-table node at child level and positions it (decision 182)", () => {
    const source = "<p/>\n&status=x\n{% if a %}\n::md:: b ::";
    const cases: [Node, string, number, number][] = [
      [
        {
          type: "MxTrigger",
          id: "status",
          position: "line",
          text: "&status",
          value: null,
          start: 5,
          end: 14,
        },
        "`status` trigger has no lowering yet",
        2,
        0,
      ],
      [
        {
          type: "MxBlockTag",
          value: " if a ",
          valueSpan: { start: 17, end: 23 },
          start: 15,
          end: 25,
        },
        "a block tag has no lowering yet",
        3,
        0,
      ],
      [
        {
          type: "MxFilter",
          name: "md",
          nameSpan: { start: 28, end: 30 },
          value: " b ",
          valueSpan: { start: 32, end: 35 },
          start: 26,
          end: 37,
        },
        "the `md` filter has no lowering yet",
        4,
        0,
      ],
    ];
    for (const [node, message, line, column] of cases) {
      expect(thrown(() => lowerChildren(ctxFor(source), [node]))).toMatchObject(
        { message, line, column },
      );
    }
  });

  it("still fails on an MX node kind lowering does not know", () => {
    const source = "ab";
    expect(
      thrown(() =>
        lowerChildren(ctxFor(source), [
          { type: "MxUnknown", start: 1, end: 2 },
        ]),
      ),
    ).toMatchObject({
      message: "`MxUnknown` has no lowering yet (not yours: an internal bug)",
      line: 1,
      column: 1,
    });
  });

  it("positions an MX-node error only against the file it is about", () => {
    const source = "ab\ncd";
    const node = { type: "MxText", start: 4, end: 5 };
    const same = thrown(() => fail("here", node, "test.mx")).e;
    positionError(ctxFor(source), same);
    expect([same.file, same.line, same.column]).toEqual(["test.mx", 2, 1]);

    // An error about another file keeps its offsets unresolved: this ctx's
    // lines would give it a wrong position, so the boundary refuses it.
    const other = thrown(() => fail("there", node, "other.mx")).e;
    positionError(ctxFor(source), other);
    expect([other.line, other.column]).toEqual([0, 0]);
    expect(() => assertPositioned(other)).toThrow(/not yours: an internal bug/);
  });

  it("refuses another file's unpositioned error at lower()'s boundary", () => {
    const source = "<div/>";
    const policy = fakeDeclarations({
      isElement: () => {
        fail("from elsewhere", { type: "MxText", start: 0, end: 1 }, "x.mx");
      },
    });
    const error = thrown(() =>
      lowerSource(
        source,
        policy,
        undefined,
        undefined,
        undefined,
        toMxShape(source),
      ),
    ).e;
    expect(error.file).toBe("x.mx");
    expect(() => assertPositioned(error)).toThrow(/not yours: an internal bug/);
  });
});
