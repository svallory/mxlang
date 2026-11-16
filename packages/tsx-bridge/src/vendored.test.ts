import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseExpression as parseExpressionNpm,
  parse as parseNpm,
} from "@babel/parser";
import {
  parseExpression as parseExpressionVendored,
  parse as parseVendored,
} from "@mxlang/babel";
import { describe, expect, it } from "vitest";

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
  {
    // Line breaks inside block comments, of every kind Babel counts (LF,
    // CRLF as one break, a lone CR, U+2028, U+2029), one right before `*/`,
    // then a run of single-line comments before tokens on later lines: the
    // fork's bounded line count (UPSTREAM.md, local modification 9) must
    // give the same lines and columns as npm's regex scan.
    name: "line-breaks-in-block-comments",
    source:
      "/* a\nb */ const x = 1; /* c\r\nd */ const y = 2;\n" +
      "/* e\rf */ let z = 3; /* g\u2028h */ z = 4; /* i\u2029j */ z = 5;\n" +
      "/* k\n*/ z = 6; /* l\r\n*/ z = 7; /* m\n\r\r\n*/ z = 8;\n" +
      "/*n*/ /*o*/ /*p*/ z = 9; /*q*/ /*r*/\n" +
      "const w = /*s*/ x + /*t*/ y;\n" +
      "  z = w;\n",
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

/**
 * The option sets the compilers pass when they re-parse with the fork in
 * place of npm `@babel/parser` (core's `coreParser()`, the Solid and Angular
 * hosts). Each case's `valid` snippet puts several block comments on one
 * line; `invalid` is a parse error under those options. The
 * fork must give npm's AST, `errors` under `errorRecovery`, and thrown
 * message and `loc`, or the site would have to stay on npm.
 */
type SiteCase = {
  name: string;
  entry: "parse" | "parseExpression";
  options: Record<string, unknown>;
  valid: string;
  invalid: string;
};

const siteCases: SiteCase[] = [
  {
    // core `core.ts`, `mapping.ts`; Solid `emitter.ts`; Angular `emitter.ts`, `tag-module.ts`
    name: 'parseExpression, plugins ["typescript"]',
    entry: "parseExpression",
    options: { plugins: ["typescript"] },
    valid: "(/*a*/ x: T /*b*/, /*c*/ { y } = {}) => /*d*/ 0",
    invalid: "(/*a*/ x: /*b*/) => 0",
  },
  {
    // core `accessor-reads.ts`; Angular `emitter.ts`
    name: 'parseExpression, plugins [["typescript", {}]]',
    entry: "parseExpression",
    options: { plugins: [["typescript", {}]] },
    valid: "/*a*/ a?.b /*b*/ ?? f(/*c*/ x as T, /*d*/ y!)",
    invalid: "/*a*/ a + /*b*/ * b",
  },
  {
    // core `template-tag.ts` (FRAGMENT_OPTIONS)
    name: "parseExpression, typescript {} with return/await outside a function",
    entry: "parseExpression",
    options: {
      plugins: [["typescript", {}]],
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
    },
    valid: "/*a*/ { /*b*/ ...input, /*c*/ k: await v }",
    invalid: "/*a*/ { /*b*/ k: }",
  },
  {
    // core `template-tag.ts` (FRAGMENT_OPTIONS, script source type)
    name: "parse, typescript {} with return/await outside a function",
    entry: "parse",
    options: {
      plugins: [["typescript", {}]],
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
    },
    valid: "/*a*/ const x = /*b*/ await f(); /*c*/ return x as T;",
    invalid: "/*a*/ const = /*b*/ 1;",
  },
  {
    // core `core.ts`, `lower.ts`; Angular `emitter.ts`, `tag-module.ts`
    name: 'parse, module, plugins ["typescript"]',
    entry: "parse",
    options: { sourceType: "module", plugins: ["typescript"] },
    valid:
      'import { /*a*/ type A, /*b*/ b } from "m"; /*c*/ export interface Input { /*d*/ x?: A }',
    invalid: 'import { /*a*/ a /*b*/ from "m";',
  },
  {
    // core `scan.ts`
    name: "parse, module, typescript, configFile/babelrc false",
    entry: "parse",
    options: {
      sourceType: "module",
      plugins: ["typescript"],
      configFile: false,
      babelrc: false,
    },
    valid:
      "export default /*a*/ { /*b*/ parseOptions: { /*c*/ x: 1 } } /*d*/ satisfies T;",
    invalid: "export default /*a*/ { /*b*/ x: 1;",
  },
  {
    // core `core.ts`, `template-tag.ts`
    name: "parse, module, no plugins",
    entry: "parse",
    options: { sourceType: "module" },
    valid: 'import /*a*/ D, /*b*/ { e as f } /*c*/ from "m";',
    invalid: 'import /*a*/ type { e } /*b*/ from "m";',
  },
  {
    // core `callee-input.ts`
    name: 'parse, module, plugins ["typescript", "jsx"]',
    entry: "parse",
    options: { sourceType: "module", plugins: ["typescript", "jsx"] },
    valid:
      "export const C = (/*a*/ p: P) => /*b*/ <div /*c*/ id={p.id}>{/*d*/ p.x}</div>;",
    invalid: "const e = /*a*/ <div>{/*b*/ x}</span>;",
  },
  {
    // core `accessor-reads.ts`
    name: "parse, module, jsx+typescript with return/await outside a function",
    entry: "parse",
    options: {
      sourceType: "module",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      plugins: ["jsx", "typescript"],
    },
    valid: "/*a*/ const v = await /*b*/ f(<b /*c*/ />); /*d*/ return v;",
    invalid: "/*a*/ return <b>/*b*/;",
  },
  {
    // core `lower.ts` (firstJsxStart), with an explicit undefined option
    name: "parse, module, typescript+jsx, return outside a function, import/export anywhere undefined",
    entry: "parse",
    options: {
      sourceType: "module",
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: undefined,
      plugins: ["typescript", "jsx"],
    },
    valid: "/*a*/ return /*b*/ <b>{/*c*/ x}</b>;",
    invalid: '{ /*a*/ import x from /*b*/ "m"; }',
  },
  {
    // core `lower.ts` (static type units)
    name: "parse, module, typescript, errorRecovery",
    entry: "parse",
    options: {
      sourceType: "module",
      plugins: ["typescript"],
      errorRecovery: true,
    },
    valid: "/*a*/ type T = /*b*/ { x: number } /*c*/ | U;",
    invalid: "/*a*/ export { missing } /*b*/; /*c*/ let x = 1; let x = 2;",
  },
  {
    // core `lower.ts` (decorated statements)
    name: "parse, module, decorators+decoratorAutoAccessors, errorRecovery, start line/column",
    entry: "parse",
    options: {
      sourceType: "module",
      allowReturnOutsideFunction: true,
      errorRecovery: true,
      startLine: 3,
      startColumn: 7,
      plugins: ["typescript", "decorators", "decoratorAutoAccessors"],
    },
    valid:
      "export /*a*/ @d() class C { /*b*/ @e accessor x = /*c*/ 1; } /*d*/ return C;",
    invalid: "/*a*/ @d /*b*/ let x = 1; /*c*/ const y;",
  },
  {
    // core `reserved-bindings.ts` (MARKO_PLUGINS + jsx)
    name: "parse, module, Marko plugins + jsx, start line/column, errorRecovery",
    entry: "parse",
    options: {
      sourceType: "module",
      startLine: 2,
      startColumn: 4,
      allowReturnOutsideFunction: true,
      errorRecovery: true,
      plugins: [
        "objectRestSpread",
        "classProperties",
        ["typescript", { disallowAmbiguousJSXLike: false, dts: false }],
        "jsx",
      ],
    },
    valid: "/*a*/ const { a, /*b*/ ...rest } = <i /*c*/ />; /*d*/ return rest;",
    invalid: "/*a*/ export { gone }; /*b*/ let let = 1;",
  },
  {
    // core `reserved-bindings.ts` (MARKO_PLUGINS, no jsx)
    name: "parse, module, Marko plugins, start line/column",
    entry: "parse",
    options: {
      sourceType: "module",
      startLine: 2,
      startColumn: 4,
      plugins: [
        "objectRestSpread",
        "classProperties",
        ["typescript", { disallowAmbiguousJSXLike: false, dts: false }],
      ],
    },
    valid: "/*a*/ const v = /*b*/ <T>x; /*c*/ class K { /*d*/ p = 1 }",
    invalid: "/*a*/ const v = /*b*/ <b/>;",
  },
  {
    // core `statement-parse-options.ts` via `static-triggers.ts` and `lower.ts`
    name: "parse, Marko statement options, typescript",
    entry: "parse",
    options: {
      sourceType: "module",
      allowSuperOutsideMethod: true,
      allowNewTargetOutsideFunction: true,
      allowUndeclaredExports: true,
      plugins: ["typescript"],
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
    },
    valid:
      "/*a*/ let q = super.x; /*b*/ export { q, u }; /*c*/ return new.target;",
    invalid: "/*a*/ let q = /*b*/ super;",
  },
  {
    // Angular `page-class.ts`
    name: 'parse, module, [["typescript", {}], "decorators-legacy"]',
    entry: "parse",
    options: {
      sourceType: "module",
      plugins: [["typescript", {}], "decorators-legacy"],
    },
    valid:
      '@Component({ /*a*/ selector: "p" /*b*/ }) export class P { /*c*/ @Input() v = 1; /*d*/ go() {} }',
    invalid: "@Component() /*a*/ export /*b*/ const p = 1;",
  },
  {
    // Solid `compile.ts` (`reparseAsTsx`, an `MxStatements` container)
    name: "parse, module, typescript+jsx, start index/line/column, return outside a function",
    entry: "parse",
    options: {
      plugins: ["typescript", "jsx"],
      startIndex: 17,
      startLine: 2,
      startColumn: 5,
      sourceType: "module",
      allowReturnOutsideFunction: true,
    },
    valid: "/*a*/ const x = /*b*/ <b>{/*c*/ y}</b>; /*d*/ return x;",
    invalid: "/*a*/ const x = /*b*/ <b>;",
  },
  {
    // Solid `compile.ts` (`reparseAsTsx`, arguments and parameters)
    name: "parseExpression, typescript+jsx, start index/line/column",
    entry: "parseExpression",
    options: {
      plugins: ["typescript", "jsx"],
      startIndex: 9,
      startLine: 1,
      startColumn: 9,
    },
    valid: "(/*a*/ x: T, /*b*/ { y } = <i />, /*c*/ ...z) => {}",
    invalid: "(/*a*/ x: T, /*b*/ 1 = y) => {}",
  },
];

/** A parse error as plain data: its message plus every own enumerable field (`loc`, `pos`, `code`, `reasonCode`, …). */
function errorData(error: unknown): Record<string, unknown> {
  const own = JSON.parse(JSON.stringify(error)) as Record<string, unknown>;
  return {
    ...own,
    name: (error as Error).name,
    message: (error as Error).message,
  };
}

/** The parse's AST with its `errors` as plain data, or the thrown error as plain data. */
function outcome(
  parse: (code: string, options: never) => unknown,
  code: string,
  options: Record<string, unknown>,
): { ast?: unknown; errors?: unknown; thrown?: unknown } {
  try {
    const ast = parse(code, options as never) as { errors?: unknown[] };
    return { ast, errors: ast.errors?.map(errorData) };
  } catch (error) {
    return { thrown: errorData(error) };
  }
}

describe("vendored @babel/parser equivalence under the option sets the compilers pass", () => {
  for (const { name, entry, options, valid, invalid } of siteCases) {
    it(`matches node_modules/@babel/parser for ${name}`, () => {
      const vendored =
        entry === "parse" ? parseVendored : parseExpressionVendored;
      const npm = entry === "parse" ? parseNpm : parseExpressionNpm;
      // The fixture is what it claims: `valid` parses cleanly, `invalid` is an error.
      const npmValid = outcome(npm as never, valid, options);
      expect(npmValid.thrown).toBeUndefined();
      expect(npmValid.errors ?? []).toEqual([]);
      const npmInvalid = outcome(npm as never, invalid, options);
      expect(
        npmInvalid.thrown !== undefined ||
          (npmInvalid.errors as unknown[]).length > 0,
      ).toBe(true);

      expect(outcome(vendored as never, valid, options)).toEqual(npmValid);
      expect(outcome(vendored as never, invalid, options)).toEqual(npmInvalid);
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
      : "skipped: dist/index.js not found — run `bun run build` in packages/tsx-bridge first",
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
