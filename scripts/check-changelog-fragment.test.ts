import { describe, expect, it } from "vitest";
import { assertFragmentPackages, parseFragment } from "./assemble-changelog.ts";
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

  describe("fragment packages", () => {
    const packages = new Map([
      ["core", "packages/core/CHANGELOG.md"],
      ["solid", "packages/hosts/solid/CHANGELOG.md"],
    ]);
    const fragment = (names: string, slug = "my-change") => ({
      path: `changes/${slug}.md`,
      text: `---\npackages: [${names}]\nkind: Fixed\n---\nSomething.\n`,
    });
    const base = {
      changed: ["packages/core/src/ir.ts"],
      added: ["changes/my-change.md"],
      body: "",
      packages,
    };

    it("refuses a fragment naming a package with no CHANGELOG.md, with assemble's text", () => {
      const result = evaluate({
        ...base,
        fragments: [fragment("core, angular")],
      });
      expect(result).toEqual({
        ok: false,
        message:
          "changes/my-change.md would make `bun run changelog:assemble` fail: `my-change` names package `angular`, which has no CHANGELOG.md (known: core, solid)",
      });
    });

    it("refuses it even when the PR body says no-changelog", () => {
      expect(
        evaluate({
          ...base,
          body: "no-changelog: nothing\n",
          fragments: [fragment("angular")],
        }).ok,
      ).toBe(false);
    });

    it("refuses a fragment assemble cannot parse", () => {
      const result = evaluate({
        ...base,
        fragments: [{ path: "changes/bad.md", text: "no front matter\n" }],
      });
      expect(result.ok).toBe(false);
      expect(result.message).toContain(
        "bad: expected the file to open with `---`",
      );
    });

    it("accepts fragments naming only known packages, or none", () => {
      expect(
        evaluate({ ...base, fragments: [fragment("core, solid")] }).ok,
      ).toBe(true);
      expect(evaluate({ ...base, fragments: [fragment("")] }).ok).toBe(true);
    });

    it("uses the rule assemble uses (same refusal text)", () => {
      expect(() =>
        assertFragmentPackages(
          parseFragment("my-change", fragment("angular").text),
          packages,
        ),
      ).toThrow(
        "`my-change` names package `angular`, which has no CHANGELOG.md (known: core, solid)",
      );
    });
  });
});
