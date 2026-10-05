/**
 * The side-by-side examples at the top of each host page.
 *
 * Every host page opens with the same small component twice: once as the
 * framework's own idiomatic component, once with MX in place of the JSX or
 * template. The pair lives in `example/hosts/<host>/` as real files; the page
 * quotes both verbatim, and `host-examples.test.ts` fails when
 *
 *   - the MX file stops compiling through that host's own entry point (so a
 *     docs example cannot outlive the emitter that was supposed to accept it),
 *   - the compile drops a warning, or
 *   - a page's fenced block no longer matches the file it was copied from.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileNgMx } from "@mxlang/angular";
import { lowerAstroMx } from "@mxlang/astro/template";
import type { MxWarning } from "@mxlang/core";
import { compileHonoMx } from "@mxlang/hono";
import { print } from "@mxlang/parser";
import { compilePreactMx } from "@mxlang/preact";
import { compileReactMx } from "@mxlang/react";
import { compileSolidMx } from "@mxlang/solid";

const here = dirname(fileURLToPath(import.meta.url));
const docsRoot = join(here, "..");
export const hostsExampleDir = join(docsRoot, "example", "hosts");

export interface HostExample {
  /** The host page, `docs/hosts/<page>.md`. */
  page: string;
  /** The framework's own component, in `example/hosts/<dir>/`. */
  native: string;
  /** The same component with MX in place of the JSX or template. */
  mx: string;
  /** Compiles the MX file through the host's own entry point. */
  compile: (source: string, filename: string, warnings: MxWarning[]) => string;
}

function wholeFile(
  compile:
    | typeof compileReactMx
    | typeof compilePreactMx
    | typeof compileHonoMx,
): HostExample["compile"] {
  return (source, filename, warnings) =>
    compile(source, filename, { warnings }).code;
}

export const hostExamples: Record<string, HostExample> = {
  react: {
    page: "react",
    native: "react/Greeter.tsx",
    mx: "react/Greeter.mx",
    compile: wholeFile(compileReactMx),
  },
  preact: {
    page: "preact",
    native: "preact/Greeter.tsx",
    mx: "preact/Greeter.mx",
    compile: wholeFile(compilePreactMx),
  },
  hono: {
    page: "hono",
    native: "hono/Greeter.tsx",
    mx: "hono/Greeter.mx",
    compile: wholeFile(compileHonoMx),
  },
  // `.solid.mx` is a TypeScript module with MX regions; the parser finds each
  // region and hands it to the host, exactly as the Vite plugin does.
  solidmx: {
    page: "solidmx",
    native: "solid/Greeter.tsx",
    mx: "solid/Greeter.solid.mx",
    compile: (source, filename, warnings) =>
      print(source, filename, {
        mxRegionCompile: (input) =>
          compileSolidMx(input.source, { ...input, warnings }),
      } as Parameters<typeof print>[2]).code,
  },
  astro: {
    page: "astro",
    native: "astro/Greeter.astro",
    mx: "astro/Greeter.astro.mx",
    compile: (source, filename, warnings) =>
      lowerAstroMx(source, filename, { warnings }).code,
  },
  angular: {
    page: "angular",
    native: "angular/greeter.component.ts",
    mx: "angular/greeter.component.ng.mx",
    compile: (source, filename, warnings) =>
      compileNgMx(source, filename, { warnings }).code,
  },
};

export function readHostExample(file: string): string {
  return readFileSync(join(hostsExampleDir, file), "utf8");
}

export function hostPage(page: string): string {
  return readFileSync(join(docsRoot, "docs", "hosts", `${page}.md`), "utf8");
}

/** The bodies of every fenced code block in a markdown file. */
export function fencedBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const re = /^```[^\n]*\n([\s\S]*?)^```$/gm;
  for (let m = re.exec(markdown); m; m = re.exec(markdown)) blocks.push(m[1]);
  return blocks;
}
