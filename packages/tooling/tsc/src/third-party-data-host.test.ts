/**
 * `mx-tsc` on a project whose host is third-party and built on the data
 * target (Mesh's `.mesh.mx`, decision 148): the file kind is accepted and
 * checked through data, a real data error prints positioned, and a valid file
 * exits 0.
 */
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  type MeshOptions,
  meshProject,
  setupMesh,
  teardownMesh,
} from "../../../../test-fixtures/third-party-targets/mesh.ts";
import { builtinLookup } from "../../../target-registry/src/index.ts";
import { runInProcess } from "./in-process.ts";

afterEach(() => {
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
    const { status, output } = check("<object a=1/>\n", options);
    expect(output).toBe("");
    expect(status).toBe(0);
  });

  it("fails on a real data error, positioned in the file", () => {
    const { status, output } = check("<object a=1/>\n<define name=y/>\n", {
      fileKinds: MESH_KIND,
    });
    expect(status).toBe(1);
    expect(output).toContain(`${join("src", "post.mesh.mx")}(2,`);
    expect(output).toContain("render-time macro");
  });

  it("reports an invalid host defaultTag at the manifest, once", () => {
    const { status, output } = check("<object a=1/>\n", {
      fileKinds: MESH_KIND,
      hostDefaultTag: "nonexistent",
    });
    expect(status).toBe(1);
    expect(output.match(/invalid `defaultTag` value/g)).toHaveLength(1);
  });
});

describe("mx-tsc's data check keys on the resolved base target", () => {
  const FILE = join("src", "post.mesh.mx");
  const UNKNOWN = `${FILE}(1,1): error TS80001: \`<x>\` is not a known tag: it has no contract in \`customTags\`\n`;

  it("gives a host built on data data's strict defaults: an unknown tag is an error", () => {
    const { status, output } = check("<x a=1/>\n", { fileKinds: MESH_KIND });
    expect(output).toBe(UNKNOWN);
    expect(status).toBe(1);
  });

  it("gives it data's structural reject", () => {
    const { status, output } = check("<if=true><object/></if>\n");
    expect(output).toBe(
      `${FILE}(1,1): error TS80001: the data tree is static; this file's consumer does not evaluate \`<if>\`\n`,
    );
    expect(status).toBe(1);
  });

  it("reads the mx.data.* keys of the host's project", () => {
    const allow = check("<x a=1/>\n", {
      mx: { data: { unknownTags: "allow" } },
    });
    expect(allow).toEqual({ status: 0, output: "" });
    const pass = check("<if=true><object/></if>\n", {
      mx: { data: { structural: "pass" } },
    });
    expect(pass).toEqual({ status: 0, output: "" });
  });

  it("reports an invalid mx.data value at the manifest and stays strict", () => {
    const { status, output } = check("<x a=1/>\n", {
      mx: { data: { unknownTags: "maybe" } },
    });
    expect(output).toContain(
      'mx.data.unknownTags must be "allow" or "reject", got "maybe"; using "reject"',
    );
    expect(output).toContain(UNKNOWN);
    expect(status).toBe(1);
  });

  it("warns on an unknown mx.data key", () => {
    const { status, output } = check("<object a=1/>\n", {
      mx: { data: { nope: 1 } },
    });
    expect(output).toContain(
      'unknown mx.data key "nope"; known keys: structural, unknownTags, imports, defaultTag',
    );
    expect(status).toBe(0);
  });

  it("leaves a host whose descriptor is not built on data on its ordinary run", () => {
    const { status, output } = check("<x a=1/>\n", { notBuiltOnData: true });
    expect(output).toBe("");
    expect(status).toBe(0);
    // The host's own compile ran (the data check calls `parseData` itself).
    expect(
      (globalThis as { __mxMeshCompiles?: string[] }).__mxMeshCompiles?.length,
    ).toBeGreaterThan(0);
  });
});
