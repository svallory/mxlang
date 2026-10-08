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
  type MeshGlobals,
  type MeshOptions,
  meshProject,
  setupMesh,
  teardownMesh,
} from "../../../../test-fixtures/third-party-targets/mesh.ts";
import {
  builtinLookup,
  defaultTagFor,
  resolveTargetPolicyDetailed,
} from "../../../target-registry/src/index.ts";
import { runInProcess } from "./in-process.ts";

afterEach(() => {
  teardownMesh();
});

const UNKNOWN = `${join("src", "post.mesh.mx")}(1,1): error TS80001: \`<x>\` is not a known tag: it has no contract in \`customTags\`\n`;
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
    files: {
      ...options.files,
      "tsconfig.json": TSCONFIG,
      "src/post.mesh.mx": source,
    },
  };
  setupMesh(builtinLookup().target("tree"), merged);
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
    expect(
      (globalThis as { __mxMeshCompiles?: string[] }).__mxMeshCompiles?.length,
    ).toBeGreaterThan(0);
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

const CONTRACTS = `export default {
  service: {
    parents: ["#root"],
    attributes: {
      id: { type: "string" },
      value: { type: "string", required: true },
    },
    children: { port: { repeatable: true } },
  },
  port: {
    parents: ["service"],
    attributes: {
      id: { type: "string" },
      value: { type: "string", required: true },
    },
  },
};
`;
const WITH_CONTRACTS = {
  files: { "contracts.ts": CONTRACTS },
  fileKinds: MESH_KIND,
};
const SHORTHAND = '<#a value="x"/>\n';
const PORT_AT_TOP = `${join("src", "post.mesh.mx")}(1,1): error TS80001: \`<port>\` must be inside \`<service>\`; found at the top level\n`;

describe("the unnamed-tag ladder (decision 145) on a host built on data", () => {
  const mx = (extra: Record<string, unknown> = {}) => ({
    contracts: "./contracts.ts",
    ...extra,
  });

  it("rung 4: data's `object` when nothing overrides it", () => {
    const run = check("<#a/>\n", { ...WITH_CONTRACTS, mx: mx() });
    expect(run).toEqual({ status: 0, output: "" });
    expect((globalThis as MeshGlobals).__mxMeshDefaultTags?.at(-1)).toBe(
      "object",
    );
  });

  it("rung 3: the descriptor's defaultTag", () => {
    const run = check(SHORTHAND, {
      ...WITH_CONTRACTS,
      mx: mx(),
      defaultTag: "port",
    });
    expect(run.output).toBe(PORT_AT_TOP);
    expect(run.status).toBe(1);
  });

  it("rung 2: the host's override outranks the descriptor's", () => {
    const run = check(SHORTHAND, {
      ...WITH_CONTRACTS,
      mx: mx(),
      defaultTag: "service",
      hostDefaultTag: "port",
    });
    expect(run.output).toBe(PORT_AT_TOP);
    expect(run.status).toBe(1);
    expect((globalThis as MeshGlobals).__mxMeshDefaultTags?.at(-1)).toBe(
      "port",
    );
  });

  it("rung 1: the host's own mx key outranks the host override", () => {
    const run = check(SHORTHAND, {
      ...WITH_CONTRACTS,
      mx: mx({ "mesh-data": { defaultTag: "service" } }),
      hostDefaultTag: "port",
    });
    expect(run).toEqual({ status: 0, output: "" });
  });

  it("rung 1: mx.tree.defaultTag is read for a host built on tree, and mx-tsc's tag is defaultTagFor's", () => {
    const options = {
      ...WITH_CONTRACTS,
      mx: mx({ tree: { defaultTag: "port" } }),
    };
    const run = check(SHORTHAND, options);
    expect(run.output).toBe(PORT_AT_TOP);
    expect(run.status).toBe(1);
    // The registry's shared ladder, the one Vite, the LS and the TS plugin use.
    const dir = (globalThis as MeshGlobals).__mxMeshProjectDir as string;
    const file = join(dir, "src", "post.mesh.mx");
    const shared = defaultTagFor(
      file,
      resolveTargetPolicyDetailed(file).policy,
    );
    expect(shared).toBe("port");
    expect((globalThis as MeshGlobals).__mxMeshDefaultTags?.at(-1)).toBe(
      shared,
    );
  });

  it("an invalid mx.tree.defaultTag is one positioned error and falls to the next rung", () => {
    const run = check(SHORTHAND, {
      ...WITH_CONTRACTS,
      mx: mx({ tree: { defaultTag: "nonexistent" } }),
      hostDefaultTag: "service",
    });
    expect(run.output.match(/invalid `defaultTag` value/g)).toHaveLength(1);
    expect(run.output).toContain("package.json(");
    expect(run.status).toBe(1);
  });

  it("the host's own key wins over mx.tree.defaultTag, and a differing pair warns naming both", () => {
    const run = check(SHORTHAND, {
      ...WITH_CONTRACTS,
      mx: mx({
        "mesh-data": { defaultTag: "service" },
        tree: { defaultTag: "port" },
      }),
    });
    expect(run.status).toBe(0);
    expect(run.output).toMatch(
      /^package\.json\(\d+,\d+\): warning TS\d+: mx\.tree\.defaultTag "port" is ignored: mx\["mesh-data"\]\.defaultTag "service" takes precedence\n$/,
    );
  });

  it("the same value under both keys is silent", () => {
    const run = check(SHORTHAND, {
      ...WITH_CONTRACTS,
      mx: mx({
        "mesh-data": { defaultTag: "service" },
        tree: { defaultTag: "service" },
      }),
    });
    expect(run).toEqual({ status: 0, output: "" });
  });
});

describe("the data check adds to a host built on data; it never replaces the host's compile", () => {
  const RULE = "forbidden";

  it("the host's own rule still fires", () => {
    const run = check(`<object a="${RULE}"/>\n`, {
      fileKinds: MESH_KIND,
      hostRule: RULE,
    });
    expect(run.output).toBe(
      `${join("src", "post.mesh.mx")}(1,1): error TS80001: mesh rule: ${RULE} is not allowed\n`,
    );
    expect(run.status).toBe(1);
  });

  it("data's strict defaults and the host's rule both report, in one run", () => {
    const run = check(`<x a="${RULE}"/>\n`, {
      fileKinds: MESH_KIND,
      hostRule: RULE,
    });
    expect(run.output).toBe(
      `${UNKNOWN}${join("src", "post.mesh.mx")}(1,1): error TS80001: mesh rule: ${RULE} is not allowed\n`,
    );
    expect(run.status).toBe(1);
  });

  it("every error the host's compile reports is printed (decision 162)", () => {
    const run = check(
      `<object a="${RULE}"/>\n<object/>\n<object b="${RULE}"/>\n`,
      {
        fileKinds: MESH_KIND,
        hostRule: RULE,
      },
    );
    const at = (line: number) =>
      `${join("src", "post.mesh.mx")}(${line},1): error TS80001: mesh rule: ${RULE} is not allowed\n`;
    expect(run.output).toBe(at(1) + at(3));
    expect(run.status).toBe(1);
  });

  it("an error both report is printed once", () => {
    const run = check("<object a=1/>\n<define name=y/>\n", {
      fileKinds: MESH_KIND,
    });
    expect(run.output.match(/render-time macro/g)).toHaveLength(1);
  });
});
