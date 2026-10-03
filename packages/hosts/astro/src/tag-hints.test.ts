import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CustomTag, getCustomTags } from "@mxlang/core";
import { afterAll, describe, expect, it } from "vitest";
import { lowerAstroMx } from "./astro-template.ts";

/**
 * Marko 6.3.51 says only "Unable to find entry point for custom tag `<X>`."
 * (`custom-tag.ts` `tagNotFoundError`); MX adds where the tag could come from
 * (audit item 14, cases h14/s08). Every suggested fix is compiled too. A
 * lowercase tag is never unresolved here (any lowercase name is an element),
 * so only `@mxlang/html` offers an element did-you-mean.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour
const ANSI = /\x1b\[[0-9;]*m/g;

const root = mkdtempSync(join(tmpdir(), "mx-astro-tag-hints-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function failure(
  source: string,
  filename = "Test.astro.mx",
  customTags?: Record<string, CustomTag>,
): { message: string; line: number; column: number } {
  try {
    lowerAstroMx(source, filename, { customTags });
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

const FENCE = "---\nconst x = 1;\n---\n";

describe("unresolved tag hints (astro)", () => {
  it("tells an unresolved capitalized tag how to resolve it", () => {
    const error = failure(`${FENCE}<Card title="x"/>`);
    expect(error.message).toBe(
      'Unable to find entry point for custom tag `<Card>`. Import it in the `---` fence (`import Card from "./Card.astro"`) or add `tags/Card.mx`.',
    );
    expect(error).toMatchObject({ line: 4, column: 0 });
  });

  it("the fence import it suggests compiles", () => {
    expect(() =>
      lowerAstroMx(
        '---\nimport Card from "./Card.astro";\n---\n<Card title="x"/>',
        "Test.astro.mx",
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
    const page = join(dir, "page.astro.mx");
    const source = `${FENCE}<Card title="x"/>`;
    const customTags = getCustomTags(page, { host: "astro" });
    expect(() => lowerAstroMx(source, page, { customTags })).not.toThrow();
    expect(failure(source, page).message).toContain("or add `tags/Card.mx`.");
  });

  it("suggests the nearest fence import for a near-miss", () => {
    const error = failure(
      '---\nimport Badge from "./Badge.astro";\n---\n<Bage label="a"/>',
    );
    expect(error.message).toBe(
      "Unable to find entry point for custom tag `<Bage>`. Did you mean `<Badge>`?",
    );
    expect(error).toMatchObject({ line: 4, column: 0 });
  });
});
