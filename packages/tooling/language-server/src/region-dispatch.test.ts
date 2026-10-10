/**
 * Region files are dispatched by the registry, through the document's own
 * lookup (`lookupFor(policy)`): a host registered with a region entry gets its
 * `.<segment>.mx` regions, a `.<word>.mx` no region kind registers compiles
 * whole-file under the page policy.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearScanCache,
  type HostRegionInput,
  type TargetDescriptor,
  type TargetPolicy,
} from "@mxlang/core";
import { builtinLookup, lookupFor, regionFileKind } from "@mxlang/targets";
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
