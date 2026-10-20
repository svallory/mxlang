import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMutablePluginService } from "./fixtures/plugin-service.ts";

const unit = [
  "export interface Input { title: string }",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
  "<h1>${input.title}</h1>",
  "<return value=input.title.length/>",
].join("\n");
let directory: string;
let consumer: string;
let component: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "mx-editor-export-signature-"));
  consumer = join(directory, "signature-consumer.ts");
  component = join(directory, "signature-unit.mx");
  symlinkSync(
    join(import.meta.dirname, "../../../hosts/astro/node_modules"),
    join(directory, "node_modules"),
    "dir",
  );
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ mx: { host: "html" } }),
  );
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function check(
  source: string,
  extra: Record<string, string> = {},
  config: object = {},
) {
  const files = { [component]: unit, [consumer]: source, ...extra };
  // Callee metadata resolution also probes the filesystem before reading a
  // buffer. Use real temporary files, not unresolved in-memory siblings.
  for (const [file, text] of Object.entries(files)) writeFileSync(file, text);
  const { service, project } = createMutablePluginService(
    files,
    [consumer, ...Object.keys(extra)],
    { config },
  );
  try {
    return [consumer, ...Object.keys(extra)].flatMap((file) =>
      [
        ...service.getSyntacticDiagnostics(file),
        ...service.getSemanticDiagnostics(file),
      ].map((diagnostic) => ({
        code: diagnostic.code,
        text: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      })),
    );
  } finally {
    service.dispose();
    project.close();
  }
}

describe("html default export diagnostic signatures in the editor", () => {
  it("prints the input and result for a wrong prop, function argument and assignment", () => {
    expect(
      check(
        [
          'import Comp from "./signature-unit.mx";',
          "Comp({ title: 1 });",
          "const takes = (fn: (input: { count: number }) => string) => fn;",
          "takes(Comp);",
          "const mismatch: number = Comp;",
        ].join("\n"),
      ),
    ).toMatchInlineSnapshot(`
      [
        {
          "code": 2322,
          "text": "Type 'number' is not assignable to type 'string'.",
        },
        {
          "code": 2345,
          "text": "Argument of type '((input: Input) => string) & { render: (input: Input, __mxOut: Out) => number; }' is not assignable to parameter of type '(input: { count: number; }) => string'.
        Types of parameters 'input' and 'input' are incompatible.
          Property 'title' is missing in type '{ count: number; }' but required in type 'Input'.",
        },
        {
          "code": 2322,
          "text": "Type '((input: Input) => string) & { render: (input: Input, __mxOut: Out) => number; }' is not assignable to type 'number'.",
        },
      ]
    `);
  });

  it("keeps direct calls, render returns, extracted Input and MX tag calls typed", () => {
    const page = join(directory, "signature-page.mx");
    expect(
      check(
        [
          'import Comp from "./signature-unit.mx";',
          'import "./signature-page.mx";',
          'const input: Parameters<typeof Comp>[0] = { title: "ok" };',
          "const html: string = Comp(input);",
          "const length: number = Comp.render(input, undefined as never);",
          "const accepts: (props: typeof input) => string = Comp;",
        ].join("\n"),
        {
          [page]: [
            'import Comp from "./signature-unit.mx";',
            '<Comp/length title="ok"/>',
            // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
            "<p>${length.toFixed()}</p>",
          ].join("\n"),
        },
      ),
    ).toEqual([]);
  });

  it("accepts an html unit from an AstroMX fence and template", () => {
    const page = join(directory, "signature.astro.mx");
    expect(
      check(
        'import "./signature.astro.mx";',
        {
          [page]: [
            "---",
            'import Comp from "./signature-unit.mx";',
            'const text: string = Comp({ title: "ok" });',
            'const size: number = Comp.render({ title: "ok" }, undefined as never);',
            "---",
            '<Comp title="ok"/>',
          ].join("\n"),
        },
        { astro: true },
      ),
    ).toEqual([]);
  });

  it("rejects wrong props on an html unit imported by AstroMX", () => {
    const page = join(directory, "signature-bad.astro.mx");
    const diagnostics = check(
      'import "./signature-bad.astro.mx";',
      {
        [page]: [
          "---",
          'import Comp from "./signature-unit.mx";',
          "Comp({ title: 1 });",
          "Comp.render({ title: 1 }, undefined as never);",
          "---",
          "<Comp title=1/>",
        ].join("\n"),
      },
      { astro: true },
    );
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      2322, 2322, 2322,
    ]);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.text).toContain(
        "Type 'number' is not assignable to type 'string'.",
      );
    }
  });

  it("still rejects wrong render props and tag props instead of erasing Input", () => {
    const page = join(directory, "signature-bad-page.mx");
    expect(
      check(
        [
          'import Comp from "./signature-unit.mx";',
          'import "./signature-bad-page.mx";',
          "Comp.render({ title: 1 }, undefined as never);",
          "const badInput: Parameters<typeof Comp>[0] = { title: 1 };",
        ].join("\n"),
        {
          [page]: 'import Comp from "./signature-unit.mx";\n<Comp title=1/>',
        },
      ).map((diagnostic) => diagnostic.text),
    ).toEqual([
      "Type 'number' is not assignable to type 'string'.",
      "Type 'number' is not assignable to type 'string'.",
      "Type 'number' is not assignable to type 'string'.",
    ]);
  });
});
