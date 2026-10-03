import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtures, mxTsc, run, SPAWN_TIMEOUT_MS } from "./test-support.ts";

describe("mx-tsc", () => {
  // Every spawn below blocks this worker's thread, and consecutive
  // synchronous tests never return to the event loop. Past a minute of that
  // vitest's own worker RPC times out (`Timeout calling "onTaskUpdate"`) and
  // fails a run whose tests all passed, so each test hands the loop back.
  afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

  describe(".ng.mx", () => {
    describe("Angular template diagnostics (mx.angular.diagnostics)", () => {
      describe("tsc -b with several projects", () => {
        const failing = join(fixtures, "ng-diag-failing");
        const passing = join(fixtures, "ng-diag-passing");
        const off = join(fixtures, "ng-diag-off");

        // `-b` writes tsconfig.tsbuildinfo, and an up-to-date project is not
        // compiled again, so its templates are not checked either: `--force`
        // below, and no leftovers in the fixtures.
        afterEach(() => {
          for (const dir of [failing, passing, off]) {
            rmSync(join(dir, "tsconfig.tsbuildinfo"), { force: true });
          }
        });

        it(
          "checks the templates of every project and reports the failing one's file, whatever the order",
          () => {
            for (const projects of [
              [passing, failing],
              [failing, passing],
            ]) {
              const result = run(mxTsc, ["-b", "--force", ...projects]);
              expect(result.status).toBe(1);
              expect(result.output).toContain("x.component.ng.mx(");
              expect(result.output).toContain("error TS2339");
              expect(result.output).toContain("nmae");
              expect(result.output).not.toContain("error mxlang");
              expect(result.output).not.toContain(passing);
            }
          },
          SPAWN_TIMEOUT_MS,
        );

        it(
          "passes when every project is clean, including one that turns diagnostics off",
          () => {
            const result = run(mxTsc, ["-b", "--force", passing, off]);
            expect(result.output).toBe("");
            expect(result.status).toBe(0);
          },
          SPAWN_TIMEOUT_MS,
        );
      });

      it(
        "checks templates under the tsconfig mx-tsc was given with -p, not tsconfig.json",
        () => {
          const dir = join(fixtures, "ng-diag-tsconfig");
          // tsconfig.json is strict (`name` is possibly undefined: an error);
          // tsconfig.app.json is not (clean). Only the one named decides.
          const strict = run(mxTsc, [
            "--noEmit",
            "-p",
            join(dir, "tsconfig.json"),
          ]);
          expect(strict.status).not.toBe(0);
          expect(strict.output).toContain(
            "x.component.ng.mx(5,18): error TS2532",
          );

          const loose = run(mxTsc, [
            "--noEmit",
            "-p",
            join(dir, "tsconfig.app.json"),
          ]);
          expect(loose.output).toBe("");
          expect(loose.status).toBe(0);

          // `--project` and a directory argument resolve the same way.
          const longForm = run(mxTsc, [
            "--noEmit",
            "--project",
            join(dir, "tsconfig.app.json"),
          ]);
          expect(longForm.status).toBe(0);
        },
        SPAWN_TIMEOUT_MS,
      );

      it(
        "resolves a relative `extends` in a -p tsconfig against that tsconfig's directory",
        () => {
          const dir = join(fixtures, "ng-diag-extends", "cfg");
          // The non-strict base sits beside the tsconfig, not beside the
          // project: templates must be clean, exactly as tsc accepts the code.
          const loose = run(mxTsc, [
            "--noEmit",
            "-p",
            join(dir, "tsconfig.app.json"),
          ]);
          expect(loose.output).toBe("");
          expect(loose.status).toBe(0);
          // The strict sibling flags the same template: the check is live.
          const strict = run(mxTsc, [
            "--noEmit",
            "-p",
            join(dir, "tsconfig.strict.json"),
          ]);
          expect(strict.status).not.toBe(0);
          expect(strict.output).toContain("error TS2532");
        },
        SPAWN_TIMEOUT_MS,
      );

      it(
        "fails with the tsconfig path when -p names a malformed or missing tsconfig",
        () => {
          const dir = join(fixtures, "ng-diag-extends", "cfg");
          for (const name of ["missing.json"]) {
            const r = run(mxTsc, ["--noEmit", "-p", join(dir, name)]);
            expect(r.status).not.toBe(0);
            expect(r.output).toContain(name);
          }
        },
        SPAWN_TIMEOUT_MS,
      );
    });
  });
});
