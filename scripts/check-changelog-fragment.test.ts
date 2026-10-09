import { describe, expect, it } from "vitest";
import { evaluate, noChangelogRe } from "./check-changelog-fragment.ts";

describe("evaluate", () => {
  it("fails when package src is touched with no fragment", () => {
    const result = evaluate({
      changed: ["packages/core/src/ir.ts", "docs/index.md"],
      added: [],
      body: "",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("packages/core/src/ir.ts");
  });

  it("fails for a nested package's package.json too", () => {
    expect(
      evaluate({
        changed: ["packages/hosts/solid/package.json"],
        added: [],
        body: "",
      }).ok,
    ).toBe(false);
  });

  it("passes when package src is touched and a fragment is added", () => {
    expect(
      evaluate({
        changed: ["packages/core/src/ir.ts"],
        added: ["changes/feat-thing.md", "packages/core/src/ir.ts"],
        body: "",
      }).ok,
    ).toBe(true);
  });

  it("passes with a no-changelog: reason line in the PR body", () => {
    expect(
      evaluate({
        changed: ["packages/core/src/ir.ts"],
        added: [],
        body: "Some description.\n\nno-changelog: test-only refactor\n",
      }).ok,
    ).toBe(true);
  });

  it("treats a bare no-changelog: line (no reason) as absent", () => {
    expect(noChangelogRe.test("no-changelog:")).toBe(false);
    expect(
      evaluate({
        changed: ["packages/core/src/ir.ts"],
        added: [],
        body: "no-changelog:\n",
      }).ok,
    ).toBe(false);
  });

  it("passes for a docs-only diff with no fragment", () => {
    expect(
      evaluate({
        changed: ["apps/docs/docs/index.md", "scripts/thing.ts", "README.md"],
        added: [],
        body: "",
      }).ok,
    ).toBe(true);
  });

  it("ignores paths that merely contain src or package.json elsewhere", () => {
    expect(
      evaluate({
        changed: [
          "packages/core/test/x.test.ts",
          "packages/core/CHANGELOG.md",
          "src/app.ts",
        ],
        added: [],
        body: "",
      }).ok,
    ).toBe(true);
  });
});
