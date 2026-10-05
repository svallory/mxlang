/**
 * `mx-tsc` on a project whose host is third-party and built on the data
 * target (Mesh's `.mesh.mx`, decision 148): the file kind is accepted and
 * checked through data, a real data error prints positioned, and a valid file
 * exits 0.
 */
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { clearScanCache } from "@mxlang/core";
import { builtinLookup } from "@mxlang/target-registry";
import { afterEach, describe, expect, it } from "vitest";
import {
  type MeshOptions,
  meshProject,
  setupMesh,
  teardownMesh,
} from "../../../../test-fixtures/third-party-targets/mesh.ts";
import { runInProcess } from "./in-process.ts";

afterEach(() => {
  clearScanCache();
  teardownMesh();
});

const MESH_KIND = [{ segment: "mesh", diagnosticSource: "mesh" }];
const TSCONFIG = JSON.stringify({
  compilerOptions: {
    noEmit: true,
    strict: true,
    module: "esnext",
    moduleResolution: "bundler",
    target: "esnext",
    types: [],
  },
  include: ["src"],
});

function check(source: string, options: MeshOptions = {}) {
  const merged = {
    ...options,
    files: { "tsconfig.json": TSCONFIG, "src/post.mesh.mx": source },
  };
  setupMesh(builtinLookup().target("data"), merged);
  const dir = meshProject("mx-tsc-mesh-", merged);
  const saved = process.cwd();
  process.chdir(dir);
  try {
    const run = runInProcess(["-p", "."]);
    return {
      status: run.status,
      output: stripVTControlCharacters(run.stderr + run.stdout),
    };
  } finally {
    process.chdir(saved);
  }
}

describe("mx-tsc on a third-party host built on data", () => {
  it.each([
    ["with its file kind declared", { fileKinds: MESH_KIND }],
    ["without one", {}],
  ])("accepts a valid .mesh.mx file, %s", (_name, options) => {
    const { status, output } = check("<x a=1/>\n", options);
    expect(output).toBe("");
    expect(status).toBe(0);
    expect(
      (globalThis as { __mxMeshCompiles?: string[] }).__mxMeshCompiles?.length,
    ).toBeGreaterThan(0);
  });

  it("fails on a real data error, positioned in the file", () => {
    const { status, output } = check("<x a=1/>\n<define name=y/>\n", {
      fileKinds: MESH_KIND,
    });
    expect(status).toBe(1);
    expect(output).toContain(join("src", "post.mesh.mx") + "(2,");
    expect(output).toContain("render-time macro");
  });

  it("reports an invalid host defaultTag at the manifest, once", () => {
    const { status, output } = check("<x a=1/>\n", {
      fileKinds: MESH_KIND,
      hostDefaultTag: "nonexistent",
    });
    expect(status).toBe(1);
    expect(output.match(/invalid `defaultTag` value/g)).toHaveLength(1);
  });
});
