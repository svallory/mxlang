import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
    it(
      "type-checks a clean .ng.mx with no diagnostics",
      () => {
        const result = run(mxTsc, [
          "--noEmit",
          "-p",
          join(fixtures, "ng-mx-passing"),
        ]);
        expect(result.output).toBe("");
        expect(result.status).toBe(0);
      },
      SPAWN_TIMEOUT_MS,
    );

    it(
      "reports a class TS error at its .ng.mx line and column, past a lowered region",
      () => {
        const result = run(mxTsc, [
          "--noEmit",
          "-p",
          join(fixtures, "ng-mx-failing"),
        ]);
        expect(result.status).not.toBe(0);
        // Line 7, column 60: `bad` in the class line below the region.
        expect(result.output).toContain(
          "x.component.ng.mx(7,60): error TS2322",
        );
        expect(result.output).not.toContain("not wired");
      },
      SPAWN_TIMEOUT_MS,
    );

    describe("Angular template diagnostics (mx.angular.diagnostics)", () => {
      it(
        "reports a template error at its .ng.mx line and column, and fails the run",
        () => {
          const dir = join(fixtures, "ng-diag-failing");
          const source = readFileSync(
            join(dir, "src", "x.component.ng.mx"),
            "utf8",
          );
          const before = source
            .slice(0, source.indexOf("user.nmae"))
            .split("\n");
          const line = before.length;
          const column = (before.at(-1) ?? "").length + 1;

          const result = run(mxTsc, ["--noEmit", "-p", dir]);
          expect(result.status).not.toBe(0);
          expect(result.output).toContain(
            `x.component.ng.mx(${line},${column}): error TS2339`,
          );
          expect(result.output).toContain("nmae");
        },
        SPAWN_TIMEOUT_MS,
      );

      it(
        "fails with tsc's own message and exit 1 for a command line it rejects",
        () => {
          const result = run(mxTsc, [
            "--noEmit",
            `--project=${join(fixtures, "ng-diag-passing")}`,
          ]);
          expect(result.status).toBe(1);
          expect(result.output).toContain("TS5023");
          expect(result.output).not.toContain("error mxlang");
        },
        SPAWN_TIMEOUT_MS,
      );

      it(
        "passes a clean template with exit 0 and no output",
        () => {
          const result = run(mxTsc, [
            "--noEmit",
            "-p",
            join(fixtures, "ng-diag-passing"),
          ]);
          expect(result.output).toBe("");
          expect(result.status).toBe(0);
        },
        SPAWN_TIMEOUT_MS,
      );

      it(
        'skips template checking when mx.angular.diagnostics is "off"',
        () => {
          const result = run(mxTsc, [
            "--noEmit",
            "-p",
            join(fixtures, "ng-diag-off"),
          ]);
          expect(result.output).toBe("");
          expect(result.status).toBe(0);
        },
        SPAWN_TIMEOUT_MS,
      );

      it(
        "fails once, naming the tsconfig, for a compiler option error (extendedDiagnostics with strictTemplates: false)",
        () => {
          const dir = join(fixtures, "ng-diag-ext");
          const result = run(mxTsc, ["--noEmit", "-p", dir]);
          expect(result.status).not.toBe(0);
          expect(result.output).toContain(join(dir, "tsconfig.json"));
          expect(result.output).toContain("extendedDiagnostics");
          // Two .ng.mx files in the project, one report.
          expect(result.output.split("error mxlang:").length - 1).toBe(1);
        },
        SPAWN_TIMEOUT_MS,
      );

      it(
        "prints a TypeScript option error exactly once (tsc's own; not repeated by the Angular step)",
        () => {
          const result = run(mxTsc, [
            "--noEmit",
            "-p",
            join(fixtures, "ng-diag-jsxopt"),
          ]);
          expect(result.status).not.toBe(0);
          expect(result.output.split("TS5089").length - 1).toBe(1);
          expect(result.output).not.toContain("error mxlang:");
        },
        SPAWN_TIMEOUT_MS,
      );

      describe("without a usable @angular/compiler-cli", () => {
        const created: string[] = [];
        afterEach(() => {
          for (const dir of created.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
          }
        });

        /**
         * A project under the OS temp dir, where no ancestor `node_modules`
         * can supply `@angular/compiler-cli` (the in-repo fixtures would find
         * the workspace's copy by walking up).
         */
        function tmpProject(options: {
          ngMx: boolean;
          angular?: Record<string, unknown>;
          compilerCliVersion?: string;
        }): string {
          const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-tsc-ng-")));
          created.push(dir);
          writeFileSync(
            join(dir, "package.json"),
            JSON.stringify({
              name: "tmp",
              ...(options.angular ? { mx: { angular: options.angular } } : {}),
            }),
          );
          writeFileSync(
            join(dir, "tsconfig.json"),
            readFileSync(
              join(fixtures, "ng-mx-passing", "tsconfig.json"),
              "utf8",
            ),
          );
          mkdirSync(join(dir, "src"));
          // A stub Component keeps the type-check itself independent of
          // Angular: only the template-diagnostics step needs compiler-cli.
          writeFileSync(
            join(dir, "src", "stub.ts"),
            "export function Component(_: object): ClassDecorator {\n  return () => undefined;\n}\n",
          );
          writeFileSync(
            join(dir, "src", options.ngMx ? "x.component.ng.mx" : "plain.ts"),
            options.ngMx
              ? [
                  'import { Component } from "./stub.ts";',
                  "@Component({ selector: 'app-x', template: <p>${n}</p> })",
                  "export class X { n: number = 1; }",
                  "",
                ].join("\n")
              : "export const n: number = 1;\n",
          );
          if (options.compilerCliVersion) {
            const pkgDir = join(
              dir,
              "node_modules",
              "@angular",
              "compiler-cli",
            );
            mkdirSync(pkgDir, { recursive: true });
            writeFileSync(
              join(pkgDir, "package.json"),
              JSON.stringify({
                name: "@angular/compiler-cli",
                version: options.compilerCliVersion,
                main: "index.js",
              }),
            );
            writeFileSync(join(pkgDir, "index.js"), "module.exports = {};\n");
          }
          return dir;
        }

        it(
          "does not touch compiler-cli, and says nothing, when there are no .ng.mx files",
          () => {
            const dir = tmpProject({ ngMx: false });
            const result = run(mxTsc, ["--noEmit", "-p", dir]);
            expect(result.output).toBe("");
            expect(result.status).toBe(0);
          },
          SPAWN_TIMEOUT_MS,
        );

        it(
          "fails with an explicit message when it is missing",
          () => {
            const dir = tmpProject({ ngMx: true });
            const result = run(mxTsc, ["--noEmit", "-p", dir]);
            expect(result.status).not.toBe(0);
            expect(result.output).toContain(
              "@angular/compiler-cli was not found",
            );
            expect(result.output).toContain('"mx.angular.diagnostics": "off"');
            expect(result.output).toContain("1 .ng.mx file");
          },
          SPAWN_TIMEOUT_MS,
        );

        it(
          "fails with an explicit message when its version is out of range",
          () => {
            const dir = tmpProject({
              ngMx: true,
              compilerCliVersion: "21.0.0",
            });
            const result = run(mxTsc, ["--noEmit", "-p", dir]);
            expect(result.status).not.toBe(0);
            expect(result.output).toContain("@angular/compiler-cli 21.0.0");
            expect(result.output).toContain("outside the supported range");
            expect(result.output).toContain('"mx.angular.diagnostics": "off"');
          },
          SPAWN_TIMEOUT_MS,
        );

        it(
          'passes when it is missing but diagnostics are "off"',
          () => {
            const dir = tmpProject({
              ngMx: true,
              angular: { diagnostics: "off" },
            });
            const result = run(mxTsc, ["--noEmit", "-p", dir]);
            expect(result.output).toBe("");
            expect(result.status).toBe(0);
          },
          SPAWN_TIMEOUT_MS,
        );
      });
    });

    it(
      "still reports the not-wired guard for an angular .mx page",
      () => {
        const result = run(mxTsc, [
          "--noEmit",
          "-p",
          join(fixtures, "ng-mx-page-guard"),
        ]);
        expect(result.status).not.toBe(0);
        expect(result.output).toContain(
          "the angular host is not wired into @mxlang/typescript-plugin yet",
        );
      },
      SPAWN_TIMEOUT_MS,
    );
  });
});
