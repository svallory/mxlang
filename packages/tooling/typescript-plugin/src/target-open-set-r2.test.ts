import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clearScanCache, isTranslateError, TranslateError } from "@mxlang/core";
import * as registry from "@mxlang/target-registry";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import { foreignTemplateError } from "./language.ts";
import { createMxLanguagePlugin, MX_LANGUAGE_ID } from "./mx-language.ts";

const dirs: string[] = [];
function project(manifest: object, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mx-r2-tool-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  for (const [name, source] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  }
  return join(dir, "page.mx");
}
function compile(file: string, source: string) {
  const plugin = createMxLanguagePlugin(ts);
  const code = plugin.createVirtualCode!(
    file,
    MX_LANGUAGE_ID,
    ts.ScriptSnapshot.fromString(source),
    { getAssociatedScript: () => undefined },
  )!;
  return {
    code: code.snapshot.getText(0, code.snapshot.getLength()),
    diagnostics: plugin.getCompileDiagnostics(file),
    policy: registry.resolveHostPolicy(file),
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  clearScanCache();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

it("keeps data-only tool policy and generated renderer identical to base HTML", () => {
  const source = "<div>Hello</div>";
  const base = compile(project({}), source);
  const data = compile(
    project({ dependencies: { "@mxlang/data": "*" } }),
    source,
  );
  expect(data.policy).toEqual(base.policy);
  expect(data.code).toBe(base.code);
  expect(data.diagnostics).toEqual(base.diagnostics);
  expect(data.code).toContain("let out");
});

it("excludes restricted tags when a tool target has no host filter key, keeping unrestricted tags", () => {
  vi.spyOn(registry, "hostFilterKey").mockReturnValue(undefined);
  const file = project(
    { mx: { tags: [{ dir: "extra", hosts: ["html"] }] } },
    {
      "extra/thing.mx": "<div/>",
      "tags/shared.mx": "<div/>",
    },
  );
  expect(compile(file, "<shared/>").diagnostics).toEqual([]);
  const restricted = compile(file, "<thing/>");
  expect(
    restricted.diagnostics.some((d) =>
      d.message.includes("Unable to find entry point for custom tag `<thing>`"),
    ),
  ).toBe(true);
  expect(restricted.code).not.toContain("./extra/thing.mx");
});

it("routes an actual second core copy's error to both callee and caller", async () => {
  const file = project({});
  const dir = dirname(file);
  const core = fileURLToPath(
    new URL("../../../core/src/core.ts", import.meta.url),
  );
  execFileSync(
    "bun",
    [
      "build",
      core,
      "--outfile",
      join(dir, "foreign-core.mjs"),
      "--target",
      "node",
      "--format",
      "esm",
      "--external",
      "@marko/compiler",
    ],
    { stdio: "pipe" },
  );
  const foreign = (await import(
    /* @vite-ignore */ pathToFileURL(join(dir, "foreign-core.mjs")).href
  )) as { TranslateError: typeof TranslateError };
  expect(foreign.TranslateError).not.toBe(TranslateError);
  const callee = join(dir, "callee.mx");
  const error = new foreign.TranslateError("bad template", 2, 3, callee);
  expect(error instanceof TranslateError).toBe(false);
  expect(isTranslateError(error)).toBe(true);
  const routed = foreignTemplateError(
    error,
    file,
    "<callee/>",
    () => "first\nsecond",
  );
  expect(routed?.templateDiagnostic).toMatchObject({
    fileName: callee,
    message: "bad template",
    offset: 9,
    category: "error",
  });
  expect(routed?.callerDiagnostic).toMatchObject({
    fileName: file,
    message: `bad template (in ${callee}:2:4)`,
    offset: 0,
    category: "error",
  });
});
