import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  astroStatic,
  fixtures,
  honoApp,
  mxTsc,
  plainTsc,
  preactApp,
  reactApp,
  run,
  SPAWN_TIMEOUT_MS,
} from "./test-support.ts";

describe("mx-tsc", () => {
  // Every spawn below blocks this worker's thread, and consecutive
  // synchronous tests never return to the event loop. Past a minute of that
  // vitest's own worker RPC times out (`Timeout calling "onTaskUpdate"`) and
  // fails a run whose tests all passed, so each test hands the loop back.
  afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

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
      // TypeScript colourises its pretty output when FORCE_COLOR reaches the
      // spawned process, so assert on the stripped text.
      const output = stripVTControlCharacters(result.output);
      expect(output).toContain("error TS2307");
      expect(output).not.toContain("TS2345");
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
    "accepts a correctly typed .astro.mx page in Astro mode",
    () => {
      const result = run(mxTsc, [
        "--astro",
        "--noEmit",
        "-p",
        join(astroStatic, "typecheck-fixtures", "astro-mx-correct.json"),
      ]);

      expect(result.output).toBe("");
      expect(result.status).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports .astro.mx prop and interpolation errors at exact source columns",
    () => {
      const result = run(mxTsc, [
        "--astro",
        "--noEmit",
        "-p",
        join(astroStatic, "typecheck-fixtures", "astro-mx-wrong.json"),
      ]);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain(
        "astro-mx-wrong.astro.mx(8,7): error TS2322",
      );
      expect(result.output).toContain(
        "astro-mx-wrong.astro.mx(9,27): error TS2345",
      );
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
    "reports a .astro.mx fence error at its exact source column",
    () => {
      const result = run(mxTsc, [
        "--astro",
        "--noEmit",
        "-p",
        join(astroStatic, "typecheck-fixtures", "astro-mx-fence-wrong.json"),
      ]);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain(
        "astro-mx-fence-wrong.astro.mx(2,7): error TS2322",
      );
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

  it(
    "types a /var on an imported .mx call as the callee's <return> value, positioned at the misuse",
    () => {
      const result = run(mxTsc, [
        "--noEmit",
        "-p",
        join(fixtures, "imported-return-var-failing"),
      ]);

      expect(result.status).not.toBe(0);
      const errors = result.output
        .split("\n")
        .filter((line) => line.includes("): error TS"));
      // `<Counter/n start=1/>` returns `input.start + 1`, so `n` is a number:
      // the only diagnostic is the string method read on it, at its authored
      // position. A `/var` rejected by core would show TS80001 here instead.
      expect(errors).toHaveLength(1);
      expect(result.output).toContain("VarType.mx(8,8): error TS2339");
      expect(result.output).toContain(
        "Property 'toUpperCase' does not exist on type 'number'",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "types a /var on a dynamic tag from its callee's render, and prints a unit's default export as its signature",
    () => {
      const result = run(mxTsc, [
        "--noEmit",
        "-p",
        join(fixtures, "dynamic-return-var-failing"),
      ]);

      expect(result.status).not.toBe(0);
      const errors = result.output
        .split("\n")
        .filter((line) => line.includes("): error TS"));
      expect(errors).toHaveLength(3);
      // `<${input.tag}/n start=1/>` over `typeof Counter`: decision 155 binds
      // what the callee's `render` returns, so `n` is Counter's `<return>`
      // value, a number — not the `any` the dynamic helper used to hand back.
      expect(result.output).toContain(
        "Dyn.mx(10,8): error TS2339: Property 'toUpperCase' does not exist on type 'number'",
      );
      // A plain function has no `render`: its string is written, and the
      // binding is `undefined`.
      expect(result.output).toContain(
        "Dyn.mx(12,6): error TS18048: 'm' is possibly 'undefined'",
      );
      // A callee typed `unknown` or `object` might be a unit at run time, so
      // its binding is `unknown`: a `typeof` guard narrows it to `number`
      // instead of `never` (no error on the `toFixed` lines, so the count of
      // three above would grow if the binding were `undefined`).
      expect(result.output).not.toContain("toFixed");
      // The wording an agent reads when it misuses a unit's default export:
      // its call signature and sink entry, not `typeof Dyn`.
      expect(stripVTControlCharacters(result.output)).toContain(
        "index.ts(3,14): error TS2322: Type '((input: Input) => string) & { render: (input: Input, __mxOut: Out) => void; }' is not assignable to type 'number'.",
      );
    },
    SPAWN_TIMEOUT_MS,
  );
});
