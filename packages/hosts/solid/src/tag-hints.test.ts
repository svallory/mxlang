import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CustomTag, getCustomTags } from "@mxlang/core";
import { parse as parseMxFile } from "@mxlang/tsx-bridge";
import { afterAll, describe, expect, it } from "vitest";
import { compileSolidMx, solidTargets } from "./index.ts";

/**
 * Marko 6.3.51 says only "Unable to find entry point for custom tag `<X>`."
 * (`custom-tag.ts` `tagNotFoundError`); MX adds where the tag could come from
 * (audit item 14, cases s08/h04). Compiled as a whole `.solid.mx` file, the
 * way every integration does, and every suggested fix is compiled too. The
 * parser appends ` (line:column)` to a region's message. A lowercase tag is
 * never unresolved here (Solid's JSX takes any lowercase name as an element),
 * so there is no element did-you-mean on this host.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour
const ANSI = /\x1b\[[0-9;]*m/g;

const root = mkdtempSync(join(tmpdir(), "mx-solid-tag-hints-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const file = (body: string, head = "") =>
  `${head}export function App() {\n  return (\n    ${body}\n  );\n}\n`;

function parseFile(
  source: string,
  filename = "fixture.solid.mx",
  customTags?: Record<string, CustomTag>,
): void {
  const regionCompile = (
    input: Parameters<typeof compileSolidMx>[1] & { source: string },
  ) => compileSolidMx(input.source, { ...input, customTags });
  parseMxFile(source, filename, {
    // biome-ignore lint/suspicious/noExplicitAny: MxRegionCompile shape, avoiding a parser<->solid type cycle in a test
    mxRegionCompile: regionCompile as any,
  });
}

function failure(
  source: string,
  filename?: string,
): {
  message: string;
  line?: number;
  column?: number;
  /** A parser error's own position (1-based line, 0-based column). */
  loc?: { line: number; column: number };
} {
  try {
    parseFile(source, filename);
  } catch (error) {
    const e = error as {
      message: string;
      line?: number;
      column?: number;
      loc?: { line: number; column: number };
    };
    return {
      message: e.message.replace(ANSI, ""),
      line: e.line,
      column: e.column,
      loc: e.loc,
    };
  }
  throw new Error("expected a compile error, but the template compiled");
}

describe("unresolved tag hints (solid)", () => {
  it("tells an unresolved capitalized tag how to resolve it", () => {
    const error = failure(file('<Card title="x"/>'));
    expect(error.message).toBe(
      'Unable to find entry point for custom tag `<Card>`. Import it (`import Card from "./Card.mx"`) or add `tags/Card.mx`.',
    );
    // The position rides on the error itself, not in the text: a printed
    // position is 1-based (ruling #227) and the parser's `loc.column` is
    // 0-based, which is what every consumer converts on.
    expect(error.loc).toMatchObject({ line: 3, column: 4 });
  });

  it("the import it suggests compiles", () => {
    expect(() =>
      parseFile(file('<Card title="x"/>', 'import Card from "./Card.mx";\n')),
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
    const page = join(dir, "page.solid.mx");
    const source = file('<Card title="x"/>');
    const customTags = getCustomTags(page, {
      host: "solid",
      targets: solidTargets,
    });
    expect(() => parseFile(source, page, customTags)).not.toThrow();
    expect(failure(source, page).message).toContain("or add `tags/Card.mx`.");
  });

  it("suggests the nearest imported component for a near-miss", () => {
    const error = failure(
      file('<div><Bage label="a"/></div>', 'import Badge from "./Badge.mx";\n'),
    );
    expect(error.message).toBe(
      "Unable to find entry point for custom tag `<Bage>`. Did you mean `<Badge>`?",
    );
    expect(error.loc).toMatchObject({ line: 4, column: 4 });
  });
});
