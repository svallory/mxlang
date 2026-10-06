import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { expect, it } from "vitest";
import { runInProcess } from "./in-process.ts";

/**
 * A custom tag in an `.astro.mx` page used to leave the page's type-check TSX
 * unparsable. tsc prints no semantic diagnostic once any syntactic one
 * exists, so the page's own type errors vanished with it. The error below must
 * be reported even though the page calls `<badge/>`.
 */
const fixture = join(import.meta.dirname, "fixtures/host-dispatch/astro-mx");

it("reports a semantic error in a page that calls a custom tag, and no syntax error", () => {
  const dir = mkdtempSync(join(tmpdir(), "mx-astro-custom-tag-tsx-"));
  try {
    cpSync(fixture, dir, { recursive: true });
    writeFileSync(
      join(dir, "page.astro.mx"),
      ["---", 'const n: number = "x";', "---", "<badge/>", "<p>hi</p>"].join(
        "\n",
      ),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          noEmit: true,
          strict: true,
          jsx: "preserve",
          skipLibCheck: true,
          types: [],
          module: "ESNext",
          moduleResolution: "Bundler",
        },
        files: ["page.astro.mx"],
      }),
    );
    const result = runInProcess(
      ["--noEmit", "-p", "tsconfig.json", "--astro"],
      dir,
    );
    const output = stripVTControlCharacters(result.stdout + result.stderr);
    expect(output).not.toContain("TS1005");
    expect(output).toContain(
      "Type 'string' is not assignable to type 'number'",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
