/**
 * Decision 182, PR C: with a stock `htmljs-parser` in place of MX's
 * template parser (simulated below), the default row still
 * compiles, and a table other than the default row is refused with "needs
 * MX's template parser" at each place a table enters: the manifest, the
 * explicit option. (The compile's own parse is the MX front end since port
 * PR 5, which always carries a table, so there is no pre-pass to refuse.)
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const { defaultSyntax, explicitSyntax, normalizeMxSyntax, resolveSyntax } =
  await import("./syntax-table.ts");

const MEMBER = {
  id: "member",
  chars: "&",
  match: "&[a-z]+",
  standIn: "identifier",
  node: { call: "member" },
} as const;

const dir = mkdtempSync(join(tmpdir(), "mx-syntax-stock-"));
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
    // A manifest overlay equal to the default row is the default row.
    expect(
      normalizeMxSyntax({ concise: true }, join(dir, "package.json")),
    ).toBe(defaultSyntax());
  });

  it("a manifest table is refused at the manifest's mx.syntax key", () => {
    const manifest = join(dir, "package.json");
    writeFileSync(
      manifest,
      `{\n  "name": "x",\n  "mx": { "syntax": ${JSON.stringify({ lineTriggers: [MEMBER] })} }\n}\n`,
    );
    const error = caught(() =>
      normalizeMxSyntax({ lineTriggers: [MEMBER] }, manifest),
    );
    expect(error.message).toBe(
      "`mx.syntax`: a syntax table other than the `.mx` default row needs the template parser; the installed `htmljs-parser` has no syntax table",
    );
    expect(error.file).toBe(manifest);
    expect([error.line, error.column]).toEqual([3, 10]);
  });

  it("an explicit table is refused at the file's start", () => {
    const page = join(dir, "page.mx");
    const table = Object.freeze({ ...defaultSyntax(), lineTriggers: [MEMBER] });
    const viaOption = caught(() => explicitSyntax(table, page));
    expect(viaOption.message).toContain("the `syntax` option: a syntax table");
    expect([viaOption.file, viaOption.line, viaOption.column]).toEqual([
      page,
      1,
      0,
    ]);
  });
});
