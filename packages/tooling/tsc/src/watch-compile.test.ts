import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MxCompileDiagnostic,
  MxDiagnosticLanguagePlugin,
  TargetPolicyDiagnostic,
} from "@mxlang/typescript-plugin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  currentCompileDiagnostics,
  currentPolicyDiagnostics,
  type PluginGeneration,
  trackGeneration,
} from "./watch-compile.ts";

/**
 * A stand-in for a language plugin: a per-file diagnostics map, which a
 * `compile` call replaces entry by entry, exactly as the real ones do.
 */
function fakePlugin() {
  const stored = new Map<string, MxCompileDiagnostic[]>();
  const policies = new Map<string, TargetPolicyDiagnostic[]>();
  const plugin = {
    getTargetPolicyDiagnostics: (fileName?: string) =>
      fileName === undefined
        ? [...policies.values()].flat()
        : (policies.get(fileName) ?? []),
    createVirtualCode: (fileName: string) => {
      void fileName;
      return undefined;
    },
    getCompileDiagnostics: (fileName?: string) =>
      fileName === undefined
        ? [...stored.values()].flat()
        : (stored.get(fileName) ?? []),
  } as unknown as MxDiagnosticLanguagePlugin;
  return { plugin, stored, policies };
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

  it("keeps the newest generation while it has compiled nothing, and reads its later compile", () => {
    const [a] = files as [string];
    const older = generation({ [a]: [diagnostic(a, "a broke")] });
    // The live plugin set after a rebuild that only removed a root file.
    const fake = fakePlugin();
    const newest = trackGeneration([fake.plugin]);
    const generations: PluginGeneration[] = [older, newest];
    expect(messages(currentCompileDiagnostics(generations))).toEqual([
      "a broke",
    ]);
    expect(generations).toHaveLength(2);

    fake.stored.set(a, []);
    fake.plugin.createVirtualCode?.(a, "mx", {} as never, {} as never);
    expect(currentCompileDiagnostics(generations)).toEqual([]);
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

const policy = (message: string): TargetPolicyDiagnostic =>
  ({
    file: "package.json",
    message,
    severity: "error",
    code: "target-host-mismatch",
    line: 1,
    column: 0,
  }) as TargetPolicyDiagnostic;

/** A generation whose plugin compiled `compiled`, file to its policy diagnostics. */
function policyGeneration(compiled: Record<string, TargetPolicyDiagnostic[]>) {
  const fake = fakePlugin();
  const tracked = trackGeneration([fake.plugin]);
  for (const [file, diagnostics] of Object.entries(compiled)) {
    fake.policies.set(file, diagnostics);
    fake.plugin.createVirtualCode?.(file, "mx", {} as never, {} as never);
  }
  return tracked;
}

const policyMessages = (list: readonly TargetPolicyDiagnostic[]) =>
  list.map((d) => d.message);

describe("currentPolicyDiagnostics", () => {
  it("does not read an older generation for a file a newer one compiled", () => {
    const [a] = files as [string];
    const older = policyGeneration({ [a]: [policy("old")] });
    const newer = policyGeneration({ [a]: [] });
    expect(currentPolicyDiagnostics([older, newer])).toEqual([]);
  });

  it("still reads an older generation for a file no newer one touched", () => {
    const [a, b] = files as [string, string];
    const older = policyGeneration({ [a]: [policy("a-old")] });
    const newer = policyGeneration({ [b]: [policy("b-new")] });
    expect(
      policyMessages(currentPolicyDiagnostics([older, newer])).sort(),
    ).toEqual(["a-old", "b-new"]);
  });

  it("drops the policy of a file that no longer exists", () => {
    const [a, b] = files as [string, string];
    const only = policyGeneration({
      [a]: [policy("gone")],
      [b]: [policy("kept")],
    });
    rmSync(a);
    expect(policyMessages(currentPolicyDiagnostics([only]))).toEqual(["kept"]);
  });

  it("reports one diagnostic that two files share once", () => {
    const [a, b] = files as [string, string];
    const shared = policy("shared");
    const only = policyGeneration({ [a]: [shared], [b]: [{ ...shared }] });
    expect(policyMessages(currentPolicyDiagnostics([only]))).toEqual([
      "shared",
    ]);
  });
});
