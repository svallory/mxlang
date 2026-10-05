/**
 * Shared by the `.hono.mx` region tests: print a module the way every tool
 * does (parser + this host's region entry), and load a printed module from a
 * scratch directory with its sibling `.mx` tags compiled beside it.
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createTargetLookup, getCustomTags } from "@mxlang/core";
import { print } from "@mxlang/parser";
import type { Child } from "hono/jsx";
import descriptor from "./descriptor.ts";
import { compileHonoMx, compileHonoRegion } from "./index.ts";

export const FIXTURES = join(import.meta.dirname, "fixtures", "region");
export const targets = createTargetLookup([descriptor]);

/** Every `.mx` file under `dir` (relative paths), the region input excluded. */
function tagFiles(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = join(prefix, entry.name);
      if (entry.isDirectory())
        return entry.name === "__golden__" ? [] : tagFiles(dir, path);
      return entry.name.endsWith(".mx") && !entry.name.endsWith(".hono.mx")
        ? [path]
        : [];
    },
  );
}

/** Prints a `.hono.mx` module the way every tool does: parser + this host's region entry. */
export function printHonoMx(source: string, filename: string): string {
  return print(source, filename, {
    mx: true,
    customTags: getCustomTags(filename, { targets }),
    mxRegionCompile: (input) =>
      compileHonoRegion(input.source, { ...input, targets }) as ReturnType<
        NonNullable<Parameters<typeof print>[2]>["mxRegionCompile"] & {}
      >,
  }).code;
}

/**
 * Writes a printed module (and its fixture's sibling tags) to a scratch
 * directory, imports it and hands its default export to `use`.
 */
export async function withPrinted<T>(
  printed: string,
  fixtureDir: string,
  use: (component: (props: Record<string, unknown>) => Child) => T | Promise<T>,
): Promise<T> {
  const scratch = mkdtempSync(join(tmpdir(), "mx-hono-region-"));
  try {
    writeFileSync(
      join(scratch, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    writeFileSync(
      join(scratch, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "hono/jsx" },
      }),
    );
    const toTsx = (code: string) =>
      code.replace(/(["']\.{1,2}\/[^"']*)\.(mx|marko)(["'])/g, "$1.tsx$3");
    for (const tag of tagFiles(fixtureDir)) {
      const out = join(scratch, tag.replace(/\.mx$/, ".tsx"));
      mkdirSync(dirname(out), { recursive: true });
      const source = readFileSync(join(fixtureDir, tag), "utf8");
      writeFileSync(
        out,
        toTsx(compileHonoMx(source, join(fixtureDir, tag), { targets }).code),
      );
    }
    const entry = join(scratch, "page.tsx");
    writeFileSync(entry, `/** @jsxImportSource hono/jsx */\n${toTsx(printed)}`);
    const mod = (await import(`${entry}?t=${Date.now()}`)) as {
      default: (props: Record<string, unknown>) => Child;
    };
    return await use(mod.default);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Renders a printed module's default export to HTML, the way Hono's own JSX
 * renderer does: `JSXNode.toString()`.
 */
export function renderPrinted(
  printed: string,
  fixtureDir: string,
  props: Record<string, unknown> = {},
): Promise<string> {
  return withPrinted(printed, fixtureDir, (component) =>
    String(component(props)),
  );
}
