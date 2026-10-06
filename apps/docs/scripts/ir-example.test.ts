import { readFileSync } from "node:fs";
import type { MxWarning } from "@mxlang/core";
import { createOut, escape as htmlEscape } from "@mxlang/html";
import { describe, expect, it } from "vitest";
import { fencedBlocks } from "./host-examples.ts";
import {
  compileForHtml,
  files,
  irToJson,
  lowerForHtml,
  readExample,
  specPage,
} from "./ir-example.ts";

const REGENERATE = "regenerate with `bun scripts/ir-example.ts --write`";

describe("the IR specification's worked example", () => {
  const source = readExample(files.mx);

  it("lowers, through the html target's own declarations, to the committed IR", () => {
    const warnings: MxWarning[] = [];
    const ir = irToJson(lowerForHtml(source, warnings));
    expect(warnings).toEqual([]);
    expect(ir, REGENERATE).toBe(readExample(files.ir));
  });

  it("emits the committed module through @mxlang/html", () => {
    const warnings: MxWarning[] = [];
    const code = compileForHtml(source, warnings);
    expect(warnings).toEqual([]);
    expect(code, REGENERATE).toBe(readExample(files.html));
  });

  it("renders what the page says it renders", () => {
    const code = readExample(files.html).replace(
      /^import \{ escape as __mxEscape, createOut as __mxCreateOut, type Out as __MxOut \} from "@mxlang\/html";$/m,
      "",
    );
    // The emitted module is TypeScript; strip its one interface, the
    // parameter annotations and the named `render` export, then evaluate it
    // and call its default export.
    const js = code
      .replace(/export interface Input \{[\s\S]*?\n\}\n/, "")
      .replace("(input: Input): string", "(input)")
      .replace("(input: Input, __mxOut: __MxOut): void", "(input, __mxOut)")
      .replace("export { __mxRender as render };", "")
      .replace(
        /export default Greeting(?: as [^;\n]*)?;\s*$/,
        "return Greeting;",
      );
    const render = new Function("__mxEscape", "__mxCreateOut", js)(
      htmlEscape,
      createOut,
    ) as (input: unknown) => string;
    expect(render({ name: "<Ada>", items: ["a", "b"] })).toBe(
      '<h1 class="title">Hello, &lt;Ada&gt;!</h1><ul><li>a</li><li>b</li></ul>',
    );
    expect(render({ name: "Ada", items: [] })).toBe(
      '<h1 class="title">Hello, Ada!</h1><p hidden>Nothing yet.</p>',
    );
  });

  it("is quoted verbatim by the specification page", () => {
    const blocks = fencedBlocks(readFileSync(specPage, "utf8")).map((b) =>
      b.trimEnd(),
    );
    for (const file of Object.values(files)) {
      expect(blocks, `ir-spec.md lacks ${file}`).toContain(
        readExample(file).trimEnd(),
      );
    }
  });
});
