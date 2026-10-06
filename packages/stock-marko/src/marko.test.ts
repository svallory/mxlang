/**
 * `stockMarkoCompile` / `stockMarkoTree`: the proofs in both directions —
 * inside this package `@marko/compiler` runs on the stock parser, and the
 * rest of the repo (packages/core's resolution path) still reaches the
 * patched one.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stockMarkoCompile, stockMarkoTree } from "./marko.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("stockMarkoCompile (the compiler runs on the stock parser)", () => {
  it("`<div x=:a/>` fails in Babel: the value text is `:a`, not MX's stand-in", () => {
    const result = stockMarkoCompile("<div x=:a/>");
    expect(result.ok).toBe(false);
    expect(result.error?.label ?? result.error?.message).toContain(
      "Unexpected token",
    );
    expect(result.error?.loc).toMatchObject({ line: 1, index: 7 });
  });

  it("`<div a=b :c/>` is one value `b :c`: 'Expected a single expression'", () => {
    const result = stockMarkoCompile("<div a=b :c/>");
    expect(result.ok).toBe(false);
    expect(result.error?.label ?? result.error?.message).toContain(
      "Expected a single expression, but found `:`",
    );
    expect(result.error?.loc).toMatchObject({ line: 1, index: 9 });
  });

  it("`<div x={ new :a }/>` fails in Babel (atom syntax, not JS)", () => {
    // Stock reads the expression as `{ new :a }`; Babel fails because
    // `:a` is not JavaScript syntax — that is the stock/patch divergence,
    // not a parser-level divergence here.
    const result = stockMarkoCompile("<div x={ new :a }/>");
    expect(result.ok).toBe(false);
  });

  it("`<div x=a.b .c/>` compiles: stock keeps member access across the space", () => {
    expect(stockMarkoCompile("<div x=a.b .c/>").ok).toBe(true);
  });

  it("ordinary templates compile", () => {
    expect(stockMarkoCompile("<div/>").ok).toBe(true);
    expect(
      stockMarkoCompile("<for|i| of=[1,2]>${i}</for>").ok,
    ).toBe(true);
  });
});

describe("stockMarkoTree", () => {
  it("returns the Marko AST (MarkoTag) for a simple tag", () => {
    const { ok, tree } = stockMarkoTree("<div x=1/>");
    expect(ok).toBe(true);
    const program = tree as {
      type: string;
      body: Array<{ type: string; name: { value: string } }>;
    };
    expect(program.type).toBe("Program");
    expect(program.body[0]?.type).toBe("MarkoTag");
    expect(program.body[0]?.name.value).toBe("div");
  });

  it("member access across the space is one expression in the tree", () => {
    const { ok, tree } = stockMarkoTree("<div x=a.b .c/>");
    expect(ok).toBe(true);
    const tag = (tree as { body: Array<{ attributes: unknown[] }> })
      .body[0];
    expect(tag?.attributes).toHaveLength(1);
    const [attribute] = tag?.attributes as Array<{
      name: string;
      value: { type: string; start: number; end: number };
    }>;
    expect(attribute?.name).toBe("x");
    expect(attribute?.value.type).toBe("MemberExpression");
  });
});

describe("isolation: the rest of the repo is untouched", () => {
  it("packages/core resolves the patched parser from the repo root", () => {
    const coreRequire = createRequire(join(repoRoot, "packages/core/package.json"));
    const installed = readFileSync(
      coreRequire.resolve("htmljs-parser"),
      "utf8",
    );
    expect(installed).toContain("lexAtom");
    expect(installed).toContain("isUnicodeWordCode");
  });

  it("the root patchedDependencies entry is unchanged", () => {
    const root = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as { patchedDependencies?: Record<string, string> };
    expect(root.patchedDependencies).toEqual({
      "htmljs-parser@5.18.0": "patches/htmljs-parser@5.18.0.patch",
    });
  });
});
