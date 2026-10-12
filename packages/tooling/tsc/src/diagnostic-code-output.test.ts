import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runInProcess } from "./in-process.ts";

/**
 * `mx-tsc` prints MX's own code for an `.mx` file, as it does for a dialect's
 * file: `page.mx(1,1): error MX_INVALID_FOR: …`. `TS80001` and `TS80002` stay
 * for a diagnostic that has no code.
 */
const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true });
});

/** The lines `mx-tsc` prints for a one-file project, colour-free. */
function lines(file: string, source: string, host = "html"): string[] {
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
  const run = runInProcess(["--noEmit", "-p", "tsconfig.json"], dir);
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

  it("keeps TS80001 for an error that has no code", () => {
    const [line] = lines(
      "page.solid.mx",
      "const el = <button>oops;\n",
      "solid",
    );
    expect(line).toMatch(/^page\.solid\.mx\(1,\d+\): error TS80001: /);
  });
});
