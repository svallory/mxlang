import { parse as babelParse } from "@mxlang/babel";
import { describe, expect, it } from "vitest";
import {
  programBindings,
  sourceBindings,
  unknownSourceBindings,
} from "./source-bindings.ts";

describe("sourceBindings", () => {
  it("rejects a top-level return by default (a plain ES module)", () => {
    // Every default caller here hands over real module scope, where a
    // top-level `return` genuinely is a syntax error.
    const { error } = sourceBindings('return Astro.redirect("/");');
    expect(error?.message).toContain("'return' outside of function");
  });

  it("accepts a top-level return when the caller opts in", () => {
    // The Astro fence is the one authored source the host compiles inside a
    // function body, so its top-level `return` is legal there.
    const { bindings, error } = sourceBindings(
      'const a = 1;\nreturn Astro.redirect("/");',
      {
        allowReturnOutsideFunction: true,
      },
    );
    expect(error).toBeUndefined();
    expect(bindings).toEqual(new Set(["a"]));
  });

  it("collects a default import's local name", () => {
    expect(
      sourceBindings('import Widget from "./widget.ts";').bindings,
    ).toEqual(new Set(["Widget"]));
  });

  it("collects a named import's local name, aliased or not", () => {
    expect(
      sourceBindings('import { Show, For as MyFor } from "solid-js";').bindings,
    ).toEqual(new Set(["Show", "MyFor"]));
  });

  it("excludes a whole `import type` declaration", () => {
    expect(
      sourceBindings('import type Widget from "./widget.ts";').bindings,
    ).toEqual(new Set());
  });

  it("excludes an inline `type` specifier but keeps its siblings", () => {
    expect(
      sourceBindings('import { type Show, For } from "solid-js";').bindings,
    ).toEqual(new Set(["For"]));
  });

  it("collects a top-level const/function/class declaration", () => {
    expect(
      sourceBindings(
        "const Widget = () => null; function Other() {} class Third {}",
      ).bindings,
    ).toEqual(new Set(["Widget", "Other", "Third"]));
  });

  it("collects destructured const bindings", () => {
    expect(
      sourceBindings("const { Widget, other: Renamed } = mod;").bindings,
    ).toEqual(new Set(["Widget", "Renamed"]));
  });

  it("collects an exported declaration", () => {
    expect(
      sourceBindings(
        "export const Widget = () => null; export function Other() {}",
      ).bindings,
    ).toEqual(new Set(["Widget", "Other"]));
  });

  it("does not collect a type-only declaration", () => {
    expect(
      sourceBindings(
        "type Widget = { x: number }; interface Other { y: number }",
      ).bindings,
    ).toEqual(new Set());
  });

  it("sees a binding declared after the point of use (whole-program scan)", () => {
    const { bindings } = sourceBindings(
      "const el = <Widget/>; function Widget() {}",
    );
    expect(bindings.has("Widget")).toBe(true);
  });

  it("returns an empty set, and no error, for source that parses cleanly with nothing bound", () => {
    const result = sourceBindings("1 + 1;");
    expect(result.bindings).toEqual(new Set());
    expect(result.error).toBeUndefined();
  });

  it("returns an empty set and a positioned error for source it cannot parse", () => {
    const result = sourceBindings("const x = ;;; garbage {{{");
    expect(result.bindings).toEqual(new Set());
    expect(result.error).toBeDefined();
    expect(result.error?.line).toBeGreaterThanOrEqual(1);
    expect(result.error?.message.length).toBeGreaterThan(0);
  });

  it("positions the error's line and column at the actual syntax error", () => {
    // Two clean lines, then a broken third line -- the error must point at
    // line 3, not line 1 (a caller reporting `error.line` as-is against its
    // own source needs this to actually land on the bad line).
    const result = sourceBindings(
      ["const a = 1;", "const b = 2;", "const c = ;"].join("\n"),
    );
    expect(result.error?.line).toBe(3);
  });
});

describe("programBindings", () => {
  it("matches sourceBindings when given the same parsed program", () => {
    const source =
      'import { Show } from "solid-js"; const Widget = () => null;';
    const program = babelParse(source, {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
    }).program;
    expect(programBindings(program)).toEqual(sourceBindings(source).bindings);
    expect(programBindings(program)).toEqual(new Set(["Show", "Widget"]));
  });

  it("excludes a type-only import from an already-parsed program, same as sourceBindings", () => {
    const source = 'import type Widget from "./widget.ts";';
    const program = babelParse(source, {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
    }).program;
    expect(programBindings(program)).toEqual(new Set());
  });
});
