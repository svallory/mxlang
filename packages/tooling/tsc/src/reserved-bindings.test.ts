import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { expect, it } from "vitest";
import { runInProcess } from "./in-process.ts";

it("prints one 1-based position for a reserved binding", () => {
  const dir = mkdtempSync(join(tmpdir(), "mx-reservation-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ mx: { host: "html" } }),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          noEmit: true,
          skipLibCheck: true,
          types: [],
          module: "ESNext",
          moduleResolution: "Bundler",
        },
        files: ["reserved.mx"],
      }),
    );
    writeFileSync(join(dir, "reserved.mx"), "\n<const/__mxX=1/>");
    const result = runInProcess(["--noEmit", "-p", "tsconfig.json"], dir);
    expect(result.status).toBe(1);
    const output = stripVTControlCharacters(result.stdout + result.stderr);
    expect(output).toContain(
      'reserved.mx(2,8): error TS80001: Identifiers starting with "__mx" are reserved for generated code; rename "__mxX".',
    );
    expect(output.match(/Identifiers starting with/g)).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
