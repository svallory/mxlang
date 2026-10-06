import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "./index.ts";

/**
 * A `.marko` file is not an MX input (decision 172): a tag Marko's lookup
 * resolves to one is a single positioned error naming the file and saying to
 * convert it to `.mx`, whatever the shape, and never an emitted import.
 */
const root = mkdtempSync(join(tmpdir(), "mxlang-html-marko-tags-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function write(rel: string, source: string): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  return path;
}

function emit(dir: string, page: string): string {
  return compile(page, join(root, dir, "page.mx")).code;
}

const MARKO = "<i>${input.label}</i>";
const one = (message: string) => expect.objectContaining({ message });

describe("a .marko tag is one error", () => {
  test("tags/x.marko", () => {
    write("flat/tags/badge.marko", MARKO);
    expect(() => emit("flat", '<div>\n  <badge label="a"/>\n</div>')).toThrow(
      expect.objectContaining({
        message:
          "`<badge>` resolves to `tags/badge.marko`, a `.marko` file, and MX does not compile `.marko` files. Convert it to `.mx` (`tags/badge.mx`).",
        line: 2,
      }),
    );
  });

  test("tags/x/index.marko", () => {
    write("dir/tags/im/index.marko", MARKO);
    expect(() => emit("dir", "<im/>")).toThrow(
      one(
        "`<im>` resolves to `tags/im/index.marko`, a `.marko` file, and MX does not compile `.marko` files. Convert it to `.mx` (`tags/im/index.mx`).",
      ),
    );
  });

  test("a hyphenated tag, and a tag from a parent directory", () => {
    write("par/tags/fancy-btn.marko", MARKO);
    expect(() =>
      compile("<fancy-btn/>", join(root, "par", "sub", "page.mx")),
    ).toThrow("`<fancy-btn>` resolves to `../tags/fancy-btn.marko`");
  });

  test("an authored import of a .marko file used as a tag", () => {
    write("imp/panel.marko", MARKO);
    expect(() =>
      emit("imp", 'import Panel from "./panel.marko"\n<Panel/>'),
    ).toThrow("`<Panel>` resolves to `panel.marko`, a `.marko` file");
  });

  test("never emits an import of a .marko file", () => {
    write("ok/tags/other.mx", "<b/>");
    const code = emit("ok", "<div>hi</div>");
    expect(code).not.toContain(".marko");
  });
});

describe("tags/<name>/index.mx", () => {
  test("is a positioned error, not a call to an unbound name", () => {
    write("idx/tags/ix/index.mx", "<i/>");
    expect(() => emit("idx", "<div>\n  <ix/>\n</div>")).toThrow(
      expect.objectContaining({
        message: expect.stringContaining("matches `tags/ix/index.mx`"),
        line: 2,
      }),
    );
  });
});
