import { reservedBindingMessage } from "@mxlang/core";
import { expect, it } from "vitest";
import { DiagnosticSeverity } from "vscode-languageserver/node";
import { diagnoseDocument } from "./diagnose.ts";

it.each(["html", "preact-jsx", "react-jsx", "hono-jsx"])(
  "%s reports the reservation at the authored binding, not a helper",
  (target) => {
    const diagnostics = diagnoseDocument(
      "\n<const/__mxX=1/>",
      "/app/reserved.mx",
      { target },
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      message: reservedBindingMessage("__mxX"),
      severity: DiagnosticSeverity.Error,
      range: { start: { line: 1, character: 7 } },
    });
  },
);

it("reports a host module binding through the region diagnostic path", () => {
  const diagnostics = diagnoseDocument(
    "\nconst __mxX = 1;\nconst view = <p/>;",
    "/app/reserved.solid.mx",
    { target: "solid-jsx" },
  );
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    message: reservedBindingMessage("__mxX"),
    range: { start: { line: 1, character: 6 } },
  });
});
