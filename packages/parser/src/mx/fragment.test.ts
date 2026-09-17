import { describe, expect, it } from "vitest";
import { parseSolid } from "./test-helpers.ts";

/** Walks the AST collecting every node of a given type. */
function collect(node: unknown, type: string, out: unknown[] = []): unknown[] {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) collect(item, type, out);
    return out;
  }
  const record = node as Record<string, unknown>;
  if (record.type === type) out.push(record);
  for (const key of Object.keys(record)) {
    if (key === "loc" || key === "extra") continue;
    collect(record[key], type, out);
  }
  return out;
}

const parseMx = (source: string) => parseSolid(source);

describe("TSX fragments in .solid.mx", () => {
  it("prints a JSXFragment with two MX-lowered children", () => {
    const file = parseMx(`const el = <><p>x</p><p>y</p></>;`);
    const fragments = collect(file, "JSXFragment") as { children: unknown[] }[];
    expect(fragments).toHaveLength(1);
    expect(fragments[0]?.children).toHaveLength(2);

    const elements = collect(fragments[0]?.children, "JSXElement") as {
      openingElement: { name: { name: string } };
    }[];
    expect(elements).toHaveLength(2);
    expect(elements[0]?.openingElement.name.name).toBe("p");
    expect(elements[1]?.openingElement.name.name).toBe("p");
  });

  it("parses a fragment with three consecutive MX children", () => {
    const file = parseMx(`const el = <><p>1</p><div>2</div><span>3</span></>;`);
    const elements = collect(file, "JSXElement") as {
      openingElement: { name: { name: string } };
    }[];
    expect(elements).toHaveLength(3);
    expect(elements[0]?.openingElement.name.name).toBe("p");
    expect(elements[1]?.openingElement.name.name).toBe("div");
    expect(elements[2]?.openingElement.name.name).toBe("span");
  });

  it("parses an MX child followed by a JSX expression container", () => {
    const file = parseMx(`const el = <><p>x</p>{expr}</>;`);
    const elements = collect(file, "JSXElement");
    const expressions = collect(file, "JSXExpressionContainer");
    expect(elements).toHaveLength(1);
    expect(expressions).toHaveLength(1);
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: testing MX interpolation
  it("throws for `${}` inside a fragment text child", () => {
    let error: unknown;
    try {
      parseMx(`const el = <> \${x} </>;`);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(SyntaxError);
    expect((error as Error).message).toContain("MX interpolation");
  });

  it("lowers MX constructs like <if> and <for> inside the fragment", () => {
    const file = parseMx(
      `const el = <><if=cond><p>a</p></if><for|x| of=xs><li>\${x}</li></for></>;`,
    );
    const fragments = collect(file, "JSXFragment");
    expect(fragments).toHaveLength(1);

    const elements = collect(file, "JSXElement") as {
      openingElement: { name: { name: string } };
    }[];
    // <if> lowers to <Show>, <for> lowers to <For>
    const names = elements.map((e) => e.openingElement.name.name).sort();
    expect(names).toEqual(["For", "Show", "li", "p"]);
  });

  it("parses nested fragments", () => {
    const file = parseMx(`const el = <><><p>x</p></></>;`);
    const fragments = collect(file, "JSXFragment") as { children: unknown[] }[];
    expect(fragments).toHaveLength(2);
    const elements = collect(file, "JSXElement");
    expect(elements).toHaveLength(1);
  });

  it("reports an MX error, not a fragment, for `<>` inside an MX region body", () => {
    let error: unknown;
    try {
      parseMx(`const el = <div><><p>x</p></></div>;`);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(SyntaxError);
    expect((error as Error).message).toContain(
      'The closing "div" tag was not expected',
    );
  });

  it("reports Babel's own error position for an unclosed fragment", () => {
    let error: unknown;
    try {
      parseMx(`const el = <><p>x</p></div>`);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(SyntaxError);
    const err = error as SyntaxError & {
      loc?: { line: number; index: number };
    };
    expect(err.message).toContain(
      "Expected corresponding JSX closing tag for <>",
    );
    expect(err.loc?.line).toBe(1);
    expect(err.loc?.index).toBe(21);
  });

  it("keeps source-map positions for a child region past the `<>` file-absolute", () => {
    const source = `const el = <>\n  <p>1</p>\n  <p>2</p>\n</>;`;
    const file = parseMx(source);
    const elements = collect(file, "JSXElement") as {
      start: number;
      end: number;
      loc: { start: { column: number; line: number } };
    }[];
    expect(elements).toHaveLength(2);

    // First child
    expect(source.slice(elements[0]?.start, elements[0]?.end)).toBe("<p>1</p>");
    expect(elements[0]?.loc.start.line).toBe(2);

    // Second child
    expect(source.slice(elements[1]?.start, elements[1]?.end)).toBe("<p>2</p>");
    expect(elements[1]?.loc.start.line).toBe(3);
    // 2 spaces indentation
    expect(elements[1]?.loc.start.column).toBe(2);
  });
});
