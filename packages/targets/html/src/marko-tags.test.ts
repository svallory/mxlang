import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "./index.ts";

/**
 * The import a page gets for a `tags/*.marko` tag, pinned to what Marko 6.3.51
 * emits: `import _badge from "./tags/badge.marko"` (default import, extension
 * kept, `_` + camelCased name, path relative to the page, one per module).
 * The run-time behaviour is covered by `marko-tags.bun.test.ts`.
 */
const root = mkdtempSync(join(tmpdir(), "mxlang-html-marko-tags-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function write(rel: string, source: string): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  return path;
}

function emit(page: string): string {
  const { code } = compile(`<div>${page}</div>`, join(root, "emit", "page.mx"));
  return code;
}

write("emit/tags/badge.marko", "<i>${input.label}</i>");
write("emit/tags/fancy-btn.marko", "<b>${input.label}</b>");

describe("tags/*.marko imports", () => {
  test("default import, extension kept, relative to the page", () => {
    const code = emit('<badge label="a"/>');
    expect(code).toContain('import _badge from "./tags/badge.marko"');
    expect(code).toContain("_badge.render({");
  });

  test("a hyphenated tag gets a camelCased identifier", () => {
    const code = emit('<fancy-btn label="a"/>');
    expect(code).toContain('import _fancyBtn from "./tags/fancy-btn.marko"');
    expect(code).toContain("_fancyBtn.render({");
  });

  test("a tag called twice is imported once", () => {
    const code = emit('<badge label="a"/><badge label="b"/>');
    expect(code.match(/tags\/badge\.marko/g)).toHaveLength(1);
    expect(code.match(/_badge\.render\(/g)).toHaveLength(2);
  });

  test("an identifier already in the source is not reused", () => {
    const code = emit('<badge label="a"/>${"_badge"}');
    expect(code).toContain('import _badge2 from "./tags/badge.marko"');
  });

  test("the path is relative to the page from a nested directory", () => {
    const { code } = compile(
      '<badge label="a"/>',
      join(root, "emit", "a", "b", "page.mx"),
    );
    expect(code).toContain('from "../../tags/badge.marko"');
  });

  test("no import for a file-local binding or an element", () => {
    const { code } = compile(
      "<div><span/></div>",
      join(root, "emit", "page.mx"),
    );
    expect(code).not.toContain("tags/");
  });
});
