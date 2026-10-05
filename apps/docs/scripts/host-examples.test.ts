import { describe, expect, it } from "vitest";
import {
  fencedBlocks,
  hostExamples,
  hostPage,
  readHostExample,
} from "./host-examples.ts";

describe.each(Object.entries(hostExamples))("%s host example", (_name, ex) => {
  it("compiles through the host's own entry point and drops nothing", () => {
    const warnings: never[] = [];
    const code = ex.compile(
      readHostExample(ex.mx),
      `/example/${ex.mx}`,
      warnings,
    );
    expect(warnings).toEqual([]);
    expect(code).toContain("That is plenty.");
    expect(code).toMatch(/name(\(\))?\.text/);
  });

  it("is quoted verbatim by the host page, beside the native component", () => {
    const blocks = fencedBlocks(hostPage(ex.page)).map((b) => b.trimEnd());
    expect(blocks, `${ex.page}.md lacks ${ex.native}`).toContain(
      readHostExample(ex.native).trimEnd(),
    );
    expect(blocks, `${ex.page}.md lacks ${ex.mx}`).toContain(
      readHostExample(ex.mx).trimEnd(),
    );
  });
});
