/**
 * Region files are dispatched by the registry, through the document's own
 * lookup (`lookupFor(policy)`): a host registered with a region entry gets its
 * `.<segment>.mx` regions, a `.<word>.mx` no region kind registers compiles
 * whole-file under the page policy, and a third-party host on the data target
 * (Mesh's `.mesh.mx`, decision 148) is never routed to the region bridge.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearScanCache,
  type HostRegionInput,
  type TargetDescriptor,
  type TargetPolicy,
} from "@mxlang/core";
import {
  builtinLookup,
  builtinTargets,
  defaultTagFor,
  lookupFor,
  regionFileKind,
  resolveTargetPolicyDetailed,
} from "@mxlang/target-registry";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type MeshGlobals,
  type MeshOptions,
  meshProject,
  setupMesh,
  teardownMesh,
} from "../../../../test-fixtures/third-party-targets/mesh.ts";
import { diagnoseDocument } from "./diagnose.ts";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  clearScanCache();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  teardownMesh();
});

/** A test host whose only file kind, `.fake.mx`, has a region entry. */
function fakeRegionPolicy(
  compileRegion: (source: string, input: HostRegionInput) => { code: string },
): TargetPolicy {
  const descriptor: TargetDescriptor = {
    descriptorVersion: 0,
    name: "fake-jsx",
    packageName: "@test/mx-fake",
    defaultTag: "div",
    host: {
      name: "fake",
      fileKinds: [
        { segment: "fake", diagnosticSource: "fakemx", compileRegion },
      ],
    },
  };
  return { target: "fake-jsx", host: "fake", descriptor };
}

describe("a registered test host's region file", () => {
  it("is lowered region by region through that host's compileRegion", () => {
    const compileRegion = vi.fn((_source: string, _input: HostRegionInput) => ({
      code: "null",
    }));
    const policy = fakeRegionPolicy(compileRegion);
    const dir = tempDir("mx-ls-region-");
    const file = join(dir, "view.fake.mx");
    const source = "const a = 1;\nexport const view = <p>${a}</p>;\n";

    expect(diagnoseDocument(source, file, policy)).toEqual([]);
    expect(compileRegion).toHaveBeenCalledTimes(1);
    expect(compileRegion).toHaveBeenCalledWith(
      "<p>${a}</p>",
      expect.objectContaining({
        filename: file,
        baseLine: 1,
        baseOffset: source.indexOf("<p>"),
        targets: lookupFor(policy),
      }),
    );
  });

  it("is not lowered by Solid, and a .solid.mx file is not lowered by it", () => {
    const compileRegion = vi.fn(() => ({ code: "null" }));
    const policy = fakeRegionPolicy(compileRegion);
    const dir = tempDir("mx-ls-region-");
    expect(
      diagnoseDocument(
        "export const view = <p>hi</p>;\n",
        join(dir, "view.solid.mx"),
        policy,
      ),
    ).toEqual([]);
    expect(compileRegion).not.toHaveBeenCalled();
  });
});

describe("an unregistered .<word>.mx is not claimed", () => {
  it("compiles whole-file under the page policy, never through a region entry", () => {
    const html = builtinLookup().target("html");
    if (!html?.load) throw new Error("missing html descriptor");
    const load = vi.spyOn(html, "load");
    const dir = tempDir("mx-ls-nope-");
    const file = join(dir, "page.nope.mx");
    expect(regionFileKind(file)).toBeUndefined();
    diagnoseDocument("export const view = <p>hi</p>;\n", file, {
      target: "html",
      host: "html",
    });
    // The page target's whole-file compile, never a region entry.
    expect(load).toHaveBeenCalled();
    // And a plain template in it compiles as the page it is.
    expect(
      diagnoseDocument("<p>hi</p>\n", file, { target: "html", host: "html" }),
    ).toEqual([]);
  });
});

/** Spies on every built-in region kind's compile: the region bridge's only way in. */
function spyRegionBridge() {
  return builtinTargets
    .flatMap((target) => target.host?.fileKinds ?? [])
    .filter((kind) => kind.compileRegion)
    .map((kind) => vi.spyOn(kind as Required<typeof kind>, "compileRegion"));
}

const MESH_KIND = [{ segment: "mesh", diagnosticSource: "mesh" }];
const mesh = (options: MeshOptions = {}) =>
  setupMesh(builtinLookup().target("data"), options);

describe(".mesh.mx (a third-party host on the data target)", () => {
  it("a declared whole-file kind resolves cleanly, compiles on data and never reaches the region bridge", () => {
    mesh({ fileKinds: MESH_KIND });
    const dir = meshProject("mx-ls-mesh-", { fileKinds: MESH_KIND });
    const file = join(dir, "post.mesh.mx");
    const { policy, diagnostics } = resolveTargetPolicyDetailed(file);
    expect(diagnostics).toEqual([]);
    expect(policy).toMatchObject({ target: "mesh-data", host: "mesh" });
    expect(lookupFor(policy).moduleSegments()).toContain("mesh");
    // Declared, but with no `compileRegion`: never a region kind.
    expect(regionFileKind(file, lookupFor(policy))).toBeUndefined();

    const bridge = spyRegionBridge();
    expect(diagnoseDocument("<x a=1/>\n", file, policy)).toEqual([]);
    expect((globalThis as MeshGlobals).__mxMeshCompiles).toEqual([file]);
    // The host keeps data's `object` as the unnamed tag.
    expect((globalThis as MeshGlobals).__mxMeshDefaultTags).toEqual(["object"]);
    for (const spy of bridge) expect(spy).not.toHaveBeenCalled();
  });

  it("a real data error is positioned at its tag", () => {
    mesh({ fileKinds: MESH_KIND });
    const dir = meshProject("mx-ls-mesh-", { fileKinds: MESH_KIND });
    const file = join(dir, "post.mesh.mx");
    const { policy } = resolveTargetPolicyDetailed(file);
    const found = diagnoseDocument(
      "<x a=1/>\n<define name=y/>\n",
      file,
      policy,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("render-time macro");
    expect(found[0]?.range.start.line).toBe(1);
  });

  it("the host's own defaultTag override is what the compile gets", () => {
    mesh({ fileKinds: MESH_KIND, hostDefaultTag: "node" });
    const dir = meshProject("mx-ls-mesh-", {
      fileKinds: MESH_KIND,
      hostDefaultTag: "node",
      files: { "tags/node.mx": "" },
    });
    const file = join(dir, "post.mesh.mx");
    const { policy, diagnostics } = resolveTargetPolicyDetailed(file);
    expect(diagnostics).toEqual([]);
    diagnoseDocument("<x/>\n", file, policy);
    expect((globalThis as MeshGlobals).__mxMeshDefaultTags).toEqual(["node"]);
  });

  it("mx.data.defaultTag is the shared ladder's rung for a host built on data", () => {
    const options = {
      fileKinds: MESH_KIND,
      files: { "tags/node.mx": "" },
      mx: { data: { defaultTag: "node" } },
    };
    mesh(options);
    const file = join(meshProject("mx-ls-mesh-", options), "post.mesh.mx");
    const { policy, diagnostics } = resolveTargetPolicyDetailed(file);
    expect(diagnostics).toEqual([]);
    diagnoseDocument("<x/>\n", file, policy);
    expect((globalThis as MeshGlobals).__mxMeshDefaultTags).toEqual(["node"]);
    expect(defaultTagFor(file, policy)).toBe("node");
  });

  it("without a file kind the host still resolves cleanly (defaultTag alone)", () => {
    mesh();
    const dir = meshProject("mx-ls-mesh-");
    const file = join(dir, "post.mesh.mx");
    const { policy, diagnostics } = resolveTargetPolicyDetailed(file);
    expect(diagnostics).toEqual([]);
    expect(diagnoseDocument("<x a=1/>\n", file, policy)).toEqual([]);
    expect((globalThis as MeshGlobals).__mxMeshCompiles).toEqual([file]);
  });
});
