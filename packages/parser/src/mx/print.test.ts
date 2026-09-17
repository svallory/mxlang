import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ParserOptions } from "../babel/index.ts";
import { parseBabel } from "../index.ts";
import { print } from "./print.ts";
import { solidRegionCompile } from "./test-helpers.ts";

const fixtures = fileURLToPath(
  new URL("../../../../fixtures/", import.meta.url),
);

const BABEL_OPTS: ParserOptions = {
  sourceType: "module",
  plugins: ["typescript", "jsx"],
};

/**
 * Structural AST equality, ignoring positions and whitespace-only JSX text.
 *
 * Comparison is at the AST level rather than on normalized text because
 * `print()` runs the generator with `retainLines`, which keeps the printed JSX
 * on the source's own lines, while the hand-written twin is formatted across
 * several lines. Those two texts describe the same JSX but never match
 * character for character. Whitespace-only `JSXText` children are dropped on
 * both sides for the same reason: JSX itself discards them, and MX's Marko
 * whitespace rule (AGENTS.md) already drops the newline-bearing runs the twin
 * still carries as formatting.
 */
const IGNORED_KEYS = new Set([
  "loc",
  "start",
  "end",
  "range",
  "extra",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "comments",
  "tokens",
  "errors",
]);

function shape(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(shape).filter((child) => child !== null);
  }
  if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (
      record.type === "JSXText" &&
      typeof record.value === "string" &&
      record.value.trim() === ""
    ) {
      return null;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (IGNORED_KEYS.has(key)) continue;
      out[key] = shape(record[key]);
    }
    return out;
  }
  return node;
}

function programShape(code: string): unknown {
  // Printed output is ordinary JSX, so it must be re-read with the untouched
  // vendored Babel entry point, never with `parse()` (which turns MX mode on
  // and would read `<` in expression position as an MX region).
  const file = parseBabel(code, BABEL_OPTS) as unknown as {
    program: unknown;
  };
  return shape(file.program);
}

describe("print", () => {
  it("prints the counter fixture to the same JSX as its twin", () => {
    const source = readFileSync(`${fixtures}counter/input.solid.mx`, "utf8");
    const twin = readFileSync(`${fixtures}counter/twin.tsx`, "utf8");

    const { code } = print(source, "input.solid.mx", {
      mxRegionCompile: solidRegionCompile,
    });

    expect(programShape(code)).toEqual(programShape(twin));
  });

  it("emits a source map pointing into the MX region", () => {
    const source = readFileSync(`${fixtures}counter/input.solid.mx`, "utf8");
    const { map } = print(source, "input.solid.mx", {
      mxRegionCompile: solidRegionCompile,
    });

    expect(map.version).toBe(3);
    expect(map.sources).toContain("input.solid.mx");
    expect(map.mappings.length).toBeGreaterThan(0);

    // The MX region of fixtures/counter/input.solid.mx is the `<button>` on
    // line 7; at least one mapping must resolve back into it.
    const mxLine =
      source.split("\n").findIndex((line) => line.includes("<button")) + 1;
    expect(mxLine).toBeGreaterThan(0);
    expect(originalLines(map.mappings)).toContain(mxLine);
  });

  it("round-trips plain .tsx to an equal AST", () => {
    const plain = 'export const A = () => <div class="x">{1}</div>;\n';

    const { code } = print(plain, "plain.tsx");

    expect(programShape(code)).toEqual(programShape(plain));
  });

  it("forwards `mx` and `mxRegionCompile` to `parse` for a non-.solid.mx filename", () => {
    const calls: string[] = [];
    print("const view = <div>hi</div>;", "x.ng.mx", {
      mx: true,
      mxRegionCompile: (input) => {
        calls.push(input.source);
        return { code: "null" };
      },
    });

    expect(calls).toEqual(["<div>hi</div>"]);
  });
});

/**
 * Decodes the original (source-side) line of every mapping in a VLQ
 * `mappings` string, 1-based. Only the source-line field is tracked, which is
 * all these assertions need, so this avoids a `source-map` dependency.
 */
function originalLines(mappings: string): number[] {
  const CHARS =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lines = new Set<number>();
  let originalLine = 0;

  for (const group of mappings.split(";")) {
    for (const segment of group.split(",")) {
      if (!segment) continue;

      const fields: number[] = [];
      let value = 0;
      let shift = 0;
      for (const char of segment) {
        const digit = CHARS.indexOf(char);
        if (digit === -1) break;
        const hasContinuation = digit & 32;
        value += (digit & 31) << shift;
        if (hasContinuation) {
          shift += 5;
          continue;
        }
        const negative = value & 1;
        value >>= 1;
        fields.push(negative ? -value : value);
        value = 0;
        shift = 0;
      }

      // A segment with fewer than 4 fields carries no source position.
      if (fields.length < 4) continue;
      originalLine += fields[2] as number;
      lines.add(originalLine + 1);
    }
  }

  return [...lines];
}
