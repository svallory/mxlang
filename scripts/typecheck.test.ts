import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { modeFor, tscFor } from "./typecheck.ts";

const root = resolve(import.meta.dirname, "..");

describe("modeFor", () => {
  it("plain `tsc --noEmit` stays in plain tsc mode", () => {
    expect(modeFor("packages/web-elements/")).toEqual({ kind: "tsc" });
  });

  it("`tsc -p tsconfig.<name>.json` keeps its project file", () => {
    expect(modeFor("packages/hosts/angular/")).toEqual({
      kind: "tsc",
      project: "tsconfig.typecheck.json",
    });
    expect(modeFor("packages/tooling/angular-checker/")).toEqual({
      kind: "tsc",
      project: "tsconfig.typecheck.json",
    });
  });

  it("a custom typecheck script is delegated unchanged", () => {
    // The mx-tsc wrapper examples run their own binary; the `tsc` inside
    // angular-app's chain must not be mistaken for plain tsc mode either.
    expect(modeFor("examples/counter-app/")).toEqual({
      kind: "delegate",
      script: "node ../../packages/tooling/tsc/dist/bin.cjs --noEmit",
    });
    expect(modeFor("examples/angular-app/").kind).toBe("delegate");
  });

  it("a package without a typecheck script defaults to plain tsc", () => {
    // tsx-bridge has a package.json but no typecheck script.
    expect(modeFor("packages/tsx-bridge/")).toEqual({ kind: "tsc" });
  });
});

describe("tscFor", () => {
  it("uses the package-local tsc when the package has one (host-angular pins 5.9.3, not the root's 6.0.3)", () => {
    const p = tscFor("packages/hosts/angular/");
    expect(p).toBe(
      resolve(root, "packages/hosts/angular/node_modules/.bin/tsc"),
    );
    expect(existsSync(p)).toBe(true);
  });

  it("falls back to the root tsc when the package has none", () => {
    const p = tscFor("packages/web-elements/");
    expect(p).toBe(resolve(root, "node_modules/.bin/tsc"));
    expect(existsSync(p)).toBe(true);
  });

  it("falls back to the root tsc for an unknown dir", () => {
    expect(tscFor("packages/no-such-pkg/")).toBe(
      resolve(root, "node_modules/.bin/tsc"),
    );
  });
});
