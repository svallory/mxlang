import {
  createTargetLookup,
  type HostRegionInput,
  type HostRegionResult,
  type TargetDescriptor,
} from "@mxlang/core";
import { describe, expect, it, vi } from "vitest";
// The parser's built entry (the registry does not depend on the parser).
import { print } from "../../parser/dist/index.js";
import {
  builtinFileKinds,
  builtinLookup,
  builtinTargets,
  regionCompileFor,
  regionFileKind,
  regionFileKinds,
} from "./index.ts";

/** A test host whose only file kind, `.fake.mx`, has a region entry. */
function fakeRegionHost(
  compileRegion: (source: string, input: HostRegionInput) => HostRegionResult,
): TargetDescriptor {
  return {
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
}

/** The input the parser's bridge hands a region compile. */
function regionInput(filename: string): HostRegionInput {
  return {
    source: "<p/>",
    filename,
    baseOffset: 10,
    baseLine: 0,
    baseColumn: 10,
    importSpecifiers: new Map(),
    moduleBindings: new Set(),
    importDefaultFromMarkoOrMx: new Set(),
    unknownModuleBindings: new Set(),
  };
}

describe("region file kinds are a capability, not a name", () => {
  it("derives the built-in region pipeline from compileRegion", () => {
    expect(
      builtinFileKinds
        .filter((kind) => kind.pipeline === "region")
        .map((kind) => kind.segment),
    ).toEqual(regionFileKinds().map((kind) => kind.segment));
    for (const kind of builtinFileKinds) {
      expect(kind.pipeline === "region").toBe(kind.compileRegion !== undefined);
    }
  });

  it("lists the built-in region kinds with the target that declares them", () => {
    expect(
      regionFileKinds().map(({ segment, target }) => ({ segment, target })),
    ).toEqual([{ segment: "solid", target: "solid-jsx" }]);
  });
});

describe("a registered test host's region file is routed to its own entry", () => {
  it("finds the kind by its suffix in the lookup that registers it", () => {
    const fake = fakeRegionHost(() => ({ code: "null" }));
    const lookup = createTargetLookup([...builtinTargets, fake]);
    expect(regionFileKind("/app/x.fake.mx", lookup)).toMatchObject({
      segment: "fake",
      target: "fake-jsx",
    });
    // Not registered in the built-in set: not a region file there.
    expect(regionFileKind("/app/x.fake.mx")).toBeUndefined();
    // Solid's own suffix still finds Solid in the extended lookup.
    expect(regionFileKind("/app/x.solid.mx", lookup)?.target).toBe("solid-jsx");
  });

  it("calls the test host's compileRegion with the region and the caller's lookup", () => {
    const compileRegion = vi.fn((_source: string, _input: HostRegionInput) => ({
      code: "FAKE",
      dependencies: ["/app/dep.ts"],
    }));
    const lookup = createTargetLookup([
      ...builtinTargets,
      fakeRegionHost(compileRegion),
    ]);
    const warnings: never[] = [];
    const seen: string[] = [];
    const compile = regionCompileFor("/app/x.fake.mx", {
      targets: lookup,
      warnings,
      onDependency: (file) => seen.push(file),
    });
    if (!compile) throw new Error("expected a region compile");

    expect(compile(regionInput("/app/x.fake.mx"))).toEqual({
      code: "FAKE",
      dependencies: ["/app/dep.ts"],
    });
    expect(compileRegion).toHaveBeenCalledTimes(1);
    expect(compileRegion).toHaveBeenCalledWith(
      "<p/>",
      expect.objectContaining({
        filename: "/app/x.fake.mx",
        baseOffset: 10,
        targets: lookup,
        warnings,
      }),
    );
    expect(seen).toEqual(["/app/dep.ts"]);
  });

  it("splices the test host's code at the region's span through the parser's print", () => {
    const lookup = createTargetLookup([
      ...builtinTargets,
      fakeRegionHost(() => ({ code: "FAKE_REGION" })),
    ]);
    const file = "/app/view.fake.mx";
    const source =
      "const a = 1;\nexport const view = <p>hi</p>;\nexport { a };\n";
    const { code } = print(source, file, {
      mx: true,
      mxRegionCompile: regionCompileFor(file, {
        targets: lookup,
      }) as NonNullable<Parameters<typeof print>[2]>["mxRegionCompile"],
    });
    expect(code).toBe(
      "const a = 1;\nexport const view = FAKE_REGION;\nexport { a };",
    );
  });

  it("does not route a .solid.mx region to the test host", () => {
    const compileRegion = vi.fn(() => ({ code: "FAKE" }));
    const lookup = createTargetLookup([
      ...builtinTargets,
      fakeRegionHost(compileRegion),
    ]);
    const solid = regionFileKind("/app/x.solid.mx", lookup);
    const builtinSolid = builtinLookup()
      .target("solid-jsx")
      ?.host?.fileKinds?.find((kind) => kind.segment === "solid");
    expect(solid?.compileRegion).toBe(builtinSolid?.compileRegion);
    expect(compileRegion).not.toHaveBeenCalled();
  });
});

describe("a .<word>.mx no region kind registers is not claimed", () => {
  it.each([
    "/app/x.nope.mx",
    "/app/x.react.mx",
    "/app/x.ng.mx",
    "/app/x.astro.mx",
    "/app/x.mx",
    "/app/x.SOLID.mx",
  ])("%s has no region kind and no region compile", (file) => {
    expect(regionFileKind(file)).toBeUndefined();
    expect(regionCompileFor(file)).toBeUndefined();
  });

  it("a file kind without compileRegion is never a region kind (a Mesh-style host on data)", () => {
    // Decision 148's shape: host `mesh` on a data-like target. A loaded
    // third-party descriptor may not declare file kinds today; this one is
    // registered directly, so even a declared `.mesh.mx` kind stays out of the
    // region bridge because it has no region entry.
    const data = builtinLookup().target("data");
    if (!data) throw new Error("missing data descriptor");
    const mesh: TargetDescriptor = {
      descriptorVersion: 0,
      name: "mesh-data",
      packageName: "@fake/mx-mesh",
      defaultTag: data.defaultTag,
      ...(data.declarations ? { declarations: data.declarations } : {}),
      host: {
        name: "mesh",
        fileKinds: [{ segment: "mesh", diagnosticSource: "mesh" }],
      },
    };
    const lookup = createTargetLookup([...builtinTargets, mesh]);
    expect(lookup.moduleSegments()).toContain("mesh");
    expect(regionFileKind("/app/post.mesh.mx", lookup)).toBeUndefined();
    expect(
      regionCompileFor("/app/post.mesh.mx", { targets: lookup }),
    ).toBeUndefined();
  });
});
