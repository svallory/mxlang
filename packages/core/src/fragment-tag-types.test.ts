import { describe, expect, it } from "vitest";
import { type Node, parseFragment, printExpression } from "./index.ts";

const options = {
  filename: "fragment.mx",
  baseOffset: 30,
  baseLine: 2,
  baseColumn: 4,
};

// Normalize only the fields the opt-in promises to clear. A deep comparison
// then checks every other field, expression wrapper and absolute source span.
function withoutTagTypes(value: Node): Node {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(withoutTagTypes);
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      value.type !== "MxMethod" &&
      field &&
      typeof field === "object" &&
      ["MxTypeArguments", "MxTypeParameters"].includes((field as Node).type)
        ? null
        : withoutTagTypes(field),
    ]),
  );
}

describe("parseFragment tag type erasure opt-in", () => {
  it("leaves the default and explicit false parse unchanged", () => {
    const source =
      "<define/Foo<T>|{ v }: { v: string }|><p<string>>x</p></define>";
    const original = parseFragment(source, options);
    expect(parseFragment(source, { ...options, stripTagTypes: false })).toEqual(
      original,
    );
    expect(original.body[0].typeParams?.type).toBe("MxTypeParameters");
    expect(original.body[0].body[0].typeArgs?.type).toBe("MxTypeArguments");
  });

  it("clears only tag containers, preserving method types, wrappers, text and positions", () => {
    const source = [
      "<define/Foo<T>|{ v }: { v: string }|>",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
      "<p<string> title=(v as string)><span>${v satisfies string}</span>${v!}</p>",
      "<Widget method<T>(x: T) { return x; } value=(<string>v)/>",
      "</define>",
    ].join("\n");
    const original = parseFragment(source, options);
    const stripped = parseFragment(source, { ...options, stripTagTypes: true });
    expect(stripped).toEqual(withoutTagTypes(original));
    const define = stripped.body[0];
    expect(define.typeParams).toBeNull();
    const paragraph = define.body.find((node: Node) => node.type === "MxTag");
    expect(paragraph.typeArgs).toBeNull();
    expect(paragraph.attributes[0].value.node.type).toBe("TSAsExpression");
    const span = paragraph.body.find((node: Node) => node.type === "MxTag");
    expect(span.body[0].expression.node.type).toBe("TSSatisfiesExpression");
    expect(paragraph.body.at(-1).expression.node.type).toBe(
      "TSNonNullExpression",
    );
    expect(printExpression(paragraph.attributes[0].value.node)).toBe(
      printExpression(
        original.body[0].body.find((node: Node) => node.type === "MxTag")
          .attributes[0].value.node,
      ),
    );
    const widget = define.body.find(
      (node: Node) => node.name?.value === "Widget",
    );
    expect(widget.attributes[0].value.typeParams.type).toBe("MxTypeParameters");
    expect(widget.attributes[1].value.node.type).toBe("TSTypeAssertion");
  });
});
