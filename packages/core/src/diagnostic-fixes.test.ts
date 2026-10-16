/**
 * `IrDiagnostic.fixes` (`@unstable`): the `<effect>` error offers one fix,
 * "Rename to `<script>`", whose edits are UTF-16 offsets into the file the
 * diagnostic is positioned in. Exact shapes per form, the edits applied to the
 * source and the result compiled, and the carriers inside core.
 */
import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import type { TranslateError } from "./core.ts";
import type { HostDeclarations } from "./declarations.ts";
import {
  type IrDiagnostic,
  type IrDiagnosticFix,
  lowerSource,
} from "./ir-entry/index.ts";
import { lookup } from "./test-targets.ts";

const CODE = "MX_RESERVED_EFFECT_TAG";
const TITLE = "Rename to `<script>`";

/** Applies one fix to `source`: every edit is against the original text. */
export function applyFix(source: string, fix: IrDiagnosticFix): string {
  const edits = [...fix.edits].sort((a, b) => b.offset - a.offset);
  for (let i = 1; i < edits.length; i++) {
    // No overlap: the edit after (in the text) ends where the next starts or earlier.
    expect(edits[i]?.end).toBeLessThanOrEqual(edits[i - 1]?.offset ?? 0);
  }
  let out = source;
  for (const edit of edits) {
    out = out.slice(0, edit.offset) + edit.newText + out.slice(edit.end);
  }
  return out;
}

/**
 * The form, its source, the edit ranges as the text they replace, and the
 * codes of the errors the fixed source still has (what `<script>` says about
 * that form: the rename resolves this error, not every other one).
 */
const FORMS: Array<[string, string, string[], string[]]> = [
  ["bodied", "<effect>go()</effect>", ["effect", "effect"], []],
  [
    "bodied with an element",
    "<effect><div>x</div></effect>",
    ["effect", "effect"],
    // A `<script>` body is code and must parse: `<div>x</div>` does not.
    ["MX_INVALID_STATEMENT"],
  ],
  [
    "bodied with a method",
    "<effect() { go() }>x</effect>",
    ["effect", "effect"],
    // `<script() { go() }>x</script>`: the method is the value, and the body
    // is a second one.
    ["MX_DUPLICATE_VALUE_ATTRIBUTE"],
  ],
  [
    "bodied with a variable",
    "<effect/x>y</effect>",
    ["effect", "effect"],
    // `<script/x>`: `script` takes no tag variable.
    ["MX_INERT_TAG_SHAPE"],
  ],
  ["a `</>` close", "<effect>go()</>", ["effect"], []],
  ["self-closing", "<effect/>", ["effect"], []],
  ["self-closing method", "<effect() { go() }/>", ["effect"], []],
  ["self-closing value", "<effect=go()/>", ["effect"], []],
  [
    "an attribute",
    '<effect foo="bar"/>',
    ["effect"],
    // `<script foo="bar"/>`: `script` takes no attribute but its own value.
    ["MX_INERT_TAG_SHAPE"],
  ],
  ["concise with a body", "effect\n  -- go()", ["effect"], []],
  [
    "concise with a child tag",
    "effect\n  div",
    ["effect"],
    // `script` takes a text body, not a child line.
    ["MX_PARSE_INVALID_LINE_START"],
  ],
  ["concise value", "effect=go()", ["effect"], []],
  [
    "concise block",
    "effect {\n  go()\n}",
    ["effect"],
    // `script { … }`: the block is an attribute `script` does not take, and
    // not a valid attribute name either.
    ["MX_INERT_TAG_SHAPE", "MX_INVALID_ATTRIBUTE"],
  ],
];

function fixesOf(source: string, filename = "/tmp/page.mx"): IrDiagnostic {
  const { diagnostics } = lowerSource(`${source}\n`, filename);
  const found = diagnostics.filter((d) => d.code === CODE);
  expect(found).toHaveLength(1);
  return found[0] as IrDiagnostic;
}

describe("the `<effect>` error offers the rename to `<script>`", () => {
  it.each(FORMS)(
    "lowerSource, %s: one fix, edits at the names",
    (_n, source, replaced) => {
      const diagnostic = fixesOf(source);
      expect(diagnostic.fixes).toHaveLength(1);
      const [fix] = diagnostic.fixes as IrDiagnosticFix[];
      expect(fix?.title).toBe(TITLE);
      expect(fix?.edits.map((e) => source.slice(e.offset, e.end))).toEqual(
        replaced,
      );
      expect(fix?.edits.every((e) => e.newText === "script")).toBe(true);
    },
  );

  it("the open name's edit starts at the diagnostic's own offset", () => {
    const diagnostic = fixesOf("<effect>go()</effect>");
    expect(diagnostic.offset).toBe(1);
    expect(diagnostic.fixes?.[0]?.edits).toEqual([
      { offset: 1, end: 7, newText: "script" },
      { offset: 14, end: 20, newText: "script" },
    ]);
  });

  it("exact shape: self-closing has one edit, `</>` has one edit, bodied has two", () => {
    expect(fixesOf("<effect/>").fixes).toEqual([
      { title: TITLE, edits: [{ offset: 1, end: 7, newText: "script" }] },
    ]);
    expect(fixesOf("<effect>x</>").fixes).toEqual([
      { title: TITLE, edits: [{ offset: 1, end: 7, newText: "script" }] },
    ]);
    expect(fixesOf("<effect>x</effect>").fixes?.[0]?.edits).toHaveLength(2);
  });

  it("a concise tag's edit is at column 0 of its line", () => {
    expect(fixesOf("<div>\n</div>\neffect=go()").fixes?.[0]?.edits).toEqual([
      { offset: 13, end: 19, newText: "script" },
    ]);
  });

  it("a nested tag, a CRLF file and a non-BMP character before it", () => {
    const source = "<if=x>\r\n  <p>😀</p>\r\n  <effect>go()</effect>\r\n</if>";
    const [fix] = fixesOf(source).fixes as IrDiagnosticFix[];
    expect(fix?.edits.map((e) => source.slice(e.offset, e.end))).toEqual([
      "effect",
      "effect",
    ]);
  });

  it.each(FORMS)(
    "applying the edits resolves the `<effect>` error, and leaves only what `<script>` says: %s",
    (_n, source, _replaced, remaining) => {
      const [fix] = fixesOf(source).fixes as IrDiagnosticFix[];
      const fixed = applyFix(`${source}\n`, fix as IrDiagnosticFix);
      expect(fixed).not.toContain("effect");
      const { diagnostics } = lowerSource(fixed, "/tmp/page.mx");
      expect(diagnostics.map((d) => d.code)).toEqual(remaining);
    },
  );

  it.each([
    ["a space before the close `>`", "<effect>x</effect >"],
    ["a close name in another case", "<effect>x</EFFECT>"],
  ])(
    "%s is a parse error, and so has no `<effect>` error and no fix",
    (_n, source) => {
      // The parser does not match this close to the open (`<div>x</div >` fails
      // the same way), so lowering stops before the `<effect>` rule.
      const { diagnostics } = lowerSource(`${source}\n`, "/tmp/page.mx");
      expect(diagnostics.map((d) => d.code)).toEqual([
        "MX_PARSE_MISMATCHED_CLOSING_TAG",
      ]);
      expect(diagnostics.some((d) => d.fixes !== undefined)).toBe(false);
    },
  );

  it("the fixed bodied tag is the same source with `script` for `effect`", () => {
    const source = "<effect>go()</effect>\n";
    const [fix] = fixesOf(source).fixes as IrDiagnosticFix[];
    expect(applyFix(source, fix as IrDiagnosticFix)).toBe(
      "<script>go()</script>\n",
    );
    const { diagnostics } = lowerSource(
      "<script>go()</script>\n",
      "/tmp/page.mx",
    );
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("every other diagnostic carries no `fixes` key", () => {
    const { diagnostics } = lowerSource("<else/>\n<for|x|/>\n", "/tmp/page.mx");
    expect(diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of diagnostics) {
      expect(Object.hasOwn(diagnostic, "fixes")).toBe(false);
    }
  });
});

/** A host that accepts every tag: nothing here may rescue `<effect>`. */
const open: HostDeclarations = {
  name: "fixes-test",
  attrTags: 2,
  tags: {},
  isElement: () => true,
  isComponent: () => false,
  isDelegatedTag: () => false,
  resolveAttributeMethod: () => true,
};

describe("the error a compile throws carries the fixes", () => {
  it("compileSource: TranslateError.fixes, same shape as the diagnostic's", () => {
    let error: TranslateError | undefined;
    try {
      compileSource("<effect>go()</effect>", "/page.mx", open, {
        targets: lookup,
        emitIr: () => "",
      });
    } catch (caught) {
      error = caught as TranslateError;
    }
    expect(error?.diagnosticCode).toBe(CODE);
    expect(error?.fixes).toEqual([
      {
        title: TITLE,
        edits: [
          { offset: 1, end: 7, newText: "script" },
          { offset: 14, end: 20, newText: "script" },
        ],
      },
    ]);
  });

  it("the `none` preset has no error and so no fix", () => {
    const { diagnostics } = lowerSource("<effect/>\n", "/tmp/page.mx", {
      tagRules: "none",
    });
    expect(diagnostics.some((d) => d.fixes !== undefined)).toBe(false);
  });
});

describe("an `<effect>` inside an unknown tag", () => {
  it("is labelled, and keeps its code, range and fix", () => {
    const source =
      "<open>\n  <deep>\n    <effect>go()</effect>\n  </deep>\n</open>";
    const { diagnostics } = lowerSource(source, "/u.mx", {
      customTags: { open: {} } as never,
      unknownTags: "reject",
    });
    const found = diagnostics.find((d) => d.code === CODE);
    expect(found?.message).toContain("(inside the unknown tag `<");
    expect(found?.end).toBeDefined();
    const fix = found?.fixes?.[0];
    expect(fix?.title).toBe(TITLE);
    expect(fix?.edits.map((e) => source.slice(e.offset, e.end))).toEqual([
      "effect",
      "effect",
    ]);
    expect(applyFix(source, fix as IrDiagnosticFix)).toContain(
      "<script>go()</script>",
    );
  });
});

describe("a tag template's `<effect>`: the fix indexes the template's file", () => {
  it("the diagnostic names the template and its edits slice that file", () => {
    const template = "<p>hello</p>\n<effect>go()</effect>\n";
    const { diagnostics } = lowerSource("<box/>\n", "/app/page.mx", {
      customTags: {
        box: { template: { filename: "/tags/box.mx", source: template } },
      } as never,
    });
    const found = diagnostics.find((d) => d.code === CODE);
    expect(found?.file).toBe("/tags/box.mx");
    expect(found?.offset).toBe(-1);
    const [fix] = (found?.fixes ?? []) as IrDiagnosticFix[];
    expect(fix?.edits.map((e) => template.slice(e.offset, e.end))).toEqual([
      "effect",
      "effect",
    ]);
  });
});
