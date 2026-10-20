import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

const source = [
  "export interface Input { title: string }",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
  "<h1>${input.title}</h1>",
  "<return value=input.title.length/>",
].join("\n");

function javascript(code: string): string {
  return ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
}

describe("the branded html default export's explicit type", () => {
  it.each([false, true])(
    "preserves JavaScript bytes and the brand (typeCheck: %s)",
    (typeCheck) => {
      const { code } = compile(source, "/project/comp.mx", { typeCheck });
      const typedExport =
        "export default Comp as ((input: Input) => string) & { render: typeof __mxRender };";
      expect(code).toContain(typedExport);
      expect(code).toContain(
        'Object.defineProperty(Comp, Symbol.for("mx.component"), { value: true });',
      );
      expect(javascript(code)).toBe(
        javascript(code.replace(typedExport, "export default Comp;")),
      );
    },
  );
});
