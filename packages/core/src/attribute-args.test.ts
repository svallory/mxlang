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

  it("retains the existing loop-source argument error with the option off or on", () => {
    for (const option of [undefined, "refuse"] as const) {
      expect(() =>
        compile('<for|x| of=[] by(v)="id"><i/></for>', option),
      ).toThrow("`<for by=...>` requires an expression value");
    }
  });

  it("keeps the builtin try contract error", () => {
    expect(() => compile("<try a(v)=1><i/></try>", "refuse")).toThrow(
      "`<try>`: accepts no attributes",
    );
  });

  it("keeps the host's comment error", () => {
    expect(() =>
      compile("<html-comment a(v)=1>text</html-comment>", "refuse"),
    ).toThrow("host-owned comment refusal");
  });

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
