import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { missingRuntimeEntries } from "./pack-hygiene.ts";

it("detects missing main, conditional exports and bin JS artifacts without requiring declarations", () => {
  const dir = mkdtempSync(join(tmpdir(), "mx-artifact-check-"));
  try {
    const pkg = {
      name: "@test/artifacts",
      main: "dist/index.js",
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./extra": "./dist/extra.mjs",
      },
      bin: { command: "dist/cli.cjs" },
    };
    expect(missingRuntimeEntries(dir, pkg)).toEqual([
      "dist/index.js",
      "dist/cli.cjs",
      "dist/extra.mjs",
    ]);
    mkdirSync(join(dir, "dist"));
    for (const file of ["index.js", "cli.cjs", "extra.mjs"])
      writeFileSync(join(dir, "dist", file), "");
    expect(missingRuntimeEntries(dir, pkg)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
