import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { consumeAstroFlag, resolveTscPath } from "./index.ts";

/**
 * Each of these tests spawns a real `tsc`, which takes ~1s alone but well past
 * vitest's 5s default when the whole root suite runs in parallel on a loaded
 * machine. The budget is generous on purpose: a slow machine is not a
 * regression, and a flaky gate is worse than a slow one.
 */
const SPAWN_TIMEOUT_MS = 60_000;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const fixtures = join(here, "fixtures");
const astroStatic = join(repoRoot, "examples", "astro-static");
const preactApp = join(repoRoot, "examples", "preact-app");
const reactApp = join(repoRoot, "examples", "react-app");
const honoApp = join(repoRoot, "examples", "hono-app");

/**
 * `mx-tsc` is a real `tsc` with Volar's program proxy spliced in, so there is
 * no in-process surface to assert against: the thing under test *is* the
 * process's diagnostics and exit code. These tests therefore run the built
 * entry point, which means `bun run build` must have produced `dist/bin.cjs`
 * first — the same fresh-worktree caveat `@mxlang/parser`'s `dist/index.js`
 * carries.
 *
 * `dist/bin.cjs` directly, not `node_modules/.bin/mx-tsc`: bun creates a bin
 * symlink at *install* time and silently skips one whose target does not exist
 * yet. In CI `bun install` always runs before `bun run build`, so that symlink
 * is never created there — which is exactly how this was found (`mx-tsc:
 * command not found`, on a machine where the local link existed from an
 * earlier build). Running the file needs no linking at all.
 *
 * `node`, not bun: `runTsc` reads and re-evaluates TypeScript's own `tsc.js`
 * as CommonJS, which bun's loader does not reproduce faithfully.
 */
const mxTsc = join(repoRoot, "packages", "tooling", "tsc", "dist", "bin.cjs");
const plainTsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");

interface Run {
  status: number;
  output: string;
}

function run(entry: string, args: string[]): Run {
  try {
    const output = execFileSync(process.execPath, [entry, ...args], {
      cwd: here,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (cause) {
    const error = cause as {
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      status: error.status ?? 1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

interface RunSplit {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * `mx-tsc` writes its stored-diagnostic report to stderr (`src/index.ts`'s
 * `process.stderr.write`), independent of exit code. `execFileSync`'s return
 * value only ever carries stdout on a zero exit, so a warning-only run (exit
 * 0, diagnostics on stderr) is invisible to `run()` above — `spawnSync`
 * captures both streams regardless of exit code.
 */
function runSplit(entry: string, args: string[]): RunSplit {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: here,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

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
        "`<else>` without a preceding `<if>`\nfixtures/template-error-failing/src/page.mx(1,1)",
      );
      // `page.mx` still gets a pointer diagnostic naming the template, so a
      // broken template is not silently invisible when only the caller is
      // open.
      expect(result.output).toMatch(/page\.mx\(1,1\): error TS80001/);
      expect(result.output).toContain("(in ");
      expect(result.output).toContain("broken.mx)");
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

  it.each([
    ["html", "attr-tag-html-failing", "(3,9)"],
    ["preact", "attr-tag-preact-failing", "(3,9)"],
    ["solid", "attr-tag-solid-failing", "(3,29)"],
  ])(
    "checks %s attribute-tag values against the callee Input",
    (_host, fixture, tagPosition) => {
      const result = run(mxTsc, ["--noEmit", "-p", join(fixtures, fixture)]);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain(
        `Missing${fixture.includes("solid") ? ".solid" : ""}.mx${tagPosition}`,
      );
      expect(result.output).toContain("Property 'title' is missing");
      expect(result.output).toContain(
        `Wrong${fixture.includes("solid") ? ".solid" : ""}.mx${tagPosition}`,
      );
      expect(result.output).toContain(
        "Type 'number' is not assignable to type 'string'",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    // `<Card><@tab title=1/></Card>`: the wrong attribute type is reported
    // on `title` (its own authored column), not on `tab` (the fallback
    // used only when there is no attribute of its own to blame) —
    // `solid-attr-tag-attr-offset`.
    "reports a solid attribute-tag's wrong value type on the attribute itself, not the tag name",
    () => {
      const result = run(mxTsc, [
        "--noEmit",
        "-p",
        join(fixtures, "attr-tag-solid-failing"),
      ]);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("Wrong.solid.mx(3,33): error TS2322");
      expect(result.output).toContain(
        "Type 'number' is not assignable to type 'string'",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  it.each([
    ["html", "callee-diagnostic-html-failing", "Card.mx(2,14)", "Page.mx"],
    // The `Input` interface line above `broken` gains three characters when
    // printed; the exact column proves the diagnostic is placed against the
    // authored source, not the printed text (solid-mx-tsc-column-against-printed-text).
    [
      "solid",
      "callee-diagnostic-solid-failing",
      "Card.solid.mx(4,14)",
      "Page.solid.mx",
    ],
  ])(
    "reports a %s callee's own type error in the callee, not in the caller that read its Input",
    (_host, fixture, calleePosition, caller) => {
      const result = run(mxTsc, ["--noEmit", "-p", join(fixtures, fixture)]);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain(`${calleePosition}: error TS2322`);
      expect(result.output).toContain(
        "Type 'string' is not assignable to type 'number'",
      );
      expect(result.output).not.toContain(`${caller}(`);
    },
    SPAWN_TIMEOUT_MS,
  );

  it.each([
    ["solid", "renderable-solid-passing"],
    ["preact", "renderable-preact-passing"],
  ])(
    "accepts %s callers of a declared renderable attribute tag",
    (_host, fixture) => {
      const result = run(mxTsc, ["--noEmit", "-p", join(fixtures, fixture)]);

      expect(result.output).toBe("");
      expect(result.status).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  it.each([
    ["solid", "renderable-solid-failing", "Page.solid.mx(6,"],
    ["preact", "renderable-preact-failing", "Page.mx(3,36)"],
  ])(
    "rejects a %s caller that misuses a declared attribute-tag param",
    (_host, fixture, position) => {
      const result = run(mxTsc, ["--noEmit", "-p", join(fixtures, fixture)]);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain(position);
      expect(result.output).toContain(
        "error TS2339: Property 'toUpperCase' does not exist on type 'number'.",
      );
      expect(result.output.match(/error TS/g)).toHaveLength(1);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "catches what plain tsc cannot even see",
    () => {
      const result = run(plainTsc, [
        "--noEmit",
        "-p",
        join(fixtures, "failing"),
      ]);

      // Plain `tsc` never opens the file: it fails at the *import* instead, and
      // so reports nothing about the type error the module actually contains.
      expect(result.output).toContain("error TS2307");
      expect(result.output).not.toContain("TS2345");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "accepts a correctly typed .mx component prop from an Astro file",
    () => {
      const result = run(mxTsc, [
        "--astro",
        "--noEmit",
        "-p",
        join(astroStatic, "typecheck-fixtures", "correct.json"),
      ]);

      expect(result.output).toBe("");
      expect(result.status).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports a wrong .mx component prop in an Astro file",
    () => {
      const result = run(mxTsc, [
        "--astro",
        "--noEmit",
        "-p",
        join(astroStatic, "typecheck-fixtures", "wrong.json"),
      ]);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("wrong-prop.astro(5,7): error TS2322");
      expect(result.output).toContain(
        "Type 'number' is not assignable to type 'string'",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "accepts a correctly typed .mx component prop from a .tsx file",
    () => {
      // The Preact host emits a component module whose body is JSX. Its
      // virtual script kind has to be TSX for TypeScript to parse that at
      // all: as plain TS the `return (<>…)` is a syntax error, which
      // surfaced not as a parse error but as the module appearing to have no
      // exports ("File '…/Counter.mx' is not a module").
      const result = run(mxTsc, [
        "--noEmit",
        "-p",
        join(preactApp, "typecheck-fixtures", "correct.json"),
      ]);

      expect(result.output).toBe("");
      expect(result.status).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports a wrong .mx component prop from a .tsx file",
    () => {
      const result = run(mxTsc, [
        "--noEmit",
        "-p",
        join(preactApp, "typecheck-fixtures", "wrong.json"),
      ]);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("wrong-prop.tsx(5,19): error TS2322");
      expect(result.output).toContain(
        "Type 'number' is not assignable to type 'string'",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "accepts a correctly typed React-host .mx component prop",
    () => {
      const result = run(mxTsc, [
        "--noEmit",
        "-p",
        join(reactApp, "typecheck-fixtures", "correct.json"),
      ]);

      expect(result.output).toBe("");
      expect(result.status).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports a wrong React-host .mx component prop",
    () => {
      const result = run(mxTsc, [
        "--noEmit",
        "-p",
        join(reactApp, "typecheck-fixtures", "wrong.json"),
      ]);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("wrong-prop.tsx(4,19): error TS2322");
      expect(result.output).toContain(
        "Type 'number' is not assignable to type 'string'",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "accepts a correctly typed Hono-host .mx component prop",
    () => {
      const result = run(mxTsc, [
        "--noEmit",
        "-p",
        join(honoApp, "typecheck-fixtures", "correct.json"),
      ]);

      expect(result.output).toBe("");
      expect(result.status).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports a wrong Hono-host .mx component prop",
    () => {
      const result = run(mxTsc, [
        "--noEmit",
        "-p",
        join(honoApp, "typecheck-fixtures", "wrong.json"),
      ]);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("wrong-prop.tsx(4,16): error TS2322");
      expect(result.output).toContain(
        "Type 'number' is not assignable to type 'string'",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "accepts a correctly typed .amx page in Astro mode",
    () => {
      const result = run(mxTsc, [
        "--astro",
        "--noEmit",
        "-p",
        join(astroStatic, "typecheck-fixtures", "amx-correct.json"),
      ]);

      expect(result.output).toBe("");
      expect(result.status).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports .amx prop and interpolation errors at exact source columns",
    () => {
      const result = run(mxTsc, [
        "--astro",
        "--noEmit",
        "-p",
        join(astroStatic, "typecheck-fixtures", "amx-wrong.json"),
      ]);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("amx-wrong.amx(8,7): error TS2322");
      expect(result.output).toContain("amx-wrong.amx(9,27): error TS2345");
      expect(result.output).toContain(
        "Type 'number' is not assignable to type 'string'",
      );
      expect(result.output).toContain(
        "Argument of type 'string' is not assignable to parameter of type 'number'",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports a .amx fence error at its exact source column",
    () => {
      const result = run(mxTsc, [
        "--astro",
        "--noEmit",
        "-p",
        join(astroStatic, "typecheck-fixtures", "amx-fence-wrong.json"),
      ]);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("amx-fence-wrong.amx(2,7): error TS2322");
      expect(result.output).toContain(
        "Type 'string' is not assignable to type 'number'",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "type-checks a template calling a tag discovered with no configuration",
    () => {
      // `mx-tsc` passes no `customTags` to the language plugin, so this
      // project type-checks only if the scan found `tags/stamp.tag.ts` on its
      // own. Removing that directory makes this fixture fail with TS2306
      // ("not a module"), which is what makes it a gate rather than a file
      // that happens to compile.
      const result = run(mxTsc, [
        "--noEmit",
        "-p",
        join(fixtures, "discovered-tag"),
      ]);

      expect(result.output).toBe("");
      expect(result.status).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "type-checks a template calling a discovered *template* tag",
    () => {
      // The unit-model half of the fixture above. `tags/stamp.tag.ts` is a
      // sidecar that expands to IR; `tags/icon.mx` is a template, which
      // compiles to its own module and makes the caller emit an import of it.
      // Zero diagnostics means `mx-tsc` resolved that injected import — the
      // call site is not yet typed against the unit's own `Input` (phase 3),
      // so what this pins is that the import resolves rather than reporting
      // TS2307.
      const result = run(mxTsc, [
        "--noEmit",
        "-p",
        join(fixtures, "discovered-tag"),
      ]);

      expect(result.output).toBe("");
      expect(result.status).toBe(0);

      // That the page really does call the template tag — otherwise this
      // would pass against a fixture someone had quietly emptied.
      const page = join(fixtures, "discovered-tag", "src", "page.mx");
      expect(readFileSync(page, "utf8")).toContain('<icon name="star"/>');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "types a discovered tag's call site against its own Input, and its /var",
    () => {
      // Acceptance C6. The discovered-tag test above pinned only that the
      // injected import *resolves*; this pins that the call is checked
      // against the unit's `export interface Input` through that import, and
      // that a `/var` binding carries the `<return>` value's inferred type.
      const result = run(mxTsc, [
        "--noEmit",
        "-p",
        join(fixtures, "returning-tag-failing"),
      ]);

      expect(result.status).not.toBe(0);
      // Exactly two diagnostics, one per fixture file, and nothing else: a
      // `toContain` pair alone would still pass if a regression added
      // spurious errors at other positions, which is most of what this
      // fixture exists to catch.
      const errors = result.output
        .split("\n")
        .filter((line) => line.includes("): error TS"));
      expect(errors).toHaveLength(2);
      // `<icon size="x"/>` against `Input { size: number }` — the diagnostic
      // lands on the attribute, in the *caller's* file.
      expect(result.output).toContain("WrongProp.mx(5,7): error TS2322");
      expect(result.output).toContain(
        "Type 'string' is not assignable to type 'number'",
      );
      // `<icon/doubled size=8/>` returns `input.size * 2`, so `doubled` is a
      // number. This is why the returning unit's export carries no return
      // annotation: the type is inferred from the `<return>` expression, and
      // an annotation could only widen it.
      expect(result.output).toContain("VarType.mx(6,14): error TS2339");
      expect(result.output).toContain(
        "Property 'toUpperCase' does not exist on type 'number'",
      );
    },
    SPAWN_TIMEOUT_MS,
  );
});
