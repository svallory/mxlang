import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, describe, expect, it, vi } from "vitest";
import mx from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
// Inside the package, not `tmpdir()`: a compiled page imports `@mxlang/html`
// by bare specifier, which only resolves from within the package tree.
const root = mkdtempSync(join(here, "..", ".tmp-duplicate-attr-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// Warning text is asserted ANSI-stripped: CI may colorize.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape
const ANSI = /\u001b\[[0-9;]*m/g;

function write(project: string, rel: string, source: string): void {
  const path = join(root, project, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

describe("duplicate attribute in a vite build", () => {
  it("warns with both positions, and the build still succeeds", async () => {
    write(
      "dup",
      "package.json",
      JSON.stringify({ name: "p", mx: { host: "html" } }),
    );
    write("dup", "page.mx", '<div class="a"\n  class="b">hi</div>\n');
    write(
      "dup",
      "entry.ts",
      'import page from "./page.mx";\nexport default page;\n',
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const projectRoot = join(root, "dup");
      await build({
        root: projectRoot,
        configFile: false,
        logLevel: "silent",
        plugins: [mx()],
        build: {
          ssr: join(projectRoot, "entry.ts"),
          outDir: join(projectRoot, "dist"),
          emptyOutDir: true,
          minify: false,
        },
      });
      const lines = warn.mock.calls.map((call) =>
        String(call[0]).replace(ANSI, ""),
      );
      const dup = lines.filter((line) => line.includes("duplicate attribute"));
      expect(dup).toHaveLength(1);
      expect(dup[0]).toContain("page.mx:2:2:");
      expect(dup[0]).toContain("`class`: also written at 1:6");
      const out = readFileSync(join(projectRoot, "dist", "entry.mjs"), "utf8");
      expect(out).toContain('class=\\"a\\" class=\\"b\\"');
    } finally {
      warn.mockRestore();
    }
  });
});
