/**
 * A third-party host on the data target (Mesh's `.mesh.mx`, decision 148)
 * through the TS plugin: the file is claimed as a whole-file `.mx`, resolves
 * through `mx.host` to the loaded descriptor and compiles through data.
 */

import * as core from "@mxlang/core";
import { builtinLookup } from "@mxlang/target-registry";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  type MeshOptions,
  meshProject,
  setupMesh,
  teardownMesh,
} from "../../../../test-fixtures/third-party-targets/mesh.ts";
import { createMxLanguagePlugin } from "./mx-language.ts";

afterEach(() => {
  core.clearScanCache();
  teardownMesh();
});

const MESH_KIND = [{ segment: "mesh", diagnosticSource: "mesh" }];

function compile(source: string, options: MeshOptions = {}) {
  setupMesh(builtinLookup().target("data"), options);
  const dir = meshProject("mx-plugin-mesh-", options);
  const fileName = `${dir}/post.mesh.mx`;
  const plugin = createMxLanguagePlugin(ts);
  const virtual = plugin.createVirtualCode?.(
    fileName,
    "mx",
    ts.ScriptSnapshot.fromString(source),
    { getAssociatedScript: () => undefined },
  );
  return {
    plugin,
    fileName,
    virtual,
    text: virtual?.snapshot.getText(0, virtual.snapshot.getLength()),
    diagnostics: plugin.getCompileDiagnostics(fileName),
    policyDiagnostics: plugin.getTargetPolicyDiagnostics(fileName),
  };
}

describe("`.mesh.mx` in the TS plugin", () => {
  it.each([
    ["with its file kind declared", { fileKinds: MESH_KIND }],
    ["without one", {}],
  ])(
    "is claimed as a whole-file .mx and compiles through data, %s",
    (_name, options) => {
      const {
        plugin,
        fileName,
        virtual,
        text,
        diagnostics,
        policyDiagnostics,
      } = compile("<x a=1/>\n", options);
      expect(plugin.getLanguageId(fileName)).toBe("mx");
      expect(virtual).toBeDefined();
      expect(policyDiagnostics).toEqual([]);
      expect(diagnostics).toEqual([]);
      expect(text).toContain('"kind": "document"');
      expect(
        (globalThis as { __mxMeshCompiles?: string[] }).__mxMeshCompiles,
      ).toEqual([fileName]);
    },
  );

  it("reports a real data error, positioned in the source", () => {
    const { diagnostics } = compile("<x a=1/>\n<define name=y/>\n", {
      fileKinds: MESH_KIND,
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("render-time macro");
    // `<define` starts line 2, after the 9 characters of line 1.
    expect(diagnostics[0]?.offset).toBe(9);
  });

  it("mx.data.defaultTag is the shared ladder's rung for a host built on data", () => {
    const { diagnostics, policyDiagnostics } = compile("<x/>\n", {
      fileKinds: MESH_KIND,
      files: { "tags/node.mx": "" },
      mx: { data: { defaultTag: "node" } },
    });
    expect(policyDiagnostics).toEqual([]);
    expect(diagnostics).toEqual([]);
    expect(
      (globalThis as { __mxMeshDefaultTags?: string[] }).__mxMeshDefaultTags,
    ).toEqual(["node"]);
  });

  it("warns when the host's own key and mx.data.defaultTag differ; the host's wins", () => {
    const { policyDiagnostics } = compile("<x/>\n", {
      fileKinds: MESH_KIND,
      files: { "tags/node.mx": "", "tags/leaf.mx": "" },
      mx: {
        "mesh-data": { defaultTag: "leaf" },
        data: { defaultTag: "node" },
      },
    });
    expect(policyDiagnostics.map((d) => d.message)).toEqual([
      'mx.data.defaultTag "node" is ignored: mx["mesh-data"].defaultTag "leaf" takes precedence',
    ]);
    expect(
      (globalThis as { __mxMeshDefaultTags?: string[] }).__mxMeshDefaultTags,
    ).toEqual(["leaf"]);
  });

  it("advertises the `.mx` extension that covers it", () => {
    const plugin = createMxLanguagePlugin(ts);
    expect(
      plugin.typescript?.extraFileExtensions.map((e) => e.extension),
    ).toContain("mx");
  });
});
