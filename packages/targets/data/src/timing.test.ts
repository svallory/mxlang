import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { parseData } from "./parse.ts";
import type { DataAttrTagNode, DataNode } from "./tree.ts";

/**
 * The note's §10 unmeasured risk: `lowerDelegatedTag` calls
 * `readCalleeInput(target, ctx)` for *every* tag, probing for a callee file
 * by name. The 31-tag fixture compiles instantly; a large spec file was
 * unmeasured. This test is the measurement (the lead's addition to item 10):
 * 1,000 tags, timed, printed for the report. There is deliberately no hard
 * time assertion — the number is data, not a gate.
 */

function countTags(nodes: (DataNode | DataAttrTagNode)[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.kind === "tag") {
      count += 1 + countTags(node.children) + countTags(node.attrTags);
    }
  }
  return count;
}

describe("readCalleeInput-per-tag cost (note §10)", () => {
  it("parses a generated 1,000-tag file, timed", () => {
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      lines.push(`item-${i} value="v${i}" n=${i}`);
    }
    const source = `${lines.join("\n")}\n`;

    const start = performance.now();
    const result = parseData(source, "/bench/thousand.mx");
    const elapsedMs = performance.now() - start;

    expect(result.diagnostics).toEqual([]);
    const tree = result.tree;
    if (!tree) throw new Error("expected a tree");
    expect(countTags(tree.children)).toBe(1000);
    // The measurement is the point of the test; it is printed, not gated.
    console.log(
      `[data-pr1 timing] parseData over 1,000 generated tags: ${elapsedMs.toFixed(1)}ms`,
    );
  });
});
