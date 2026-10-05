import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtures, mxTsc, run, SPAWN_TIMEOUT_MS } from "./test-support.ts";

/** The 1-based `(line,column)` mx-tsc prints for `needle`'s first byte. */
function printed(source: string, needle: string): string {
  const before = source.slice(0, source.indexOf(needle)).split("\n");
  return `${before.length},${(before.at(-1) ?? "").length + 1}`;
}

describe("mx-tsc Angular element and attribute diagnostics", () => {
  // See index-ng.test.ts: each spawn blocks the worker, so hand the loop back.
  afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

  it(
    "prints NG8001/NG8002 at the authored element or attribute, not the region start",
    () => {
      const dir = join(fixtures, "ng-diag-positions");
      const source = readFileSync(
        join(dir, "src", "x.component.ng.mx"),
        "utf8",
      );
      const result = run(mxTsc, ["--noEmit", "-p", dir]);
      expect(result.status).not.toBe(0);
      const at = (needle: string, code: string) =>
        `x.component.ng.mx(${printed(source, needle)}): error TS${code}`;

      // An unknown element: the authored tag name (`app-chld`, not the `<`).
      expect(result.output).toContain(at("app-chld", "-998001: 'app-chld'"));
      // An attribute whose name is itself bracket syntax, bound again.
      expect(result.output).toContain(
        at("[value]=title", "-998002: Can't bind to '[value]'"),
      );
      // A camelCase attribute (`labelText=title`, emitted `[labelText]`; a plain
      // lowercase name is `[attr.x]` and has no NG8002, see
      // apps/docs/docs/hosts/angular.md): the
      // authored name.
      expect(result.output).toContain(
        at("labelText=title", "-998002: Can't bind to 'labelText'"),
      );
      // A plain lowercase dynamic attribute on a native element has no
      // property to bind: it is `[attr.title]` over an `@let`, so a type error
      // in its expression is reported once, at the authored expression.
      const typeErrors = result.output.split("error TS2339").length - 1;
      expect(typeErrors).toBe(1);
      expect(result.output).toContain(
        at("title.nmae", "2339: Property 'nmae' does not exist"),
      );
      // A default attribute (`<widget=title>`) has no spelled name: its
      // value is where the diagnostic lands.
      expect(result.output).toContain(
        at("title><case", "-998002: Can't bind to 'value'"),
      );
      expect(result.output).toContain(at('case="a"', "-998001: 'case'"));
      // Not one of them falls back to the region start any more.
      expect(result.output).not.toContain("approximate location");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "no longer splices a hoisted tags/ import into the decorator (TS1206/TS2304)",
    () => {
      const dir = join(fixtures, "ng-diag-tag-import");
      const result = run(mxTsc, ["--noEmit", "-p", dir]);
      const source = readFileSync(
        join(dir, "src", "x.component.ng.mx"),
        "utf8",
      );
      expect(result.status).not.toBe(0);
      expect(result.output).not.toContain("TS1206");
      expect(result.output).not.toContain("TS2304");
      expect(result.output).not.toContain("TS-991010");
      expect(result.output).not.toContain("TS80001");
      expect(result.output).toContain(
        `x.component.ng.mx(${printed(source, "title.nmae")}): error TS2339`,
      );
      expect(result.output).toContain(
        `x.component.ng.mx(${printed(source, "labelText=title")}): error TS-998002`,
      );
      expect(result.output).not.toContain("approximate location");
    },
    SPAWN_TIMEOUT_MS,
  );
});
