import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTargetLookup, getCustomTags } from "@mxlang/core";
import { afterAll, describe, expect, it } from "vitest";
import descriptor from "./descriptor.ts";
import { compilePreactMx } from "./index.ts";

const preactTargets = createTargetLookup([descriptor]);

/**
 * Marko 6.3.51 says only "Unable to find entry point for custom tag `<X>`."
 * (`custom-tag.ts` `tagNotFoundError`); MX adds where the tag could come from
 * (audit item 14, cases h14/h04). The emitter is shared with React and Hono,
 * which assert the same text in their own suites. Every suggested fix is
 * compiled too. A lowercase tag is never unresolved on a JSX host (any
 * lowercase name is an intrinsic element), so only `@mxlang/target-html` offers an
 * element did-you-mean.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour
const ANSI = /\x1b\[[0-9;]*m/g;

const root = mkdtempSync(join(tmpdir(), "mx-preact-tag-hints-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function failure(
  source: string,
  filename = "/fixtures/test.mx",
): { message: string; line: number; column: number } {
  try {
    compilePreactMx(source, filename);
  } catch (error) {
    const e = error as { message: string; line: number; column: number };
    return {
      message: e.message.replace(ANSI, ""),
      line: e.line,
      column: e.column,
    };
  }
  throw new Error("expected a compile error, but the template compiled");
}

describe("unresolved tag hints (preact)", () => {
  it("tells an unresolved capitalized tag how to resolve it", () => {
    const error = failure('<Card title="x"/>');
    expect(error.message).toBe(
      'Unable to find entry point for custom tag `<Card>`. Import it (`import Card from "./Card.mx"`) or add `tags/Card.mx`.',
    );
    expect(error).toMatchObject({ line: 1, column: 0 });
  });

  it("the import it suggests compiles", () => {
    expect(() =>
      compilePreactMx(
        'import Card from "./Card.mx"\n<Card title="x"/>',
        "/fixtures/test.mx",
      ),
    ).not.toThrow();
  });

  it("the tags/ file it suggests resolves the tag", () => {
    const dir = join(root, "discovered");
    mkdirSync(join(dir, "tags"), { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(
      join(dir, "tags", "Card.mx"),
      `export interface Input { title: string }\n<h2>\${input.title}</h2>`,
    );
    const page = join(dir, "page.mx");
    const source = '<Card title="x"/>';
    const customTags = getCustomTags(page, {
      host: "preact",
      targets: preactTargets,
    });
    expect(() => compilePreactMx(source, page, { customTags })).not.toThrow();
    expect(failure(source, page).message).toContain("or add `tags/Card.mx`.");
  });

  it("suggests the nearest imported component for a near-miss", () => {
    const error = failure('import Badge from "./Badge.mx"\n<Bage label="a"/>');
    expect(error.message).toBe(
      "Unable to find entry point for custom tag `<Bage>`. Did you mean `<Badge>`?",
    );
    expect(error).toMatchObject({ line: 2, column: 0 });
  });
});
