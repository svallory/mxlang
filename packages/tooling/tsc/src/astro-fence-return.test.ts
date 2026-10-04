import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { expect, it } from "vitest";
import { runInProcess } from "./in-process.ts";

/**
 * A `---` fence holding a top-level `return` is valid Astro — the host
 * compiles the fence into the component function's body. `lowerAstroMx`
 * accepts it, but the *type-check* projection runs it through Astro's
 * `convertToTSX`, which puts the frontmatter at the top level of a TSX module,
 * ahead of the generated component function. TypeScript then sees a
 * module-level `return` and reports TS1108 for a fence the build accepts.
 *
 * `n: number = "wrong"` rather than `Astro.redirect("/")`, so the only
 * diagnostic in play is the projection's own: `Astro` is not a declared global
 * in the generated TSX either, and mixing the two would not say which one the
 * run is asserting about.
 */
function project(
  name: string,
  fence: string[],
): { status: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "mx-astro-fence-return-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ mx: { host: "astro" } }),
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
        files: [name],
      }),
    );
    writeFileSync(
      join(dir, name),
      ["---", ...fence, "---", "<h1>hi</h1>"].join("\n"),
    );
    const result = runInProcess(
      ["--noEmit", "-p", "tsconfig.json", "--astro"],
      dir,
    );
    return {
      status: result.status,
      output: stripVTControlCharacters(result.stdout + result.stderr),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * KNOWN GAP (`mx-tsc --astro` only; the editor is fixed).
 *
 * The editor path is closed: `createAmxLanguagePlugin.filterSemanticDiagnostics`
 * runs in the tsserver language-service proxy, so a fence `return` no longer
 * reports TS1108 there.
 *
 * `mx-tsc` cannot reach it. Volar's `runTsc` rewrites TypeScript's own source
 * so that its `createProgram` becomes a *local* binding
 * (`runTsc.js:88` — `var createProgram = require(...).proxyCreateProgram(...)`),
 * and `proxyCreateProgram` then decorates that program in place
 * (`decorateProgram`, `proxyCreateProgram.js:183`). The program is therefore
 * never handed to anything `mx-tsc` owns: `ts.createProgram` is not the binding
 * tsc calls, the compiler host does not carry diagnostics, and Volar exposes no
 * hook. Pinning this with `it.fails` so the gap stays visible and the suite
 * tells whoever closes it.
 *
 * Closing it needs one of: a diagnostics seam in Volar, or `mx-tsc` filtering
 * its own reporter's output. Both are decisions above this package.
 */
it.fails("mx-tsc still reports TS1108 for a fence return (known gap)", () => {
  const { output } = project("page.astro.mx", ["return;"]);

  expect(output).not.toContain("TS1108");
});

it("still reports a type error after the fence's return, at its own position", () => {
  // The suppression is scoped to TS1108 *inside the fence* — it must not
  // silence a real type error the author wrote there.
  const { output } = project("page.astro.mx", [
    "return;",
    'const n: number = "wrong";',
  ]);

  expect(output).toContain("TS2322");
  // Fence line 3 of the file is `const n…`; report the author's own line.
  expect(output).toContain("page.astro.mx(3,");
});

it("prints one position, not two, for a fence syntax error", () => {
  // The fence error's message carries its own file position `(L:C)`, and this
  // reporter prefixes `file(line,col)` of its own. Both surfaces strip the
  // trailing suffix before printing (`tsc/src/index.ts:718`,
  // `vite-plugin/src/index.ts:1190`), so the author sees one position — pinned
  // here because a second one would read as a bug in the message text.
  const dir = mkdtempSync(join(tmpdir(), "mx-astro-fence-pos-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ mx: { host: "astro" } }),
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
        files: ["page.astro.mx"],
      }),
    );
    // The break is on the fence's third content line, so file line 4.
    writeFileSync(
      join(dir, "page.astro.mx"),
      [
        "---",
        "const a = 1;",
        "const b = 2;",
        "const c = ;",
        "---",
        "<p>hi</p>",
      ].join("\n"),
    );

    const result = runInProcess(
      ["--noEmit", "-p", "tsconfig.json", "--astro"],
      dir,
    );
    const output = stripVTControlCharacters(result.stdout + result.stderr);

    // The break is on the fence's third content line = file line 4, column 11
    // (1-based, `const c = ;`), and it is reported once, by the reporter.
    expect(output).toContain("page.astro.mx(4,11)");
    expect(output.match(/page\.astro\.mx\(\d+,\d+\)/g)).toHaveLength(1);
    // The message text carries no `(l:c)` of its own, so the author never sees
    // the position twice. Both reporters strip that suffix before printing.
    expect(output).not.toMatch(/\(\d+:\d+\)/);
    expect(output).toContain(
      "syntax error in the `---` fence: Unexpected token",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
