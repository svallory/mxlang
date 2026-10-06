import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compile } from "./index.ts";

/**
 * A `tags/` file this host cannot call used to compile as the native element
 * `<x>`, silently. It is now a positioned error naming the file.
 */
const root = mkdtempSync(join(tmpdir(), "mx-angular-tags-shapes-"));
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
] as const;

describe("angular: a `tags/` file the host cannot call", () => {
  for (const [shape, label] of SHAPES) {
    it(`${label} is an error at the tag`, () => {
      const file = project({ [shape]: "<b/>\n" }, "page.ng.mx");
      expect(() => compile("<div>\n  <x/>\n</div>", file)).toThrow(
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
  }

  it("leaves a native element alone", () => {
    const file = project({ "tags/x.marko": "<b/>\n" }, "page.ng.mx");
    expect(compile("<div><span/></div>", file).code).toContain("<span");
  });
});
