import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { runInProcess } from "./in-process.ts";

function check(files: Record<string, string>, astro = false) {
  const root = mkdtempSync(join(tmpdir(), "mx-html-export-signature-"));
  try {
    const repo = join(import.meta.dirname, "../../../..");
    mkdirSync(join(root, "node_modules/@mxlang"), { recursive: true });
    symlinkSync(
      join(repo, "packages/targets/html"),
      join(root, "node_modules/@mxlang/target-html"),
      "dir",
    );
    symlinkSync(
      join(repo, "packages/hosts/astro"),
      join(root, "node_modules/@mxlang/host-astro"),
      "dir",
    );
    symlinkSync(
      join(repo, "packages/hosts/astro/node_modules/astro"),
      join(root, "node_modules/astro"),
      "dir",
    );
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ mx: { host: astro ? "astro" : "html" } }),
    );
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
          jsx: "preserve",
          module: "ESNext",
          moduleResolution: "Bundler",
        },
        files: Object.keys(files),
      }),
    );
    for (const [name, source] of Object.entries(files))
      writeFileSync(join(root, name), source);
    const result = runInProcess(
      [
        "-p",
        "tsconfig.json",
        "--pretty",
        "false",
        ...(astro ? ["--astro"] : []),
      ],
      root,
    );
    return {
      status: result.status,
      output: stripVTControlCharacters(result.stdout + result.stderr)
        .replaceAll(`${relative(process.cwd(), root)}/`, "")
        .replaceAll(`${root}/`, ""),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const unit = [
  "export interface Input { title: string }",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
  "<h1>${input.title}</h1>",
  "<return value=input.title.length/>",
].join("\n");

describe("html default export diagnostic signatures in mx-tsc", () => {
  it("prints the input and result for a wrong prop, function argument and assignment", () => {
    expect(
      check({
        "comp.mx": unit,
        "index.ts": [
          'import Comp from "./comp.mx";',
          "Comp({ title: 1 });",
          "const takes = (fn: (input: { count: number }) => string) => fn;",
          "takes(Comp);",
          "const mismatch: number = Comp;",
        ].join("\n"),
      }),
    ).toMatchInlineSnapshot(`
      {
        "output": "index.ts(2,8): error TS2322: Type 'number' is not assignable to type 'string'.
      index.ts(4,7): error TS2345: Argument of type '((input: Input) => string) & { render: (input: Input, __mxOut: Out) => number; }' is not assignable to parameter of type '(input: { count: number; }) => string'.
        Types of parameters 'input' and 'input' are incompatible.
          Property 'title' is missing in type '{ count: number; }' but required in type 'Input'.
      index.ts(5,7): error TS2322: Type '((input: Input) => string) & { render: (input: Input, __mxOut: Out) => number; }' is not assignable to type 'number'.
      ",
        "status": 2,
      }
    `);
  });

  it.each([false, true])(
    "preserves calls, render Input and /var on tag calls (Astro: %s)",
    (astro) => {
      expect(
        check(
          {
            "comp.mx": unit,
            "index.ts": [
              'import Comp from "./comp.mx";',
              'const input: Parameters<typeof Comp>[0] = { title: "ok" };',
              "const text: string = Comp(input);",
              "const size: number = Comp.render(input, undefined as never);",
              "const accepts: (props: typeof input) => string = Comp;",
            ].join("\n"),
            "page.mx": [
              'import Comp from "./comp.mx";',
              '<Comp/size title="ok"/>',
              // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
              "<p>${size.toFixed()}</p>",
            ].join("\n"),
            ...(astro
              ? {
                  "page.astro.mx": [
                    "---",
                    'import Comp from "./comp.mx";',
                    'const text: string = Comp({ title: "ok" });',
                    'const size: number = Comp.render({ title: "ok" }, undefined as never);',
                    "---",
                    '<Comp title="ok"/>',
                  ].join("\n"),
                }
              : {}),
          },
          astro,
        ),
      ).toEqual({ status: 0, output: "" });
    },
  );
});
