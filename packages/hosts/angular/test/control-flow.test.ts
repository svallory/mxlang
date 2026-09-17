import { describe, expect, it } from "vitest";
import { assertAngularParses, emit } from "./helpers.ts";

describe("IfChain", () => {
  it("emits @if/@else if/@else", () => {
    const out = emit("<if=a>A</if><else-if=b>B</else-if><else>C</else>");
    expect(out).toBe("@if (a) { A } @else if (b) { B } @else { C }");
    assertAngularParses(out);
  });

  it("emits a plain @if with no else", () => {
    const out = emit("<if=a>A</if>");
    expect(out).toBe("@if (a) { A }");
    assertAngularParses(out);
  });
});

describe("Const", () => {
  it("emits @let with a trailing semicolon", () => {
    const out = emit("<const/total=a+b/>${total}");
    expect(out).toBe("@let total = a+b;{{ total }}");
    assertAngularParses(out);
  });
});

describe("Comment", () => {
  it("emits an HTML comment", () => {
    const out = emit("<!-- note -->");
    expect(out).toBe("<!-- note -->");
    assertAngularParses(out);
  });

  it("drops a line comment", () => {
    const out = emit("// note");
    expect(out).toBe("");
  });

  it("rejects a comment containing --", () => {
    expect(() => emit("<!-- a -- b -->")).toThrow(
      /cannot contain `--` or end with `-`/,
    );
  });

  it("rejects a comment ending in - immediately before the closer", () => {
    expect(() => emit("<!--a---->")).toThrow(
      /cannot contain `--` or end with `-`/,
    );
  });
});

describe("DocumentType", () => {
  it("emits a doctype with a warning", () => {
    const out = emit("<!doctype html>");
    expect(out).toBe("<!doctype html>");
    assertAngularParses(out);
  });
});
