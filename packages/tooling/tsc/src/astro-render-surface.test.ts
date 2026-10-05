import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { expect, it } from "vitest";
import { runInProcess } from "./in-process.ts";

/**
 * Decision 155: an html unit's default export is `(input) => string` and its
 * `<return>` value comes from `render(input, out)`. Under `--astro` the type
 * surface casts the default export; if that cast hides `.render`, a call to
 * it is TS2339 on *unmapped generated text*, which mx-tsc drops silently, so a
 * mistyped use reports nothing at all. These runs assert the errors are
 * reported, so they fail when `.render` is dropped from the surface.
 */
const COUNTER = `export interface Input { start: number }
<span>\${input.start}</span>
<return value=input.start + 1/>
`;

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mx-astro-render-surface-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ mx: { host: "astro" } }),
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
      files: Object.keys(files).filter((f) => !f.endsWith("counter.mx")),
    }),
  );
  writeFileSync(join(dir, "counter.mx"), COUNTER);
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

function check(files: Record<string, string>): string {
  const dir = project(files);
  try {
    const result = runInProcess(
      ["--noEmit", "-p", "tsconfig.json", "--astro"],
      dir,
    );
    return stripVTControlCharacters(result.stdout + result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it("types Unit.render(...) in an .astro.mx fence: a mistyped use is reported", () => {
  const output = check({
    "page.astro.mx": [
      "---",
      'import Counter from "./counter.mx";',
      "const s: string = Counter.render({ start: 1 }, undefined as never);",
      "---",
      "<h1>hi</h1>",
    ].join("\n"),
  });

  expect(output).toContain("Type 'number' is not assignable to type 'string'");
});

it("types the default export as (input) => string: a mistyped use is reported", () => {
  const output = check({
    "page.astro.mx": [
      "---",
      'import Counter from "./counter.mx";',
      "const n: number = Counter({ start: 1 });",
      "---",
      "<h1>hi</h1>",
    ].join("\n"),
  });

  expect(output).toContain("Type 'string' is not assignable to type 'number'");
});

it("binds /var on an imported tag and on a dynamic tag from render's return type", () => {
  const output = check({
    "page.mx": [
      'import Counter from "./counter.mx";',
      "static const Dynamic = Counter;",
      "static const takes = (s: string) => s;",
      "<Counter/next start=1/>",
      "<${Dynamic}/dynamicNext start=2/>",
      "<p>${takes(next)}</p>",
      "<p>${takes(dynamicNext)}</p>",
    ].join("\n"),
  });

  const errors = output
    .split("\n")
    .filter((line) => line.includes("error TS2345"));
  expect(errors).toHaveLength(2);
  for (const line of errors) {
    expect(line).toContain("'number' is not assignable to parameter");
  }
});
