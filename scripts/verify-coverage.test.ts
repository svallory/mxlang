import { describe, expect, it } from "vitest";
import {
  findStaleExceptions,
  packageKeyOfTestPath,
} from "./verify-coverage.ts";

const root = "/repo";

const knownPaths = [
  "packages/core",
  "packages/hosts/angular",
  "packages/tooling/vite-plugin",
  "packages/editors/vscode",
  "examples/angular",
  "packages/adapters/foo",
];

describe("packageKeyOfTestPath", () => {
  it("keys a hosts package by its full workspace-relative path", () => {
    expect(
      packageKeyOfTestPath(
        `${root}/packages/hosts/angular/test/define.test.ts`,
        root,
        knownPaths,
      ),
    ).toBe("packages/hosts/angular");
  });

  it("keys an example by its full workspace-relative path", () => {
    expect(
      packageKeyOfTestPath(
        `${root}/examples/angular/src/app.test.ts`,
        root,
        knownPaths,
      ),
    ).toBe("examples/angular");
  });

  it("does not collide when an example and a hosts package share a basename", () => {
    const hostsKey = packageKeyOfTestPath(
      `${root}/packages/hosts/angular/test/define.test.ts`,
      root,
      knownPaths,
    );
    const exampleKey = packageKeyOfTestPath(
      `${root}/examples/angular/src/app.test.ts`,
      root,
      knownPaths,
    );

    expect(hostsKey).not.toBe(exampleKey);
    expect(hostsKey).toBe("packages/hosts/angular");
    expect(exampleKey).toBe("examples/angular");
  });

  it("keys a tooling/editors package by its full path", () => {
    expect(
      packageKeyOfTestPath(
        `${root}/packages/tooling/vite-plugin/src/index.test.ts`,
        root,
        knownPaths,
      ),
    ).toBe("packages/tooling/vite-plugin");
    expect(
      packageKeyOfTestPath(
        `${root}/packages/editors/vscode/src/manifest.test.ts`,
        root,
        knownPaths,
      ),
    ).toBe("packages/editors/vscode");
  });

  it("keys a plain packages/* entry", () => {
    expect(
      packageKeyOfTestPath(
        `${root}/packages/core/src/lower.test.ts`,
        root,
        knownPaths,
      ),
    ).toBe("packages/core");
  });

  it("keys a package under a group with no hardcoded name, e.g. packages/adapters/foo", () => {
    // No hosts/tooling/editors special-casing: this proves the resolver
    // walks the discovered workspace paths rather than a fixed group list,
    // so a future packages/adapters/* package resolves without a code change.
    expect(
      packageKeyOfTestPath(
        `${root}/packages/adapters/foo/src/index.test.ts`,
        root,
        knownPaths,
      ),
    ).toBe("packages/adapters/foo");
  });

  it("returns null for a path outside every known package", () => {
    expect(
      packageKeyOfTestPath(
        `${root}/scripts/verify-coverage.test.ts`,
        root,
        knownPaths,
      ),
    ).toBeNull();
  });

  it("returns null for a path under an unknown package even if it shares a prefix", () => {
    expect(
      packageKeyOfTestPath(
        `${root}/packages/hosts/angular-extra/test/x.test.ts`,
        root,
        knownPaths,
      ),
    ).toBeNull();
  });
});

describe("findStaleExceptions", () => {
  it("returns no stale entries when every exception key names a known package", () => {
    const known = new Set(["packages/editors/zed", "examples/todomvc"]);
    const exceptions = {
      "packages/editors/zed": "grammar",
      "examples/todomvc": "e2e only",
    };
    expect(findStaleExceptions(known, exceptions)).toEqual([]);
  });

  it("reports an exception key that names a package that no longer exists", () => {
    const known = new Set(["examples/todomvc"]);
    const exceptions = {
      "examples/todomvc": "e2e only",
      "examples/removed-app": "e2e only",
    };
    expect(findStaleExceptions(known, exceptions)).toEqual([
      "examples/removed-app",
    ]);
  });

  it("returns an empty array when there are no exceptions", () => {
    expect(findStaleExceptions(new Set(["packages/core"]), {})).toEqual([]);
  });
});
