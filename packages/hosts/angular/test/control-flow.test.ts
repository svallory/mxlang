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

describe("HostTag html-comment", () => {
  it("emits a plain-text html-comment", () => {
    const out = emit("<html-comment>plain text</html-comment>");
    expect(out).toBe("<!-- plain text -->");
    assertAngularParses(out);
  });

  it("rejects an interpolation inside an html-comment (R-1)", () => {
    // R-1: `@mxlang/html`'s own emitter accepts an Interpolation child
    // here and evaluates it server-side into the comment text
    // (packages/hosts/html/src/emitter.ts:604-606) — Angular has no such
    // evaluation inside a comment (probed: `<!-- {{ x }} -->` parses to no
    // node at all, the whole thing stays one opaque comment, so `{{ x }}`
    // would render literally, never `x`'s value). A hard error here, not
    // the html host's silent-render behavior.
    expect(() => emit("<html-comment>build ${sha}</html-comment>")).toThrow(
      "`<html-comment>` cannot contain `${…}` on Angular: comments are not interpolated; move the value out of the comment.",
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
