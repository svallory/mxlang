import { describe, expect, it } from "vitest";
import { parse as babelParse } from "../babel/index.ts";
import { programBindings, sourceBindings } from "./source-bindings.ts";

describe("sourceBindings", () => {
  it("collects a default import's local name", () => {
    expect(sourceBindings('import Widget from "./widget.ts";')).toEqual(
      new Set(["Widget"]),
    );
  });

  it("collects a named import's local name, aliased or not", () => {
    expect(
      sourceBindings('import { Show, For as MyFor } from "solid-js";'),
    ).toEqual(new Set(["Show", "MyFor"]));
  });

  it("excludes a whole `import type` declaration", () => {
    expect(sourceBindings('import type Widget from "./widget.ts";')).toEqual(
      new Set(),
    );
  });

  it("excludes an inline `type` specifier but keeps its siblings", () => {
    expect(
      sourceBindings('import { type Show, For } from "solid-js";'),
    ).toEqual(new Set(["For"]));
  });

  it("collects a top-level const/function/class declaration", () => {
    expect(
      sourceBindings(
        "const Widget = () => null; function Other() {} class Third {}",
      ),
    ).toEqual(new Set(["Widget", "Other", "Third"]));
  });

  it("collects destructured const bindings", () => {
    expect(sourceBindings("const { Widget, other: Renamed } = mod;")).toEqual(
      new Set(["Widget", "Renamed"]),
    );
  });

  it("collects an exported declaration", () => {
    expect(
      sourceBindings(
        "export const Widget = () => null; export function Other() {}",
      ),
    ).toEqual(new Set(["Widget", "Other"]));
  });

  it("does not collect a type-only declaration", () => {
    expect(
      sourceBindings(
        "type Widget = { x: number }; interface Other { y: number }",
      ),
    ).toEqual(new Set());
  });

  it("sees a binding declared after the point of use (whole-program scan)", () => {
    const bound = sourceBindings("const el = <Widget/>; function Widget() {}");
    expect(bound.has("Widget")).toBe(true);
  });

  it("returns an empty set for source it cannot parse", () => {
    expect(sourceBindings("const x = ;;; garbage {{{")).toEqual(new Set());
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
    expect(programBindings(program)).toEqual(sourceBindings(source));
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
