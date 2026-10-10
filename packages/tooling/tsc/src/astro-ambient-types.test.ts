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
import { afterEach, describe, expect, it } from "vitest";
import { runInProcess } from "./in-process.ts";

/**
 * `mx-tsc --astro` adds the ambient types Astro's own tooling injects into
 * every program it checks (`@astrojs/language-server`'s `addAstroTypes`:
 * `astro/env.d.ts`, which declares `Fragment`, and `astro/astro-jsx.d.ts`),
 * through the astro host's `ambientTypes`. Before, only a project listing
 * `types: ["astro/env"]` got them: under Astro's own tsconfig preset an
 * authored `<Fragment>` was TS2304, and so was the `Fragment` the projection
 * of an `.astro.mx` page writes.
 */
const ASTRO_HOST = fileURLToPath(
  new URL("../../../hosts/astro", import.meta.url),
);
const ASTRO = realpathSync(join(ASTRO_HOST, "node_modules", "astro"));

const PAGE = [
  "---",
  "const title = 'hi';",
  "---",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
  "<h1>${title}</h1>",
  "<p>body</p>",
  "",
].join("\n");
const PLAIN = [
  "---",
  "const a = 1;",
  "---",
  "<Fragment><p>{a}</p></Fragment>",
  "",
].join("\n");

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** An isolated install: `@mxlang/host-astro`, and `astro` when asked for. */
function project(withAstro: boolean, tsconfig: object): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-astro-ambient-")));
  made.push(dir);
  mkdirSync(join(dir, "node_modules", "@mxlang"), { recursive: true });
  symlinkSync(ASTRO_HOST, join(dir, "node_modules", "@mxlang", "astro"));
  if (withAstro) symlinkSync(ASTRO, join(dir, "node_modules", "astro"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ mx: { host: "astro" } }),
  );
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
  writeFileSync(join(dir, "page.astro.mx"), PAGE);
  writeFileSync(join(dir, "plain.astro"), PLAIN);
  return dir;
}

function check(dir: string) {
  const run = runInProcess(
    ["--noEmit", "--pretty", "false", "-p", "tsconfig.json", "--astro"],
    dir,
  );
  return {
    status: run.status,
    output: stripVTControlCharacters(`${run.stdout}\n${run.stderr}`),
  };
}

describe("mx-tsc --astro adds Astro's ambient types", () => {
  it("under Astro's own tsconfig preset, with no types entry and no env reference", () => {
    const dir = project(true, {
      extends: "astro/tsconfigs/strict",
      files: ["page.astro.mx", "plain.astro"],
    });
    const { status, output } = check(dir);

    expect(output).not.toMatch(/error TS/);
    expect(status).toBe(0);
  }, 60_000);

  it("from the language server's fallback types when astro is not installed", () => {
    const dir = project(false, {
      compilerOptions: {
        noEmit: true,
        strict: true,
        jsx: "preserve",
        skipLibCheck: true,
        types: [],
        module: "ESNext",
        moduleResolution: "Bundler",
      },
      files: ["page.astro.mx", "plain.astro"],
    });
    const { status, output } = check(dir);

    expect(output).not.toMatch(/error TS/);
    expect(status).toBe(0);
  }, 60_000);

  it("in a program holding plain .astro pages and no .astro.mx", () => {
    const dir = project(true, {
      extends: "astro/tsconfigs/strict",
      files: ["plain.astro"],
    });
    const { status, output } = check(dir);

    expect(output).not.toMatch(/error TS/);
    expect(status).toBe(0);
  }, 60_000);

  it("still reports a real error in a plain .astro page", () => {
    const dir = project(true, {
      extends: "astro/tsconfigs/strict",
      files: ["page.astro.mx", "plain.astro"],
    });
    writeFileSync(
      join(dir, "plain.astro"),
      "---\nconst a: number = 'x';\n---\n<Fragment>{a}</Fragment>\n",
    );
    const { status, output } = check(dir);

    expect(output).toMatch(/plain\.astro\(2,7\): error TS2322/);
    expect(output).not.toMatch(/Fragment/);
    expect(status).not.toBe(0);
  }, 60_000);
});
