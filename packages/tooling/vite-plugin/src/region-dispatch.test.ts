/**
 * The plugin's default extensions come from the registry's region file kinds,
 * and a file the registry does not call a region file compiles whole-file:
 * an unregistered `.<word>.mx`, and a third-party host on the data target
 * (Mesh's `.mesh.mx`, decision 148).
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
import { clearScanCache, type TargetDescriptor } from "@mxlang/core";
import { builtinLookup, builtinTargets } from "@mxlang/target-registry";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  delete (globalThis as MeshGlobals).__mxDataDescriptor;
  delete (globalThis as MeshGlobals).__mxMeshCompiles;
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
      ".react.mx",
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
  const dir = tempDir("mx-vite-mesh-");
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

describe(".mesh.mx (a third-party host on the data target)", () => {
  // No green routing test here: Vite resolves the policy (and refuses this
  // one, see below) before it picks the whole-file or the region branch, so
  // a routing assertion could not fail. The language server's test, given
  // the policy directly, proves `.mesh.mx` compiles whole-file through data
  // and never reaches a region entry.

  // Known failure, TODO `third-party-host-data-defaulttag` (squad-targets): a
  // loaded host keeping data's `defaultTag` (`object`, decision 148) is refused
  // by the registry's descriptor check before Vite compiles. Flips when it lands.
  it.fails("compiles whole-file through the data target (TODO third-party-host-data-defaulttag)", async () => {
    const dir = meshProject();
    const file = join(dir, "post.mesh.mx");
    const result = await transformOf(mx()).call(
      {},
      "<x a=1/>\n",
      file + MX_SUFFIX,
    );
    expect((globalThis as MeshGlobals).__mxMeshCompiles).toEqual([file]);
    expect(result?.code).toContain(`"kind": "document"`);
  });
});
