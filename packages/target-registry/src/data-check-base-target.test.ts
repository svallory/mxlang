import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type MeshOptions,
  meshProject,
  setupMesh,
  teardownMesh,
} from "../../../test-fixtures/third-party-targets/mesh.ts";
import { isDataProject } from "./data-check.ts";
import { baseTargetOf, builtinLookup, builtinTargets } from "./index.ts";

const scratch: string[] = [];

afterEach(() => {
  teardownMesh();
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function manifest(json: object): string {
  const dir = mkdtempSync(join(tmpdir(), "mx-base-target-"));
  scratch.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify(json));
  return dir;
}

function mesh(options: MeshOptions = {}): string {
  setupMesh(builtinLookup().target("data"), options);
  return meshProject("mx-base-target-mesh-", options);
}

describe("baseTargetOf", () => {
  it("is `data` for the data target and the target's own name for every other built-in", () => {
    expect(
      Object.fromEntries(builtinTargets.map((t) => [t.name, baseTargetOf(t)])),
    ).toEqual({
      html: "html",
      "astro-html": "astro-html",
      "solid-jsx": "solid-jsx",
      "preact-jsx": "preact-jsx",
      "react-jsx": "react-jsx",
      "hono-jsx": "hono-jsx",
      "angular-template": "angular-template",
      data: "data",
    });
  });

  it("follows the declarations a host reuses, not the host's own name", () => {
    const data = builtinLookup().target("data");
    if (!data?.declarations) throw new Error("no data declarations");
    expect(
      baseTargetOf({ ...data, name: "mesh-data", host: { name: "mesh" } }),
    ).toBe("data");
  });
});

describe("isDataProject keys on the resolved base target", () => {
  it("accepts mx.target: data", () => {
    expect(isDataProject(manifest({ mx: { target: "data" } }))).toBe(true);
  });

  it("accepts a third-party host built on data (mx.host)", () => {
    expect(isDataProject(mesh())).toBe(true);
  });

  it("rejects a third-party host that reuses declarations without data's base target", () => {
    expect(isDataProject(mesh({ notBuiltOnData: true }))).toBe(false);
  });

  it("rejects a built-in host and a built-in non-data target", () => {
    expect(isDataProject(manifest({ mx: { host: "solid" } }))).toBe(false);
    expect(isDataProject(manifest({ mx: { target: "html" } }))).toBe(false);
  });

  it("rejects a host that cannot be loaded", () => {
    expect(
      isDataProject(manifest({ mx: { host: "@fake/not-installed" } })),
    ).toBe(false);
  });

  it("does not infer from an @mxlang/data dependency or a missing manifest", () => {
    expect(
      isDataProject(manifest({ dependencies: { "@mxlang/data": "*" } })),
    ).toBe(false);
    expect(isDataProject(manifest({}))).toBe(false);
    expect(isDataProject(join(tmpdir(), "mx-base-target-nonexistent"))).toBe(
      false,
    );
  });
});
