import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import type { HostDeclarations } from "./declarations.ts";
import memberSyntax from "./fixtures/syntax/member-fixture.ts";
import type { Ir } from "./ir.ts";
import { lowerSource } from "./ir-entry/index.ts";
import type { Dialect } from "./syntax-table.ts";
import { lookup as targets } from "./test-targets.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip diagnostic colour
const ANSI = /\x1b\[[0-9;]*m/g;

function compile(
  source: string,
  attributeArgs?: HostDeclarations["attributeArgs"],
  dialect?: Dialect,
): Ir {
  let result: Ir | undefined;
  compileSource(
    source,
    "/v/test.mx",
    {
      tags: {},
      attrTags: 2,
      isElement: () => true,
      isComponent: (_name, ctx) => ctx.imports.has(_name),
      resolveAttributeMethod: () => true,
      attributeArgs,
      isDelegatedTag: (name) => name === "html-comment",
      resolveDelegatedTag: () => {
        throw new Error("host-owned comment refusal");
      },
    },
    {
      targets,
      dialect,
      emitIr: (ir) => {
        result = ir;
        return "";
      },
    },
  );
  if (!result) throw new Error("no IR");
  return result;
}

function failure(source: string) {
  try {
    compile(source, "refuse");
  } catch (error) {
    const e = error as { message: string; line: number; column: number };
    return { ...e, message: e.message.replace(ANSI, "") };
  }
  throw new Error("expected refusal, but compiled");
}

describe("the opt-in attribute argument refusal", () => {
  it.each([
    ["<button onClick(v)=() => {}/>", "onClick", 1, 8],
    ['<button class(v)="a"/>', "class", 1, 8],
    ["<button onClick()=fn/>", "onClick", 1, 8],
    ["<button onClick(v)/>", "onClick", 1, 8],
    ["<button\n  onClick(v)=fn/>", "onClick", 2, 2],
    ['import C from "./card.js"\n<C onClick(v)=fn/>', "onClick", 2, 3],
    ['import C from "./card.js"\n<C v:fn(x)=1/>', "v:fn", 2, 3],
  ])("refuses %s at the authored attribute", (source, name, line, column) => {
    expect(failure(source)).toMatchObject({
      message: `Unsupported arguments on the \`${name}\` attribute.`,
      line,
      column,
    });
  });

  it.each(["<define/X a(v)=1/>", "<const/x value(v)=1/>"])(
    "retains structural acceptance for %s",
    (source) => {
      expect(() => compile(source, "refuse")).not.toThrow();
    },
  );

  it.each([
    '<for|x| of=[] by(v)="id"><i/></for>',
    "<for|x| of(v)=[]><i/></for>",
    "<for|x| in(v)=input><i/></for>",
    "<for|x| to=3 step(v)=1><i/></for>",
    "<for|x| to(v)=3><i/></for>",
    "<for|x| until(v)=3><i/></for>",
    "<for|x| from(v)=1 to=3><i/></for>",
  ])(
    "reads a loop-source attribute with arguments as stock does, dropping them: %s",
    (source) => {
      expect(() => compile(source)).not.toThrow();
    },
  );

  it.each([
    ['<for|x| of=[] by(v)="id"><i/></for>', "by", 14],
    ["<for|x| of(v)=[]><i/></for>", "of", 8],
    ["<for|x| in(v)=input><i/></for>", "in", 8],
    ["<for|x| to=3 step(v)=1><i/></for>", "step", 13],
    ["<for|x| to(v)=3><i/></for>", "to", 8],
    ["<for|x| until(v)=3><i/></for>", "until", 8],
    ["<for|x| from(v)=1 to=3><i/></for>", "from", 8],
  ])(
    "refuses a loop-source attribute with arguments under the refuse option: %s",
    (source, name, column) => {
      expect(failure(source)).toMatchObject({
        message: `Unsupported arguments on the \`${name}\` attribute.`,
        line: 1,
        column,
      });
    },
  );

  it("still refuses a loop-source attribute with no value", () => {
    expect(() => compile("<for|x| of(v)><i/></for>")).toThrow(
      "`<for of=...>` requires an expression value",
    );
  });

  it("refuses an argument list on the condition attribute under the refuse option", () => {
    expect(failure("<if value(v)=x><i/></if>")).toMatchObject({
      message: "Unsupported arguments on the `value` attribute.",
      line: 1,
      column: 4,
    });
  });

  it.each([
    ["<if=a><i/></if><else if(v)=x><i/></else>", "if", 21],
    ["<if=a><i/></if><else-if value(v)=x><i/></else-if>", "value", 24],
  ])(
    "refuses an argument list on a chained condition attribute under the refuse option: %s",
    (source, name, column) => {
      expect(failure(source)).toMatchObject({
        message: `Unsupported arguments on the \`${name}\` attribute.`,
        line: 1,
        column,
      });
    },
  );

  it("keeps the builtin try contract error", () => {
    expect(() => compile("<try a(v)=1><i/></try>", "refuse")).toThrow(
      "`<try>`: accepts no attributes",
    );
  });

  it.each([
    "<html-comment a(v)=1>text</html-comment>",
    "<html-comment a=1>text</html-comment>",
  ])(
    "reports a host's own refusal of a claimed comment tag before its attributes: %s",
    (source) => {
      expect(() => compile(source, "refuse")).toThrow(
        "host-owned comment refusal",
      );
    },
  );

  it.each([
    "<html-comment a(v)=1>text</html-comment>",
    "<html-comment a=1>text</html-comment>",
  ])(
    "refuses attributes on a claimed comment tag the host renders, as Marko does: %s",
    (source) => {
      let error: { message: string; line: number; column: number } | undefined;
      try {
        compileSource(
          source,
          "/v/test.mx",
          {
            tags: {},
            attrTags: 2,
            isElement: () => true,
            isComponent: () => false,
            resolveAttributeMethod: () => true,
            isDelegatedTag: (name) => name === "html-comment",
            resolveDelegatedTag: () => ({}),
          },
          { targets, emitIr: () => "" },
        );
      } catch (e) {
        error = e as typeof error;
      }
      expect(
        error && { ...error, message: error.message.replace(ANSI, "") },
      ).toMatchObject({
        message: "The `<html-comment>` tag does not support attributes.",
        line: 1,
        column: 14,
      });
    },
  );

  it("reports a comment tag's attribute error before an error in its body, on a host that renders it", () => {
    expect(() =>
      compileSource(
        "<html-comment a=1><for/></html-comment>",
        "/v/test.mx",
        {
          tags: {},
          attrTags: 2,
          isElement: () => true,
          isComponent: () => false,
          resolveAttributeMethod: () => true,
          isDelegatedTag: (name) => name === "html-comment",
          resolveDelegatedTag: () => ({}),
        },
        { targets, emitIr: () => "" },
      ),
    ).toThrow("The `<html-comment>` tag does not support attributes.");
  });

  it("reports a host's disposition refusal of the comment tag before its attributes", () => {
    expect(() =>
      compileSource(
        "<html-comment a=1>text</html-comment>",
        "/v/test.mx",
        {
          tags: { "html-comment": { kind: "unsupported" } },
          attrTags: 2,
          isElement: () => true,
          isComponent: () => false,
          resolveAttributeMethod: () => true,
        },
        { targets, emitIr: () => "" },
      ),
    ).toThrow("`<html-comment>` is not supported");
  });

  // Marko's own attribute checks on its core tags, with or without arguments.
  // Position is the first attribute stock blames; `[source, message, column]`.
  it.each([
    [
      "<if=x a=1><i/></if>",
      "The `<if>` tag only supports the `value=` attribute.",
      6,
    ],
    [
      "<if=x a(v)=1><i/></if>",
      "The `<if>` tag only supports the `value=` attribute.",
      6,
    ],
    [
      "<if=x><i/></if><else-if=y a=1><i/></else-if>",
      "The `<else-if>` tag only supports the `value=` attribute.",
      26,
    ],
    [
      "<if=x><i/></if><else a=1><i/></else>",
      "The `<else>` tag only supports an `if=` attribute.",
      21,
    ],
    [
      "<if=x><i/></if><else a(v)=1><i/></else>",
      "The `<else>` tag only supports an `if=` attribute.",
      21,
    ],
    [
      "<if=x><i/></if><else if=y a=1><i/></else>",
      "The `<else>` tag only supports an `if=` attribute.",
      26,
    ],
    [
      "<if ...x><i/></if>",
      "The `<if>` tag only supports the `value=` attribute.",
      4,
    ],
    [
      "<if foo=x><i/></if>",
      "The `<if>` tag only supports the `value=` attribute.",
      4,
    ],
    [
      "<if=x><i/></if><else-if foo=y><i/></else-if>",
      "The `<else-if>` tag only supports the `value=` attribute.",
      24,
    ],
    [
      "<if a=1 value=x><i/></if>",
      "The `<if>` tag only supports the `value=` attribute.",
      4,
    ],
    [
      "<for|x| of=[] a=1><i/></for>",
      "`<for>` does not support the `a` attribute.",
      14,
    ],
    [
      "<for|x| of=[] a(v)=1><i/></for>",
      "`<for>` does not support the `a` attribute.",
      14,
    ],
    [
      "<for|x| of=a of=b><i/></for>",
      "`<for>` takes the `of` attribute once.",
      13,
    ],
    ["<log a=1/>", "The `<log>` tag only supports the `value=` attribute.", 5],
    [
      "<log a(v)=1/>",
      "The `<log>` tag only supports the `value=` attribute.",
      5,
    ],
    [
      "<log=1 foo=2/>",
      "The `<log>` tag only supports the `value=` attribute.",
      7,
    ],
    [
      "<debug a=1/>",
      "The `<debug>` tag only supports the `value=` attribute.",
      7,
    ],
    [
      "<debug a(v)=1/>",
      "The `<debug>` tag only supports the `value=` attribute.",
      7,
    ],
  ])(
    "refuses an attribute Marko's core tag does not read: %s",
    (source, message, column) => {
      for (const option of [undefined, "refuse"] as const) {
        let error:
          | { message: string; line: number; column: number }
          | undefined;
        try {
          compile(source, option);
        } catch (e) {
          error = e as typeof error;
        }
        expect(
          error && { ...error, message: error.message.replace(ANSI, "") },
        ).toMatchObject({
          message,
          line: 1,
          column,
        });
      }
    },
  );

  it.each([
    "<if=x><i/></if><else if=y><i/></else>",
    "<if=x><i/></if><else><i/></else>",
    '<for|x| of=[] by="id"><i/></for>',
    "<log=1/>",
    "<debug value=1/>",
  ])("keeps accepting the attributes Marko's core tag reads: %s", (source) => {
    expect(() => compile(source, "refuse")).not.toThrow();
  });

  it("refuses an argument list on an attribute tag's attribute through the opt-in", () => {
    expect(
      failure('import C from "./card.js"\n<C><@item a(v)=1/></C>'),
    ).toMatchObject({
      message: "Unsupported arguments on the `a` attribute.",
      line: 2,
      column: 10,
    });
  });

  it.each([
    [
      'import C from "./card.js"\n<C><if=x foo=1><@a/></if></C>',
      "The `<if>` tag only supports the `value=` attribute.",
      9,
    ],
    [
      'import C from "./card.js"\n<C><if=x><@a/></if><else bar=2><@b/></else></C>',
      "The `<else>` tag only supports an `if=` attribute.",
      25,
    ],
  ])(
    "refuses an attribute on a condition wrapping an attribute tag: %s",
    (source, message, column) => {
      expect(failure(source)).toMatchObject({ message, line: 2, column });
    },
  );

  it.each([
    ["<div a()/>", "a", 5],
    ["<div a(v)/>", "a", 5],
    ["<div style(v)=x/>", "style", 5],
    ["<div a(v):=b/>", "a", 5],
    ["<div a=1, (v)=fn/>", "value", 10],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored MX dynamic tag
    ["<${input.tag} a(v)=1/>", "a", 14],
  ])("refuses the ordinary call attribute in %s", (source, name, column) => {
    expect(failure(source)).toMatchObject({
      message: `Unsupported arguments on the \`${name}\` attribute.`,
      line: 1,
      column,
    });
  });

  it("keeps argument expressions, including dialect nodes, by default", () => {
    const ir = compile("<x a(&b)/>", undefined, memberSyntax);
    const node = ir.body[0];
    expect(node?.kind).toBe("Element");
    if (node?.kind !== "Element") throw new Error("no element");
    expect(node.attrs[0]).toMatchObject({
      name: "a",
      args: [{ code: "self.b", nodes: [{ type: "member:Member" }] }],
    });
    const result = lowerSource("x a(&b)\n", "/v/test.mx", {
      dialect: memberSyntax,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.body[0]).toMatchObject({
      kind: "DelegatedTag",
      tag: { attrs: [{ name: "a", args: [{ code: "self.b" }] }] },
    });
  });

  it("still accepts method shorthand when argument lists are refused", () => {
    const ir = compile("<button onClick(v) { return v }/>", "refuse");
    expect(ir.body[0]).toMatchObject({
      kind: "Element",
      attrs: [
        { kind: "event", value: { node: { type: "FunctionExpression" } } },
      ],
    });
  });

  it("lets a dialect's attribute hook refuse first in its own words", () => {
    expect(() => compile("<x &b(v) a(v)=fn/>", "refuse", memberSyntax)).toThrow(
      "`&b` is a member reference and takes no value",
    );
  });
});
