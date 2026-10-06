import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCustomTags } from "@mxlang/core";
import { afterAll, describe, expect, it } from "vitest";
import { compileSolidMx, compileSolidUnit, solidTargets } from "./index.ts";

/**
 * A `tags/` file this host cannot call used to compile as the native element
 * `<x>`, silently. It is now a positioned error naming the file; nothing here
 * makes the tag callable.
 */
const root = mkdtempSync(join(tmpdir(), "mx-solid-tags-shapes-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function project(files: Record<string, string>, page: string): string {
  const dir = join(root, `p${++n}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"name":"t"}');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return join(dir, page);
}

const SHAPES = [
  ["tags/x.marko", "a `.marko` template"],
  ["tags/x/index.marko", "a `.marko` directory tag"],
  ["tags/x/index.mx", "an `index.mx` directory tag"],
  ["tags/x/x.marko", "a `<name>.marko` directory tag"],
  ["tags/x/x.mx", "a `<name>.mx` directory tag"],
] as const;

const scan = (file: string) => getCustomTags(file, { targets: solidTargets });

describe("solid: a `tags/` file the host cannot call", () => {
  for (const [shape, label] of SHAPES) {
    it(`region: ${label} is an error at the tag`, () => {
      const file = project({ [shape]: "<b/>\n" }, "page.solid.mx");
      expect(() =>
        compileSolidMx("<div>\n  <x/>\n</div>", {
          filename: file,
          customTags: scan(file),
        }),
      ).toThrow(
        expect.objectContaining({
          message: expect.stringContaining(
            shape.endsWith(".marko")
              ? `resolves to \`${shape}\``
              : `matches \`${shape}\``,
          ),
          line: 2,
        }),
      );
    });

    it(`unit: ${label} is an error at the tag`, () => {
      const file = project({ [shape]: "<b/>\n" }, "page.mx");
      expect(() =>
        compileSolidUnit("<div>\n  <x/>\n</div>", {
          filename: file,
          customTags: scan(file),
        }),
      ).toThrow(
        shape.endsWith(".marko")
          ? `resolves to \`${shape}\``
          : `matches \`${shape}\``,
      );
    });
  }

  it("finds the file from a nested page", () => {
    const file = project(
      { "tags/x.marko": "<b/>\n" },
      "sub/deep/page.solid.mx",
    );
    expect(() =>
      compileSolidMx("<x/>", { filename: file, customTags: scan(file) }),
    ).toThrow("resolves to `../../tags/x.marko`");
  });

  it("still calls a flat tags/x.mx", () => {
    const file = project({ "tags/x.mx": "<b/>\n" }, "page.solid.mx");
    const { code } = compileSolidMx("<div><x/></div>", {
      filename: file,
      customTags: scan(file),
    });
    expect(code).toContain("<$mx_X1");
  });

  it("leaves a native element, and a tag with no file, alone", () => {
    const file = project({ "tags/x.marko": "<b/>\n" }, "page.solid.mx");
    const { code } = compileSolidMx("<div><span/></div>", {
      filename: file,
      customTags: scan(file),
    });
    expect(code).toContain("<span");
  });

  it("a .marko default import used as a direct dynamic tag is the same error, at the tag", () => {
    const file = project({ "tags/x.marko": "<b/>\n" }, "page.mx");
    expect(() =>
      compileSolidUnit(
        'import X from "./tags/x.marko"\n<div>\n  <${X}/>\n</div>',
        {
          filename: file,
          customTags: scan(file),
        },
      ),
    ).toThrow(
      expect.objectContaining({
        message: expect.stringContaining("`<${X}>` resolves to `tags/x.marko`"),
        line: 3,
      }),
    );
  });

  it("an unused .marko import, and an indirect dynamic use, stay clean", () => {
    const file = project({ "tags/x.marko": "<b/>\n" }, "page.mx");
    const opts = { filename: file, customTags: scan(file) };
    expect(() =>
      compileSolidUnit('import X from "./tags/x.marko"\n<div>hi</div>', opts),
    ).not.toThrow();
    expect(() =>
      compileSolidUnit(
        'import X from "./tags/x.marko"\nstatic const Y = X\n<div><${Y}/></div>',
        opts,
      ),
    ).not.toThrow();
  });
});
