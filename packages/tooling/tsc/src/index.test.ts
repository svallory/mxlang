import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { consumeAstroFlag, resolveTscPath } from "./index.ts";
import {
  fixtures,
  mxTsc,
  run,
  runSplit,
  SPAWN_TIMEOUT_MS,
} from "./test-support.ts";

describe("mx-tsc", () => {
  // Every spawn below blocks this worker's thread, and consecutive
  // synchronous tests never return to the event loop. Past a minute of that
  // vitest's own worker RPC times out (`Timeout calling "onTaskUpdate"`) and
  // fails a run whose tests all passed, so each test hands the loop back.
  afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

  it("has a built entry point to exercise", () => {
    expect(existsSync(mxTsc)).toBe(true);
  });

  it("resolves TypeScript's own tsc entry point", () => {
    expect(resolveTscPath()).toMatch(/typescript[/\\]lib[/\\]tsc\.js$/);
  });

  it("consumes --astro before TypeScript sees the command line", () => {
    const argv = ["node", "mx-tsc", "--noEmit", "--astro", "--astro"];

    expect(consumeAstroFlag(argv)).toBe(true);
    expect(argv).toEqual(["node", "mx-tsc", "--noEmit"]);
    expect(consumeAstroFlag(argv)).toBe(false);
  });

  it(
    "type-checks a valid .solid.mx and its importer with --noEmit",
    () => {
      const result = run(mxTsc, ["--noEmit", "-p", join(fixtures, "passing")]);

      expect(result.output).toBe("");
      expect(result.status).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports a type error inside an MX region at its own position",
    () => {
      const result = run(mxTsc, ["--noEmit", "-p", join(fixtures, "failing")]);

      expect(result.status).not.toBe(0);
      // The error is inside the `.solid.mx` file itself, not the importer, and
      // lands on the offending argument rather than the region's opening tag.
      expect(result.output).toContain("Widget.solid.mx(7,32)");
      expect(result.output).toContain("error TS2345");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports a type error in a whole-file MX static block",
    () => {
      const result = run(mxTsc, [
        "--noEmit",
        "-p",
        join(fixtures, "hoisted-failing"),
      ]);

      expect(result.status).not.toBe(0);
      // Line 2, column 14 is `bogus` in the source `.mx` file: the diagnostic
      // is reported against the author's own `static` line, not against the
      // generated module's line numbering.
      expect(result.output).toContain("StaticError.mx(2,14): error TS2322");
      expect(result.output).toContain(
        "Type 'string' is not assignable to type 'number'",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports a wrong prop passed to a component at the attribute, and a missing required prop at the tag name",
    () => {
      const result = run(mxTsc, [
        "--noEmit",
        "-p",
        join(fixtures, "wrong-prop-failing"),
      ]);

      expect(result.status).not.toBe(0);
      // `<Card title=1/>`: the excess-property/type error lands on `title`
      // itself, not on the opening tag or the whole call.
      expect(result.output).toContain("WrongType.mx(5,7): error TS2322");
      expect(result.output).toContain(
        "Type 'number' is not assignable to type 'string'",
      );
      // `<Card title="ok" nope="x"/>`: the unknown-prop error lands on `nope`.
      expect(result.output).toContain("ExcessProp.mx(5,18): error TS2353");
      expect(result.output).toContain("'nope' does not exist in type 'Input'");
      // `<Card/>` with no attrs at all: with nothing to map to the missing
      // property, the diagnostic falls back to the opening tag name.
      expect(result.output).toContain("MissingProp.mx(5,2): error TS2345");
      expect(result.output).toContain(
        "Property 'title' is missing in type '{}' but required in type 'Input'",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports only the real compile error when importers use a broken .mx every way (ts2306-cascade)",
    () => {
      const result = run(mxTsc, [
        "--noEmit",
        "-p",
        join(fixtures, "compile-error-importer"),
      ]);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("Broken.mx(4,1): error TS80001");
      expect(result.output).not.toMatch(/TS2306|TS2305|TS2614|TS7016|TS2307/);
      expect(result.output.match(/error TS/g)).toHaveLength(1);
      // The real error comes first.
      expect(result.output.indexOf("TS80001")).toBeLessThan(
        result.output.search(/error TS(?!80001)/) === -1
          ? Number.POSITIVE_INFINITY
          : result.output.search(/error TS(?!80001)/),
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports stored MX compile failures and exits non-zero",
    () => {
      const result = run(mxTsc, [
        "--noEmit",
        "-p",
        join(fixtures, "compile-error-failing"),
      ]);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("Broken.mx(3,1): error TS80001");
      expect(result.output).toContain('Missing ending "div" tag');
      expect(result.output).toContain("Repeated.mx(3,28): error TS80001");
      expect(result.output).toContain("may appear at most once");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports a whole-file Solid .mx compile error at its own line and column (decision 115)",
    () => {
      // Proves compileSolidUnit's map/mappings are wired correctly through
      // the TS plugin's virtual code (the same route `mx-tsc` uses):
      // before decision 115's wiring, this host wasn't reachable for a
      // whole-file `.mx` at all through the real entry point.
      const result = run(mxTsc, [
        "--noEmit",
        "-p",
        join(fixtures, "whole-file-solid-failing"),
      ]);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("Unclosed.mx(3,1): error TS80001");
      expect(result.output).toContain('Missing ending "div" tag');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "type-checks a whole-file Solid .mx component's ordinary props at the caller (solid-whole-file-prop-typing)",
    () => {
      // `compileSolidUnit` emits `export interface Input` and annotates
      // `function Card(input: Input)`, the same shape `@mxlang/preact` and
      // `@mxlang/html` have, so a caller's props are a JSX props check.
      // Before this, the emitted `function Card(input)` was implicitly `any`
      // and `<Card title=1/>` against `title: string` had zero diagnostics.
      const result = run(mxTsc, [
        "--noEmit",
        "-p",
        join(fixtures, "whole-file-solid-typed-props-failing"),
      ]);

      expect(result.status).not.toBe(0);
      // `<Card title=1/>`: the attribute name is the diagnostic position.
      expect(result.output).toContain("WrongProp.mx(5,7): error TS2322");
      expect(result.output).toContain(
        "Type 'number' is not assignable to type 'string'",
      );
      // `<Card/>`: the required prop is missing (reported on the tag).
      expect(result.output).toContain("MissingRequired.mx(5,");
      expect(result.output).toContain("error TS2741");
      // An optional prop is still type-checked when given.
      expect(result.output).toContain("WrongOptional.mx(5,");
      expect(result.output).toContain(
        "Type 'string' is not assignable to type 'number'",
      );
      // AttrTag props keep their `satisfies` check.
      expect(result.output).toContain("WrongAttrTag.mx(5,");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "accepts correct calls to a whole-file Solid .mx component (required, optional, AttrTag, no Input)",
    () => {
      const result = run(mxTsc, [
        "--noEmit",
        "-p",
        join(fixtures, "whole-file-solid-typed-props-passing"),
      ]);

      expect(result.output).toBe("");
      expect(result.status).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports a compile error raised inside a tag template against the template file, not the caller",
    () => {
      const result = run(mxTsc, [
        "--noEmit",
        "-p",
        join(fixtures, "template-error-failing"),
      ]);

      expect(result.status).not.toBe(0);
      // `tags/broken.mx`'s own orphan `<else>` (line 3, column 1) is reported
      // against the template file itself — spec §2's third position rule,
      // matching the language server's behavior — not against `page.mx`,
      // which only calls it.
      expect(result.output).toContain("broken.mx(3,1): error TS80001");
      expect(result.output).toContain(
        // Paths print relative to the process's working directory.
        `\`<else>\` without a preceding \`<if>\`\n${relative(process.cwd(), join(fixtures, "template-error-failing", "src", "page.mx"))}(1,1)`,
      );
      // `page.mx` still gets a pointer diagnostic naming the template *and*
      // its exact position, so a broken template a build's overlay never
      // opened is still findable from the caller's own diagnostic alone.
      expect(result.output).toMatch(/page\.mx\(1,1\): error TS80001/);
      expect(result.output).toContain("(in ");
      expect(result.output).toContain("tags/broken.mx:3:1)");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports stored compile warnings without making the run fail",
    () => {
      const result = runSplit(mxTsc, [
        "--noEmit",
        "-p",
        join(fixtures, "compile-warning"),
      ]);

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Page.mx(3,2): warning TS80002");
      expect(result.stderr).toContain("attribute-tag shape inferred");
    },
    SPAWN_TIMEOUT_MS,
  );
});
