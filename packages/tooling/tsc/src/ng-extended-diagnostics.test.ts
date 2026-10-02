import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { fixtures, mxTsc, run, SPAWN_TIMEOUT_MS } from "./test-support.ts";

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

function check(tsconfig: string): { status: number; text: string } {
  const result = run(mxTsc, ["--noEmit", "-p", join(dir, tsconfig)]);
  return {
    status: result.status,
    text: stripVTControlCharacters(result.output),
  };
}

/** The first line of the message, up to the end of the sentence naming the directive. */
const MESSAGE =
  "NG8103: The `*ngIf` directive was used in the template, but neither the `NgIf` directive nor the `CommonModule` was imported.";
// Line 5, column 18: the `*ngIf` attribute in `template: <div *ngIf="title">x</div>,`.
const POSITION = "src/x.component.ng.mx(5,18)";

describe("NG8103 extendedDiagnostics", () => {
  afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

  it(
    "is a warning at the .ng.mx position of the directive by default, exit 0",
    () => {
      const { status, text } = check("tsconfig.json");
      expect(text).toContain(`${POSITION}: warning TS-998103: ${MESSAGE}`);
      expect(text).not.toContain("error");
      expect(status).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'checks.missingControlFlowDirective: "error" prints an error and exits non-zero',
    () => {
      const { status, text } = check("tsconfig.check-error.json");
      expect(text).toContain(`${POSITION}: error TS-998103: ${MESSAGE}`);
      expect(text).not.toContain("warning");
      expect(status).not.toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'checks.missingControlFlowDirective: "suppress" prints nothing and exits 0',
    () => {
      expect(check("tsconfig.check-suppress.json")).toEqual({
        status: 0,
        text: "",
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'defaultCategory: "error" promotes it too',
    () => {
      const { status, text } = check("tsconfig.default-error.json");
      expect(text).toContain(`${POSITION}: error TS-998103: ${MESSAGE}`);
      expect(status).not.toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "a per-check setting overrides defaultCategory",
    () => {
      const { status, text } = check(
        "tsconfig.default-error-check-warning.json",
      );
      expect(text).toContain(`${POSITION}: warning TS-998103: ${MESSAGE}`);
      expect(status).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'defaultCategory: "suppress" hides it',
    () => {
      expect(check("tsconfig.default-suppress.json")).toEqual({
        status: 0,
        text: "",
      });
    },
    SPAWN_TIMEOUT_MS,
  );
});
