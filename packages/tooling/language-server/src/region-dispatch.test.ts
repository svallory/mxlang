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
  lookupFor,
  regionFileKind,
  resolveTargetPolicyDetailed,
} from "@mxlang/target-registry";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  delete (globalThis as MeshGlobals).__mxDataDescriptor;
  delete (globalThis as MeshGlobals).__mxMeshCompiles;
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

interface MeshGlobals {
  __mxDataDescriptor?: TargetDescriptor;
  __mxMeshCompiles?: string[];
}

/**
 * A faithful Mesh-style host (decision 148): a third-party package selected by
 * `mx.host`, host `mesh` on the data target, no file kinds of its own (a
 * loaded descriptor may not declare any), compiling through the data target's
 * own compile and keeping data's `defaultTag` (`object`). The data descriptor
 * is handed over on `globalThis` because the
 * package is installed in a temp project that cannot resolve `@mxlang/data`.
 */
const MESH_INDEX = `const data = globalThis.__mxDataDescriptor;
module.exports = {
  descriptorVersion: 0,
  name: "mesh-data",
  packageName: "@fake/mx-mesh",
  defaultTag: data.defaultTag,
  declarations: data.declarations,
  get parseTranslator() { return data.parseTranslator; },
  host: { name: "mesh" },
  load(core) {
    const compiler = data.load(core);
    return {
      compileModule(source, filename, options) {
        globalThis.__mxMeshCompiles.push(filename);
        return compiler.compileModule(source, filename, options);
      },
    };
  },
};
`;

function meshProject(): string {
  const data = builtinLookup().target("data");
  if (!data) throw new Error("missing data descriptor");
  const globals = globalThis as MeshGlobals;
  globals.__mxDataDescriptor = data;
  globals.__mxMeshCompiles = [];
  const dir = tempDir("mx-ls-mesh-");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ mx: { host: "@fake/mx-mesh" } }),
  );
  const pkg = join(dir, "node_modules", "@fake", "mx-mesh");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "@fake/mx-mesh",
      version: "1.0.0",
      main: "index.cjs",
    }),
  );
  writeFileSync(join(pkg, "index.cjs"), MESH_INDEX);
  return dir;
}

/** Spies on every built-in region kind's compile: the region bridge's only way in. */
function spyRegionBridge() {
  return builtinTargets
    .flatMap((target) => target.host?.fileKinds ?? [])
    .filter((kind) => kind.compileRegion)
    .map((kind) => vi.spyOn(kind as Required<typeof kind>, "compileRegion"));
}

describe(".mesh.mx (a third-party host on the data target)", () => {
  it("has no region kind in its own lookup, compiles whole-file on data, never reaches the region bridge", () => {
    const dir = meshProject();
    const file = join(dir, "post.mesh.mx");
    const { policy } = resolveTargetPolicyDetailed(file);
    expect(policy).toMatchObject({ target: "mesh-data", host: "mesh" });
    expect(policy.descriptor?.name).toBe("mesh-data");
    expect(regionFileKind(file, lookupFor(policy))).toBeUndefined();

    const bridge = spyRegionBridge();
    // Given the policy directly (its resolution diagnostics are the known
    // failure below), the file compiles whole-file through data.
    expect(diagnoseDocument("<x a=1/>\n", file, policy)).toEqual([]);
    expect((globalThis as MeshGlobals).__mxMeshCompiles).toEqual([file]);
    for (const spy of bridge) expect(spy).not.toHaveBeenCalled();
  });

  // Known failure, TODO `third-party-host-data-defaulttag` (squad-targets): the
  // registry checks a loaded descriptor's own `defaultTag` with no built-ins,
  // and data's `isElement` is false for every name, so a host keeping data's
  // `object` (decision 148) is refused at resolution. Flips when that lands.
  it.fails("resolves cleanly and compiles whole-file on data (TODO third-party-host-data-defaulttag)", () => {
    const dir = meshProject();
    const file = join(dir, "post.mesh.mx");
    const { policy, diagnostics } = resolveTargetPolicyDetailed(file);
    expect(diagnostics).toEqual([]);
    expect(diagnoseDocument("<x a=1/>\n", file, policy)).toEqual([]);
    expect((globalThis as MeshGlobals).__mxMeshCompiles).toEqual([file]);
  });
});
