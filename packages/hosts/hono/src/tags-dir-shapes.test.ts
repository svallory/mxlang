import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileHonoMx } from "./index.ts";

/**
 * A `tags/` file Marko's lookup finds is imported from the path Marko found
 * it at, never from one derived from the tag's name; a shape with no template
 * to import is a positioned error, not an import of a file that does not exist.
 */
const root = mkdtempSync(join(tmpdir(), "mx-hono-tags-shapes-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function project(files: Record<string, string>): string {
  const dir = join(root, `p${++n}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"name":"t"}');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return join(dir, "page.mx");
}

const MARKO = "<b>${input.label}</b>\n";

describe("hono: `tags/` shapes", () => {
  it.each(["tags/x.marko", "tags/x/index.marko", "tags/x/x.marko"])(
    "%s is one positioned error, never an import",
    (shape) => {
      const file = project({ [shape]: MARKO });
      expect(() =>
        compileHonoMx('<div>\n  <x label="a"/>\n</div>', file),
      ).toThrow(
        expect.objectContaining({
          message: expect.stringContaining(
            `resolves to \`${shape}\`, a \`.marko\` file`,
          ),
          line: 2,
        }),
      );
    },
  );

  it("names the file relative to a nested page", () => {
    const file = project({ "tags/x/index.marko": MARKO });
    const nested = join(file, "..", "sub", "deep", "page.mx");
    mkdirSync(join(nested, ".."), { recursive: true });
    expect(() => compileHonoMx('<x label="a"/>', nested)).toThrow(
      "resolves to `../../tags/x/index.marko`",
    );
  });

  it("an authored import of a .marko file used as a tag is the same error", () => {
    const file = project({ "tags/x.marko": MARKO });
    expect(() =>
      compileHonoMx('import X from "./tags/x.marko"\n<X/>', file),
    ).toThrow("resolves to `tags/x.marko`, a `.marko` file");
  });

  it.each(["tags/x/index.mx", "tags/x/x.mx"])(
    "%s is a positioned error naming the file",
    (shape) => {
      const file = project({ [shape]: "<b/>\n" });
      expect(() => compileHonoMx("<div>\n  <x/>\n</div>", file)).toThrow(
        expect.objectContaining({
          message: expect.stringContaining(`matches \`${shape}\``),
          line: 2,
        }),
      );
    },
  );

  it("a .marko default import used as a direct dynamic tag is the same error, at the tag", () => {
    const file = project({ "tags/x.marko": MARKO });
    expect(() =>
      compileHonoMx(
        'import X from "./tags/x.marko"\n<div>\n  <${X}/>\n</div>',
        file,
      ),
    ).toThrow(
      expect.objectContaining({
        message: expect.stringContaining(
          "`<${X}>` resolves to `tags/x.marko`, a `.marko` file",
        ),
        line: 3,
      }),
    );
  });

  it("an unused .marko import, and an indirect dynamic use, stay clean", () => {
    const file = project({ "tags/x.marko": MARKO });
    expect(() =>
      compileHonoMx('import X from "./tags/x.marko"\n<div>hi</div>', file),
    ).not.toThrow();
    expect(() =>
      compileHonoMx(
        'import X from "./tags/x.marko"\nstatic const Y = X\n<div><${Y}/></div>',
        file,
      ),
    ).not.toThrow();
  });

  it("leaves a native element alone", () => {
    const { code } = compileHonoMx(
      "<div><span/></div>",
      project({ "tags/x.marko": MARKO }),
    );
    expect(code).toContain("<span");
    expect(code).not.toContain("tags/x.marko");
  });
});
