import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCustomTags } from "@mxlang/core";
import { afterAll, describe, expect, it } from "vitest";
import { compile, htmlTargets } from "./index.ts";

/**
 * Marko 6.3.51 says only "Unable to find entry point for custom tag `<X>`."
 * (`custom-tag.ts` `tagNotFoundError`); MX adds where the tag could come from
 * (audit item 14, cases h14/h04). Every suggested fix is compiled here.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour
const ANSI = /\x1b\[[0-9;]*m/g;

const root = mkdtempSync(join(tmpdir(), "mx-html-tag-hints-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function failure(
  source: string,
  filename = "/fixtures/test.mx",
): {
  message: string;
  line: number;
  column: number;
} {
  try {
    compile(source, filename);
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

describe("unresolved tag hints (html)", () => {
  it("tells an unresolved capitalized tag how to resolve it", () => {
    const error = failure('<Card title="x"/>');
    expect(error.message).toBe(
      'Unable to find entry point for custom tag `<Card>`. Import it (`import Card from "./Card.mx"`) or add `tags/Card.mx`.',
    );
    expect(error).toMatchObject({ line: 1, column: 0 });
  });

  it("the import it suggests compiles", () => {
    expect(() =>
      compile(
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
    writeFileSync(page, source);
    const customTags = getCustomTags(page, {
      host: "html",
      targets: htmlTargets,
    });
    expect(() => compile(source, page, { customTags })).not.toThrow();
    // …and without the file the same page fails with the hint above.
    const empty = join(root, "empty");
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, "package.json"), "{}");
    expect(failure(source, join(empty, "page.mx")).message).toContain(
      "or add `tags/Card.mx`.",
    );
  });

  it("suggests the nearest imported component for a near-miss", () => {
    const error = failure('import Badge from "./Badge.mx"\n<Bage label="a"/>');
    expect(error.message).toBe(
      "Unable to find entry point for custom tag `<Bage>`. Did you mean `<Badge>`?",
    );
    expect(error).toMatchObject({ line: 2, column: 0 });
  });

  it("suggests a `<define>` that is one edit away", () => {
    expect(failure("<define/Panel>x</define>\n<Pannel/>").message).toBe(
      "Unable to find entry point for custom tag `<Pannel>`. Did you mean `<Panel>`?",
    );
  });

  it("suggests the HTML element a lowercase tag mistypes", () => {
    const error = failure("<dvi>x</dvi>");
    expect(error.message).toBe(
      "Unable to find entry point for custom tag `<dvi>`. Did you mean `<div>`?",
    );
    expect(error).toMatchObject({ line: 1, column: 0 });
    expect(() => compile("<div>x</div>", "/fixtures/test.mx")).not.toThrow();
  });

  it("stays Marko's wording for a lowercase name near no element", () => {
    expect(failure("<my-widget/>").message).toBe(
      "Unable to find entry point for custom tag `<my-widget>`.",
    );
  });
});
