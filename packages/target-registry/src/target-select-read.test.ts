import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

// Permit the real core read, then make the manifest unavailable. Isolated in
// this file so the I/O fault cannot affect other registry/tooling suites.
const state = vi.hoisted(() => ({ resolved: false, secondReads: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    readFileSync: (...args: Parameters<typeof original.readFileSync>) => {
      if (state.resolved) {
        state.secondReads++;
        throw new Error("manifest unavailable after core resolution");
      }
      return original.readFileSync(...args);
    },
  };
});
vi.mock("@mxlang/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@mxlang/core")>();
  return {
    ...original,
    resolveTargetPolicyDetailed: (
      ...args: Parameters<typeof original.resolveTargetPolicyDetailed>
    ) => {
      const resolution = original.resolveTargetPolicyDetailed(...args);
      state.resolved = true;
      return resolution;
    },
  };
});

import { resolveTargetPolicyDetailed } from "./index.ts";

it("positions the unknown-target error for tree without a second manifest read", () => {
  const root = mkdtempSync(join(tmpdir(), "mx-registry-no-reread-"));
  try {
    writeFileSync(join(root, "package.json"), '{"mx":{"target":"tree"}}');
    const { diagnostics } = resolveTargetPolicyDetailed(join(root, "a.mx"));
    expect(diagnostics[0]).toMatchObject({
      code: "unknown-target",
      severity: "error",
      value: "tree",
      length: 6,
      message:
        'unknown mx.target "tree"; valid targets: html, astro-html, solid-jsx, preact-jsx, react-jsx, hono-jsx, angular-template. Compiling under the target taken from the @mxlang dependencies (or the default) so later diagnostics are not drowned.',
    });
    expect(state.secondReads).toBe(0);
  } finally {
    state.resolved = false;
    rmSync(root, { recursive: true, force: true });
  }
});
