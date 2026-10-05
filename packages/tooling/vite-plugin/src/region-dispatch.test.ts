/**
 * The plugin's default extensions come from the registry's region file kinds,
 * and a file the registry does not call a region file compiles whole-file:
 * an unregistered `.<word>.mx`, and a third-party host on the data target
 * (Mesh's `.mesh.mx`, decision 148).
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearScanCache } from "@mxlang/core";
import { builtinLookup, builtinTargets } from "@mxlang/target-registry";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type MeshGlobals,
  type MeshOptions,
  meshProject,
  setupMesh,
  teardownMesh,
} from "../../../../test-fixtures/third-party-targets/mesh.ts";
import mx, { defaultExtensions, MX_SUFFIX } from "./index.ts";

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

type Transform = (
  this: unknown,
  code: string,
  id: string,
) => Promise<{ code: string } | null>;

function transformOf(plugin: ReturnType<typeof mx>): Transform {
  return plugin.transform as unknown as Transform;
}

describe("default extensions", () => {
  it("are the registry's region kinds, then .mx, before any hook runs", async () => {
    expect(await defaultExtensions()).toEqual([
      ".solid.mx",
      ".preact.mx",
      ".react.mx",
      ".hono.mx",
      ".mx",
    ]);
  });

  it("claim .solid.mx and .mx on a first transform, with no buildStart", async () => {
    const dir = tempDir("mx-vite-default-ext-");
    writeFileSync(join(dir, "package.json"), '{"mx":{"host":"html"}}');
    const transform = transformOf(mx());
    const region = await transform.call(
      {},
      "export const view = <p>hi</p>;\n",
      join(dir, "view.solid.mx") + MX_SUFFIX,
    );
    // Printed through the region bridge: TypeScript stays, the region is JSX.
    expect(region?.code).toContain("export const view =");
    const page = await transform.call(
      {},
      "<p>hi</p>\n",
      join(dir, "page.mx") + MX_SUFFIX,
    );
    expect(page?.code).toContain("hi");
  });

  it("are replaced by a user's extensions option", async () => {
    const dir = tempDir("mx-vite-user-ext-");
    writeFileSync(join(dir, "package.json"), '{"mx":{"host":"html"}}');
    const transform = transformOf(mx({ extensions: [".solid.mx"] }));
    expect(
      await transform.call({}, "<p>hi</p>\n", join(dir, "page.mx") + MX_SUFFIX),
    ).toBeNull();
    expect(
      (
        await transform.call(
          {},
          "export const view = <p>hi</p>;\n",
          join(dir, "view.solid.mx") + MX_SUFFIX,
        )
      )?.code,
    ).toContain("export const view =");
  });
});

describe("a listed extension no region kind serves", () => {
  it("is an error naming the file, not a compile through the first region kind", async () => {
    const dir = tempDir("mx-vite-foo-ext-");
    writeFileSync(join(dir, "package.json"), '{"mx":{"host":"html"}}');
    const file = join(dir, "view.foo.mx");
    await expect(
      transformOf(mx({ extensions: [".foo.mx"] })).call(
        {},
        "export const view = <p>hi</p>;\n",
        file + MX_SUFFIX,
      ),
    ).rejects.toThrow(
      `@mxlang/vite-plugin: no registered host compiles MX regions for "${file}"`,
    );
  });
});

describe("a file no region kind registers compiles whole-file", () => {
  it("an unregistered .<word>.mx is an ordinary .mx page", async () => {
    const dir = tempDir("mx-vite-nope-");
    writeFileSync(join(dir, "package.json"), '{"mx":{"host":"html"}}');
    const result = await transformOf(mx()).call(
      {},
      "<p>whole file</p>\n",
      join(dir, "page.nope.mx") + MX_SUFFIX,
    );
    // The html target's string module, not a printed TypeScript region file.
    expect(result?.code).toContain("whole file");
    expect(result?.code).toContain("@mxlang/html");
  });
});

const MESH_KIND = [{ segment: "mesh", diagnosticSource: "mesh" }];

describe(".mesh.mx (a third-party host on the data target)", () => {
  const compile = async (options: MeshOptions, source = "<x a=1/>\n") => {
    setupMesh(builtinLookup().target("data"), options);
    const dir = meshProject("mx-vite-mesh-", options);
    const file = join(dir, "post.mesh.mx");
    const result = await transformOf(mx()).call({}, source, file + MX_SUFFIX);
    return { file, result };
  };

  it("a declared whole-file kind compiles through the data target, not a region entry", async () => {
    const { file, result } = await compile({ fileKinds: MESH_KIND });
    expect((globalThis as MeshGlobals).__mxMeshCompiles).toEqual([file]);
    expect((globalThis as MeshGlobals).__mxMeshDefaultTags).toEqual(["object"]);
    expect(result?.code).toContain(`"kind": "document"`);
  });

  it("the host without a file kind compiles the same way", async () => {
    const { file, result } = await compile({});
    expect((globalThis as MeshGlobals).__mxMeshCompiles).toEqual([file]);
    expect(result?.code).toContain(`"kind": "document"`);
  });

  it("a real data error surfaces positioned", async () => {
    await expect(
      compile({ fileKinds: MESH_KIND }, "<x a=1/>\n<define name=y/>\n"),
    ).rejects.toThrow(/render-time macro/);
  });

  it("an invalid host override is refused, not compiled", async () => {
    await expect(
      compile({ fileKinds: MESH_KIND, hostDefaultTag: "nonexistent" }),
    ).rejects.toThrow(/invalid `defaultTag` value/);
    expect((globalThis as MeshGlobals).__mxMeshCompiles).toEqual([]);
  });
});
