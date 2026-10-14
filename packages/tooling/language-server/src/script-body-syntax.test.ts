// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * A `<script>` body that does not parse is an error in the editor, at the
 * author's own line and column. Before, the page compiled and the body was
 * never read.
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

describe("a <script> body in the editor", () => {
  it("compiles clean when it parses", () => {
    expect(
      diagnose(
        '<div/>\n<script>\nimport x from "./x";\nconst n: number = 1;\nexport const y = n;\n</script>\n',
      ),
    ).toEqual([]);
  });

  it.each([
    [
      "a decorator",
      "<div/>\n<script>\n@d class C {}\n</script>\n",
      "Decorators are not read inside a `<script>` body",
      [2, 0, 2, 2],
    ],
    [
      "a syntax error",
      "<div/>\n<script>\nconst = 1;\n</script>\n",
      "Unexpected token",
      [2, 6, 2, 7],
    ],
    [
      "a syntax error on the second line, in a nested tag",
      "<div>\n  <script>\n    const a = 1;\n    const b = ;\n  </script>\n</div>\n",
      "Unexpected token",
      [3, 14, 3, 15],
    ],
  ])("%s", (_name, source, message, [sl, sc, el, ec]) => {
    const diagnostics = diagnose(source);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain(message);
    expect(diagnostics[0]?.code).toBe("MX_INVALID_STATEMENT");
    expect(diagnostics[0]?.range).toEqual({
      start: { line: sl, character: sc },
      end: { line: el, character: ec },
    });
  });
});
