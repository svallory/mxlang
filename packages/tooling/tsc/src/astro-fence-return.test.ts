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
  return projectOf(name, ["---", ...fence, "---", "<h1>hi</h1>"].join("\n"));
}

/** The same one-file project, with the file's text given whole. */
function projectOf(
  name: string,
  text: string,
  host = "astro",
  extraArgs: string[] = [],
): { status: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "mx-astro-fence-return-"));
  try {
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
          jsx: "preserve",
          jsxImportSource: "astro",
          paths: { "astro/jsx-runtime": ["./astro-jsx-runtime.d.ts"] },
        },
        files: [name, "astro-env.d.ts"],
      }),
    );
    // Astro's TSX wraps a page in `<Fragment>` and types its elements through
    // astro's own packages; a temp dir has neither, so state the two things the
    // generated code needs and keep the diagnostics about the fence alone.
    writeFileSync(
      join(dir, "astro-env.d.ts"),
      "declare const Fragment: any;\ndeclare namespace JSX {\n  interface IntrinsicElements {\n    [tag: string]: unknown;\n  }\n}\n",
    );
    writeFileSync(join(dir, "astro-jsx-runtime.d.ts"), "export {};\n");
    writeFileSync(join(dir, name), text);
    const result = runInProcess(
      ["--noEmit", "-p", "tsconfig.json", "--astro", ...extraArgs],
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

it("does not report TS1108 for a top-level return in the fence", () => {
  // `--pretty`: tsc prints its `Found N errors` summary only in pretty mode, so
  // that is the only mode in which an absent summary proves anything.
  const { output, status } = projectOf(
    "page.astro.mx",
    "---\nreturn;\n---\n<h1>hi</h1>",
    "astro",
    ["--pretty"],
  );

  expect(output).not.toContain("TS1108");
  expect(output).not.toMatch(/Found \d+ errors?/);
  expect(status).toBe(0);
});

it("counts only the unfiltered errors: a fence return plus two type errors is 2", () => {
  const { output, status } = projectOf(
    "page.astro.mx",
    [
      "---",
      "return;",
      'const a: number = "x";',
      'const b: number = "y";',
      "---",
      "<h1>hi</h1>",
    ].join("\n"),
    "astro",
    ["--pretty"],
  );

  expect(output).not.toContain("TS1108");
  expect(output).toContain("Found 2 errors");
  expect(status).not.toBe(0);
});

it("still reports TS1108 outside the fence, at its own position", () => {
  // A `static` block in the template body is hoisted to module level too, so
  // its `return` is a real TS1108 the author must see — only the fence is
  // exempt. Template line 5 of the file, column 1 (whole-block mapping).
  const { output, status } = projectOf(
    "page.astro.mx",
    ["---", "const a = 1;", "---", "<h1>hi</h1>", "static return;", ""].join(
      "\n",
    ),
  );

  expect(output).toContain("page.astro.mx(5,1): error TS1108");
  expect(status).not.toBe(0);
});

it("still reports TS1108 for a fence return and a template one together", () => {
  // The fence's own return is dropped, the template's is not: one line, and
  // the count reflects only it.
  const { output } = projectOf(
    "page.astro.mx",
    ["---", "return;", "---", "<h1>hi</h1>", "static return;", ""].join("\n"),
  );

  expect(output.match(/TS1108/g)).toHaveLength(1);
  expect(output).toContain("page.astro.mx(5,1): error TS1108");
  expect(output).not.toContain("page.astro.mx(2,");
});

it("still reports TS1108 in a non-Astro .mx file", () => {
  const { output, status } = projectOf(
    "page.mx",
    "static return;\n<p>hi</p>",
    "html",
  );

  expect(output).toContain("page.mx(1,8): error TS1108");
  expect(status).not.toBe(0);
});

it("still reports TS1108 in a plain .ts file of the same program", () => {
  const dir = mkdtempSync(join(tmpdir(), "mx-astro-fence-ts-"));
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
        files: ["page.astro.mx", "plain.ts"],
      }),
    );
    writeFileSync(join(dir, "page.astro.mx"), "---\nreturn;\n---\n<h1>hi</h1>");
    writeFileSync(join(dir, "plain.ts"), "export {};\nreturn;\n");

    const result = runInProcess(
      ["--noEmit", "-p", "tsconfig.json", "--astro"],
      dir,
    );
    const output = stripVTControlCharacters(result.stdout + result.stderr);

    expect(output).toContain("plain.ts(2,1): error TS1108");
    expect(output.match(/TS1108/g)).toHaveLength(1);
    expect(result.status).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
