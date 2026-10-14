// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runInProcess } from "./in-process.ts";

/**
 * `mx-tsc` reports a `<script>` body that does not parse, with MX's code at the
 * body's own 1-based line and column, and stays quiet for one that parses.
 * Before, the body was never read and the page compiled.
 */
const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true });
});

/** The lines `mx-tsc` prints for a one-file html project, colour-free. */
function lines(file: string, source: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "mx-script-body-"));
  created.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ mx: { host: "html" } }),
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        skipLibCheck: true,
        types: [],
        module: "ESNext",
        moduleResolution: "Bundler",
      },
      files: [file],
    }),
  );
  writeFileSync(join(dir, file), source);
  const run = runInProcess(["--noEmit", "-p", "tsconfig.json"], dir);
  return stripVTControlCharacters(run.stdout + run.stderr)
    .split("\n")
    .filter((line) => line.includes(`${file}(`))
    .map((line) => line.slice(line.indexOf(`${file}(`)));
}

describe("mx-tsc and a <script> body", () => {
  it("prints a decorator at its own line and column, with MX's code", () => {
    const found = lines(
      "page.mx",
      "<div/>\n<script>\n@d class C {}\n</script>\n",
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(
      /^page\.mx\(3,1\): error MX_INVALID_STATEMENT: Decorators are not read inside a `<script>` body: /,
    );
  });

  it("prints a syntax error in a nested, indented script", () => {
    const found = lines(
      "page.mx",
      "<div>\n  <script>\n    const a = 1;\n    const b = ;\n  </script>\n</div>\n",
    );
    expect(found).toEqual([
      "page.mx(4,15): error MX_INVALID_STATEMENT: Unexpected token",
    ]);
  });

  it("prints nothing for a body that parses", () => {
    expect(
      lines(
        "page.mx",
        '<div/>\n<script>\nimport x from "./x";\nconst n: number = 1;\n</script>\n',
      ).filter((line) => line.includes("MX_")),
    ).toEqual([]);
  });
});
