import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { CustomTag, MxWarning, TemplateBackedTag } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import cases from "../../../../test-fixtures/body-whitespace/cases.json";
import { type ParseDataResult, parseData, parseDataFile } from "./parse.ts";
import type { DataAttr, DataNode, DataTag } from "./tree.ts";

/**
 * Every construct row of the design note's §3 table (pass-through, and
 * reject with its positioned message), the `structural` option, the reserved
 * names, contracts, duplicates, raw-text trade, and the fail-fast contract.
 * Line and column are asserted on every diagnostic.
 */

const D = "${"; // keeps test sources free of TS interpolation

function ok(source: string, options?: Parameters<typeof parseData>[2]) {
  const result = parseData(source, "/t.mx", options);
  expect(result.diagnostics).toEqual([]);
  expect(result.tree).toBeDefined();
  return result.tree as NonNullable<ParseDataResult["tree"]>;
}

function failWith(
  source: string,
  expected: { message: string; line: number; column: number },
  options?: Parameters<typeof parseData>[2],
) {
  const result = parseData(source, "/t.mx", options);
  expect(result.tree).toBeUndefined();
  expect(result.diagnostics).toHaveLength(1);
  const [diagnostic] = result.diagnostics;
  expect(diagnostic?.severity).toBe("error");
  expect(diagnostic?.message).toBe(expected.message);
  expect(diagnostic?.line).toBe(expected.line);
  expect(diagnostic?.column).toBe(expected.column);
  return diagnostic;
}

/** Every error of a file, in order: no tree, and exactly these diagnostics. */
function failAll(
  source: string,
  expected: { message: string; line: number; column: number }[],
  options?: Parameters<typeof parseData>[2],
) {
  const result = parseData(source, "/t.mx", options);
  expect(result.tree).toBeUndefined();
  expect(
    result.diagnostics.map(({ severity, message, line, column }) => ({
      severity,
      message,
      line,
      column,
    })),
  ).toEqual(expected.map((e) => ({ severity: "error", ...e })));
}

function firstTag(tree: { children: DataNode[] }): DataTag {
  expect(tree.children[0]?.kind).toBe("tag");
  return tree.children[0] as DataTag;
}

function slice(
  source: string,
  span: { sourceStart: number; sourceEnd: number },
) {
  return source.slice(span.sourceStart, span.sourceEnd);
}

/** A name span the tree is expected to carry; the field is optional in the type. */
function named(span: { sourceStart: number; sourceEnd: number } | undefined) {
  if (!span) throw new Error("expected a nameSpan");
  return span;
}

const RESERVED = (name: string) =>
  `\`<${name}>\` cannot name a data tag: it is reserved — core consumes the structural names (\`if\`, \`else\`, \`else-if\`, \`for\`, \`const\`, \`define\`, \`return\`, \`import\`, \`export\`, \`static\`) and \`<try>\` before a target sees them`;

const STATIC = (construct: string) =>
  `the data tree is static; this file's consumer does not evaluate ${construct}`;

describe("normalized body text (decision 141)", () => {
  it.each(
    cases.filter(({ label }) => label !== "element" && label !== "mixed"),
  )("$label passes through unchanged", ({ body, html }) => {
    const children = firstTag(ok(`<x>${body}</x>`)).children;
    expect(
      children
        .filter((node) => node.kind === "text")
        .map((node) => node.value)
        .join(""),
    ).toBe(html);
  });
  it.each(
    cases.filter(
      ({ label, html }) => html === " " && !label.includes("comment"),
    ),
  )("$label is still rejected as text", ({ body }) => {
    failWith(
      `<x>${body}</x>`,
      { message: STATIC("text"), line: 1, column: 3 },
      { structural: "reject" },
    );
  });
  it.each(["\n  ", "\r\n\t  "])(
    "dropped indentation %j is not structural text",
    (body) => {
      expect(
        firstTag(ok(`<x>${body}</x>`, { structural: "reject" })).children,
      ).toEqual([]);
    },
  );
});

describe("pass-through constructs (the §3 table)", () => {
  it("text arrives normalized, its span slicing the authored text", () => {
    const source = `<x>hello</x>\n`;
    const tree = ok(source);
    const text = firstTag(tree).children[0];
    expect(text).toMatchObject({ kind: "text", value: "hello" });
    if (text?.kind !== "text") throw new Error("expected text");
    expect(slice(source, text.span)).toBe("hello");
  });

  it(`\`\${}\` and \`$!{}\` arrive as expressions with escaped flags and spans`, () => {
    const source = `<x>hi ${D}name} $!{raw}</x>\n`;
    const tree = ok(source);
    const children = firstTag(tree).children;
    expect(children.map((node) => node.kind)).toEqual([
      "text",
      "expression",
      "text",
      "expression",
    ]);
    const escaped = children[1];
    const raw = children[3];
    if (escaped?.kind !== "expression" || raw?.kind !== "expression") {
      throw new Error("expected expression nodes");
    }
    expect(escaped.escaped).toBe(true);
    expect(escaped.value.code).toBe("name");
    expect(slice(source, escaped.value.span)).toBe("name");
    expect(raw.escaped).toBe(false);
    expect(slice(source, raw.value.span)).toBe("raw");
  });

  it("an if-chain arrives with its branches, `<else>` as a null test", () => {
    const source = `<if=a>t</if><else-if=b>u</else-if><else>v</else>\n`;
    const tree = ok(source);
    const node = tree.children[0];
    expect(node?.kind).toBe("if");
    if (node?.kind !== "if") throw new Error("expected if");
    // The chain's span covers the whole chain; each branch's span slices
    // its own tag, body and closing tag included.
    expect(slice(source, node.span)).toBe(source.trimEnd());
    expect(
      node.branches.map((branch) => [
        branch.test?.code ?? null,
        slice(source, branch.span),
      ]),
    ).toEqual([
      ["a", "<if=a>t</if>"],
      ["b", "<else-if=b>u</else-if>"],
      [null, "<else>v</else>"],
    ]);
  });

  it("`<for>` arrives as of, in and range heads, with params and key", () => {
    const ofSource = `<for|i| of=items>x</for>\n`;
    const ofTree = ok(ofSource);
    const ofNode = ofTree.children[0];
    if (ofNode?.kind !== "for") throw new Error("expected for");
    expect(ofNode.head.source.kind).toBe("of");
    expect(ofNode.head.params).toEqual(["i"]);
    expect(ofNode.head.key).toBeNull();
    expect(slice(ofSource, ofNode.span)).toBe(ofSource.trimEnd());

    const inTree = ok(`<for|k, v| in=obj>x</for>\n`);
    const inNode = inTree.children[0];
    if (inNode?.kind !== "for") throw new Error("expected for");
    expect(inNode.head.source.kind).toBe("in");
    expect(inNode.head.params).toEqual(["k", "v"]);

    const rangeTree = ok(
      `<for|i| from=0 until=10 step=2 by=(i) => i>x</for>\n`,
    );
    const rangeNode = rangeTree.children[0];
    if (rangeNode?.kind !== "for") throw new Error("expected for");
    expect(rangeNode.head.source).toMatchObject({
      kind: "range",
      inclusive: false,
    });
    if (rangeNode.head.source.kind !== "range") throw new Error("range");
    expect(rangeNode.head.source.from?.code).toBe("0");
    expect(rangeNode.head.source.bound.code).toBe("10");
    expect(rangeNode.head.source.step?.code).toBe("2");
    expect(rangeNode.head.key?.code).toBe("(i) => i");
  });

  it("`<const>` arrives with its name and init expression", () => {
    const source = `<const/n=count + 1/>\n`;
    const tree = ok(source);
    const node = tree.children[0];
    if (node?.kind !== "const") throw new Error("expected const");
    expect(node.name).toBe("n");
    expect(node.init.code).toBe("count + 1");
    expect(slice(source, node.init.span)).toBe("count + 1");
    expect(slice(source, node.span)).toBe(source.trimEnd());
  });

  it("import, static, export and `export interface Input` arrive as sorted statements", () => {
    const source = `import a from "b"\nstatic const s = 1\nexport const e = 2\nexport interface Input { a: string }\n<x/>\n`;
    const tree = ok(source);
    expect(tree.statements.map((stmt) => stmt.kind)).toEqual([
      "import",
      "static",
      "export",
      "export",
    ]);
    // Sorted by span, and each span slices the authored statement, the
    // trailing line terminator excluded.
    expect(tree.statements.map((stmt) => slice(source, stmt.span))).toEqual([
      `import a from "b"`,
      "static const s = 1",
      "export const e = 2",
      "export interface Input { a: string }",
    ]);
    expect(tree.statements[0]?.code).toBe(`import a from "b"`);
    // One tag in the body, and the statements are out of it.
    expect(tree.children).toHaveLength(1);
  });

  it("tag params and tag args arrive", () => {
    const tag = firstTag(ok(`<x(1, two)|a, b|/>\n`));
    expect(tag.args.map((arg) => arg.code)).toEqual(["1", "two"]);
    expect(tag.params).toEqual(["a", "b"]);
  });

  it("comments arrive, `html` distinguishing `<!-- -->` from `//`", () => {
    const source = `// line\n<!-- html -->\n<x/>\n`;
    const tree = ok(source);
    const line = tree.children[0];
    const html = tree.children[1];
    expect(line).toMatchObject({
      kind: "comment",
      value: " line",
      html: false,
    });
    expect(html).toMatchObject({
      kind: "comment",
      value: " html ",
      html: true,
    });
    if (line?.kind !== "comment" || html?.kind !== "comment") {
      throw new Error("expected comments");
    }
    // The spans cover the delimiters.
    expect(slice(source, line.span)).toBe("// line");
    expect(slice(source, html.span)).toBe("<!-- html -->");
  });

  it("attribute tags arrive in tree form, `<if>` and `<for>` among them kept", () => {
    const source = `<x><if=a><@y/></if><else><@z/></else></x>\n`;
    const tree = ok(source);
    const tag = firstTag(tree);
    expect(tag.children).toEqual([]);
    const ifNode = tag.attrTags[0];
    if (ifNode?.kind !== "if") throw new Error("expected attr-tag if");
    expect(ifNode.branches).toHaveLength(2);
    const [first, second] = ifNode.branches;
    if (!first || !second) throw new Error("expected two branches");
    expect(first.test?.code).toBe("a");
    expect(slice(source, first.span)).toBe("<if=a><@y/></if>");
    expect(first.children[0]).toMatchObject({
      kind: "attr-tag",
      name: "y",
    });
    expect(second.test).toBeNull();
    expect(slice(source, second.span)).toBe("<else><@z/></else>");
    expect(second.children[0]).toMatchObject({
      kind: "attr-tag",
      name: "z",
    });

    const forTree = ok(`<x><for|i| of=items><@y n=i/></for></x>\n`);
    const forNode = firstTag(forTree).attrTags[0];
    if (forNode?.kind !== "for") throw new Error("expected attr-tag for");
    expect(forNode.head.source.kind).toBe("of");
    expect(forNode.head.params).toEqual(["i"]);
    expect(forNode.children[0]).toMatchObject({
      kind: "attr-tag",
      name: "y",
    });
  });

  it("an attribute method and the method shorthand arrive as expression attributes", () => {
    const arrow = firstTag(ok(`<x change=({ post }) => { post.x = 1 }/>\n`));
    expect(arrow.attrs[0]).toMatchObject({
      kind: "expression",
      name: "change",
    });

    // The method shorthand needs `resolveAttributeMethod` — without the hook
    // core fails the file as an event handler requiring a runtime (note §3).
    const source = `<x value({ post }) { return 1 }/>\n`;
    const tag = firstTag(ok(source));
    const attr = tag.attrs[0];
    if (attr?.kind !== "expression") throw new Error("expected expression");
    expect(attr.name).toBe("value");
    // `code` is the printed form; `span` slices the authored text.
    expect(attr.value.code).toBe("function ({ post }) { return 1; }");
    expect(slice(source, attr.value.span)).toBe("({ post }) { return 1 }");
  });

  it("a bound attribute carries its refinement, with a span over the modifier", () => {
    const source = "<x v:fn:=y w:=z/>\n";
    const tag = firstTag(ok(source));
    const [refined, plain] = tag.attrs;
    if (refined?.kind !== "expression") throw new Error("expected expression");
    expect(refined).toMatchObject({ name: "v", bound: true });
    const { refinement } = refined;
    if (!refinement) throw new Error("expected a refinement");
    expect(refinement).toMatchObject({
      code: "fn",
      shape: "other",
      node: null,
    });
    expect(slice(source, refinement.span)).toBe("fn");
    expect(plain).toMatchObject({ name: "w", bound: true });
    expect(plain).not.toHaveProperty("refinement");
  });

  it("a refinement that is no identifier is Marko's error at the modifier", () => {
    const result = parseData("<x v:no-update:=y/>\n", "x.mx");
    expect(result.diagnostics).toMatchObject([
      {
        severity: "error",
        message:
          "Bound attribute refinement shorthand must be a valid JavaScript identifier.",
        line: 1,
        column: 5,
      },
    ]);
  });

  it("attribute shapes: string, boolean, expression, bound and spread", () => {
    const source = `<x s="v" required n=1 v:=y ...rest/>\n`;
    const tag = firstTag(ok(source));
    const kinds = tag.attrs.map((attr: DataAttr) => attr.kind);
    expect(kinds).toEqual([
      "string",
      "boolean",
      "expression",
      "expression",
      "spread",
    ]);
    expect(tag.attrs[0]).toMatchObject({ name: "s", value: "v" });
    expect(tag.attrs[1]).toMatchObject({ name: "required" });
    expect(tag.attrs[2]).toMatchObject({ name: "n" });
    expect(tag.attrs[3]).toMatchObject({ name: "v", bound: true });
    const spread = tag.attrs[4];
    if (spread?.kind !== "spread") throw new Error("expected spread");
    expect(spread.value.code).toBe("rest");
    expect(slice(source, spread.value.span)).toBe("rest");
  });

  it("a default attribute is named `value` with a zero-width name span at the `=`", () => {
    const source = `<resource="post"/>\n`;
    const tag = firstTag(ok(source));
    const attr = tag.attrs[0];
    if (attr?.kind !== "string") throw new Error("expected string attr");
    expect(attr.name).toBe("value");
    expect(attr.value).toBe("post");
    // Authored (a default attribute has a name span, zero-width at the `=`);
    // only the shorthand leaves it absent.
    const nameSpan = attr.nameSpan;
    if (!nameSpan) throw new Error("expected a name span");
    expect(nameSpan.sourceStart).toBe(nameSpan.sourceEnd);
    expect(slice(source, nameSpan)).toBe("");
    expect(slice(source, attr.valueSpan)).toBe('"post"');
  });

  it("an `on*` attribute on a delegated tag stays a plain expression attribute", () => {
    const tag = firstTag(ok(`<x onClick=fn/>\n`));
    expect(tag.attrs[0]).toMatchObject({ kind: "expression", name: "onClick" });
  });
});

describe("rejected constructs (the §3 table), each positioned", () => {
  it("`<define>` is rejected as a render-time macro", () => {
    failWith(`<define/R|a|>${D}a}</define>\n<R>y</R>\n`, {
      message:
        "`<define>` is a render-time macro: the data tree is static and cannot expand it; inline the content at each use",
      line: 1,
      column: 0,
    });
  });

  it("`<return>` is rejected as the evaluated mode's channel", () => {
    failWith(`<return=1/>\n`, {
      message:
        "`<return>` needs the evaluated mode: the data tree is static and has no value to return",
      line: 1,
      column: 0,
    });
  });

  it("a tag variable is rejected", () => {
    failWith(`<x/v/>\n`, {
      message:
        "tag variable `/v` on `<x>`: the data tree is static; a binding without evaluation means nothing",
      line: 1,
      column: 0,
    });
  });

  it(`a dynamic tag is rejected, in the \`<\${x}>\` and bare \`\${x}\` forms`, () => {
    const message = `a dynamic tag (\`<\${expr}>\`) has no name; the data tree is static and needs one`;
    failWith(`<${D}d} a=1/>\n`, { message, line: 1, column: 0 });
    failWith(`${D}d}\n`, { message, line: 1, column: 0 });
  });

  it("`<!doctype>` is rejected", () => {
    failWith(`<!doctype html>\n<x/>\n`, {
      message:
        "`<!doctype>` means nothing in a data file; the data tree describes tags and data, not a page",
      line: 1,
      column: 0,
    });
  });

  it("a `tags/` template tag called from a data file is rejected", () => {
    const badge: TemplateBackedTag = {
      template: {
        filename: "/t/tags/badge.mx",
        source: "<div/>",
      },
    };
    failWith(
      `<badge/>\n`,
      {
        message:
          "`<badge>` calls a template tag; a data file cannot call a template tag",
        line: 1,
        column: 0,
      },
      { customTags: { badge } },
    );
  });

  it("a capitalized import call is rejected at the call, positioned", () => {
    failWith(`import Badge from "./badge.mx"\n\n<Badge/>\n`, {
      message:
        "`<Badge>` calls a template tag; a data file cannot call a template tag",
      line: 3,
      column: 0,
    });
  });
});

describe("reserved names", () => {
  it("`<try>` fails with the reserved-name message", () => {
    failWith(`<try>x</try>\n`, {
      message: RESERVED("try"),
      line: 1,
      column: 0,
    });
  });

  it("`<else>` fails with the reserved-name message", () => {
    failWith(`<else>x</else>\n`, {
      message: RESERVED("else"),
      line: 1,
      column: 0,
    });
  });

  it("`<else-if>` fails with the reserved-name message", () => {
    failWith(`<else-if=a>x</else-if>\n`, {
      message: RESERVED("else-if"),
      line: 1,
      column: 0,
    });
  });

  it("the reserved-name error is positioned at the tag", () => {
    failWith(`<x/>\n\n<try>x</try>\n`, {
      message: RESERVED("try"),
      line: 3,
      column: 0,
    });
  });

  it("an `<else>` inside a real `<if>` chain is fine", () => {
    const tree = ok(`<if=a>t</if><else>v</else>\n`);
    expect(tree.children[0]?.kind).toBe("if");
  });
});

describe('structural: "reject"', () => {
  it("a tags-and-attributes file builds the same under either option", () => {
    const source = `<x a=1><y s="v"/></x>\n`;
    const passTree = ok(source);
    const rejectTree = ok(source, { structural: "reject" });
    expect(rejectTree).toEqual(passTree);
  });

  it("`<if>` is the fixed positioned error", () => {
    failWith(
      `<if=a>t</if>\n`,
      { message: STATIC("`<if>`"), line: 1, column: 0 },
      { structural: "reject" },
    );
  });

  it("`<for>` is the fixed positioned error", () => {
    failWith(
      `<for|i| of=items>t</for>\n`,
      { message: STATIC("`<for>`"), line: 1, column: 0 },
      { structural: "reject" },
    );
  });

  it("`<const>` is the fixed positioned error", () => {
    failWith(
      `<const/x=1/>\n`,
      { message: STATIC("`<const>`"), line: 1, column: 0 },
      { structural: "reject" },
    );
  });

  it("text is the fixed positioned error", () => {
    failWith(
      `<x>hello</x>\n`,
      { message: STATIC("text"), line: 1, column: 3 },
      { structural: "reject" },
    );
  });

  it("an interpolation is the fixed positioned error", () => {
    failWith(
      `<x>${D}y}</x>\n`,
      { message: STATIC(`\`\${}\``), line: 1, column: 3 },
      { structural: "reject" },
    );
  });

  it("a `//` line comment stays a `Comment` node under reject (decision 131 addendum 5)", () => {
    const source = "// src/domain/billing/invoice.mesh.mx\nentity :Invoice\n";
    const tree = ok(source, {
      structural: "reject",
      imports: "pass",
    });
    expect(tree.children.map((node) => node.kind)).toEqual(["comment", "tag"]);
    expect(tree.children[0]).toMatchObject({ kind: "comment", html: false });
  });

  it("an `<!-- -->` comment stays a `Comment` node under reject", () => {
    const source = "<!-- header -->\nentity :Invoice\n";
    const tree = ok(source, { structural: "reject" });
    expect(tree.children.map((node) => node.kind)).toEqual(["comment", "tag"]);
    expect(tree.children[0]).toMatchObject({ kind: "comment", html: true });
  });

  it("a comment inside a tag body is a child comment under reject", () => {
    const tree = ok("<x>\n  // note\n</x>\n", { structural: "reject" });
    const tag = firstTag(tree);
    expect(tag.children.map((node) => node.kind)).toEqual(["comment"]);
  });

  it.each(["import", "export", "static"])(
    "an `%s` statement is the fixed positioned error",
    (kind) => {
      const statement =
        kind === "import"
          ? `import a from "b"`
          : kind === "export"
            ? "export const e = 2"
            : "static const s = 1";
      failWith(
        `${statement}\n<x/>\n`,
        { message: STATIC(`\`${kind}\``), line: 1, column: 0 },
        { structural: "reject" },
      );
    },
  );

  it("a structural construct nested in a tag is found, positioned", () => {
    failWith(
      `<x><if=a>t</if></x>\n`,
      { message: STATIC("`<if>`"), line: 1, column: 3 },
      { structural: "reject" },
    );
  });

  it("a structural construct among attribute tags is found, positioned", () => {
    failWith(
      `<x><if=a><@y/></if></x>\n`,
      { message: STATIC("`<if>`"), line: 1, column: 3 },
      { structural: "reject" },
    );
  });

  it("the earliest construct in document order is reported", () => {
    // Both are reported, the earlier first.
    failAll(
      `<if=c>t</if>\nimport a from "b"\n`,
      [
        { message: STATIC("`<if>`"), line: 1, column: 0 },
        { message: STATIC("`import`"), line: 2, column: 0 },
      ],
      { structural: "reject" },
    );
    failAll(
      `import a from "b"\n<if=c>t</if>\n`,
      [
        { message: STATIC("`import`"), line: 1, column: 0 },
        { message: STATIC("`<if>`"), line: 2, column: 0 },
      ],
      { structural: "reject" },
    );
  });

  it("the same constructs pass by default", () => {
    const tree = ok(
      `// c\n<if=a>t${D}x}</if><else>u</else>\n<for|i| of=items>v</for>\n<const/n=1/>\n`,
    );
    expect(tree.children.map((node) => node.kind)).toEqual([
      "comment",
      "if",
      "for",
      "const",
    ]);
  });
});

describe("contract-only custom tags (decision 130)", () => {
  const contract: Record<string, CustomTag> = {
    attribute: {
      attributes: {
        value: { type: "string", required: true },
        type: { type: "string", required: true },
      },
    },
  };

  it("a correct call builds, with the attributes carried", () => {
    const tree = ok(`<attribute="title" type="string"/>\n`, {
      customTags: contract,
    });
    const tag = firstTag(tree);
    expect(tag.name).toBe("attribute");
    expect(tag.attrs.map((attr) => (attr as { name: string }).name)).toEqual([
      "value",
      "type",
    ]);
  });

  it("a missing required attribute is the contract's positioned error", () => {
    failWith(
      `<attribute="title"/>\n`,
      {
        message: "`<attribute>`: missing required attribute `type`",
        line: 1,
        column: 0,
      },
      { customTags: contract },
    );
  });

  it("an unknown attribute is the contract's positioned error", () => {
    failWith(
      `<attribute="title" type="string" bogus=1/>\n`,
      {
        message: "`<attribute>`: unknown attribute `bogus`",
        line: 1,
        column: 33,
      },
      { customTags: contract },
    );
  });
});

describe("duplicate attributes", () => {
  // Decision 135 (last-wins in core) merged, so this is the flip the test
  // has been carrying since round 1: core drops the earlier occurrence and
  // warns on **it**, naming the survivor. Before 135 both attributes reached
  // the tree; after it exactly one does.
  it("warns on the dropped occurrence and keeps only the survivor", () => {
    const result = parseData(`<x b=1 b=2/>\n`, "/t.mx");
    expect(result.tree).toBeDefined();
    const tag = firstTag(result.tree as NonNullable<typeof result.tree>);
    expect(tag.attrs).toHaveLength(1);
    if (tag.attrs[0]?.kind !== "expression") {
      throw new Error("expected an expression attribute");
    }
    expect(tag.attrs[0].value.code).toBe("2");
    expect(result.diagnostics).toEqual([
      {
        severity: "warning",
        message:
          "duplicate attribute `b`: the later one at 1:8 wins, so this one is dropped",
        line: 1,
        column: 3,
        offset: 3,
        // No `file`: the warning is in the parsed file (review 460 F8).
      },
    ]);
  });
});

describe("the raw-text trade (the addendum's item 3)", () => {
  it("a `<style>` body with tag-like content parses as tags, not text", () => {
    const tree = ok(`<style>.a <b>bold</b></style>\n`);
    const style = firstTag(tree);
    expect(style.name).toBe("style");
    expect(style.children[0]).toMatchObject({ kind: "text", value: ".a " });
    expect(style.children[1]).toMatchObject({ kind: "tag", name: "b" });
  });

  it("a `<` that starts no tag stays text, in `style`, `script` and `title`", () => {
    for (const name of ["style", "script", "title"]) {
      const source = `<${name}>a < b {}</${name}>\n`;
      const tree = ok(source);
      const text = firstTag(tree).children[0];
      expect(text).toMatchObject({ kind: "text", value: "a < b {}" });
      if (text?.kind !== "text") throw new Error("expected text");
      expect(slice(source, text.span)).toBe("a < b {}");
    }
  });
});

describe("UTF-16 spans (note §2.1's verified fixture)", () => {
  it("spans count UTF-16 code units across an emoji in an attribute and in text", () => {
    const source = `<a t="é😀" b=\`ñ\`/>\n<b c="x">😀 ok ${D}y}</b>\n`;
    const tree = ok(source);
    const [a, b] = tree.children as [DataTag, DataTag];

    expect(slice(source, a.span)).toBe(`<a t="é😀" b=\`ñ\`/>`);
    const t = a.attrs[0];
    if (t?.kind !== "string" || !t.nameSpan) {
      throw new Error("expected string attr with a name span");
    }
    expect(slice(source, t.nameSpan)).toBe("t");
    expect(slice(source, t.valueSpan)).toBe(`"é😀"`);

    // The text span counts the emoji as two UTF-16 code units and slices
    // the authored text.
    const text = b.children[0];
    expect(text).toMatchObject({ kind: "text", value: "😀 ok " });
    if (text?.kind !== "text") throw new Error("expected text");
    expect(slice(source, text.span)).toBe("😀 ok ");

    const expr = b.children[1];
    if (expr?.kind !== "expression") throw new Error("expected expression");
    expect(slice(source, expr.value.span)).toBe("y");
  });
});

describe("round 2 (rev-236)", () => {
  describe("finding 1: the path prefix on a relative filename", () => {
    const MESSAGE =
      "`<return>` needs the evaluated mode: the data tree is static and has no value to return";

    // Babel resolves the filename itself before prefixing the error, so the
    // prefix is the absolute path whatever the caller passed.
    it.each(["t.mx", "./t.mx", "../data/t.mx", "/abs/t.mx"])(
      "`parseData` with the filename `%s` keeps the path out of the message",
      (filename) => {
        const result = parseData(`<return=1/>\n`, filename);
        expect(result.tree).toBeUndefined();
        expect(result.diagnostics).toEqual([
          {
            severity: "error",
            message: MESSAGE,
            line: 1,
            column: 0,
            offset: 0,
          },
        ]);
        for (const diagnostic of result.diagnostics) {
          expect(diagnostic.message).not.toMatch(/^(?:[/.]|\w:)/);
        }
      },
    );

    it("`parseDataFile` on a relative path leaks nothing either", () => {
      const dir = mkdtempSync(join(tmpdir(), "mx-data-r2-"));
      try {
        const file = join(dir, "t.mx");
        writeFileSync(file, `<return=1/>\n`);
        const relativePath = relative(process.cwd(), file);
        expect(relativePath.startsWith("/")).toBe(false);
        const result = parseDataFile(relativePath);
        expect(result.tree).toBeUndefined();
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]?.message).toBe(MESSAGE);
      } finally {
        rmSync(dir, { force: true, recursive: true });
      }
    });

    it("a Marko syntax error is unaffected", () => {
      const result = parseData(`<x\n`, "t.mx");
      expect(result.diagnostics).toEqual([
        {
          severity: "error",
          message: "EOF reached while parsing open tag",
          line: 1,
          column: 0,
          offset: 0,
        },
      ]);
    });
  });

  describe("finding 2: shorthand `#id` / `.class` attributes", () => {
    it("carry a name span over the sigil and token, and never a null one", () => {
      const source = `<a#myid.cls1.cls2 x=1/>\n`;
      const tag = firstTag(ok(source));
      // Core hands the synthesized attributes over after the authored ones,
      // `class` before `id`; the authored order among themselves is kept.
      expect(
        tag.attrs.map((attr) => [attr.kind, "name" in attr ? attr.name : null]),
      ).toEqual([
        ["expression", "x"],
        ["string", "class"],
        ["string", "id"],
      ]);
      const [, cls, id] = tag.attrs;
      if (cls?.kind !== "string" || id?.kind !== "string") {
        throw new Error("expected shorthand attributes");
      }
      // The name span is the sigil plus the token, as for the spaced sugar
      // form (` .y`); the value span is measured from *after* the sigil, so
      // it is the class/id text itself.
      expect(slice(source, named(cls.nameSpan))).toBe(".cls1.cls2");
      expect(slice(source, named(id.nameSpan))).toBe("#myid");
      expect(slice(source, cls.valueSpan)).toBe("cls1.cls2");
      expect(slice(source, id.valueSpan)).toBe("myid");
      expect(cls.value).toBe("cls1 cls2");
      expect(id.value).toBe("myid");
    });

    it("`<div.foo/>` carries the one shorthand class with its name span", () => {
      const source = `<div.foo/>\n`;
      const attr = firstTag(ok(source)).attrs[0];
      if (!attr) throw new Error("expected an attribute");
      expect(attr).toMatchObject({
        kind: "string",
        name: "class",
        value: "foo",
      });
      if (attr.kind !== "string") throw new Error("expected a string attr");
      expect(slice(source, named(attr.nameSpan))).toBe(".foo");
      expect(slice(source, attr.valueSpan)).toBe("foo");
    });

    it("an authored attribute still carries its name span", () => {
      const source = `<div#i.cls x=1/>\n`;
      const attr = firstTag(ok(source)).attrs[0];
      if (attr?.kind !== "expression") throw new Error("expected expression");
      expect(slice(source, attr.nameSpan)).toBe("x");
    });

    it("no attribute anywhere in the tree carries a null offset", () => {
      const source = `<a#myid.cls1 x=1 b ...rest/>\n<d.foo/>\n`;
      const tree = ok(source);
      expect(nonNumericSpanOffsets(tree)).toEqual([]);
    });
  });

  describe("finding 3: nothing vanishes silently", () => {
    // Decision 139 moved this to core, where it belongs: a CDATA section and
    // an XML declaration are rejected by lowering, at the `<` of the
    // construct, on every target. The messages below are **core's**, spelled
    // out as literals rather than imported, so this test pins that the data
    // target reports core's rule unchanged rather than substituting its own.
    // biome-ignore-start lint/suspicious/noTemplateCurlyInString: the message quotes core's MX placeholder syntax, not a JS template
    const CORE_CDATA =
      '`<![CDATA[…]]>` is not supported: write the text inline, as `${"…"}` when it must stay raw, or in an attribute value';
    // biome-ignore-end lint/suspicious/noTemplateCurlyInString: the message quotes core's MX placeholder syntax, not a JS template
    const CORE_DECLARATION =
      "`<?…?>` (an XML declaration or processing instruction) is not supported: remove it";

    it("a CDATA section is rejected by core, positioned, in either mode", () => {
      const source = `<a>pre<![CDATA[ x ]]>post</a>\n`;
      // 1:6 — the `<` of `<![CDATA[`, core's position for the node.
      failWith(source, { message: CORE_CDATA, line: 1, column: 6 });
      failWith(
        source,
        { message: CORE_CDATA, line: 1, column: 6 },
        {
          structural: "reject",
        },
      );
    });

    it("core rejects it on its own line, with the offset derived", () => {
      const result = parseData(`<a>pre</a>\n<![CDATA[ x ]]>\n`, "/t.mx");
      expect(result.tree).toBeUndefined();
      expect(result.diagnostics).toEqual([
        {
          severity: "error",
          message: CORE_CDATA,
          line: 2,
          column: 0,
          offset: 11,
        },
      ]);
    });

    it("`<?xml …?>` is rejected by core, positioned, in either mode", () => {
      for (const [source, column] of [
        [`<?xml version="1.0"?>\n<a/>\n`, 0],
        [`<a><?target data?></a>\n`, 3],
      ] as const) {
        failWith(source, { message: CORE_DECLARATION, line: 1, column });
        failWith(
          source,
          { message: CORE_DECLARATION, line: 1, column },
          { structural: "reject" },
        );
      }
    });

    it("no data-specific code decides this: core rejects it whatever the tree would be", () => {
      // The same rejection reaches the consumer as any other core error —
      // one positioned diagnostic and no partial tree, in both modes, with no
      // branch in this package that knows the construct exists.
      for (const structural of ["pass", "reject"] as const) {
        const result = parseData(`<a><![CDATA[ x ]]></a>\n`, "/t.mx", {
          structural,
        });
        expect(result.diagnostics).toEqual([
          {
            severity: "error",
            message: CORE_CDATA,
            line: 1,
            column: 3,
            offset: 3,
          },
        ]);
      }
    });

    it("a construct inside a string, a comment or an interpolation is still text", () => {
      // Marko's parser decides text vs node, and core's new rule only fires on
      // the node — so none of these is a CDATA construct. This is now a
      // property of the language rather than of a scanner in this package.
      ok(`<x a="<?" b='<![CDATA[y]]>'/>\n`);
      ok(`<x a="<?"/>\n`);
      ok(`// <?xml\n<x/>\n`);
      ok(`<!-- <![CDATA[y]] -->\n<x/>\n`);
      ok(`<x>${D}a < b ? "<?" : "<![CDATA[y]]>"}</x>\n`);
      ok(`<script>var a = 1 < 2;</script>\n`);
    });
  });

  describe("finding 4: the text reject position", () => {
    it("a text node after a newline reports the text, not the end of the line above", () => {
      failWith(
        `<a>\n  <b/>\n  text\n</a>\n`,
        { message: STATIC("text"), line: 3, column: 2 },
        { structural: "reject" },
      );
      // CRLF: the span carries the `\r\n`, and the position is still the
      // first character of the text itself.
      failWith(
        `<a>\r\n  <b/>\r\n  text\r\n</a>\r\n`,
        { message: STATIC("text"), line: 3, column: 2 },
        { structural: "reject" },
      );
    });

    it("text with no leading line break keeps its position", () => {
      failWith(
        `<a>hi</a>\n`,
        { message: STATIC("text"), line: 1, column: 3 },
        {
          structural: "reject",
        },
      );
      failAll(
        `<a>x <b/> y</a>\n`,
        [
          { message: STATIC("text"), line: 1, column: 3 },
          { message: STATIC("text"), line: 1, column: 10 },
        ],
        {
          structural: "reject",
        },
      );
      failAll(
        `<a>x<b/>y</a>\n`,
        [
          { message: STATIC("text"), line: 1, column: 3 },
          { message: STATIC("text"), line: 1, column: 8 },
        ],
        {
          structural: "reject",
        },
      );
    });
  });

  describe("finding 5: a tag name that is not usable", () => {
    // The rule was narrowed in round 4 (rev-236-r2 finding 2): it rejects the
    // `$…`/`!…`/placeholder shapes it was written for and accepts everything
    // else, namespaced and non-ASCII names included. Round 4's block covers
    // the accepted names; this keeps the rejected ones.
    it("a bare concise raw-placeholder line is the dynamic-tag reject", () => {
      const message = `a dynamic tag (\`<\${expr}>\`) has no name; the data tree is static and needs one`;
      failWith(`$!{x}\n`, { message, line: 1, column: 0 });
      failWith(`$!{x} a=1\n`, { message, line: 1, column: 0 });
    });

    it("any other unusable tag name is rejected", () => {
      const unusable = (name: string) =>
        `\`${name}\` is not a tag name a data file can use: it must not start with \`$\` or \`!\`, or contain \`{\`, \`}\` or whitespace — those are a \`$…\` scriptlet or a \`\${…}\` placeholder, which a data file does not have`;
      failWith(`$const x = 1\n`, {
        message: unusable("$const"),
        line: 1,
        column: 0,
      });
      failWith(`$ref\n`, { message: unusable("$ref"), line: 1, column: 0 });
      failWith(`<a><$x/></a>\n`, {
        message: unusable("$x"),
        line: 1,
        column: 3,
      });
    });

    it("ordinary tag names still pass", () => {
      expect(
        ok(`hello\na-b\na_b\n_x\n`).children.map((node) =>
          "name" in node ? node.name : null,
        ),
      ).toEqual(["hello", "a-b", "a_b", "_x"]);
    });
  });

  describe("finding 6: a concise-mode tag's span", () => {
    it("excludes the trailing line terminator, like a `<tag/>` span", () => {
      const source = `b\n  c\n`;
      const tree = ok(source);
      const outer = firstTag(tree);
      expect(slice(source, outer.span)).toBe("b\n  c");
      const inner = outer.children[0];
      if (inner?.kind !== "tag") throw new Error("expected a tag");
      expect(slice(source, inner.span)).toBe("c");
    });

    it("trims every trailing line terminator, CRLF included", () => {
      const lf = ok(`b\n\n  c\n\n`);
      expect(slice(`b\n\n  c\n\n`, firstTag(lf).span)).toBe("b\n\n  c");
      const crlf = `b\r\n  c\r\n`;
      expect(slice(crlf, firstTag(ok(crlf)).span)).toBe("b\r\n  c");
    });

    it("a `<tag/>` span is unchanged", () => {
      const source = `<a>\n  <b/>\n</a>\n`;
      const tag = firstTag(ok(source));
      expect(slice(source, tag.span)).toBe("<a>\n  <b/>\n</a>");
      const inner = tag.children[0];
      if (inner?.kind !== "tag") throw new Error("expected a tag");
      expect(slice(source, inner.span)).toBe("<b/>");
    });
  });

  describe("every construct is either in the tree or rejected", () => {
    // A construct whose authored characters no span in the tree claims has
    // vanished. Each row is one construct this target knows about; the test
    // fails if a row is neither represented nor rejected.
    const rows: {
      name: string;
      source: string;
      marker?: string;
      present?: (tree: NonNullable<ParseDataResult["tree"]>) => boolean;
      options?: Parameters<typeof parseData>[2];
    }[] = [
      { name: "text", source: `<a>hi</a>\n`, marker: "hi" },
      { name: "an interpolation", source: `<a>${D}x}</a>\n`, marker: `${D}x}` },
      { name: "`$!{}`", source: `<a>$!{x}</a>\n`, marker: "$!{x}" },
      {
        name: "`<if>`/`<else>`",
        source: `<if=a>t</if><else>v</else>\n`,
        marker: "<if=a>t</if>",
      },
      {
        name: "`<for>`",
        source: `<for|i| of=items>t</for>\n`,
        marker: "of=items",
      },
      {
        name: "`<const>`",
        source: `<const/n=count/>\n`,
        marker: "<const/n=count/>",
      },
      {
        name: "`import`",
        source: `import a from "b"\n`,
        marker: `import a from "b"`,
      },
      {
        name: "`export`",
        source: `export const e = 2\n`,
        marker: "export const e = 2",
      },
      {
        name: "`static`",
        source: `static const s = 1\n`,
        marker: "static const s = 1",
      },
      {
        name: "`export interface Input`",
        source: `export interface Input { a: string }\n`,
        marker: "export interface Input { a: string }",
      },
      {
        name: "an html comment",
        source: `<!-- hi -->\n`,
        marker: "<!-- hi -->",
      },
      { name: "a line comment", source: `// hi\n`, marker: "// hi" },
      { name: "a block comment", source: `/* hi */\n`, marker: "/* hi */" },
      { name: "an attribute tag", source: `<x><@y/></x>\n`, marker: "<@y/>" },
      {
        name: "an attribute tag `<if>`",
        source: `<x><if=a><@y/></if></x>\n`,
        marker: "<if=a><@y/></if>",
      },
      { name: "shorthand `.class`", source: `<x.foo/>\n`, marker: ".foo" },
      { name: "shorthand `#id`", source: `<x#foo/>\n`, marker: "#foo" },
      { name: "a boolean attribute", source: `<x b/>\n`, marker: "b" },
      { name: "a string attribute", source: `<x a="v"/>\n`, marker: 'a="v"' },
      { name: "a default attribute", source: `<x="v"/>\n`, marker: '"v"' },
      { name: "a spread", source: `<x ...rest/>\n`, marker: "...rest" },
      { name: "a bound attribute", source: `<x v:=y/>\n`, marker: "v" },
      { name: "a tag argument", source: `<x(1)/>\n`, marker: "1" },
      {
        name: "tag params",
        source: `<x|a, b|/>\n`,
        present: (tree) => {
          const tag = tree.children[0];
          return tag?.kind === "tag" && tag.params.join(",") === "a,b";
        },
      },
      {
        name: "CDATA",
        source: `<a><![CDATA[ x ]]></a>\n`,
        marker: "<![CDATA[",
      },
      { name: "`<?xml?>`", source: `<?xml version="1.0"?>\n`, marker: "<?" },
      {
        name: "`<!doctype>`",
        source: `<!doctype html>\n`,
        marker: "<!doctype",
      },
      {
        name: "`<define>`",
        source: `<define/R|a|>${D}a}</define>\n`,
        marker: "<define",
      },
      { name: "`<return>`", source: `<return=1/>\n`, marker: "<return" },
      { name: "a tag variable", source: `<x/v/>\n`, marker: "<x/v/>" },
      { name: "a dynamic tag", source: `<${D}d}/>\n`, marker: `${D}d}` },
      {
        name: "a bare interpolation line",
        source: `${D}d}\n`,
        marker: `${D}d}`,
      },
      { name: "a bare `$!{}` line", source: `$!{x}\n`, marker: "$!{x}" },
      {
        name: "a scriptlet",
        source: `$ const x = 1\n`,
        marker: "$ const x = 1",
      },
      { name: "a reserved name", source: `<try>x</try>\n`, marker: "<try>" },
      {
        name: "an attribute method",
        source: `<x value({ post }) { return 1 }/>\n`,
        marker: "({ post }) { return 1 }",
      },
    ];

    it.each(rows)("$name", ({ source, marker, present, options }) => {
      const result = parseData(source, "/t.mx", options);
      if (!result.tree) {
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]?.severity).toBe("error");
        return;
      }
      expect(result.diagnostics).toEqual([]);
      const tree = result.tree;
      if (marker !== undefined) {
        const start = source.indexOf(marker);
        expect(start, `marker ${marker} not in the source`).toBeGreaterThan(-1);
        expect(
          covers(spansOf(tree), start, start + marker.length),
          `${marker} is covered by no span in the tree`,
        ).toBe(true);
      }
      if (present) expect(present(tree)).toBe(true);
    });

    it('the same holds under `structural: "reject"`', () => {
      const passing = rows.filter(
        (row) =>
          row.name.startsWith("shorthand") ||
          row.name === "a boolean attribute" ||
          row.name === "a tag argument",
      );
      for (const row of passing) {
        const result = parseData(row.source, "/t.mx", { structural: "reject" });
        expect(result.diagnostics).toEqual([]);
        expect(result.tree).toBeDefined();
      }
    });
  });
});

/** Every `SourceSpan` in a tree, by deep walk (the tree is plain data). */
function spansOf(value: unknown): { sourceStart: number; sourceEnd: number }[] {
  const out: { sourceStart: number; sourceEnd: number }[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, item] of Object.entries(node)) {
      // A Babel node carries its own offsets; only the tree's spans count.
      if (key === "node") continue;
      walk(item);
    }
    const span = node as { sourceStart?: unknown; sourceEnd?: unknown };
    if (
      typeof span.sourceStart === "number" &&
      typeof span.sourceEnd === "number"
    ) {
      out.push({ sourceStart: span.sourceStart, sourceEnd: span.sourceEnd });
    }
  };
  walk(value);
  return out;
}

function covers(
  spans: { sourceStart: number; sourceEnd: number }[],
  start: number,
  end: number,
): boolean {
  for (let offset = start; offset < end; offset++) {
    if (
      !spans.some(
        (span) => span.sourceStart <= offset && offset < span.sourceEnd,
      )
    ) {
      return false;
    }
  }
  return true;
}

/** Every `sourceStart`/`sourceEnd` in the tree whose value is not a number. */
function nonNumericSpanOffsets(value: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      for (const [index, item] of node.entries())
        walk(item, `${path}[${index}]`);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, item] of Object.entries(node)) {
      // A Babel node carries its own offsets; only the tree's spans count.
      if (key === "node") continue;
      if (
        (key === "sourceStart" || key === "sourceEnd") &&
        typeof item !== "number"
      ) {
        out.push(`${path}.${key} = ${JSON.stringify(item)}`);
      }
      walk(item, `${path}.${key}`);
    }
  };
  walk(value, "tree");
  return out;
}

// biome-ignore-start lint/suspicious/noTemplateCurlyInString: the reject messages quote core's MX placeholder syntax, not JS templates
describe("finding 3: a whitespace-only text reject points at the text", () => {
  it("`<pre>  </pre>` reports the text's start, not the close tag", () => {
    // The span is the two spaces at 5–7; advancing past the whitespace
    // lands on 7, the `<` of `</pre>`.
    failWith(
      `<pre>  </pre>\n`,
      { message: STATIC("text"), line: 1, column: 5 },
      { structural: "reject" },
    );
    failWith(
      `<title> </title>\n`,
      { message: STATIC("text"), line: 1, column: 7 },
      { structural: "reject" },
    );
  });

  it("a text with a non-whitespace character is unchanged", () => {
    failWith(
      `<a>x</a>`,
      { message: STATIC("text"), line: 1, column: 3 },
      { structural: "reject" },
    );
    failWith(
      `<a>\t\tx</a>\n`,
      { message: STATIC("text"), line: 1, column: 5 },
      { structural: "reject" },
    );
  });
});

describe("round 4 (rev-236-r2)", () => {
  describe("finding 1: `parseData` must never throw on valid input", () => {
    // A shorthand class next to an authored `class` is valid Marko. Core
    // merges the two into one synthesized expression that has no span, and
    // the tree builder used to raise its "core IR invariant broken" error —
    // an exception with no position and no tree, where every other bad input
    // gets one positioned diagnostic.
    const MERGED =
      "a shorthand class (`.a`) together with a `class` attribute is not supported in a data file: write every class in the `class` attribute";

    it.each([
      ["html syntax", `<x.a class="b"/>\n`, 1, 0],
      ["concise syntax", `x.a class="b"\n`, 1, 0],
      ["an expression value", `<x.a class=y/>\n`, 1, 0],
      ["an array value", `<x.a class=["b"]/>\n`, 1, 0],
      ["two shorthand classes", `<x.a.b class="c"/>\n`, 1, 0],
    ])(
      "rejects %s as one positioned diagnostic",
      (_case, source, line, column) => {
        failWith(source, { message: MERGED, line, column });
      },
    );

    it("rejects it on an attribute tag too, at the attribute tag", () => {
      failWith(`<a><@t.c class="d"/></a>\n`, {
        message: MERGED,
        line: 1,
        column: 3,
      });
    });

    it("a shorthand class alone is still fine", () => {
      const tag = firstTag(ok(`<x.a.b/>\n`));
      expect(tag.attrs).toEqual([
        expect.objectContaining({
          kind: "string",
          name: "class",
          value: "a b",
        }),
      ]);
    });

    it("an authored `class` alone is still fine", () => {
      const tag = firstTag(ok(`<x class="b"/>\n`));
      expect(tag.attrs).toEqual([
        expect.objectContaining({ kind: "string", name: "class", value: "b" }),
      ]);
    });

    it("never throws over a list of odd inputs", () => {
      // The real contract: `parseData` returns a result for everything, and
      // an internal error escaping is the failure mode. Each source here is
      // either fine or a positioned diagnostic; none may throw.
      const inputs = [
        `<x.a class="b"/>\n`,
        `x.a class="b"\n`,
        `<x.a class=y/>\n`,
        `<x.a class=["b"]/>\n`,
        `<a><@t.c class="d"/></a>\n`,
        `<a#myid.cls1.cls2 x=1/>\n`,
        `<div.foo/>\n`,
        `<x/v/>\n`,
        `${D}d}\n`,
        `$!{x}\n`,
        `$const x = 1\n`,
        `<define/R|a|>${D}a}</define>\n`,
        `<return=1/>\n`,
        `<try>x</try>\n`,
        `<!doctype html>\n`,
        `<a><![CDATA[ x ]]></a>\n`,
        `<?xml version="1.0"?>\n`,
        `<x\n`,
        `<svg:rect/>\n`,
        `<é/>\n`,
        `",
      <pre>  </pre>
      <a>\t\tx</a>
      `,
        ``,
        `\n\n\n`,
      ];
      for (const source of inputs) {
        for (const structural of ["pass", "reject"] as const) {
          let decided: ParseDataResult;
          try {
            decided = parseData(source, "/t.mx", { structural });
          } catch (error) {
            throw new Error(
              `parseData threw on ${JSON.stringify(source)} under structural: "${structural}": ${(error as Error).message}`,
            );
          }
          // Whatever it decided, it decided it in the documented shape: an
          // error means no tree, and no error means one.
          if (decided.diagnostics.some((d) => d.severity === "error")) {
            expect(decided.tree).toBeUndefined();
          } else {
            expect(decided.tree).toBeDefined();
          }
        }
      }
    });
  });

  describe("finding 2: the tag-name rule is narrow", () => {
    // It was written to catch a concise `$!{x}` line and a `$const x = 1`
    // scriptlet, both of which Marko parses as a tag *name*. It must not
    // refuse a non-ASCII name (a data file in Portuguese or Japanese).
    it.each([
      ["a non-ASCII name", `<é/>\n`],
      ["a CJK name", `<日本/>\n`],
      ["a non-ASCII name, concise", `é\n`],
      ["a dollar inside a name", `<a$b/>\n`],
      ["an underscore name", `<_x/>\n`],
      ["a leading digit", `<1x/>\n`],
    ])("accepts %s", (_case, source) => {
      const tree = ok(source);
      expect(tree.children[0]).toMatchObject({ kind: "tag" });
    });

    // Decision 146: a colon in a tag name is the `name` sugar, so the
    // XML-style namespaced spellings are the tag plus a name, not a name that
    // carries a colon. (Attribute tags keep their colon, below.)
    it.each([
      ["a namespaced name", `<svg:rect/>\n`, "svg", "rect"],
      ["an xml: prefix", `<xml:lang/>\n`, "xml", "lang"],
      ["a namespaced dashed name", `<ns:tag-x/>\n`, "ns", "tag-x"],
      ["a namespaced name, concise", `svg:rect\n`, "svg", "rect"],
      ["a close tag form", `<a:b></a:b>\n`, "a", "b"],
    ])("splits %s into the tag plus `name`", (_case, source, tag, name) => {
      const node = firstTag(ok(source));
      expect(node.name).toBe(tag);
      expect(
        node.attrs.map((a) =>
          a.kind === "string" || a.kind === "atom" ? [a.name, a.value] : null,
        ),
      ).toEqual([["name", name]]);
    });

    it("accepts the same names as attribute tags, so both agree", () => {
      const tag = firstTag(ok(`<a><@svg:rect/><@é/><@ns:tag-x/></a>\n`));
      expect(
        tag.attrTags.map((node) =>
          node.kind === "attr-tag" ? node.name : node.kind,
        ),
      ).toEqual(["svg:rect", "é", "ns:tag-x"]);
    });

    it("still rejects a bare `$!{x}` line as a dynamic tag", () => {
      failWith(`$!{x}\n`, {
        message:
          "a dynamic tag (`<${expr}>`) has no name; the data tree is static and needs one",
        line: 1,
        column: 0,
      });
    });

    it("still rejects a `$…` scriptlet line and a `!…` line", () => {
      for (const [source, name] of [
        [`$const x = 1\n`, "$const"],
        [`$a\n`, "$a"],
        [`!x\n`, "!x"],
      ] as const) {
        failWith(source, {
          message: `\`${name}\` is not a tag name a data file can use: it must not start with \`$\` or \`!\`, or contain \`{\`, \`}\` or whitespace — those are a \`$…\` scriptlet or a \`\${…}\` placeholder, which a data file does not have`,
          line: 1,
          column: 0,
        });
      }
    });

    it("still rejects a name holding a placeholder", () => {
      // A name with *whitespace* in it is unreachable — Marko reads `a b` as
      // the tag `a` with an attribute `b` — so the whitespace arm of the rule
      // is defensive. The placeholder arm is the reachable one.
      const result = parseData(`$!{x} y\n`, "/t.mx");
      expect(result.tree).toBeUndefined();
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.message).toBe(
        "a dynamic tag (`<${expr}>`) has no name; the data tree is static and needs one",
      );
    });

    it("applies the same rule to an attribute tag", () => {
      // `<@$const/>` is rejected exactly as `<$const/>` is, at 1:3 — the
      // attribute tag's own position, which is what the check reports.
      failWith(`<a><@$const/></a>\n`, {
        message:
          "`$const` is not a tag name a data file can use: it must not start with `$` or `!`, or contain `{`, `}` or whitespace — those are a `$…` scriptlet or a `${…}` placeholder, which a data file does not have",
        line: 1,
        column: 3,
      });
    });

    it("applies the dynamic-tag rule to an attribute tag too", () => {
      failWith(`<a><@$!{x}/></a>\n`, {
        message:
          "a dynamic tag (`<${expr}>`) has no name; the data tree is static and needs one",
        line: 1,
        column: 3,
      });
    });
  });
});
// biome-ignore-end lint/suspicious/noTemplateCurlyInString: the reject messages quote core's MX placeholder syntax, not JS templates

describe("fail-fast parse (the addendum's item 8)", () => {
  it("a syntax error returns `tree: undefined` and one positioned error", () => {
    const result = parseData(`<x\n`, "/t.mx");
    expect(result.tree).toBeUndefined();
    expect(result.diagnostics).toEqual([
      {
        severity: "error",
        message: "EOF reached while parsing open tag",
        line: 1,
        column: 0,
        offset: 0,
      },
    ]);
  });

  it("the error is positioned on its own line, with the offset derived", () => {
    const result = parseData(`import a from "b"\n<x a=/>\n`, "/t.mx");
    expect(result.tree).toBeUndefined();
    expect(result.diagnostics).toEqual([
      {
        severity: "error",
        message: "Missing value for attribute",
        line: 2,
        column: 5,
        offset: 23,
      },
    ]);
  });

  it("no partial tree accompanies a rejected construct", () => {
    const result = parseData(`<good/>\n<return=1/>\n`, "/t.mx");
    expect(result.tree).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
  });
});

describe("a registration error with no source position is file-level", () => {
  const source = "<pub/>\n<other/>\n";

  it("a `finalize`-only declaration reports at 1:0, offset 0", () => {
    const result = parseData(source, "/t.mx", {
      customTags: { pub: { finalize: () => [] } },
    });
    expect(result.tree).toBeUndefined();
    expect(result.diagnostics).toEqual([
      {
        severity: "error",
        message:
          "`<pub>`: a custom tag that defines only `finalize` has no call site and nothing to collect; add a `transform`, an `analyze` or a template file",
        line: 1,
        column: 0,
        offset: 0,
      },
    ]);
  });

  it("a contradictory attribute declaration reports at 1:0, offset 0", () => {
    const result = parseData(source, "/t.mx", {
      customTags: { pub: { attributes: { n: { items: "string" } } } },
    });
    expect(result.tree).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      severity: "error",
      line: 1,
      column: 0,
      offset: 0,
    });
    expect(result.diagnostics[0]?.message).toContain('"n" attribute');
  });

  it("an unknown child-declaration key reports at 1:0, offset 0", () => {
    const result = parseData(source, "/t.mx", {
      customTags: {
        pub: {
          children: { other: { nope: true } as never },
        },
        other: {},
      },
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      severity: "error",
      line: 1,
      column: 0,
      offset: 0,
    });
    expect(result.diagnostics[0]?.message).toContain('Unknown key "nope"');
  });

  it("an empty source still reports at 1:0, offset 0", () => {
    const result = parseData("", "/t.mx", {
      customTags: { pub: { finalize: () => [] } },
    });
    expect(result.diagnostics[0]).toMatchObject({
      line: 1,
      column: 0,
      offset: 0,
    });
  });

  it("an error with a real position is left alone", () => {
    const result = parseData("<x\n", "/t.mx");
    expect(result.diagnostics[0]).toMatchObject({
      line: 1,
      column: 0,
      offset: 0,
    });
    const later = parseData("<good/>\n<return=1/>\n", "/t.mx");
    expect(later.diagnostics[0]?.line).toBe(2);
    expect(later.diagnostics[0]?.offset).toBeGreaterThan(0);
  });
});

describe("an error in another file keeps `offset: -1`", () => {
  it("is not normalized: its position stays the other file's", () => {
    const badge: TemplateBackedTag = {
      template: { filename: "/t/tags/badge.mx", source: "<return=1/>\n" },
    };
    const result = parseData("<badge/>\n", "/t.mx", {
      customTags: { badge },
    });
    expect(result.tree).toBeUndefined();
    expect(result.diagnostics).toEqual([
      {
        severity: "error",
        message: expect.stringContaining("`<return>` needs the evaluated mode"),
        line: 1,
        column: 0,
        offset: -1,
        file: "/t/tags/badge.mx",
      },
    ]);
  });
});

describe("a warning with no source position is file-level too", () => {
  const source = "<good/>\n<pub/>\n";
  const cases = [
    {
      label: "line 0, current file",
      at: { line: 0, column: 0 },
      want: { line: 1, column: 0, offset: 0 },
    },
    {
      label: "line -1, current file",
      at: { line: -1, column: 19 },
      want: { line: 1, column: 0, offset: 0 },
    },
    {
      label: "line 0, foreign file",
      at: { line: 0, column: 0, file: "/foreign.mx" },
      want: { line: 1, column: 0, offset: -1 },
    },
    {
      label: "positioned, current file",
      at: { line: 2, column: 3 },
      want: { line: 2, column: 3, offset: 11 },
    },
    {
      label: "positioned, foreign file",
      at: { line: 2, column: 3, file: "/foreign.mx" },
      want: { line: 2, column: 3, offset: -1 },
    },
  ];

  it.each(cases)("$label", ({ at, want }) => {
    const warnings: MxWarning[] = [];
    const result = parseData(source, "/t.mx", {
      warnings,
      customTags: {
        pub: {
          transform() {
            warnings.push({ message: "probe warning", ...at });
            return [];
          },
        },
      },
    });
    expect(result.tree).toBeDefined();
    expect(result.diagnostics).toEqual([
      {
        severity: "warning",
        message: "probe warning",
        ...want,
        ...(at.file !== undefined ? { file: at.file } : {}),
      },
    ]);
    // The caller-owned sink keeps core's raw position.
    expect(warnings[0]?.line).toBe(at.line);
    expect(warnings[0]?.column).toBe(at.column);
  });
});

const nameOf = (attr: DataAttr): string | undefined =>
  attr.kind === "spread" ? undefined : attr.name;

describe("valueless default-attribute modifier (Mesh span bug)", () => {
  const options = { structural: "reject" } as const;

  // Decision 146 made the bare `:Todo` `name="Todo"` sugar; the Mesh bug was
  // an invariant failure on every valueless modifier attribute, so the
  // regression rows use the spellings that are still modifiers.
  it.each([
    ["x:foo", "<a x:foo/>"],
    ["x:", "<a x:/>"],
    ["value:foo", "<a value:foo/>"],
    ["value:Todo", 'entity value:Todo table="todos"\n'],
  ])("`%s` valueless modifier carries a zero-width value span", (name, src) => {
    const attr = firstTag(ok(src, options)).attrs.find(
      (a) => nameOf(a) === name,
    );
    expect(attr).toMatchObject({ kind: "string", value: "" });
    const span = (attr as Extract<DataAttr, { kind: "string" }>).valueSpan;
    expect(span.sourceEnd).toBe(span.sourceStart);
  });

  it("a child line with a valueless modifier does not throw either", () => {
    const tree = ok("entity\n  create value:complete done=true\n", options);
    const create = firstTag(tree).children.find(
      (c) => c.kind === "tag" && c.name === "create",
    ) as DataTag;
    expect(create.attrs.map(nameOf)).toContain("value:complete");
  });

  it("the other modifier forms keep working (`x:=y` bound, `class:x`)", () => {
    expect(firstTag(ok("<a x:=y/>", options)).attrs[0]).toMatchObject({
      kind: "expression",
      name: "x",
      bound: true,
    });
    const classX = firstTag(ok('<a class:x="y"/>', options)).attrs[0];
    expect(classX?.kind).toBeDefined();
  });
});

// Decision 146: `:name`, `#id` and `.class` sugar reaches the tree as the
// attributes the author would have written.
describe("name sugar (decision 146)", () => {
  const options = { structural: "reject" } as const;
  const attrNames = (src: string) =>
    firstTag(ok(src, options)).attrs.map((a) =>
      a.kind === "string" || a.kind === "atom"
        ? `${a.name}=${a.value}`
        : nameOf(a),
    );

  it("`entity :Todo table=...` is name=Todo (the Mesh spelling)", () => {
    const entity = firstTag(ok('entity :Todo table="todos"\n', options));
    expect(
      entity.attrs.map((a) =>
        a.kind === "string" || a.kind === "atom"
          ? [a.name, a.value]
          : nameOf(a),
      ),
    ).toEqual([
      ["name", "Todo"],
      ["table", "todos"],
    ]);
    // Decision 156 addendum 1, item 2: the sugar's `name` is an atom; the
    // token `:Todo` is both the name span and the atom's span.
    const name = entity.attrs[0] as Extract<DataAttr, { kind: "atom" }>;
    expect(name.kind).toBe("atom");
    expect(name.nameSpan).toEqual({ sourceStart: 7, sourceEnd: 12 });
    expect(name.span).toEqual({ sourceStart: 7, sourceEnd: 12 });
  });

  it("a child line `create :complete ...` works", () => {
    const tree = ok("entity\n  create :complete done=true\n", options);
    const create = firstTag(tree).children.find(
      (c) => c.kind === "tag" && c.name === "create",
    ) as DataTag;
    expect(create.attrs.map(nameOf)).toEqual(["name", "done"]);
  });

  it.each([
    ['<input:email type="email"/>', ["name=email", "type=email"]],
    ["<:email/>", ["name=email"]],
    ["<a.c:b/>", ["name=b", "class=c"]],
    ['<a x="1" :b/>', ["x=1", "name=b"]],
    ['<a x="1" #b .c :d/>', ["x=1", "id=b", "class=c", "name=d"]],
  ])("%s", (src, expected) => {
    expect(attrNames(src)).toEqual(expected);
  });

  it("an unnamed `<:title/>` is the data target's default tag, named `title`", () => {
    const tag = firstTag(ok("<:title/>\n", options));
    expect(tag.name).toBe("object");
    expect(
      tag.attrs.map((a) =>
        a.kind === "string" || a.kind === "atom"
          ? [a.name, a.value]
          : nameOf(a),
      ),
    ).toEqual([["name", "title"]]);
  });
});

// Decision 146, lead ruling: an attribute tag's name is a property key, not an
// element, so `<@svg:rect>` is not split; attribute-position sugar on an
// attribute tag applies (`<@z .b>` gives `class="b"`).
describe("name sugar on attribute tags", () => {
  it("`<@svg:rect/>` keeps its colon and gets no name", () => {
    const tag = firstTag(ok("<a><@svg:rect/></a>\n"));
    expect(
      tag.attrTags.map((node) =>
        node.kind === "attr-tag" ? node.name : node.kind,
      ),
    ).toEqual(["svg:rect"]);
    const rect = tag.attrTags[0];
    expect(rect?.kind === "attr-tag" ? rect.attrs : null).toEqual([]);
  });

  it('`<@z .b/>` gives the attribute tag `class="b"`', () => {
    const tag = firstTag(ok("<a><@z .b/></a>\n"));
    const z = tag.attrTags[0];
    expect(z?.kind === "attr-tag" ? z.name : null).toBe("z");
    expect(
      z?.kind === "attr-tag"
        ? z.attrs.map((a) =>
            a.kind === "string" || a.kind === "atom"
              ? [a.name, a.value]
              : nameOf(a),
          )
        : null,
    ).toEqual([["class", "b"]]);
  });

  it("`<@z :b #c/>` gives name and id", () => {
    const tag = firstTag(ok("<a><@z :b #c/></a>\n"));
    const z = tag.attrTags[0];
    expect(
      z?.kind === "attr-tag"
        ? z.attrs.map((a) =>
            a.kind === "string" || a.kind === "atom"
              ? [a.name, a.value]
              : nameOf(a),
          )
        : null,
    ).toEqual([
      ["name", "b"],
      ["id", "c"],
    ]);
  });
});

// TODO `data-dynamic-shorthand-invariant`: `parseData('<a.${x}/>')` used to
// throw "core IR invariant broken — attribute `class` carries no name span"
// instead of returning a diagnostic. #338 gave a shorthand attribute a real
// nameSpan, so the case works now; this pins that, and that the `class` the
// tree carries names the expression the author wrote.
describe("a dynamic shorthand class on data", () => {
  it("a dynamic tag-adjacent class shorthand builds", () => {
    const tag = firstTag(ok(`<a.${D}x}/>`));
    const cls = tag.attrs[0];
    expect(cls?.kind).toBe("expression");
    if (cls?.kind !== "expression") throw new Error("expected an expression");
    expect(cls.name).toBe("class");
    expect(cls.value.code).toBe("x");
    // #338: the name span is the sigil plus the token, as the static `.cls`
    // form reports — for the dynamic shorthand that is `.${x}`, not just `x`.
    expect(slice(`<a.${D}x}/>`, named(cls.nameSpan))).toBe(`.${D}x}`);
  });

  it.each([
    [`<a.${D}x} .${D}y}/>`, "a dynamic shorthand works only tag-adjacent"],
    [`<a .${D}x}/>`, "a dynamic shorthand works only tag-adjacent"],
    [
      `<a.${D}x} class="y"/>`,
      "a shorthand class (`.a`) together with a `class` attribute",
    ],
  ])("%s is a positioned diagnostic, not a throw", (source, expected) => {
    const result = parseData(source, "/t.mx");
    expect(result.tree).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.severity).toBe("error");
    expect(result.diagnostics[0]?.message).toContain(expected);
  });
});

// TODO `data-import-tag-internal-error`: `<root><import:x/></root>` used to
// throw "@mxlang/data: unexpected IR node kind `Import` in a body". The cause
// was core's: a `:name` sugar on a statement tag rewrote into `<import
// name="x"/>`, which lowers to a statement node in whatever body the tag sits
// in. Core now rejects that sugar, positioned on the colon, so every target
// reports source feedback instead of an internal error.
describe("a `:name` sugar on a statement tag nested in a body", () => {
  it.each([
    ["import", "<root><import:x/></root>", 13],
    ["export", "<root><export:x/></root>", 13],
    ["static", "<root><static:x/></root>", 13],
  ])("%s", (name, source, column) => {
    failWith(source, {
      message: `a \`:name\` is not supported on the statement tag \`${name}\`: its text is code, not attributes — write \`${name} …\` at the root of the template instead`,
      line: 1,
      column,
    });
  });

  it("is reported at the root too", () => {
    failWith("<import:x/>", {
      message:
        "a `:name` is not supported on the statement tag `import`: its text is code, not attributes — write `import …` at the root of the template instead",
      line: 1,
      column: 7,
    });
  });
});
