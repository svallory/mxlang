// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
/**
 * `/var` on a bare-identifier dynamic tag is a call of that binding, so it
 * needs a `<return>` to bind, as it does on `<Child/x/>`: Marko 6.4 refuses
 * `<${Child}/x/>` when the unit declares none. Preact binds a dynamic tag's
 * `/var` at run time, so only the callee MX can name statically is judged.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

const dir = mkdtempSync(join(tmpdir(), "mx-preact-dynamic-var-return-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, "plain.mx"), "<b>x</b>\n");
writeFileSync(join(dir, "returns.mx"), "<b>x</b>\n<return value=1/>\n");

interface Failure {
  message: string;
  code: string | undefined;
  line: number;
  column: number;
  end: { line: number; column: number } | undefined;
}

function failure(source: string): Failure | undefined {
  try {
    compilePreactMx(source, join(dir, "page.mx"));
  } catch (caught) {
    const error = caught as Failure & { diagnosticCode?: string };
    return {
      message: error.message,
      code: error.diagnosticCode,
      line: error.line,
      column: error.column,
      end: error.end,
    };
  }
  return undefined;
}

describe("/var on a bare-identifier dynamic tag on Preact", () => {
  it("refuses a default import of a unit that declares no <return>, at the variable", () => {
    expect(
      failure('import Plain from "./plain.mx"\n<${Plain}/x/>\n<p>${x}</p>\n'),
    ).toEqual({
      message:
        "`<Plain>` does not return a value; add `<return value=…/>` to the imported file to bind it with `/var`",
      code: "MX_INVALID_TAG_VAR",
      line: 2,
      column: 10,
      end: { line: 2, column: 11 },
    });
  });

  it("refuses a <define> callee, at the variable", () => {
    expect(
      failure("<define/Foo><b>x</b></define>\n<${Foo}/x/>\n"),
    ).toMatchObject({ line: 2, column: 8, end: { line: 2, column: 9 } });
  });

  it("still compiles a returning unit, an input tag and a ternary (controls)", () => {
    expect(
      failure('import R from "./returns.mx"\n<${R}/x/>\n<p>${x}</p>\n'),
    ).toBeUndefined();
    expect(failure("<${input.tag}/x/>\n")).toBeUndefined();
    expect(failure("<${null}/x/>\n")).toBeUndefined();
    expect(
      failure(
        'import Plain from "./plain.mx"\n<${input.a ? Plain : "b"}/x/>\n',
      ),
    ).toBeUndefined();
  });
});
