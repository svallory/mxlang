/**
 * `markoViewOf`: the Marko-shaped view core hands every host hook while the
 * compile parses with the MX front end (decision 163 addendum, option A).
 *
 * Two halves. The first pins the view's fields on a real MX parse
 * (`parseMx`): names, `var`, attributes, modifiers, Marko `loc` values,
 * identity across calls and read-only-ness. The second drives every hook
 * kind through `compileSource` (the MX front end) and through Marko's own
 * parse (`@marko/compiler`'s `compileSync` with a lowering translator), with
 * a recording `HostDeclarations`, and asserts both paths hand the hook the
 * same fields and lower to the same IR (or fail with the same positioned
 * error).
 */
import { describe, expect, it } from "vitest";
import { compileSource, printExpression } from "./compile.ts";
import {
  type Ctx,
  DYNAMIC_TAG,
  type Node,
  newCtx,
  TranslateError,
} from "./core.ts";
import { STATEMENT_TAGLIB, STATEMENT_TAGLIB_ID } from "./core-taglib.ts";
import type { HostDeclarations } from "./declarations.ts";
import type { Ir } from "./ir.ts";
import { lower } from "./lower.ts";
import { markoCompiler } from "./marko-frontend.ts";
import { markoViewOf, mxNodeOf } from "./marko-view.ts";
import { parseMx } from "./mx-parse.ts";
import { resolveSyntax } from "./syntax-table.ts";
import { lookup } from "./test-targets.ts";

const FILE = "/tmp/mx-core-test/marko-view.mx";

function declarations(
  overrides: Partial<HostDeclarations> = {},
): HostDeclarations {
  return {
    tags: {},
    isElement: (name) => /^[a-z]/.test(name),
    isComponent: (name, ctx) => ctx.defines.has(name),
    ...overrides,
  };
}

/** A real MX parse and a lowering context over it, nothing lowered. */
function parsed(source: string): { ctx: Ctx; body: Node[] } {
  const document = parseMx(source, {
    syntax: resolveSyntax(FILE),
    lookup: undefined,
  });
  expect(document.errors).toEqual([]);
  const ctx = newCtx(
    source,
    printExpression,
    declarations(),
    undefined,
    FILE,
    lookup,
  );
  return { ctx, body: document.body };
}

function firstTag(body: Node[]): Node {
  return body.find((node) => node.type === "MxTag");
}

/** `[startLine, startColumn, endLine, endColumn]` of a Marko `loc`. */
function locOf(node: Node): number[] {
  const { start, end } = node.loc;
  return [start.line, start.column, end.line, end.column];
}

describe("markoViewOf on a real MX parse", () => {
  const source = [
    "<p>hi</p>",
    '<card/handle a=1 class:active=on b:=c on(e) { go(e) } ...rest key="k">',
    "  <@head>H</@head>",
    "  <if=x><@item>I</@item></if>",
    `  text \${value}`,
    "</card>",
    `<\${Comp}|row| (one, two)/>`,
    "",
  ].join("\n");

  it("views a tag: name, var, attributes, attribute tags, body", () => {
    const { ctx, body } = parsed(source);
    const tag = body.filter((node) => node.type === "MxTag")[1];
    const view = markoViewOf(ctx, tag);

    expect(view.type).toBe("MarkoTag");
    expect(view.name).toMatchObject({ type: "StringLiteral", value: "card" });
    expect(locOf(view.name)).toEqual([2, 1, 2, 5]);
    expect(view.var).toMatchObject({ type: "Identifier", name: "handle" });
    expect(view.arguments).toBeUndefined();
    expect(view.typeArguments).toBeUndefined();
    expect(
      view.attributes.map((attr: Node) => [
        attr.type,
        attr.name,
        attr.modifier,
        attr.bound,
      ]),
    ).toEqual([
      ["MarkoAttribute", "a", null, false],
      ["MarkoAttribute", "class", "active", false],
      ["MarkoAttribute", "b", null, true],
      ["MarkoAttribute", "on", null, false],
      ["MarkoSpreadAttribute", undefined, undefined, undefined],
      ["MarkoAttribute", "key", null, false],
    ]);
    // Marko moves attribute tags, and control flow holding one, out of the body.
    expect(view.attributeTags.map((t: Node) => t.name.value ?? t.name)).toEqual(
      ["@head", "if"],
    );
    expect(view.body.body.map((child: Node) => child.type)).toEqual([
      "MarkoText",
      "MarkoPlaceholder",
    ]);
    expect(view.body.body[1].value).toMatchObject({
      type: "Identifier",
      name: "value",
    });
    expect(view.body.params).toEqual([]);
    expect(locOf(view)).toEqual([2, 0, 6, 7]);
    expect(view.loc.start.index).toBe(tag.start);
    expect(view.start).toBe(tag.start);
    expect(view.end).toBe(tag.end);
  });

  it("views an attribute: value, modifier, bound, method, spread", () => {
    const { ctx, body } = parsed(source);
    const tag = body.filter((node) => node.type === "MxTag")[1];
    const [a, modifier, bound, method, spread] = markoViewOf(
      ctx,
      tag,
    ).attributes;

    expect(a.value).toMatchObject({ type: "NumericLiteral", value: 1 });
    expect(a.default).toBe(false);
    expect(locOf(a)).toEqual([2, 13, 2, 16]);
    expect(modifier.value).toMatchObject({ type: "Identifier", name: "on" });
    expect(bound.value).toMatchObject({ type: "Identifier", name: "c" });
    expect(method.value.type).toBe("FunctionExpression");
    expect(method.value.params.map((p: Node) => p.name)).toEqual(["e"]);
    expect(spread.value).toMatchObject({ type: "Identifier", name: "rest" });
  });

  it("names the default value `value`, as Marko did", () => {
    const { ctx, body } = parsed("<let/x=1/>\n");
    const [attr] = markoViewOf(ctx, firstTag(body)).attributes;
    expect(attr).toMatchObject({
      type: "MarkoAttribute",
      name: "value",
      default: true,
    });
    expect(attr.value).toMatchObject({ type: "NumericLiteral", value: 1 });
  });

  it("views a dynamic tag: name is the expression, params and arguments", () => {
    const { ctx, body } = parsed(source);
    const tag = body.filter((node) => node.type === "MxTag")[2];
    const view = markoViewOf(ctx, tag);
    expect(view.name).toMatchObject({ type: "Identifier", name: "Comp" });
    expect(view.name.loc.start).toMatchObject({ line: 7, column: 3 });
    expect(view.body.params.map((p: Node) => p.name)).toEqual(["row"]);
    expect(view.arguments.map((a: Node) => a.name)).toEqual(["one", "two"]);
  });

  it("is one view per node, with stable field identity", () => {
    const { ctx, body } = parsed(source);
    const tag = body.filter((node) => node.type === "MxTag")[1];
    const view = markoViewOf(ctx, tag);
    expect(markoViewOf(ctx, tag)).toBe(view);
    expect(view.attributes).toBe(view.attributes);
    expect(view.attributes[0]).toBe(markoViewOf(ctx, tag.attributes[0]));
    expect(view.body).toBe(view.body);
    expect(view.body.body).toBe(view.body.body);
    expect(view.name).toBe(view.name);
    expect(view.loc).toBe(view.loc);
    expect(mxNodeOf(view)).toBe(tag);
  });

  it("is one view per node and ctx: each ctx's loc is its own source's", () => {
    // Offset 5 is line 2, column 0 of the first source and line 1, column 5
    // of the second: one node, two compiles, two positions.
    const { ctx: first, body } = parsed("<p/>\n<a/>");
    const tag = body.filter((node) => node.type === "MxTag")[1];
    const second = newCtx(
      "  xyz<a/>",
      printExpression,
      declarations(),
      undefined,
      FILE,
      lookup,
    );
    const one = markoViewOf(first, tag);
    const two = markoViewOf(second, tag);
    expect(two).not.toBe(one);
    expect(locOf(one)).toEqual([2, 0, 2, 4]);
    expect(locOf(two)).toEqual([1, 5, 1, 9]);
    expect(one.name.loc.start).toMatchObject({ line: 2, column: 1 });
    expect(two.name.loc.start).toMatchObject({ line: 1, column: 6 });
    // Each ctx keeps its own view, in either order of first use.
    expect(markoViewOf(first, tag)).toBe(one);
    expect(markoViewOf(second, tag)).toBe(two);
    expect(mxNodeOf(one)).toBe(tag);
    expect(mxNodeOf(two)).toBe(tag);
  });

  it("is read-only and never writes to the MX tree", () => {
    const { ctx, body } = parsed(source);
    const tag = body.filter((node) => node.type === "MxTag")[1];
    const before = JSON.stringify(tag);
    const view = markoViewOf(ctx, tag);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.attributes)).toBe(true);
    expect(Object.isFrozen(view.body)).toBe(true);
    expect(Object.isFrozen(view.body.body)).toBe(true);
    expect(Object.isFrozen(view.attributeTags)).toBe(true);
    expect(Object.isFrozen(view.loc.start)).toBe(true);
    expect(() => {
      view.name = "other";
    }).toThrow(TypeError);
    expect(() => {
      view.attributes.push({});
    }).toThrow(TypeError);
    expect(() => {
      view.attributes[0].name = "other";
    }).toThrow(TypeError);
    expect(JSON.stringify(tag)).toBe(before);
  });

  it("passes a node that is not an MX node through unchanged", () => {
    const { ctx } = parsed("<p/>\n");
    const babel = { type: "Identifier", name: "x" };
    const marko = { type: "MarkoAttribute", name: "id", value: babel };
    expect(markoViewOf(ctx, babel)).toBe(babel);
    expect(markoViewOf(ctx, marko)).toBe(marko);
    expect(markoViewOf(ctx, null)).toBeNull();
    expect(markoViewOf(ctx, undefined)).toBeUndefined();
    expect(mxNodeOf(marko)).toBe(marko);
  });
});

/** What a hook saw of a tag, read the way a Marko-era host reads it. */
function tagSummary(node: Node): unknown {
  return {
    type: node.type,
    name:
      node.name?.type === "StringLiteral" ? node.name.value : node.name?.type,
    var: node.var?.name ?? null,
    attributes: (node.attributes ?? []).map((attr: Node) => [
      attr.type,
      attr.name,
      attr.modifier ?? null,
    ]),
    attributeTags: (node.attributeTags ?? []).map(
      (tag: Node) => tag.name?.value,
    ),
    params: (node.body?.params ?? []).length,
    loc: node.loc ? locOf(node).slice(0, 2) : null,
  };
}

function attrSummary(attr: Node): unknown {
  return {
    type: attr.type,
    name: attr.name,
    modifier: attr.modifier ?? null,
    value: attr.value?.type,
    loc: locOf(attr).slice(0, 2),
  };
}

type Seen = Array<[string, unknown]>;
type Outcome = {
  ir?: Ir;
  error?: { message: string; line: number; column: number };
};

/** Lowers `source` through the MX front end (`compileSource`). */
function viaMx(source: string, decls: HostDeclarations): Outcome {
  let ir: Ir | undefined;
  try {
    compileSource(source, FILE, decls, {
      targets: lookup,
      emitIr: (lowered) => {
        ir = lowered;
        return "";
      },
    });
  } catch (error) {
    return { error: errorOf(error) };
  }
  return { ir };
}

/** Lowers `source` through Marko's own parse, as core did before PR 5. */
function viaMarko(source: string, decls: HostDeclarations): Outcome {
  let ir: Ir | undefined;
  let thrown: unknown;
  const translator = {
    taglibs: [[STATEMENT_TAGLIB_ID, STATEMENT_TAGLIB]],
    tagDiscoveryDirs: [] as string[],
    translate: {
      Program: {
        exit(path: { node: { body: Node[] } }) {
          const ctx = newCtx(
            source,
            printExpression,
            decls,
            undefined,
            FILE,
            lookup,
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
  markoCompiler().compileSync(source, FILE, {
    translator,
    output: "html",
    writeVersionComment: false,
  });
  if (thrown) return { error: errorOf(thrown) };
  return { ir };
}

function errorOf(error: unknown): {
  message: string;
  line: number;
  column: number;
} {
  if (!(error instanceof TranslateError)) throw error;
  return {
    message: error.message.replace(/^.*?: /, ""),
    line: error.line,
    column: error.column,
  };
}

/**
 * The IR without what differs by front door only: Babel payload nodes
 * (`node`, another parse's objects) and `exportName`, which `compileSource`
 * sets and a bare `lower()` does not.
 */
function comparable(ir: Ir | undefined): unknown {
  return JSON.parse(
    JSON.stringify(ir ?? null, (key, value) =>
      key === "node" || key === "exportName" ? undefined : value,
    ),
  );
}

/** Runs one input through both paths with fresh recorders and compares. */
function bothPaths(
  source: string,
  make: (seen: Seen) => HostDeclarations,
): { mx: Outcome; marko: Outcome; mxSeen: Seen; markoSeen: Seen } {
  const mxSeen: Seen = [];
  const markoSeen: Seen = [];
  const mx = viaMx(source, make(mxSeen));
  const marko = viaMarko(source, make(markoSeen));
  // Every input reaches its hook: an empty record would pass vacuously.
  expect(mxSeen.length).toBeGreaterThan(0);
  expect(mxSeen).toEqual(markoSeen);
  expect(mx.error).toEqual(marko.error);
  if (!mx.error) expect(comparable(mx.ir)).toEqual(comparable(marko.ir));
  return { mx, marko, mxSeen, markoSeen };
}

describe("every hook sees the Marko-shaped view, on both parses", () => {
  it("resolveDelegatedTag: a claimed tag and a dynamic tag", () => {
    const { mxSeen } = bothPaths(
      `<claim/v a=1 class="c">body</claim>\n<\${Comp} x=2/>\n`,
      (seen) =>
        declarations({
          isDelegatedTag: (name) => name === "claim" || name === DYNAMIC_TAG,
          resolveDelegatedTag(name, node) {
            seen.push(["resolveDelegatedTag", tagSummary(node)]);
            return { name, head: node.name.name ?? node.name.value };
          },
        }),
    );
    expect(mxSeen).toEqual([
      [
        "resolveDelegatedTag",
        {
          type: "MarkoTag",
          name: "claim",
          var: "v",
          attributes: [
            ["MarkoAttribute", "a", null],
            ["MarkoAttribute", "class", null],
          ],
          attributeTags: [],
          params: 0,
          loc: [1, 0],
        },
      ],
      [
        "resolveDelegatedTag",
        expect.objectContaining({ name: "Identifier", loc: [2, 0] }),
      ],
    ]);
  });

  it("resolveModifier: accepted as target syntax", () => {
    bothPaths("<div class:active=on/>\n", (seen) =>
      declarations({
        resolveModifier(attr, on) {
          seen.push([
            "resolveModifier",
            { ...(attrSummary(attr) as object), on },
          ]);
          return `${attr.name}:${attr.modifier}`;
        },
      }),
    );
  });

  it("rejectModifier: the host's error, positioned at the attribute", () => {
    const { mx, mxSeen } = bothPaths(
      "<p>x</p>\n<div class:active=on/>\n",
      (seen) =>
        declarations({
          rejectModifier(attr, on) {
            seen.push([
              "rejectModifier",
              { ...(attrSummary(attr) as object), on },
            ]);
            throw new TranslateError(
              `no ${attr.name}:${attr.modifier}`,
              attr.loc.start.line,
              attr.loc.start.column,
            );
          },
        }),
    );
    expect(mx.error).toEqual({
      message: "no class:active",
      line: 2,
      column: 5,
    });
    expect(mxSeen).toHaveLength(1);
  });

  it("resolveAttributeMethod: a method attribute carried as a prop", () => {
    bothPaths("<div onClick(e) { go(e) }/>\n", (seen) =>
      declarations({
        resolveAttributeMethod(attr, on) {
          seen.push([
            "resolveAttributeMethod",
            { ...(attrSummary(attr) as object), on },
          ]);
          return true;
        },
      }),
    );
  });

  it("rejectAttributeMethod: the host's error", () => {
    const { mx } = bothPaths("<div onClick(e) { go(e) }/>\n", (seen) =>
      declarations({
        resolveAttributeMethod: () => false,
        rejectAttributeMethod(attr) {
          seen.push(["rejectAttributeMethod", attrSummary(attr)]);
          throw new TranslateError(
            `no method ${attr.name}`,
            attr.loc.start.line,
            attr.loc.start.column,
          );
        },
      }),
    );
    expect(mx.error?.message).toBe("no method onClick");
  });

  it("resolveAttributeMethod: handed the tag by the tag-arguments hint", () => {
    const { mx, mxSeen } = bothPaths("<button(click)=go/>\n", (seen) =>
      declarations({
        resolveAttributeMethod(node) {
          seen.push(["resolveAttributeMethod", tagSummary(node)]);
          return true;
        },
      }),
    );
    expect(mxSeen[0]?.[1]).toMatchObject({ type: "MarkoTag", name: "button" });
    expect(mx.error?.message).toContain("onClick=go");
  });

  it("resolveDefaultTag: the unnamed tag and its parents", () => {
    const { mxSeen } = bothPaths(
      "<section>\n  <.card>x</>\n</section>\n",
      (seen) =>
        declarations({
          resolveDefaultTag(node, parents) {
            seen.push([
              "resolveDefaultTag",
              {
                node: node.type,
                parents: parents.map((parent) => [
                  parent.name,
                  tagSummary(parent.node),
                ]),
              },
            ]);
            return "span";
          },
        }),
    );
    expect(mxSeen).toEqual([
      [
        "resolveDefaultTag",
        {
          node: "MarkoTag",
          parents: [["section", expect.objectContaining({ name: "section" })]],
        },
      ],
    ]);
  });

  it("rejectElementAttributeTags: reads the first attribute tag", () => {
    const { mx } = bothPaths("<div>\n  <@slot>x</@slot>\n</div>\n", (seen) =>
      declarations({
        rejectElementAttributeTags(name, node) {
          seen.push(["rejectElementAttributeTags", tagSummary(node)]);
          const first = node.attributeTags[0];
          throw new TranslateError(
            `${name} cannot take ${first.name.value}`,
            first.loc.start.line,
            first.loc.start.column,
          );
        },
      }),
    );
    expect(mx.error).toEqual({
      message: "div cannot take @slot",
      line: 2,
      column: 2,
    });
  });

  it("rejectComponentTag: sees the call and lets it through", () => {
    // A host-resolved name: a `<define>` call is not the host's to refuse.
    const { mxSeen } = bothPaths("<Card a=1>c</Card>\n", (seen) =>
      declarations({
        isComponent: (name) => name === "Card",
        rejectComponentTag(name, node) {
          seen.push([
            "rejectComponentTag",
            { name, ...(tagSummary(node) as object) },
          ]);
        },
      }),
    );
    expect(mxSeen).toEqual([
      [
        "rejectComponentTag",
        expect.objectContaining({
          name: "Card",
          type: "MarkoTag",
          attributes: [["MarkoAttribute", "a", null]],
        }),
      ],
    ]);
  });

  it("rejectComponentTag: a host error positioned from `node.loc`", () => {
    const { mx } = bothPaths("<p/>\n<p/>\n<p>x</p><Card/>\n", (seen) =>
      declarations({
        isComponent: (name) => name === "Card",
        rejectComponentTag(name, node) {
          seen.push(["rejectComponentTag", tagSummary(node)]);
          const { line, column } = node.loc.start;
          throw new TranslateError(`no ${name}`, line, column);
        },
      }),
    );
    expect(mx.error).toEqual({ message: "no Card", line: 3, column: 8 });
  });

  it("rejectUnknownTag: an unresolved capitalized tag", () => {
    const { mx } = bothPaths("<Missing a=1/>\n", (seen) =>
      declarations({
        rejectUnknownTag(name, node) {
          seen.push(["rejectUnknownTag", tagSummary(node)]);
          const { line, column } = node.loc.start;
          throw new TranslateError(`unknown ${name}`, line, column);
        },
      }),
    );
    expect(mx.error).toEqual({
      message: "unknown Missing",
      line: 1,
      column: 0,
    });
  });

  it("checkBinding: the `<const>` pattern, a Babel node", () => {
    const { mxSeen } = bothPaths(`<const/{ a, b }=x/>\n\${a}\n`, (seen) =>
      declarations({
        checkBinding(target, what) {
          seen.push(["checkBinding", { type: target.type, what }]);
        },
      }),
    );
    expect(mxSeen).toEqual([
      ["checkBinding", { type: "ObjectPattern", what: "`<const>`" }],
    ]);
  });
});
