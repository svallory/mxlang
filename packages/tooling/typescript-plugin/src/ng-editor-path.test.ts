import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { angularDiagnostics } from "./index.ts";
import { createNgMxLanguagePlugin } from "./language.ts";
import {
  createNgDiagnosticsService,
  type NgDiagnosticsService,
} from "./ng-diagnostics.ts";

// The editor path end to end: language plugin compile -> debounce -> real
// worker process -> mapped tsserver diagnostics. No fakes.
const PROJECT = path.resolve(import.meta.dirname, "../fixtures/ng-project");
const WORKER = path.resolve(import.meta.dirname, "ng-worker.ts");

const component = (expr: string) =>
  [
    'import { Component } from "@angular/core";',
    "@Component({",
    '  selector: "app-x",',
    "  standalone: true,",
    `  template: <p>\${${expr}}</p>,`,
    "})",
    "export class XComponent { user = { name: 'a' }; }",
  ].join("\n");

let service: NgDiagnosticsService | undefined;
afterEach(() => service?.dispose());

async function editorDiagnostics(source: string, project = PROJECT) {
  const fileName = path.join(project, "x.component.ng.mx");
  let refreshed: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    refreshed = resolve;
  });
  service = createNgDiagnosticsService({
    workerPath: WORKER,
    refresh: () => refreshed(),
  });
  const plugin = createNgMxLanguagePlugin(ts, {
    onCompiled: (entry) => service?.notifyCompiled(entry),
  });
  plugin.createVirtualCode?.(
    fileName,
    "ngmx",
    ts.ScriptSnapshot.fromString(source),
    // biome-ignore lint/suspicious/noExplicitAny: Volar's codegen context is unused here
    undefined as any,
  );
  await done; // a refresh: the worker answered
  return angularDiagnostics(ts, service, fileName);
}

describe("Angular template diagnostics through the plugin path", () => {
  it("a known-bad .ng.mx yields an Angular diagnostic (silent-zero guard)", async () => {
    const source = component("user.nmae");
    const found = await editorDiagnostics(source);
    expect(found.length).toBeGreaterThanOrEqual(1);
    const [d] = found;
    expect(d?.source).toBe("angular");
    expect(d?.code).toBe(2339);
    expect(d?.start).toBe(source.indexOf("user.nmae"));
  }, 60_000);

  it("a missing compiler-cli shows one message and does not crash", async () => {
    // A project dir no node_modules above it can satisfy: the OS tmp dir.
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(path.join(tmpdir(), "mx-nocli-"));
    try {
      writeFileSync(path.join(dir, "package.json"), "{}");
      const found = await editorDiagnostics(component("user.nmae"), dir);
      expect(found).toHaveLength(1);
      expect(found[0]?.messageText).toMatch(/compiler-cli/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
