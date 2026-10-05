/**
 * The language server on `.react.mx` (decision 154): routed by the registry
 * to `@mxlang/react`'s region entry, it reports React's region errors and
 * region parse errors at their file-absolute position, and nothing for a
 * clean document. Type errors are the TypeScript plugin's (and `mx-tsc`'s),
 * not the language server's.
 */
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { diagnoseDocument } from "./diagnose.ts";

const URI = "file:///project/Panel.react.mx";
const policy = { target: "html" as const };

describe(".react.mx in the language server", () => {
  it("reports a React region error at its file-absolute position, naming the hook", () => {
    const source = `import { useState } from "react";

export function Panel() {
  return (
    <div>
      <let/count=1/>
    </div>
  );
}
`;
    const diagnostics = diagnoseDocument(source, URI, policy);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      severity: 1,
      source: "mxlang",
      range: {
        start: { line: 5, character: 6 },
        end: { line: 5, character: 7 },
      },
    });
    expect(
      stripVTControlCharacters(String(diagnostics[0]?.message ?? "")),
    ).toContain(
      "`<let>` is Marko reactive state; use React's `useState` in the surrounding component",
    );
  });

  it("reports `<const>` in a region at its own position", () => {
    const source =
      "export function Panel() {\n  return (\n    <div>\n      <const/n=1/>\n    </div>\n  );\n}\n";
    const [diagnostic] = diagnoseDocument(source, URI, policy);
    expect(diagnostic?.range.start).toEqual({ line: 3, character: 6 });
    expect(
      stripVTControlCharacters(String(diagnostic?.message ?? "")),
    ).toContain(
      "`<const>` cannot declare a binding inside a `.react.mx` expression",
    );
  });

  it("reports an expression parse error inside a region", () => {
    const source = "export const view = () => (\n  <p>${a b}</p>\n);\n";
    const diagnostics = diagnoseDocument(source, URI, policy);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.range).toEqual({
      start: { line: 1, character: 9 },
      end: { line: 1, character: 10 },
    });
  });

  it("reports nothing for a clean document, also under the reactmx language id", () => {
    const source =
      "export const view = () => <p class={ on: true }>hello</p>;\n";
    expect(diagnoseDocument(source, URI, policy)).toEqual([]);
    expect(
      diagnoseDocument(
        source,
        "untitled:Untitled-1",
        policy,
        undefined,
        "reactmx",
      ),
    ).toEqual([]);
  });
});
