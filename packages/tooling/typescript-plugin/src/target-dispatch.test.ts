import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TargetDescriptor } from "@mxlang/core";
import * as core from "@mxlang/core";
import { builtinFileKinds, builtinLookup } from "@mxlang/targets";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAmxLanguagePlugin } from "./amx-language.ts";
import { createConfiguredLanguagePlugins } from "./index.ts";
import { createMxLanguagePlugin } from "./mx-language.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  core.clearScanCache();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function compile(target: string, source = "<p/>\n") {
  const dir = mkdtempSync(join(tmpdir(), "mx-plugin-dispatch-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ mx: { target } }));
  const fileName = join(dir, "page.mx");
  const plugin = createMxLanguagePlugin(ts);
  const virtual = plugin.createVirtualCode?.(
    fileName,
    "mx",
    ts.ScriptSnapshot.fromString(source),
    { getAssociatedScript: () => undefined },
  );
  if (!virtual) throw new Error("missing virtual code");
  return {
    virtual,
    diagnostics: plugin.getCompileDiagnostics(fileName),
    policyDiagnostics: plugin.getTargetPolicyDiagnostics(fileName),
  };
}

describe("target-table page dispatch", () => {
  it("passes the tool core, full lookup, strictness and projection option to a fake descriptor with neither map nor mappings", () => {
    const compileModule = vi.fn(() => ({
      code: "export default 1;",
      dependencies: [],
    }));
    const load = vi.fn(() => ({ compileModule }));
    const typeSurface = vi.fn((code: string) => `${code}\n// type surface`);
    const fake: TargetDescriptor = {
      descriptorVersion: 0,
      name: "html",
      packageName: "@test/fake",
      defaultTag: "node",
      host: { name: "not-a-built-in-host" },
      mappings: "merge-recorded",
      strict: "always",
      load,
      typeSurface,
    };
    const lookup = builtinLookup();
    const original = lookup.target;
    vi.spyOn(lookup, "target").mockImplementation((name) =>
      name === "html" ? fake : original(name),
    );
    const { virtual, diagnostics } = compile("html");
    expect(diagnostics).toEqual([]);
    expect(virtual.mappings).toEqual([]);
    expect(virtual.snapshot.getText(0, virtual.snapshot.getLength())).toBe(
      "export default 1;\n// type surface",
    );
    expect(load).toHaveBeenCalledWith(core);
    expect(compileModule).toHaveBeenCalledWith(
      "<p/>\n",
      expect.any(String),
      expect.objectContaining({
        strict: true,
        typeCheck: true,
        targets: lookup,
      }),
    );
    expect(typeSurface).toHaveBeenCalledWith("export default 1;");
  });

  it("keeps the absent-load pending text byte-identical", () => {
    expect(compile("angular-template").diagnostics[0]?.message).toBe(
      "the angular host is not wired into @mxlang/typescript-plugin yet (phase 2)",
    );
  });

  it("reports the removed tree target through the tooling policy wrapper", () => {
    expect(compile("tree").policyDiagnostics[0]?.message).toBe(
      'mx.target "tree" was removed (decision 204); a consumer that reads the tree calls lowerSource from @mxlang/core',
    );
  });
});

describe("registered file pipelines", () => {
  it("projects an Angular tag by its template pipeline, even when the target's host name differs", () => {
    const lookup = builtinLookup();
    const original = lookup.target;
    const descriptor = original("angular-template");
    if (!descriptor?.host) throw new Error("missing template descriptor");
    const fake: TargetDescriptor = {
      ...descriptor,
      host: { ...descriptor.host, name: "not-angular" },
    };
    vi.spyOn(lookup, "target").mockImplementation((name) =>
      name === descriptor.name ? fake : original(name),
    );
    const file = join(
      import.meta.dirname,
      "../../tsc/src/fixtures/ng-diag-tag-import/tags/user-card.mx",
    );
    const source = readFileSync(file, "utf8");
    const plugin = createMxLanguagePlugin(ts);
    const virtual = plugin.createVirtualCode?.(
      file,
      "mx",
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );
    expect(plugin.getCompileDiagnostics(file)).toEqual([]);
    expect(virtual?.id).toBe("angular-tag");
    expect(virtual?.mappings.length).toBeGreaterThan(0);
    if (!virtual) throw new Error("missing tag projection");
    expect(plugin.typescript?.getServiceScript(virtual)?.extension).toBe(".ts");
  });

  it("routes each registered suffix before page policy, including mixed casing", () => {
    const plugins = [
      ...createConfiguredLanguagePlugins(ts, false),
      createAmxLanguagePlugin(ts),
    ];
    for (const kind of builtinFileKinds) {
      for (const suffix of [
        `${kind.segment}.mx`,
        `${kind.segment.toUpperCase()}.MX`,
      ]) {
        const fileName = `/app/component.${suffix}`;
        const ids = plugins
          .map((plugin) => plugin.getLanguageId?.(fileName))
          .filter(Boolean);
        expect(ids).toEqual([kind.languageIds?.[0] ?? kind.diagnosticSource]);
      }
    }
  });
});
