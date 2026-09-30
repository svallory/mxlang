import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CheckerWorker, createCheckerWorker } from "./worker-client.ts";

// The real worker entry, forked as TypeScript (node strips the types).
const WORKER = path.resolve(import.meta.dirname, "worker-main.ts");
const PROJECT_DIR = path.resolve(import.meta.dirname, "..");
const VIRTUAL = path.join(PROJECT_DIR, "w.component.ts");

const component = (expr: string) =>
  [
    'import { Component } from "@angular/core";',
    `@Component({ selector: "app-w", standalone: true, template: \`<p>${expr}</p>\` })`,
    "export class WComponent { user = { name: 'a' }; }",
  ].join("\n");

const live: CheckerWorker[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const make = (projectDir = PROJECT_DIR, tsconfigPath?: string) => {
  const w = createCheckerWorker({
    projectDir,
    workerPath: WORKER,
    ...(tsconfigPath ? { tsconfigPath } : {}),
  });
  live.push(w);
  return w;
};

describe("the real checker worker", () => {
  it("reports a template error through the process boundary (silent-zero guard)", async () => {
    const out = await make().check(VIRTUAL, component("{{ user.nmae }}"));
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    const ng = out.diagnostics.filter((d) => d.source === "ngtsc");
    expect(ng.length).toBeGreaterThanOrEqual(1);
    expect(ng[0]?.code).toBe(2339);
  });

  it("reports a clean template as ok with no ngtsc records", async () => {
    const out = await make().check(VIRTUAL, component("{{ user.name }}"));
    expect(
      out.kind === "ok" && out.diagnostics.filter((d) => d.source === "ngtsc"),
    ).toEqual([]);
  });

  it("keeps one checker across files and edits (incremental)", async () => {
    const w = make();
    await w.check(VIRTUAL, component("{{ user.name }}"));
    const pid = w.pid();
    const out = await w.check(VIRTUAL, component("{{ user.nmae }}"));
    expect(w.pid()).toBe(pid);
    expect(
      out.kind === "ok" && out.diagnostics.some((d) => d.source === "ngtsc"),
    ).toBe(true);
  });

  it("answers configDiagnostics for a project with an invalid combination", async () => {
    const out = await make().configDiagnostics();
    expect(out.kind).toBe("ok");
  });

  it("reports a missing compiler-cli as unavailable, with the fix in the message", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mx-no-cli-"));
    dirs.push(dir);
    writeFileSync(path.join(dir, "package.json"), "{}");
    const out = await make(dir).check(
      path.join(dir, "a.ts"),
      component("{{ x }}"),
    );
    expect(out).toMatchObject({ kind: "unavailable", reason: "compiler-cli" });
    expect(out.kind === "unavailable" && out.message).toMatch(/compiler-cli/);
  });

  it("reports an unreadable tsconfig as unavailable, not as a clean file", async () => {
    const out = await make(
      PROJECT_DIR,
      path.join(PROJECT_DIR, "no-such-tsconfig.json"),
    ).check(VIRTUAL, component("{{ user.name }}"));
    expect(out).toMatchObject({ kind: "unavailable", reason: "config" });
  });
});

describe("the real checker worker without typescript in the project", () => {
  it("answers with one unavailable outcome that names typescript", async () => {
    // compiler-cli resolves (a fake), typescript does not.
    const dir = mkdtempSync(path.join(tmpdir(), "mx-ngworker-nots-"));
    dirs.push(dir);
    writeFileSync(path.join(dir, "package.json"), "{}");
    const cli = path.join(dir, "node_modules/@angular/compiler-cli");
    mkdirSync(cli, { recursive: true });
    writeFileSync(
      path.join(cli, "package.json"),
      '{"name":"@angular/compiler-cli","version":"22.0.0","main":"index.js"}',
    );
    writeFileSync(
      path.join(cli, "index.js"),
      "module.exports = { NgtscProgram: class {} };",
    );
    const w = make(dir);
    const first = await w.check(path.join(dir, "a.component.ts"), "");
    expect(first.kind).toBe("unavailable");
    if (first.kind !== "unavailable") return;
    expect(first.reason).toBe("compiler-cli");
    expect(first.message).toContain("typescript was not found");
    // One notice per project: a second check reports the same, no restart loop.
    const pid = w.pid();
    const second = await w.check(path.join(dir, "a.component.ts"), "");
    expect(second.kind).toBe("unavailable");
    expect(w.pid()).toBe(pid);
  });
});
