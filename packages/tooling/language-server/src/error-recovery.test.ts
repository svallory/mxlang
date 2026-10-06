import { describe, expect, it } from "vitest";
import { diagnoseDocument } from "./diagnose.ts";

// Three independent errors: a scriptlet, an `<if>` without a condition, CDATA.
const SOURCE = [
  "<div>ok</div>",
  "$ const a = 1",
  "<p>fine</p>",
  "<if></if>",
  "<![CDATA[raw]]>",
  "<span>fine</span>",
].join("\n");

describe("language server error recovery (decision 162)", () => {
  it("publishes one diagnostic per error of the file", () => {
    const diagnostics = diagnoseDocument(SOURCE, "/app/page.mx", {
      target: "html",
    });
    expect(diagnostics.map((d) => d.range.start.line)).toEqual([1, 3, 4]);
    expect(diagnostics[0]?.message).toContain("scriptlets");
    expect(diagnostics[1]?.message).toContain("without a condition");
    expect(diagnostics[2]?.message).toContain("CDATA");
  });
});
