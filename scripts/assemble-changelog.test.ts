import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendEntry,
  assembleChangelog,
  discoverPackages,
  FragmentError,
  parseFragment,
  renameUnreleased,
} from "./assemble-changelog.ts";

const tempRoots: string[] = [];

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "mx-changelog-"));
  tempRoots.push(root);
  return root;
}

function addPackage(
  root: string,
  short: string,
  group = "",
  changelog: string,
) {
  const dir = join(root, "packages", group, short);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "CHANGELOG.md"), changelog);
  return join(dir, "CHANGELOG.md");
}

function addFragment(root: string, slug: string, text: string) {
  mkdirSync(join(root, "changes"), { recursive: true });
  writeFileSync(join(root, "changes", `${slug}.md`), text);
}

afterEach(() => {
  while (tempRoots.length > 0)
    rmSync(tempRoots.pop() as string, { recursive: true, force: true });
});

describe("parseFragment", () => {
  it("reads packages, kind and a one-paragraph body", () => {
    const fragment = parseFragment(
      "feat-thing",
      "---\npackages: [core, data]\nkind: Added\n---\n\nDoes the thing,\nacross two source lines.\n",
    );
    expect(fragment).toEqual({
      slug: "feat-thing",
      packages: ["core", "data"],
      kind: "Added",
      body: "Does the thing, across two source lines.",
    });
  });

  it("rejects a bad kind, missing front matter and an empty body", () => {
    expect(() => parseFragment("a", "kind: Added\n---\nbody")).toThrow(
      FragmentError,
    );
    expect(() => parseFragment("a", "---\npackages: []\n---\n")).toThrow(
      FragmentError,
    );
    expect(() =>
      parseFragment("a", "---\npackages: []\nkind: Bumped\n---\nbody"),
    ).toThrow(/kind must be one of/);
  });

  it("accepts an empty package list (process-only change)", () => {
    expect(
      parseFragment("a", "---\npackages: []\nkind: Added\n---\nbody").packages,
    ).toEqual([]);
  });
});

describe("appendEntry", () => {
  it("appends inside an existing Unreleased section, before the next heading", () => {
    const text =
      "# @mxlang/core\n\n## Unreleased\n\n- **old:** entry\n\n## 0.1.0\n- old release\n";
    expect(appendEntry(text, "- **new:** entry")).toBe(
      "# @mxlang/core\n\n## Unreleased\n\n- **old:** entry\n\n- **new:** entry\n\n## 0.1.0\n- old release\n",
    );
  });

  it("creates the section under the title when the file has none", () => {
    const text = "# @mxlang/babel changelog\n\nSome prose.\n";
    const result = appendEntry(text, "- **new:** entry");
    expect(result).toBe(
      "# @mxlang/babel changelog\n\n## Unreleased\n\n- **new:** entry\n\nSome prose.\n",
    );
  });

  it("never reformats existing lines", () => {
    const text =
      "# @mxlang/x\n\n## Unreleased\nweird   spacing   stays\n- kept\n";
    const result = appendEntry(text, "- **new:** entry");
    expect(result).toContain(
      "weird   spacing   stays\n- kept\n\n- **new:** entry",
    );
  });
});

describe("renameUnreleased", () => {
  it("renames the heading with an em dash and date", () => {
    expect(
      renameUnreleased(
        "## Unreleased\n- x\n\n## 1.0.0\n",
        "0.2.0",
        "2026-10-12",
      ),
    ).toBe("## 0.2.0 — 2026-10-12\n- x\n\n## 1.0.0\n");
  });

  it("leaves files without the section unchanged", () => {
    expect(renameUnreleased("## 1.0.0\n", "0.2.0", "2026-10-12")).toBe(
      "## 1.0.0\n",
    );
  });
});

describe("assembleChangelog", () => {
  it("appends one entry per named package, in slug order, and consumes fragments", () => {
    const root = makeRepo();
    const core = addPackage(
      root,
      "core",
      "",
      "# @mxlang/core\n\n## Unreleased\n\n- **old:** entry\n",
    );
    const data = addPackage(
      root,
      "data",
      "targets",
      "# @mxlang/data\n\n## Unreleased\n\n",
    );
    addFragment(
      root,
      "zzz-last",
      "---\npackages: [core]\nkind: Fixed\n---\nlast fix",
    );
    addFragment(
      root,
      "aaa-first",
      "---\npackages: [core, data]\nkind: Added\n---\nfirst add",
    );

    const result = assembleChangelog(root, { date: "2026-10-12" });
    expect(result.consumedFragments).toEqual(["aaa-first", "zzz-last"]);
    expect(result.appended).toBe(3);
    const coreText = readFileSync(core, "utf8");
    expect(coreText.indexOf("first add")).toBeLessThan(
      coreText.indexOf("last fix"),
    );
    expect(coreText).toContain("- **Added (aaa-first):** first add");
    expect(coreText).toContain("- **Fixed (zzz-last):** last fix");
    expect(readFileSync(data, "utf8")).toContain(
      "- **Added (aaa-first):** first add",
    );
    expect(existsSync(join(root, "changes", "aaa-first.md"))).toBe(false);
    expect(existsSync(join(root, "changes", "zzz-last.md"))).toBe(false);
  });

  it("is idempotent: a second run with no fragments changes nothing", () => {
    const root = makeRepo();
    const core = addPackage(
      root,
      "core",
      "",
      "# @mxlang/core\n\n## Unreleased\n\n",
    );
    addFragment(root, "one", "---\npackages: [core]\nkind: Added\n---\nentry");
    assembleChangelog(root);
    const afterFirst = readFileSync(core, "utf8");
    const result = assembleChangelog(root);
    expect(result).toEqual({
      appended: 0,
      renamedFiles: [],
      consumedFragments: [],
    });
    expect(readFileSync(core, "utf8")).toBe(afterFirst);
  });

  it("fails when a fragment names a package with no CHANGELOG", () => {
    const root = makeRepo();
    addPackage(root, "core", "", "# @mxlang/core\n\n## Unreleased\n");
    addFragment(root, "one", "---\npackages: [nope]\nkind: Added\n---\nentry");
    expect(() => assembleChangelog(root)).toThrow(/no CHANGELOG.md/);
  });

  it("renames Unreleased everywhere on --release, including untouched packages", () => {
    const root = makeRepo();
    const core = addPackage(
      root,
      "core",
      "",
      "# @mxlang/core\n\n## Unreleased\n",
    );
    const solid = addPackage(
      root,
      "solid",
      "hosts",
      "# Changelog\n\n## Unreleased\n\n- **old:** x\n",
    );
    addFragment(root, "one", "---\npackages: [core]\nkind: Added\n---\nentry");

    const result = assembleChangelog(root, {
      release: "0.2.0",
      date: "2026-10-12",
    });
    expect(result.renamedFiles.sort()).toEqual([core, solid].sort());
    expect(readFileSync(core, "utf8")).toBe(
      "# @mxlang/core\n\n## Unreleased\n\n- **Added (one):** entry\n".replace(
        "## Unreleased",
        "## 0.2.0 — 2026-10-12",
      ),
    );
    expect(readFileSync(solid, "utf8")).toContain("## 0.2.0 — 2026-10-12");
  });
});

describe("discoverPackages", () => {
  it("keys both workspace depths by directory basename", () => {
    const root = makeRepo();
    addPackage(root, "core", "", "# @mxlang/core\n");
    addPackage(root, "data", "targets", "# @mxlang/data\n");
    expect([...discoverPackages(root).keys()].sort()).toEqual(["core", "data"]);
  });
});
