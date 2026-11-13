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
  assembleChangelog,
  discoverPackages,
  FragmentError,
  parseAssembleArgs,
  parseFragment,
  prependEntries,
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

describe("prependEntries", () => {
  it("puts the new block on top of older entries, tight, older lines untouched", () => {
    const text =
      "# @mxlang/core\n\n## Unreleased\n\n- **old:** entry\n\n- **older:**   loose\n\n## 0.1.0\n- old release\n";
    expect(prependEntries(text, ["- **new:** one", "- **new:** two"])).toBe(
      "# @mxlang/core\n\n## Unreleased\n\n- **new:** one\n- **new:** two\n- **old:** entry\n\n- **older:**   loose\n\n## 0.1.0\n- old release\n",
    );
  });

  it("fills an empty section followed by the next heading", () => {
    const text = "# @mxlang/core\n\n## Unreleased\n\n## 0.1.0\n- old release\n";
    expect(prependEntries(text, ["- **new:** entry"])).toBe(
      "# @mxlang/core\n\n## Unreleased\n\n- **new:** entry\n\n## 0.1.0\n- old release\n",
    );
  });

  it("fills an empty section at the end of the file", () => {
    expect(
      prependEntries("# @mxlang/core\n\n## Unreleased\n", ["- **new:** entry"]),
    ).toBe("# @mxlang/core\n\n## Unreleased\n\n- **new:** entry\n");
  });

  it("replaces the blank lines under the heading with one", () => {
    const text =
      "# @mxlang/x\n\n## Unreleased\n\n\n\nweird   spacing   stays\n- kept\n";
    expect(prependEntries(text, ["- **new:** entry"])).toBe(
      "# @mxlang/x\n\n## Unreleased\n\n- **new:** entry\nweird   spacing   stays\n- kept\n",
    );
  });

  it("adds one blank line when the heading has none under it", () => {
    const text = "# @mxlang/x\n\n## Unreleased\n- kept\n";
    expect(prependEntries(text, ["- **new:** entry"])).toBe(
      "# @mxlang/x\n\n## Unreleased\n\n- **new:** entry\n- kept\n",
    );
  });

  it("creates the section under the title when the file has none", () => {
    const text = "# @mxlang/babel changelog\n\nSome prose.\n";
    expect(prependEntries(text, ["- **a:** one", "- **b:** two"])).toBe(
      "# @mxlang/babel changelog\n\n## Unreleased\n\n- **a:** one\n- **b:** two\n\nSome prose.\n",
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
  it("adds one entry per named package, the batch in slug order above older entries, and consumes fragments", () => {
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
    expect(readFileSync(core, "utf8")).toBe(
      "# @mxlang/core\n\n## Unreleased\n\n- **Added (aaa-first):** first add\n- **Fixed (zzz-last):** last fix\n- **old:** entry\n",
    );
    expect(readFileSync(data, "utf8")).toBe(
      "# @mxlang/data\n\n## Unreleased\n\n- **Added (aaa-first):** first add\n",
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

describe("assembleChangelog --packages", () => {
  function releaseRepo() {
    const root = makeRepo();
    return {
      root,
      core: addPackage(
        root,
        "core",
        "",
        "# @mxlang/core\n\n## Unreleased\n\n- **old:** c\n",
      ),
      data: addPackage(
        root,
        "data",
        "targets",
        "# @mxlang/data\n\n## Unreleased\n\n- **old:** d\n",
      ),
      solid: addPackage(
        root,
        "solid",
        "hosts",
        "# Changelog\n\n## Unreleased\n\n- **old:** s\n",
      ),
    };
  }

  it("renames only the named packages' headings; fragment folding is not restricted", () => {
    const { root, core, data, solid } = releaseRepo();
    addFragment(root, "one", "---\npackages: [solid]\nkind: Added\n---\nentry");
    const result = assembleChangelog(root, {
      release: "1",
      date: "2026-10-12",
      packages: ["core", "data"],
    });
    expect(result.renamedFiles.sort()).toEqual([core, data].sort());
    expect(readFileSync(core, "utf8")).toBe(
      "# @mxlang/core\n\n## 1 — 2026-10-12\n\n- **old:** c\n",
    );
    expect(readFileSync(data, "utf8")).toBe(
      "# @mxlang/data\n\n## 1 — 2026-10-12\n\n- **old:** d\n",
    );
    expect(readFileSync(solid, "utf8")).toBe(
      "# Changelog\n\n## Unreleased\n\n- **Added (one):** entry\n- **old:** s\n",
    );
  });

  it("fails on a package with no CHANGELOG", () => {
    const { root } = releaseRepo();
    expect(() =>
      assembleChangelog(root, { release: "1", packages: ["nope"] }),
    ).toThrow(FragmentError);
  });
});

describe("parseAssembleArgs", () => {
  const known = new Map([
    ["core", "/r/packages/core/CHANGELOG.md"],
    ["data", "/r/packages/targets/data/CHANGELOG.md"],
  ]);

  it("parses --release and a trimmed comma list for --packages", () => {
    expect(
      parseAssembleArgs(
        ["--release", "1", "--packages", " core, ,data ,"],
        known,
      ),
    ).toEqual({ release: "1", packages: ["core", "data"] });
  });

  it("parses no arguments and --release alone", () => {
    expect(parseAssembleArgs([], known)).toEqual({});
    expect(parseAssembleArgs(["--release", "0.2.0"], known)).toEqual({
      release: "0.2.0",
    });
  });

  it("refuses --packages without --release, with the usage line", () => {
    expect(() => parseAssembleArgs(["--packages", "core"], known)).toThrow(
      "--packages needs --release\nusage: bun run changelog:assemble [--release <version> [--packages <name,name>]]",
    );
  });

  it("refuses an unknown package, listing the known names", () => {
    expect(() =>
      parseAssembleArgs(["--release", "1", "--packages", "core,nope"], known),
    ).toThrow(
      "--packages names `nope`, which has no CHANGELOG.md (known: core, data)",
    );
  });

  it("refuses a missing value and an unknown argument", () => {
    expect(() => parseAssembleArgs(["--release"], known)).toThrow(
      /^--release needs a value\n/,
    );
    expect(() => parseAssembleArgs(["--nope"], known)).toThrow(
      /^unknown argument: --nope\n/,
    );
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
