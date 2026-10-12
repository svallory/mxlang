/**
 * Quick fixes: a diagnostic's `fixes` (`IrDiagnostic.fixes`, `@unstable`)
 * travel in the published diagnostic's `data.fixes` and come back as one
 * `quickfix` code action per applicable fix.
 */
import type { IrDiagnosticFix } from "@mxlang/core";
import { defaultTarget, hostOf } from "@mxlang/targets";
import { describe, expect, it } from "vitest";
import { CodeActionKind, type Diagnostic } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { diagnoseDocument } from "./diagnose.ts";
import { fixActions } from "./fix-actions.ts";

const URI = "file:///project/App.mx";
const target = defaultTarget();
const policy = { target, host: hostOf(target) };

function document(text: string, uri = URI): TextDocument {
  return TextDocument.create(uri, "marko", 1, text);
}

function diagnosticWith(fixes: unknown): Diagnostic {
  return {
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    },
    message: "m",
    data: { fixes },
  };
}

function fixesIn(diagnostic: Diagnostic | undefined): IrDiagnosticFix[] {
  const data = diagnostic?.data as { fixes?: IrDiagnosticFix[] } | undefined;
  return data?.fixes ?? [];
}

/** The text each edit of `fix` covers. */
function covered(text: string, fix: IrDiagnosticFix | undefined): string[] {
  return (fix?.edits ?? []).map((edit) => text.slice(edit.offset, edit.end));
}

describe("diagnoseDocument puts a diagnostic's fixes in its data", () => {
  it("`<effect>` carries the rename, by offset into the document", () => {
    const text = "<div>\n  <effect>go()</effect>\n</div>\n";
    const [diagnostic] = diagnoseDocument(text, URI, policy);
    expect(diagnostic?.code).toBe("MX_RESERVED_EFFECT_TAG");
    const fixes = fixesIn(diagnostic);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.title).toBe("Rename to `<script>`");
    expect(covered(text, fixes[0])).toEqual(["effect", "effect"]);
  });

  it("a diagnostic without a fix has no `fixes` in its data", () => {
    const [diagnostic] = diagnoseDocument("<else/>\n", URI, policy);
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.data).toBeUndefined();
  });

  it("a non-BMP character before the tag does not shift the fix", () => {
    const text = "<p>\u{1F600}</p>\n<effect>go()</effect>\n";
    const [diagnostic] = diagnoseDocument(text, URI, policy);
    expect(covered(text, fixesIn(diagnostic)[0])).toEqual(["effect", "effect"]);
  });
});

describe("fixActions", () => {
  it("one quickfix per fix, the edits as a workspace edit on the document", () => {
    const text = "<div>\n  <effect>go()</effect>\n</div>\n";
    const doc = document(text);
    const diagnostics = diagnoseDocument(text, URI, policy);
    const actions = fixActions(doc, diagnostics);
    expect(actions).toHaveLength(1);
    const [action] = actions;
    expect(action?.title).toBe("Rename to `<script>`");
    expect(action?.kind).toBe(CodeActionKind.QuickFix);
    expect(action?.isPreferred).toBe(true);
    expect(action?.diagnostics).toEqual(diagnostics);
    expect(action?.edit?.changes?.[URI]).toEqual([
      {
        range: {
          start: { line: 1, character: 3 },
          end: { line: 1, character: 9 },
        },
        newText: "script",
      },
      {
        range: {
          start: { line: 1, character: 16 },
          end: { line: 1, character: 22 },
        },
        newText: "script",
      },
    ]);
  });

  it("applying the action's edits gives the fixed source", () => {
    const text = "<p>\u{1F600}</p>\r\n<effect>go()</effect>\r\n";
    const doc = document(text);
    const [action] = fixActions(doc, diagnoseDocument(text, URI, policy));
    const edits = action?.edit?.changes?.[URI] ?? [];
    const fixed = TextDocument.applyEdits(doc, edits);
    expect(fixed).toBe("<p>\u{1F600}</p>\r\n<script>go()</script>\r\n");
  });

  it("several fixes make several actions, none preferred", () => {
    const doc = document("abcdef");
    const actions = fixActions(doc, [
      diagnosticWith([
        { title: "A", edits: [{ offset: 0, end: 1, newText: "x" }] },
        { title: "B", edits: [{ offset: 1, end: 2, newText: "y" }] },
      ]),
    ]);
    expect(actions.map((action) => action.title)).toEqual(["A", "B"]);
    expect(actions.map((action) => action.isPreferred)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("a diagnostic with no data, no fixes or a non-array gives none", () => {
    const doc = document("abc");
    const plain: Diagnostic = diagnosticWith(undefined);
    delete plain.data;
    expect(
      fixActions(doc, [
        plain,
        diagnosticWith(undefined),
        diagnosticWith([]),
        diagnosticWith("nope"),
        diagnosticWith({ title: "x" }),
      ]),
    ).toEqual([]);
  });

  it.each([
    ["an edit past the end of the document", [{ offset: 2, end: 9 }]],
    ["a negative offset", [{ offset: -1, end: 1 }]],
    ["an end before its offset", [{ offset: 2, end: 1 }]],
    ["a fractional offset", [{ offset: 0.5, end: 1 }]],
    [
      "overlapping edits",
      [
        { offset: 0, end: 2 },
        { offset: 1, end: 3 },
      ],
    ],
    ["no edits", []],
  ])("drops a fix with %s", (_name, edits) => {
    const doc = document("abcdef");
    const fix = {
      title: "T",
      edits: edits.map((edit) => ({ ...edit, newText: "z" })),
    };
    expect(fixActions(doc, [diagnosticWith([fix])])).toEqual([]);
  });

  it("drops a fix with a missing title or a non-string newText", () => {
    const doc = document("abcdef");
    expect(
      fixActions(doc, [
        diagnosticWith([
          { edits: [{ offset: 0, end: 1, newText: "z" }] },
          { title: "T", edits: [{ offset: 0, end: 1, newText: 1 }] },
        ]),
      ]),
    ).toEqual([]);
  });

  it("keeps the good fix when its sibling is dropped", () => {
    const doc = document("abcdef");
    const actions = fixActions(doc, [
      diagnosticWith([
        { title: "bad", edits: [{ offset: 0, end: 99, newText: "z" }] },
        { title: "good", edits: [{ offset: 0, end: 1, newText: "z" }] },
      ]),
    ]);
    expect(actions.map((action) => action.title)).toEqual(["good"]);
  });

  it("adjacent edits (end equals the next offset) are not an overlap", () => {
    const doc = document("abcdef");
    const [action] = fixActions(doc, [
      diagnosticWith([
        {
          title: "T",
          edits: [
            { offset: 0, end: 2, newText: "x" },
            { offset: 2, end: 4, newText: "y" },
          ],
        },
      ]),
    ]);
    expect(
      TextDocument.applyEdits(doc, action?.edit?.changes?.[URI] ?? []),
    ).toBe("xyef");
  });
});
