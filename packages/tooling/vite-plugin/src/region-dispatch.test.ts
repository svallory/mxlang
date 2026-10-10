/**
 * The plugin's default extensions come from the registry's region file kinds,
 * and a file the registry does not call a region file compiles whole-file:
 * an unregistered `.<word>.mx`.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearScanCache } from "@mxlang/core";
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
    expect(result?.code).toContain("@mxlang/target-html");
  });
});
