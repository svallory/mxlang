import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseNpm } from "@babel/parser";
import { describe, expect, it } from "vitest";
import { parse as parseVendored } from "@mxlang/babel";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixturesDir = `${repoRoot}/fixtures`;
const distEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

type ParserOptions = {
  sourceType: "module";
  plugins: ("jsx" | "typescript")[];
  tokens: boolean;
  ranges: false;
};

const parserOptions: ParserOptions = {
  sourceType: "module",
  plugins: ["jsx", "typescript"],
  tokens: false,
  ranges: false,
};

const tokenizedOptions: ParserOptions = {
  ...parserOptions,
  tokens: true,
};

function fixtureTwins(): { name: string; source: string }[] {
  return readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = `${fixturesDir}/${entry.name}/twin.tsx`;
      return { name: entry.name, source: readFileSync(path, "utf8") };
    });
}

const syntheticSnippets: { name: string; source: string }[] = [
  {
    name: "generic-arrow",
    source: "const identity = <T,>(x: T) => x;\n",
  },
  {
    name: "class-with-decorators-disabled",
    source: "class Foo {\n  bar() {\n    return 1;\n  }\n}\n",
  },
  {
    name: "jsx-fragments-and-namespaced-attributes",
    source: `
      const el = (
        <>
          <div on:scroll={() => {}} prop:value="x" attr:title="y" bool:open={true}>
            <span>text</span>
          </div>
        </>
      );
    `,
  },
];

const cases = [...fixtureTwins(), ...syntheticSnippets];

describe("vendored @babel/parser equivalence", () => {
  for (const { name, source } of cases) {
    it(`produces an identical AST to node_modules/@babel/parser for ${name}`, () => {
      const vendoredAst = parseVendored(source, parserOptions);
      const npmAst = parseNpm(source, parserOptions);

      expect(vendoredAst).toEqual(npmAst);
    });
  }

  // tokens: true exercises State's initial flags (e.g. canStartJSXElement)
  // in a way tokens: false's parse-only path doesn't: a wrong initial flag
  // value changes what the first token is, not just internal bookkeeping.
  //
  // Each parser module has its own singleton TokenType table (tt), so a
  // token's `type` property holds function references (e.g.
  // `updateContext`) that are structurally identical but never `===` across
  // the two module instances — toEqual treats that as a real difference.
  // This is expected, not a bug in either parser: strip `type` down to its
  // `label` (the only field that identifies which token type it is) before
  // comparing.
  function stripTokenType<T>(ast: T): T {
    return JSON.parse(
      JSON.stringify(ast, (key, value) =>
        key === "type" && value && typeof value === "object" && "label" in value
          ? value.label
          : value,
      ),
    );
  }

  for (const { name, source } of cases) {
    it(`produces identical tokens to node_modules/@babel/parser for ${name}`, () => {
      const vendoredAst = parseVendored(source, tokenizedOptions);
      const npmAst = parseNpm(source, tokenizedOptions);

      expect(stripTokenType(vendoredAst)).toEqual(stripTokenType(npmAst));
    });
  }
});

describe("built dist/index.js equivalence", () => {
  const distExists = existsSync(distEntry);

  // This test parses every fixture file with both parsers (~1 s idle, >5 s
  // under machine load). 4x the idle time = 4 s, still short of the 5000 ms
  // default, but peak load pushes it over; 4x the worst measured time (5 s)
  // is 20 s. Scoped to this test rather than raised globally.
  it.skipIf(!distExists)(
    distExists
      ? "produces an identical AST to node_modules/@babel/parser for every case"
      : "skipped: dist/index.js not found — run `bun run build` in packages/parser first",
    async () => {
      // `parse` is the MX entry point; the vendored @babel/parser surface is
      // exported as `parseBabel`, and that is what must stay equivalent to npm.
      const { parseBabel: parseDist } = await import(distEntry);

      for (const { source } of cases) {
        const distAst = parseDist(source, parserOptions);
        const npmAst = parseNpm(source, parserOptions);
        expect(distAst).toEqual(npmAst);
      }
    },
    20_000,
  );
});
