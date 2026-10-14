// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX source uses `${...}` placeholders.
/**
 * `import` and `export` inside a `static` block on Preact: the statements are
 * the module's, so they land in the module head, before `export interface
 * Input` and the component, exactly where the block-less `static` statement's
 * code goes. A `client` or `server` block is refused by the host before its
 * text matters.
 */
import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

function compile(source: string): string {
  return compilePreactMx(source, "/f/t.mx").code;
}

/** The module code between the JSX pragma and `export interface Input`. */
function head(source: string): string {
  const code = compile(source);
  const from = code.indexOf("\n", code.indexOf("@jsxImportSource")) + 1;
  return code.slice(from, code.indexOf("export interface Input")).trim();
}

describe("preact: an import or export in a static block is module code", () => {
  it.each([
    ["an import", 'static { import x from "./x" }', 'import x from "./x"'],
    ["an export const", "static { export const z = 1 }", "export const z = 1"],
    [
      "an import used by a later statement",
      'static { import x from "./x"; const y = x; }',
      'import x from "./x"; const y = x;',
    ],
    [
      "an export list",
      "static { const y = 1; export { y } }",
      "const y = 1; export { y }",
    ],
  ])("%s", (_name, statement, expected) => {
    expect(head(`${statement}\n<div/>`)).toBe(expected);
  });

  it("leaves the template reading the static binding", () => {
    expect(
      compile('static { import x from "./x"; const y = x; }\n<div>${y}</div>'),
    ).toContain("<div>{y}</div>");
  });

  it("is the module code the statement has without the block", () => {
    expect(head('static import x from "./x"\n<div/>')).toBe(
      head('static { import x from "./x" }\n<div/>'),
    );
  });
});

describe("preact: a client or server block with an import or export keeps the host's refusal", () => {
  it.each([
    ["client", 'client { import x from "./x" }', /`client` block/],
    ["client", "client { export const y = 1 }", /`client` block/],
    ["server", "server { export const z = 1 }", /`server` block/],
  ])("%s block: %s", (_name, statement, message) => {
    expect(() => compile(`${statement}\n<div/>`)).toThrow(message);
  });
});
