import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { expect, it } from "vitest";
import { runInProcess } from "./in-process.ts";

/**
 * TODO `astro-isolated-install-ts-resolution`: a compiled html `.mx` module
 * imports the bare `@mxlang/html`. In an isolated install (bun workspaces,
 * pnpm) a project holds `@mxlang/astro` and nothing else, so TypeScript could
 * not resolve that import; the TS2307 sits on generated text no source
 * position maps to, so it was dropped, and `Out`, `createOut` and `escape`
 * silently became `any`. Passing `42` as the sink of `render(input, out)` is
 * only an error when `Out` resolved.
 */
const ASTRO_DIR = fileURLToPath(
  new URL("../../../hosts/astro", import.meta.url),
);

const COUNTER = `export interface Input { start: number }
<span>\${input.start}</span>
`;

/** A project whose `node_modules` holds `@mxlang/astro` only, as `bun add -d @mxlang/astro` leaves it. */
function isolatedProject(): string {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "mx-astro-isolated-ts-")),
  );
  mkdirSync(join(dir, "node_modules", "@mxlang"), { recursive: true });
  symlinkSync(ASTRO_DIR, join(dir, "node_modules", "@mxlang", "astro"));
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
      files: ["page.astro.mx"],
    }),
  );
  writeFileSync(join(dir, "counter.mx"), COUNTER);
  return dir;
}

function check(page: string): string {
  const dir = isolatedProject();
  try {
    writeFileSync(join(dir, "page.astro.mx"), page);
    const result = runInProcess(
      ["--noEmit", "-p", "tsconfig.json", "--astro"],
      dir,
    );
    return stripVTControlCharacters(result.stdout + result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it("types the sink of Unit.render under an isolated install: a non-Out sink is reported", () => {
  const output = check(
    [
      "---",
      'import Counter from "./counter.mx";',
      "Counter.render({ start: 1 }, 42);",
      "---",
      "<h1>hi</h1>",
    ].join("\n"),
  );

  expect(output).toMatch(/Argument of type '(?:number|42)' is not assignable/);
});

it("types AttrTag, which the emitter imports as a type only: a wrong attribute tag is reported", () => {
  const dir = isolatedProject();
  try {
    writeFileSync(
      join(dir, "card.mx"),
      "export interface Input { head: AttrTag }\n<section/>\n",
    );
    writeFileSync(
      join(dir, "page.astro.mx"),
      [
        "---",
        'import Card from "./card.mx";',
        "Card({ head: 42 });",
        "---",
        "<h1>hi</h1>",
      ].join("\n"),
    );
    const result = runInProcess(
      ["--noEmit", "-p", "tsconfig.json", "--astro"],
      dir,
    );
    const output = stripVTControlCharacters(result.stdout + result.stderr);
    expect(output).toMatch(/not assignable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("passes a real sink under an isolated install (a false-positive guard, green with or without the fix)", () => {
  const output = check(
    [
      "---",
      'import Counter from "./counter.mx";',
      'import { createOut } from "@mxlang/astro/runtime";',
      "Counter.render({ start: 1 }, createOut());",
      "---",
      "<h1>hi</h1>",
    ].join("\n"),
  );

  expect(output).not.toMatch(/error TS/);
});
