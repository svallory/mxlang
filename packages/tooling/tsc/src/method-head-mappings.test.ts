import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { runInProcess } from "./in-process.ts";

const ROOT = resolve(import.meta.dirname, "../../../..");
const TEMPLATE = [
  "<div>",
  "  <button onClick(e: MissingParameter) {} />",
  '  <button onClick(e: number = "bad") {} />',
  "  <button onClick<T extends MissingConstraint>(e: T) {} />",
  "  <button onClick=function (): MissingReturn { return 1 } />",
  "</div>",
].join("\n");

function check() {
  const dir = mkdtempSync(join(tmpdir(), "mx-method-head-"));
  try {
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ mx: { host: "solid" } }),
    );
    writeFileSync(join(dir, "page.mx"), TEMPLATE);
    writeFileSync(
      join(dir, "Region.solid.mx"),
      `export const Page = (\n${TEMPLATE}\n);`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "preserve",
          jsxImportSource: "@solidjs/web",
          ignoreDeprecations: "6.0",
        },
        include: ["*.mx"],
      }),
    );
    const run = runInProcess([
      "--pretty",
      "false",
      "-p",
      join(dir, "tsconfig.json"),
    ]);
    expect(run.status).not.toBe(0);
    return `${run.stdout}\n${run.stderr}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Solid is the CLI smoke. The plugin's method-head-mappings.test.ts owns the
// per-host projection (whole-file and region); <host>-region.test.ts owns each
// host's region CLI door.
describe("solid mx-tsc printed method heads", () => {
  let output: string;
  beforeAll(() => {
    output = check();
  }, 60_000);

  it.each([false, true])(
    "reports authored line and column (region: %s)",
    (region) => {
      const file = region ? "Region.solid.mx" : "page.mx";
      const shift = region ? 1 : 0;
      const lines = output
        .split("\n")
        .filter((line) => line.includes(`${file}(`));
      for (const [line, column, code, message] of [
        [2, 22, 2304, "MissingParameter"],
        [3, 19, 2322, "Type 'string' is not assignable to type 'number'"],
        [4, 29, 2304, "MissingConstraint"],
        [5, 32, 2304, "MissingReturn"],
      ] as const) {
        // The region generic gap lives in the plugin's host matrix, with
        // one CLI print smoke below.
        if (region && message === "MissingConstraint") continue;
        const diagnostic = lines.find(
          (entry) =>
            entry.includes(
              `${file}(${line + shift},${column}): error TS${code}:`,
            ) && entry.includes(message),
        );
        expect(diagnostic, output).toBeDefined();
        expect(diagnostic).not.toMatch(
          /position approximate|MX-generated code|position unknown/,
        );
      }
    },
  );
  it("known gap, see bead mx-oasj: region generic constraints have an approximate position", () => {
    const lines = output
      .split("\n")
      .filter(
        (line) =>
          line.includes("Region.solid.mx(") &&
          line.includes("MissingConstraint"),
      );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      `Region.solid.mx(5,11): error TS2304: Cannot find name 'MissingConstraint'. (position approximate: generated 4:74)`,
    );
  });
});
