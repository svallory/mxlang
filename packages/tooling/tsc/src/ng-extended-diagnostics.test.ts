import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runInProcess } from "./in-process.ts";
import { fixtures, SPAWN_TIMEOUT_MS } from "./test-support.ts";

/**
 * NG8103 (`*ngIf` used without `NgIf`/`CommonModule` imported; audit cases a21
 * and a25) follows Angular's own `extendedDiagnostics` model: a warning at the
 * `.ng.mx` position of the directive by default, promoted, demoted or hidden
 * by `angularCompilerOptions.extendedDiagnostics` in the tsconfig. ngtsc
 * applies the category (check name `missingControlFlowDirective`); `mx-tsc`
 * only has to pass the project's options through and not override them.
 * One fixture project, several tsconfigs, picked with `-p <file>`.
 */
const dir = join(fixtures, "ng-diag-ngif");

const MESSAGE =
  "NG8103: The `*ngIf` directive was used in the template, but neither the `NgIf` directive nor the `CommonModule` was imported.";
// Line 5, column 19: `ngIf`, after the structural `*`, in the template.
const FILE = "src/x.component.ng.mx(";
const POSITION = "src/x.component.ng.mx(5,19)";

/**
 * The run's output as lines, each cut to start at the fixture's `src/x.component.ng.mx(` path (tsc prints
 * it relative to the cwd, which differs between runners). Every line the run
 * prints is kept, so an unexpected extra diagnostic fails the assert too.
 */
function check(tsconfig: string): { status: number; lines: string[] } {
  const result = runInProcess(["--noEmit", "-p", tsconfig], dir);
  const text = stripVTControlCharacters(result.stdout + result.stderr);
  return {
    status: result.status,
    lines: text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.slice(Math.max(line.indexOf(FILE), 0))),
  };
}

/** The one NG8103 line a run prints, cut to the length of `expected` (the rest is Angular's advice text). */
function onlyLine(lines: string[], expected: string): string {
  expect(lines).toHaveLength(1);
  return (lines[0] ?? "").slice(0, expected.length);
}

describe("NG8103 extendedDiagnostics", () => {
  it(
    "a25: prints NG8103 at ngFor (5,22), not the structural *",
    () => {
      const result = runInProcess(
        ["--noEmit", "-p", "tsconfig.json"],
        join(fixtures, "ng-diag-ngfor"),
      );
      const text = stripVTControlCharacters(result.stdout + result.stderr);
      expect(text).toContain(
        "x.component.ng.mx(5,22): warning TS-998103: NG8103: The `*ngFor` directive",
      );
      expect(text).not.toContain("approximate location");
      expect(result.status).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );
  afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

  it(
    "is a warning at the .ng.mx position of the directive by default, exit 0",
    () => {
      const { status, lines } = check("tsconfig.json");
      expect(
        onlyLine(lines, `${POSITION}: warning TS-998103: ${MESSAGE}`),
      ).toBe(`${POSITION}: warning TS-998103: ${MESSAGE}`);
      expect(status).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'checks.missingControlFlowDirective: "error" prints an error and exits non-zero',
    () => {
      const { status, lines } = check("tsconfig.check-error.json");
      expect(onlyLine(lines, `${POSITION}: error TS-998103: ${MESSAGE}`)).toBe(
        `${POSITION}: error TS-998103: ${MESSAGE}`,
      );
      expect(status).not.toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'checks.missingControlFlowDirective: "suppress" prints nothing and exits 0',
    () => {
      expect(check("tsconfig.check-suppress.json")).toEqual({
        status: 0,
        lines: [],
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'defaultCategory: "error" promotes it too',
    () => {
      const { status, lines } = check("tsconfig.default-error.json");
      expect(onlyLine(lines, `${POSITION}: error TS-998103: ${MESSAGE}`)).toBe(
        `${POSITION}: error TS-998103: ${MESSAGE}`,
      );
      expect(status).not.toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "a per-check setting overrides defaultCategory",
    () => {
      const { status, lines } = check(
        "tsconfig.default-error-check-warning.json",
      );
      expect(
        onlyLine(lines, `${POSITION}: warning TS-998103: ${MESSAGE}`),
      ).toBe(`${POSITION}: warning TS-998103: ${MESSAGE}`);
      expect(status).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'defaultCategory: "suppress" hides it',
    () => {
      expect(check("tsconfig.default-suppress.json")).toEqual({
        status: 0,
        lines: [],
      });
    },
    SPAWN_TIMEOUT_MS,
  );
});
