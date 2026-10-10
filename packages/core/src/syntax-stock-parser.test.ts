/**
 * Decision 182, PR C: with a stock `htmljs-parser` in place of MX's
 * template parser (simulated below), the default row still
 * compiles, and a table other than the default row is refused with "needs
 * MX's template parser" at each place a table enters: a dialect package
 * that claims the file's extension, the explicit option. (The compile's own parse is the MX front end since port
 * PR 5, which always carries a table, so there is no pre-pass to refuse.)
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// MX's template parser without its syntax-table API: what a stock parser
// offers in its place.
vi.mock("./marko-frontend.ts", async (original) => {
  const actual = await original<typeof import("./marko-frontend.ts")>();
  return {
    ...actual,
    mxTemplateParser: () => {
      const { createParser } = actual.mxTemplateParser();
      return { createParser };
    },
  };
});

const { TranslateError } = await import("./core.ts");
const { dialectProject } = await import("./test-dialect-project.ts");
const { defaultSyntax, explicitSyntax, resolveSyntax } = await import(
  "./syntax-table.ts"
);

const MEMBER = {
  id: "member",
  chars: "&",
  match: "&[a-z]+",
  standIn: "identifier",
  node: { call: "member" },
} as const;

const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-syntax-stock-")));

/**
 * A project in `dir/name` using a table-only dialect package that claims
 * `.tst`. Returns the dialect's module file.
 */
function dialect(name: string, table: unknown): string {
  const root = join(dir, name);
  mkdirSync(root);
  const { packageDir } = dialectProject(root, {
    module: `export default ${JSON.stringify({ table })};`,
  });
  return join(packageDir, "index.mjs");
}
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function caught(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TranslateError);
    return error as InstanceType<typeof TranslateError>;
  }
  throw new Error("expected an error");
}

describe("a stock parser", () => {
  it("the default row needs no parser: resolution is a no-op", () => {
    writeFileSync(join(dir, "package.json"), '{ "name": "x" }');
    const page = join(dir, "page.mx");
    expect(resolveSyntax(page)).toBe(defaultSyntax());
  });

  it("a dialect's table equal to the default row is the default row", () => {
    dialect("same", { concise: true });
    expect(resolveSyntax(join(dir, "same", "page.tst"))).toBe(defaultSyntax());
  });

  it("a dialect's table is refused in the dialect file", () => {
    const file = dialect("other", { lineTriggers: [MEMBER] });
    const error = caught(() => resolveSyntax(join(dir, "other", "page.tst")));
    expect(error.message).toBe(
      "`table`: needs a template parser with the syntax-table API; the installed `htmljs-parser` has none",
    );
    expect([error.file, error.line, error.column]).toEqual([file, 1, 0]);
  });

  it("an explicit table is refused at the file's start", () => {
    const page = join(dir, "page.mx");
    const table = Object.freeze({ ...defaultSyntax(), lineTriggers: [MEMBER] });
    const viaOption = caught(() => explicitSyntax(table, page));
    expect(viaOption.message).toContain(
      "the `dialect` option: needs a template parser",
    );
    expect([viaOption.file, viaOption.line, viaOption.column]).toEqual([
      page,
      1,
      0,
    ]);
  });
});
