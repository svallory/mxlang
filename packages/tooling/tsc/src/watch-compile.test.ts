import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MxCompileDiagnostic,
  MxDiagnosticLanguagePlugin,
} from "@mxlang/typescript-plugin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  currentCompileDiagnostics,
  type PluginGeneration,
  trackGeneration,
} from "./watch-compile.ts";

/**
 * A stand-in for a language plugin: a per-file diagnostics map, which a
 * `compile` call replaces entry by entry, exactly as the real ones do.
 */
function fakePlugin() {
  const stored = new Map<string, MxCompileDiagnostic[]>();
  const plugin = {
    createVirtualCode: (fileName: string) => {
      void fileName;
      return undefined;
    },
    getCompileDiagnostics: (fileName?: string) =>
      fileName === undefined
        ? [...stored.values()].flat()
        : (stored.get(fileName) ?? []),
  } as unknown as MxDiagnosticLanguagePlugin;
  return { plugin, stored };
}

let dir: string;
let files: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mx-tsc-watch-compile-"));
  files = ["a.mx", "b.mx", "c.mx"].map((name) => join(dir, name));
  for (const file of files) writeFileSync(file, "<div></div>\n");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const diagnostic = (
  fileName: string,
  message: string,
): MxCompileDiagnostic => ({
  fileName,
  message,
  offset: 0,
  source: "x",
  category: "error",
});

/** A generation whose plugin compiled `compiled`, file to diagnostics. */
function generation(compiled: Record<string, MxCompileDiagnostic[]>) {
  const fake = fakePlugin();
  const tracked = trackGeneration([fake.plugin]);
  for (const [file, diagnostics] of Object.entries(compiled)) {
    fake.stored.set(file, diagnostics);
    fake.plugin.createVirtualCode?.(file, "mx", {} as never, {} as never);
  }
  return tracked;
}

const messages = (list: readonly MxCompileDiagnostic[]) =>
  list.map((d) => d.message);

describe("currentCompileDiagnostics", () => {
  it("reports what the one generation holds, ordered by file", () => {
    const [a, b] = files as [string, string];
    const generations = [
      generation({
        [b]: [diagnostic(b, "b broke")],
        [a]: [diagnostic(a, "a broke")],
      }),
    ];
    expect(messages(currentCompileDiagnostics(generations))).toEqual([
      "a broke",
      "b broke",
    ]);
  });

  it("lets a file the newest generation compiled clean supersede the older error", () => {
    const [a, b] = files as [string, string];
    const generations: PluginGeneration[] = [
      generation({ [a]: [diagnostic(a, "a broke")], [b]: [] }),
      generation({ [a]: [] }),
    ];
    expect(currentCompileDiagnostics(generations)).toEqual([]);
  });

  it("keeps the older generation's error for a file the newest never compiled", () => {
    const [a, b] = files as [string, string];
    const generations: PluginGeneration[] = [
      generation({ [a]: [diagnostic(a, "a broke")] }),
      generation({ [b]: [diagnostic(b, "b broke")] }),
    ];
    expect(messages(currentCompileDiagnostics(generations))).toEqual([
      "a broke",
      "b broke",
    ]);
  });

  it("takes a file's diagnostics from the newest generation that compiled it, not both", () => {
    const [a] = files as [string];
    const generations: PluginGeneration[] = [
      generation({ [a]: [diagnostic(a, "old")] }),
      generation({ [a]: [diagnostic(a, "new")] }),
    ];
    expect(messages(currentCompileDiagnostics(generations))).toEqual(["new"]);
  });

  it("drops a generation every file of which a newer one settled", () => {
    const [a] = files as [string];
    const generations: PluginGeneration[] = [
      generation({ [a]: [diagnostic(a, "old")] }),
      generation({ [a]: [] }),
    ];
    currentCompileDiagnostics(generations);
    expect(generations).toHaveLength(1);
  });

  it("reports an entry a compile stored under another file (a template's)", () => {
    const [a, b] = files as [string, string];
    const fake = fakePlugin();
    const tracked = trackGeneration([fake.plugin]);
    // `a` is compiled; its compile stored an error against `b`.
    fake.stored.set(a, []);
    fake.stored.set(b, [diagnostic(b, "in the template")]);
    fake.plugin.createVirtualCode?.(a, "mx", {} as never, {} as never);
    expect(messages(currentCompileDiagnostics([tracked]))).toEqual([
      "in the template",
    ]);
  });

  it("reports nothing for a file that no longer exists", () => {
    const [a, b] = files as [string, string];
    const generations = [
      generation({
        [a]: [diagnostic(a, "a broke")],
        [b]: [diagnostic(b, "b broke")],
      }),
    ];
    rmSync(a);
    expect(messages(currentCompileDiagnostics(generations))).toEqual([
      "b broke",
    ]);
  });

  it("answers an empty run with nothing", () => {
    expect(currentCompileDiagnostics([])).toEqual([]);
  });
});

describe("trackGeneration", () => {
  it("records every file a plugin is asked to compile and still compiles it", () => {
    const seen: string[] = [];
    const plugin = {
      createVirtualCode: (fileName: string) => {
        seen.push(fileName);
        return { id: "virtual" };
      },
      getCompileDiagnostics: () => [],
    } as unknown as MxDiagnosticLanguagePlugin;
    const tracked = trackGeneration([plugin]);
    const result = plugin.createVirtualCode?.(
      "/x/a.mx",
      "mx",
      {} as never,
      {} as never,
    );
    expect(result).toEqual({ id: "virtual" });
    expect(seen).toEqual(["/x/a.mx"]);
    expect([...tracked.touched]).toEqual(["/x/a.mx"]);
  });

  it("leaves a plugin with no compile entry alone", () => {
    const plugin = {
      getCompileDiagnostics: () => [],
    } as unknown as MxDiagnosticLanguagePlugin;
    expect(() => trackGeneration([plugin])).not.toThrow();
  });
});
