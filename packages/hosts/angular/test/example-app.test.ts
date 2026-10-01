import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { build } from "../src/build.ts";

const exampleDir = fileURLToPath(
  new URL("../../../../examples/angular-app", import.meta.url),
);

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "mx-angular-example-test-"));
  cpSync(join(exampleDir, "src"), join(projectDir, "src"), {
    recursive: true,
    filter: (path) => !path.endsWith("app.component.html"),
  });
  cpSync(join(exampleDir, "package.json"), join(projectDir, "package.json"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("examples/angular-app", () => {
  // `ng build` of the example fails with TS2339 `__mxOn` when a page binds an
  // event handler but its hand-written class lacks the invoker members. The
  // build warns on every such page (it cannot see the class), so each warned
  // page's own class must carry the members or extend `MxHandlers`.
  it("gives every page that binds an event handler its invoker members", () => {
    const result = build(projectDir);
    expect(result.errors).toEqual([]);
    const pages = result.warnings
      .filter((w) => w.message.includes("binds an event handler"))
      .map((w) => w.file);
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      const classFile = page.replace(/\.mx$/, ".ts");
      const source = readFileSync(classFile, "utf8");
      const hasMembers =
        /readonly __mxOn\b/.test(source) && /readonly __mxOnAt\b/.test(source);
      const extendsRuntime = /\bMxHandlers(Mixin)?\b/.test(source);
      expect(
        hasMembers || extendsRuntime,
        `${classFile} lacks the invoker`,
      ).toBe(true);
    }
  });
});
