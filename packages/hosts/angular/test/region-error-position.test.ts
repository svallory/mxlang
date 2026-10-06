import { describe, expect, it } from "vitest";
import { compileNgMx } from "../src/index.ts";

/**
 * A core error raised through the `.ng.mx` region path carries `line` and
 * `column` (as the whole-file entry's `TranslateError` does), not only the
 * parser `SyntaxError`'s `loc`: a caller reading `line`/`column` reported 0:0.
 */
function run(template: string): Record<string, unknown> | undefined {
  const source = [
    'import { Component } from "@angular/core";',
    "",
    "@Component({",
    '  selector: "app-x",',
    `  template: ${template},`,
    "})",
    "export class XComponent {}",
  ].join("\n");
  try {
    compileNgMx(source, "x.ng.mx");
  } catch (error) {
    return error as Record<string, unknown>;
  }
  return undefined;
}

/** The 1-based line and 0-based column of `needle` in the template `<div>\n  <needle…`. */
function at(template: string, needle: string): [number, number] {
  const offset = template.indexOf(needle);
  const before = template.slice(0, offset).split("\n");
  const line = 5 + before.length - 1;
  const last = before[before.length - 1] as string;
  return [
    line,
    before.length === 1 ? "  template: ".length + last.length : last.length,
  ];
}

describe(".ng.mx region: a core error carries line and column", () => {
  it.each([
    [
      "a refinement that is no identifier",
      "<div>\n  <i v:no-update:=q/>\n</div>",
      "no-update",
      "must be a valid JavaScript identifier",
    ],
    [
      "an empty refinement",
      "<div>\n  <i x::=q/>\n</div>",
      ":=q",
      "must be a valid JavaScript identifier",
    ],
    [
      "a refinement on the first line",
      "<i v:no-update:=q/>",
      "no-update",
      "must be a valid JavaScript identifier",
    ],
    [
      "a refinement in a fragment",
      "<>\n  <i v:no-update:=q/>\n</>",
      "no-update",
      "must be a valid JavaScript identifier",
    ],
    [
      "an `<if>` with no condition",
      "<div>\n  <if>x</if>\n</div>",
      "<if>",
      "`<if>` without a condition",
    ],
    [
      "a `<const>` with no value",
      "<div>\n  <const/x/>\n</div>",
      "<const/x/>",
      "`<const>` without a value",
    ],
    [
      "an `<else>` with no `<if>`",
      "<div>\n  <else/>\n</div>",
      "<else/>",
      "`<else>` without a preceding `<if>`",
    ],
  ])("%s", (_name, template, needle, message) => {
    const error = run(template);
    expect(String(error?.message)).toContain(message);
    const [line, column] = at(template, needle);
    expect(error).toMatchObject({ line, column });
    // Same position the parser's own `loc` reports.
    expect(error?.loc).toMatchObject({ line, column });
  });

  it("an empty default in a destructured tag param, at the param", () => {
    const error = run("<define/Foo|{a=}|/>");
    expect(error).toMatchObject({
      message: expect.stringContaining("Unexpected token"),
      line: 5,
      column: "  template: ".length + 15,
    });
  });
});
