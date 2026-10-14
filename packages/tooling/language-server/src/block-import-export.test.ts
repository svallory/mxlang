/**
 * A diagnostic inside a `static`, `server` or `client` block that holds an
 * `import` or an `export` keeps its source position in the editor: the
 * block's braces are read as the module's, and the range is the author's own
 * line and column.
 */
import { pathToFileURL } from "node:url";
import { defaultTarget, hostOf } from "@mxlang/targets";
import { describe, expect, it } from "vitest";
import { diagnoseDocument } from "./diagnose.ts";

const target = defaultTarget();
const policy = { target, host: hostOf(target) };
const PAGE = pathToFileURL("/project/page.mx").href;

function diagnose(source: string) {
  return diagnoseDocument(source, PAGE, policy, undefined, "", {});
}

describe("a diagnostic inside a block with an import, in the editor", () => {
  it("a block with an import and an export compiles clean", () => {
    expect(
      diagnose(
        'static {\n  import x from "./x";\n  export const y = x;\n}\n<div/>\n',
      ),
    ).toEqual([]);
  });

  it.each([
    [
      "a syntax error after an import",
      'static {\n  import x from "./x";\n  let a = ;\n}\n<div/>\n',
      "Unexpected token",
      [2, 10, 2, 11],
    ],
    [
      "a decorator after an export",
      "server {\n  export const y = 1;\n  @d class C {}\n}\n<div/>\n",
      "Decorators are not read inside a `server` statement",
      [2, 2, 2, 4],
    ],
    [
      "an import in a nested block",
      'static {\n  { import x from "./x" }\n}\n<div/>\n',
      "'import' and 'export' may only appear at the top level.",
      [1, 4, 1, 5],
    ],
  ])("%s", (_name, source, message, [sl, sc, el, ec]) => {
    const diagnostics = diagnose(source);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain(message);
    expect(diagnostics[0]?.range).toEqual({
      start: { line: sl, character: sc },
      end: { line: el, character: ec },
    });
  });
});
