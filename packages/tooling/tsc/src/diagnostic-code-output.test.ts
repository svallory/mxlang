import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runInProcess } from "./in-process.ts";

/**
 * `mx-tsc` prints MX's own code for an `.mx` file, as it does for a dialect's
 * file: `page.mx(1,1): error MX_INVALID_FOR: …`. That holds for a whole-file
 * `.mx`, for a region inside a `.solid.mx`, `.preact.mx` or other JSX file,
 * and for an `.astro.mx` file. `TS80001` and `TS80002` stay for a diagnostic
 * that has no code (a Babel syntax error, an undeclared colon tag).
 */
const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true });
});

/** The lines `mx-tsc` prints for a one-file project, colour-free. */
function lines(
  file: string,
  source: string,
  host = "html",
  flags: string[] = [],
): string[] {
  const dir = mkdtempSync(join(tmpdir(), "mx-code-output-"));
  created.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ mx: { host } }));
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
  const run = runInProcess(["--noEmit", ...flags, "-p", "tsconfig.json"], dir);
  return stripVTControlCharacters(run.stdout + run.stderr)
    .split("\n")
    .filter((line) => line.includes(`${file}(`))
    .map((line) => line.slice(line.indexOf(`${file}(`)));
}

describe("mx-tsc prints MX's code for an .mx file", () => {
  it("a lowering error: its code, at its 1-based position", () => {
    const [line] = lines("page.mx", "<for|x|/>\n");
    expect(line).toMatch(/^page\.mx\(1,1\): error MX_INVALID_FOR: /);
    expect(line).not.toContain("TS80001");
  });

  it("a template parse error: the parser's code, at its 1-based position", () => {
    const [line] = lines("page.mx", "<div></span>\n");
    expect(line).toMatch(
      /^page\.mx\(1,6\): error MX_PARSE_MISMATCHED_CLOSING_TAG: /,
    );
  });

  it("a warning: its code too, as a warning", () => {
    const warnings = lines("page.mx", "<div a=1 a=2/>\n").filter((line) =>
      line.includes(": warning "),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /^page\.mx\(1,6\): warning MX_DUPLICATE_ATTRIBUTE: /,
    );
  });

  it("a region's lowering error in a .solid.mx file: its code, at the tag", () => {
    const [line] = lines("page.solid.mx", "const el = <for|x|/>;\n", "solid");
    expect(line).toMatch(/^page\.solid\.mx\(1,12\): error MX_INVALID_FOR: /);
    expect(line).not.toContain("TS80001");
  });

  it("a region's lowering error in a .preact.mx file: its code, at the tag", () => {
    const [line] = lines("page.preact.mx", "const el = <for|x|/>;\n", "preact");
    expect(line).toMatch(/^page\.preact\.mx\(1,12\): error MX_INVALID_FOR: /);
  });

  it("a lowering error in an .astro.mx file: its code, at the tag", () => {
    const [line] = lines("page.astro.mx", "---\n---\n<for|x|/>\n", "astro", [
      "--astro",
    ]);
    expect(line).toMatch(/^page\.astro\.mx\(3,1\): error MX_INVALID_FOR: /);
    expect(line).not.toContain("TS80001");
  });

  it("an undeclared colon tag has no code: TS80001 at the tag, on each host", () => {
    for (const [file, source, host, flags] of [
      ["page.solid.mx", "const el = <ns:tag/>;\n", "solid", []],
      ["page.preact.mx", "const el = <ns:tag/>;\n", "preact", []],
      ["page.astro.mx", "---\n---\n<ns:tag/>\n", "astro", ["--astro"]],
    ] as const) {
      const [line] = lines(file, source, host, [...flags]);
      expect(line, file).toMatch(
        new RegExp(
          `^${file.replaceAll(".", "\\.")}\\(\\d+,\\d+\\): error TS80001: Unable to find entry point for custom tag \`<ns:tag>\`\\. A colon belongs to the tag name`,
        ),
      );
    }
  });

  it("keeps TS80001 for an error that has no code", () => {
    const [line] = lines(
      "page.solid.mx",
      "const el = <button>oops;\n",
      "solid",
    );
    expect(line).toMatch(/^page\.solid\.mx\(1,\d+\): error TS80001: /);
  });
});
