import { join } from "node:path";
import type { CustomTag } from "@mxlang/core";
import * as core from "@mxlang/core";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import descriptor from "./descriptor.ts";
import { compile } from "./index.ts";

// A bound attribute's refinement (`v:fn:=q`, Marko's `q = fn(next)` change
// handler) belongs to a target with an update path. html renders once, like
// Marko's server html, where the handler is client-only: the attribute renders
// as the unrefined `v:=q` does, byte for byte.
// The runtime module carries nothing of the refinement: the attribute renders
// as the unrefined one does, and the code is the unrefined code, byte for byte.
// The type-check reference to `fn` lives only in the tooling projection
// (`typeCheck: true`, below).
describe("a refined bound attribute renders like the unrefined one (html)", () => {
  it.each([
    ["<input value:fn:=q/>", "<input value:=q/>"],
    ["<div is:raw:=x/>", "<div is:=x/>"],
    ["<div data-x:fn:=q/>", "<div data-x:=q/>"],
    ["<div class:fn:=q/>", "<div class:=q/>"],
    [
      "<define/Card|input|><b/></define><Card v:fn:=q/>",
      "<define/Card|input|><b/></define><Card v:=q/>",
    ],
    ['<${"div"} v:fn:=q/>', '<${"div"} v:=q/>'],
    ["<div ...{} v:fn:=q/>", "<div ...{} v:=q/>"],
    // Marko accepts an optional-chain target, refined or not; the refinement
    // is client-only, so html renders the same `q?.a` attribute for both.
    ["<input value:fn:=q?.a/>", "<input value:=q?.a/>"],
  ])("%s", (refined, plain) => {
    const code = compile(refined, "x.mx").code;
    expect(code).not.toContain("(false && fn(");
    expect(code).toBe(compile(plain, "x.mx").code);
  });
});

// A refinement that is no identifier is Marko's error, at the modifier, on every
// tag shape: a dynamic tag, a contracted custom-tag call and its attribute tags.
const card: Record<string, CustomTag> = {
  card: {
    attributes: { v: { type: "string" } },
    attributeTags: { row: { attributes: { v: { type: "string" } } } },
    transform: () => [],
  },
};

describe("a refinement that is no identifier, wherever it appears (html)", () => {
  it.each([
    ["<div v:no-update:=q/>", 1, 7],
    ["<div x::=q/>", 1, 7],
    ["<${t} v:no-update:=q/>", 1, 8],
    ["<card v:no-update:=q/>", 1, 8],
    ["<card><@row v:no-update:=q/></card>", 1, 14],
    ["<div a=1\n  v:no-update:=q/>", 2, 4],
  ])("is Marko's error at the modifier: %j", (source, line, column) => {
    let error: { message: string; line: number; column: number } | undefined;
    try {
      compile(source, "x.mx", { customTags: card });
    } catch (e) {
      error = e as typeof error;
    }
    expect(error).toMatchObject({ line, column });
    expect(error?.message).toBe(
      "Bound attribute refinement shorthand must be a valid JavaScript identifier.",
    );
  });
});

// html emits no handler (Marko's is client-only), but the refinement is a real
// reference in Marko's client output, so the type-check projection must see it:
// `fn` applied to the bound value's type, mapped to the modifier's span.
function diagnosticsOf(source: string): Array<{ text: string; at: string }> {
  const result = compile(source, "x.mx", { typeCheck: true });
  const file = join(import.meta.dirname, "bound-modifier.virtual.ts");
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...rest) =>
    name === file
      ? ts.createSourceFile(name, result.code, ts.ScriptTarget.ES2022, true)
      : original(name, ...rest);
  const program = ts.createProgram([file], options, host);
  return ts
    .getPreEmitDiagnostics(program, program.getSourceFile(file))
    .filter((d) => d.file?.fileName === file)
    .map((d) => {
      const start = d.start ?? 0;
      const mapping = result.mappings.find(
        (m) => m.generatedStart <= start && start < m.generatedEnd,
      );
      return {
        text: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
        at: mapping
          ? source.slice(mapping.sourceStart, mapping.sourceEnd)
          : "?",
      };
    });
}

describe("html type-checks a refinement it never emits a handler for", () => {
  const prelude =
    'static function fn(next: string): string { return next; }\nstatic function bad(next: number): string { return String(next); }\nstatic const q = "a";\n';

  it("accepts a refinement that takes the bound value", () => {
    expect(diagnosticsOf(`${prelude}<input value:fn:=q/>`)).toEqual([]);
  });

  it("reports a misspelled refinement at the modifier", () => {
    const found = diagnosticsOf(`${prelude}<input value:fnn:=q/>`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ at: "fnn" });
    expect(found[0]?.text).toContain("Cannot find name 'fnn'");
  });

  it.each([
    [
      "a <define> component call",
      "<define/Card|input|><b/></define><Card v:fnn:=q/>",
    ],
    ["a dynamic tag", '<${"div"} v:fnn:=q/>'],
    ["a tag with a spread", "<div ...{} v:fnn:=q/>"],
  ])("reports a misspelled refinement on %s", (_shape, mx) => {
    // Only the refinement's own diagnostic: the fixture's other findings
    // (an untyped `|input|`, `...{}`) are not this test's subject.
    const found = diagnosticsOf(`${prelude}${mx}`).filter((d) =>
      d.text.includes("fnn"),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ at: "fnn" });
    expect(found[0]?.text).toContain("Cannot find name 'fnn'");
  });

  it("reports a refinement that does not take the bound value's type", () => {
    const found = diagnosticsOf(`${prelude}<input value:bad:=q/>`);
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toContain(
      "not assignable to parameter of type 'number'",
    );
  });
});

describe("the tooling projection is what the type-check sees", () => {
  it("the descriptor passes typeCheck through, so the TS plugin's compile references fn", () => {
    const load = descriptor.load;
    if (!load) throw new Error("expected a loadable descriptor");
    const source = "<input value:fn:=q/>";
    const projected = load(core).compileModule(source, "x.mx", {
      typeCheck: true,
    });
    const runtime = load(core).compileModule(source, "x.mx", {});
    expect(projected.code).toContain("(false && fn(q), q)");
    expect(runtime.code).not.toContain("(false && fn(");
  });
});
