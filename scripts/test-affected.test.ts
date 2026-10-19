import { describe, expect, it } from "vitest";
import { isWide, laneFor, projectDirs, projectFor } from "./test-affected.ts";

describe("laneFor", () => {
  it("names the slow-lane packages a change touches", () => {
    expect(
      laneFor([
        "packages/tooling/tsc/src/watch.test.ts",
        "packages/core/src/x.ts",
      ]),
    ).toEqual(["packages/tooling/tsc"]);
    expect(
      laneFor([
        "packages/tooling/tsc/src/a.ts",
        "packages/tooling/typescript-plugin/src/b.ts",
      ]),
    ).toEqual(["packages/tooling/tsc", "packages/tooling/typescript-plugin"]);
  });

  it("is empty when no slow-lane package changed", () => {
    expect(laneFor(["packages/core/src/x.ts", "docs/a.md"])).toEqual([]);
  });
});

describe("isWide", () => {
  it("flags the wide files at the repo root", () => {
    expect(isWide("vitest.config.ts")).toBe(true);
    expect(isWide("package.json")).toBe(true);
    expect(isWide("bun.lock")).toBe(true);
    expect(isWide("tsconfig.base.json")).toBe(true);
    expect(isWide("scripts/vitest-lanes.ts")).toBe(true);
  });

  it("flags a per-package vitest config but not ordinary sources", () => {
    expect(isWide("packages/core/vitest.config.ts")).toBe(true);
    expect(isWide("packages/core/src/core.ts")).toBe(false);
    expect(isWide("packages/core/package.json")).toBe(false);
  });
});

describe("projectFor", () => {
  const dirs = projectDirs();

  it("lists the real vitest project dirs, including nested packages", () => {
    expect(dirs).toContain("packages/tooling/tsc/");
    expect(dirs).toContain("packages/hosts/angular/");
    expect(dirs).toContain("scripts/");
  });

  it("maps a fixture change to its package's project name", () => {
    expect(projectFor("packages/tooling/tsc/fixtures/a.json", dirs)).toBe(
      "@mxlang/tsc",
    );
    expect(
      projectFor("packages/parser/test/fixtures/expected.html", dirs),
    ).toBe("@mxlang/parser");
    expect(
      projectFor("packages/oracle/fixtures-custom-tags/run.ts", dirs),
    ).toBe("@mxlang/oracle");
  });

  it("prefers the nearest enclosing project", () => {
    expect(projectFor("packages/hosts/angular/test/x.json", dirs)).toBe(
      "@mxlang/host-angular",
    );
    // a file directly under packages/ is in no project
    expect(projectFor("packages/readme.md", dirs)).toBeUndefined();
  });

  it("returns undefined for files outside every project", () => {
    expect(projectFor("docs/a.md", dirs)).toBeUndefined();
    expect(projectFor("apps/docs/docs/x.md", dirs)).toBeUndefined();
    expect(projectFor("AGENTS.md", dirs)).toBeUndefined();
  });

  it("falls back to the dir name when a project has no package.json name", () => {
    expect(projectFor("scripts/some-tool.ts", dirs)).toBe("scripts");
    expect(projectFor("patches/foo.ts", dirs)).toBe("patches");
  });
});
