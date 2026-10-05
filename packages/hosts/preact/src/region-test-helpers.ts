/**
 * Shared by the `.preact.mx` region tests: print a module the way every tool
 * does (parser + this host's region entry), and load a printed module from a
 * scratch directory with its sibling `.mx` tags compiled beside it.
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createTargetLookup, getCustomTags } from "@mxlang/core";
import { print } from "@mxlang/tsx-bridge";
import { type FunctionComponent, h } from "preact";
import { render } from "preact-render-to-string";
import descriptor from "./descriptor.ts";
import { compilePreactMx, compilePreactRegion } from "./index.ts";

export const FIXTURES = join(import.meta.dirname, "fixtures", "region");
const WORKSPACE_MODULES = join(import.meta.dirname, "../../../../node_modules");
export const targets = createTargetLookup([descriptor]);

/** Every `.mx` file under `dir` (relative paths), the region input excluded. */
function tagFiles(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = join(prefix, entry.name);
      if (entry.isDirectory())
        return entry.name === "__golden__" ? [] : tagFiles(dir, path);
      return entry.name.endsWith(".mx") && !entry.name.endsWith(".preact.mx")
        ? [path]
        : [];
    },
  );
}

/** Prints a `.preact.mx` module the way every tool does: parser + this host's region entry. */
export function printPreactMx(source: string, filename: string): string {
  return print(source, filename, {
    mx: true,
    customTags: getCustomTags(filename, { targets }),
    mxRegionCompile: (input) =>
      compilePreactRegion(input.source, { ...input, targets }) as ReturnType<
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
  use: (
    component: FunctionComponent<Record<string, unknown>>,
  ) => T | Promise<T>,
): Promise<T> {
  const scratch = mkdtempSync(join(tmpdir(), "mx-preact-region-"));
  try {
    // The workspace root's `node_modules` holds preact and
    // preact-render-to-string, so the scratch module renders with the same
    // preact instance as this test.
    symlinkSync(WORKSPACE_MODULES, join(scratch, "node_modules"), "dir");
    writeFileSync(
      join(scratch, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    writeFileSync(
      join(scratch, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "preact" },
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
        toTsx(compilePreactMx(source, join(fixtureDir, tag), { targets }).code),
      );
    }
    const entry = join(scratch, "page.tsx");
    writeFileSync(entry, `/** @jsxImportSource preact */\n${toTsx(printed)}`);
    const mod = (await import(`${entry}?t=${Date.now()}`)) as {
      default: FunctionComponent<Record<string, unknown>>;
    };
    return await use(mod.default);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Renders a printed module's default export to static HTML. */
export function renderPrinted(
  printed: string,
  fixtureDir: string,
  props: Record<string, unknown> = {},
): Promise<string> {
  return withPrinted(printed, fixtureDir, (component) =>
    render(h(component, props)),
  );
}
