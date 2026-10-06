import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fencedBlocks,
  hostExamples,
  hostPage,
  hostsExampleDir,
  readHostExample,
} from "./host-examples.ts";

describe.each(Object.entries(hostExamples))("%s host example", (_name, ex) => {
  it("compiles through the host's own entry point and drops nothing", () => {
    const warnings: never[] = [];
    // The real path: the example imports the hand-written component beside
    // it, and the compile reads that file's `Input` for the attribute tags.
    const code = ex.compile(
      readHostExample(ex.mx),
      join(hostsExampleDir, ex.mx),
      warnings,
    );
    expect(warnings).toEqual([]);
    for (const emitted of ex.emits) expect(code).toContain(emitted);
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
