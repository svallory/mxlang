/**
 * One region language plugin per region file kind (decision 154): each claims
 * its own `.<segment>.mx` suffix, a kind that is not built in included, and
 * lowers the regions with its own kind's `compileRegion`.
 */
import type { HostFileKind, HostRegionInput } from "@mxlang/core";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { fileKindForPipeline } from "./file-kinds.ts";
import {
  createRegionLanguagePlugin,
  createRegionLanguagePlugins,
} from "./language.ts";

/** A region file kind no built-in target declares. */
function fakeKind(
  compileRegion: (source: string, input: HostRegionInput) => { code: string },
): HostFileKind {
  return {
    segment: "fake",
    languageIds: ["fakemx"],
    diagnosticSource: "fakemx",
    compileRegion,
  };
}

const snapshot = (text: string) => ts.ScriptSnapshot.fromString(text);
const noScript = { getAssociatedScript: () => undefined };

describe("two region kinds, two plugins", () => {
  const compileRegion = vi.fn(() => ({ code: "null" }));
  const solid = createRegionLanguagePlugin(ts, fileKindForPipeline("region"));
  const fake = createRegionLanguagePlugin(ts, fakeKind(compileRegion));

  it("each claims only its own suffix", () => {
    expect(solid.getLanguageId("/a/x.solid.mx")).toBe("solidmx");
    expect(solid.getLanguageId("/a/x.fake.mx")).toBeUndefined();
    expect(fake.getLanguageId("/a/x.fake.mx")).toBe("fakemx");
    expect(fake.getLanguageId("/a/x.solid.mx")).toBeUndefined();
    for (const plugin of [solid, fake])
      expect(plugin.getLanguageId("/a/x.mx")).toBeUndefined();
  });

  it("each advertises only its own extension", () => {
    expect(
      solid.typescript?.extraFileExtensions.map((e) => e.extension),
    ).toEqual(["solid.mx"]);
    expect(
      fake.typescript?.extraFileExtensions.map((e) => e.extension),
    ).toEqual(["fake.mx"]);
  });

  it("the non-built-in kind lowers its own file's regions with its own entry", () => {
    const file = "/a/view.fake.mx";
    const source = "export const view = <p>hi</p>;\n";
    // Claimed by suffix, whatever language id the host attached.
    const virtual = fake.createVirtualCode?.(
      file,
      "typescript",
      snapshot(source),
      noScript,
    );
    expect(virtual).toBeDefined();
    expect(fake.getSyntaxError(file)).toBeUndefined();
    expect(compileRegion).toHaveBeenCalledWith(
      "<p>hi</p>",
      expect.objectContaining({ filename: file, baseOffset: 20 }),
    );
    expect(
      solid.createVirtualCode?.(file, "typescript", snapshot(source), noScript),
    ).toBeUndefined();
  });
});

describe("a case-variant suffix (X.SOLID.mx) is claimed but not lowered", () => {
  // Unchanged from before decision 154: the plugin has matched the suffix
  // case-insensitively since it was added, and the parser's `.solid.mx`
  // default left the grammar off for any other case. The language server,
  // Vite and the registry all treat `X.SOLID.mx` as a whole-file `.mx`.
  const source = "export const view = <if=true><p>x</p></if>;\n";

  it("is claimed by the Solid plugin", () => {
    const solid = createRegionLanguagePlugin(ts, fileKindForPipeline("region"));
    expect(solid.getLanguageId("/a/X.SOLID.mx")).toBe("solidmx");
  });

  it("parses as plain TSX: MX syntax is a syntax error there, and lowered in .solid.mx", () => {
    const solid = createRegionLanguagePlugin(ts, fileKindForPipeline("region"));
    for (const file of ["/a/X.SOLID.mx", "/a/x.solid.mx"])
      solid.createVirtualCode?.(file, "solidmx", snapshot(source), noScript);
    expect(solid.getSyntaxError("/a/X.SOLID.mx")).toBeDefined();
    expect(solid.getSyntaxError("/a/x.solid.mx")).toBeUndefined();
  });
});

describe(".react.mx: the React region kind's own plugin", () => {
  const react = createRegionLanguagePlugins(ts).find(
    (plugin) => plugin.getLanguageId("/a/x.react.mx") !== undefined,
  );

  it("claims .react.mx as reactmx, and no other kind's suffix", () => {
    expect(react?.getLanguageId("/a/x.react.mx")).toBe("reactmx");
    for (const file of ["/a/x.solid.mx", "/a/x.mx", "/a/x.preact.mx"])
      expect(react?.getLanguageId(file)).toBeUndefined();
    expect(
      react?.typescript?.extraFileExtensions.map((e) => e.extension),
    ).toEqual(["react.mx"]);
  });

  it("lowers a region to React JSX in the virtual code", () => {
    const file = "/a/Panel.react.mx";
    const source =
      'export const view = <label for="n" class={ on: true }>n</label>;\n';
    const virtual = react?.createVirtualCode?.(
      file,
      "reactmx",
      snapshot(source),
      noScript,
    );
    expect(react?.getSyntaxError(file)).toBeUndefined();
    const text = virtual?.snapshot.getText(0, virtual.snapshot.getLength());
    expect(text).toContain("htmlFor=");
    expect(text).toContain("className=");
  });
});

describe(".preact.mx: the Preact region kind's own plugin", () => {
  const preact = createRegionLanguagePlugins(ts).find(
    (plugin) => plugin.getLanguageId("/a/x.preact.mx") !== undefined,
  );

  it("claims .preact.mx as preactmx, and no other kind's suffix", () => {
    expect(preact?.getLanguageId("/a/x.preact.mx")).toBe("preactmx");
    for (const file of ["/a/x.solid.mx", "/a/x.mx", "/a/x.react.mx"])
      expect(preact?.getLanguageId(file)).toBeUndefined();
    expect(
      preact?.typescript?.extraFileExtensions.map((e) => e.extension),
    ).toEqual(["preact.mx"]);
  });

  it("lowers a region to Preact JSX in the virtual code", () => {
    const file = "/a/Panel.preact.mx";
    const source =
      'export const view = <label for="n" class={ on: true }>n</label>;\n';
    const virtual = preact?.createVirtualCode?.(
      file,
      "preactmx",
      snapshot(source),
      noScript,
    );
    expect(preact?.getSyntaxError(file)).toBeUndefined();
    const text = virtual?.snapshot.getText(0, virtual.snapshot.getLength());
    expect(text).toContain("for=");
    expect(text).toContain("class=");
  });
});
