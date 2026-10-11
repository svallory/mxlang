import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertFragmentPackages, parseFragment } from "./assemble-changelog.ts";
import {
  evaluate as evaluateInput,
  loadFragmentContext,
  noChangelogRe,
} from "./check-changelog-fragment.ts";

const packages = new Map([
  ["core", "packages/core/CHANGELOG.md"],
  ["solid", "packages/hosts/solid/CHANGELOG.md"],
]);
const evaluate = (
  input: Omit<Parameters<typeof evaluateInput>[0], "fragments" | "packages"> &
    Partial<Parameters<typeof evaluateInput>[0]>,
) => evaluateInput({ fragments: [], packages, ...input });

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
    const fragment = (names: string, slug = "my-change") => ({
      slug,
      text: `---\npackages: [${names}]\nkind: Fixed\n---\nSomething.\n`,
    });
    // A fragment already on main (not in `added`) is still assembled.
    const base = {
      changed: ["docs/index.md"],
      added: [] as string[],
      body: "",
    };

    it("refuses a fragment naming a package with no CHANGELOG.md, with assemble's text", () => {
      expect(
        evaluate({ ...base, fragments: [fragment("core, angular")] }),
      ).toEqual({
        ok: false,
        message:
          "changes/my-change.md would make `bun run changelog:assemble` fail: `my-change` names package `angular`, which has no CHANGELOG.md (known: core, solid)",
      });
    });

    it("refuses a bad fragment this branch did not add or touch", () => {
      const result = evaluate({
        changed: ["README.md"],
        added: [],
        body: "no-changelog: docs\n",
        fragments: [fragment("core"), fragment("targets", "old-one")],
      });
      expect(result).toEqual({
        ok: false,
        message:
          "changes/old-one.md would make `bun run changelog:assemble` fail: `old-one` names package `targets`, which has no CHANGELOG.md (known: core, solid)",
      });
    });

    it("refuses it even when the PR body says no-changelog", () => {
      expect(
        evaluate({
          ...base,
          body: "no-changelog: nothing\n",
          fragments: [fragment("angular")],
        }),
      ).toEqual({
        ok: false,
        message:
          "changes/my-change.md would make `bun run changelog:assemble` fail: `my-change` names package `angular`, which has no CHANGELOG.md (known: core, solid)",
      });
    });

    it("refuses a fragment assemble cannot parse", () => {
      expect(
        evaluate({
          ...base,
          fragments: [{ slug: "bad", text: "no front matter\n" }],
        }),
      ).toEqual({
        ok: false,
        message:
          "changes/bad.md would make `bun run changelog:assemble` fail: bad: expected the file to open with `---`",
      });
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

  describe("loadFragmentContext", () => {
    it("reads every changes/*.md in slug order and the packages that own a CHANGELOG.md", () => {
      const dir = mkdtempSync(join(tmpdir(), "fragment-context-"));
      try {
        mkdirSync(join(dir, "changes"));
        mkdirSync(join(dir, "packages/core"), { recursive: true });
        mkdirSync(join(dir, "packages/hosts/solid"), { recursive: true });
        mkdirSync(join(dir, "packages/hosts/hono"), { recursive: true });
        writeFileSync(join(dir, "packages/core/CHANGELOG.md"), "# core\n");
        writeFileSync(join(dir, "packages/hosts/solid/CHANGELOG.md"), "# s\n");
        writeFileSync(join(dir, "changes/b.md"), "B");
        writeFileSync(join(dir, "changes/a.md"), "A");
        writeFileSync(join(dir, "changes/notes.txt"), "ignored");
        const context = loadFragmentContext(dir);
        expect(context.fragments).toEqual([
          { slug: "a", text: "A" },
          { slug: "b", text: "B" },
        ]);
        expect([...context.packages.keys()].sort()).toEqual(["core", "solid"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("sees no fragments in an empty or missing changes/ (a release PR)", () => {
      const dir = mkdtempSync(join(tmpdir(), "fragment-context-"));
      try {
        mkdirSync(join(dir, "packages/core"), { recursive: true });
        writeFileSync(join(dir, "packages/core/CHANGELOG.md"), "# core\n");
        expect(loadFragmentContext(dir).fragments).toEqual([]);
        mkdirSync(join(dir, "changes"));
        expect(loadFragmentContext(dir).fragments).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
