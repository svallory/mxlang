import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  clearMxConfigCache,
  clearScanCache,
  findMxConfig,
  scanCached,
} from "@mxlang/core";
import { afterEach, expect, it } from "vitest";
import { builtinLookup, resolveTargetPolicyDetailed } from "./index.ts";

/**
 * One file serves the whole project: the registry's resolution (which the
 * language server, the TypeScript plugin, `mx-tsc` and the Vite plugin all
 * call) and core's tag scan read the project directory's config for a file
 * however deep it sits, and never a config in a subdirectory.
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
  clearMxConfigCache();
  clearScanCache();
});

it("resolves the project's config for a nested file, ignoring a subdirectory's", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mx-config-agree-")));
  roots.push(root);
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "app" }),
    "mx.config.json": `{ "host": "react", "tags": "./ui" }`,
    "src/mx.config.json": `{ "host": "html", "tags": "./other" }`,
    "ui/card.mx": "<div/>\n",
    "other/badge.mx": "<span/>\n",
    "src/App.mx": "",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const file = join(root, "src/App.mx");
  expect(findMxConfig(dirname(file))?.file).toBe(join(root, "mx.config.json"));
  const { policy, diagnostics } = resolveTargetPolicyDetailed(file);
  expect({ host: policy.host, diagnostics }).toEqual({
    host: "react",
    diagnostics: [],
  });
  expect([
    ...scanCached(file, { targets: builtinLookup() }).tags.keys(),
  ]).toEqual(["card"]);
});
