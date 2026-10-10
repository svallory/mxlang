/**
 * A `.astro.mx` template reaches core only through `parseFragment`, from
 * `lowerAstroMx`. It must hand core the target lookup it compiles under, so
 * routing refuses a dialect that claims `.astro.mx` instead of accepting the
 * claim and dropping the file (review 492 r1, B1).
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranslateError } from "@mxlang/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lowerAstroMx } from "./astro-template.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-astro-host-claim-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A project depending on a dialect package whose manifest names `extensions`, and the package's `package.json`. */
function claimingProject(extensions: readonly string[]): string {
  const packageDir = join(dir, "node_modules", "test-dialect");
  mkdirSync(packageDir, { recursive: true });
  const packageFile = join(packageDir, "package.json");
  writeFileSync(
    packageFile,
    `${JSON.stringify(
      {
        name: "test-dialect",
        mx: {
          dialect: {
            id: "test",
            name: "Test",
            extensions,
            module: "./index.mjs",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(packageDir, "index.mjs"),
    "export default { table: {} };\n",
  );
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      { name: "app", devDependencies: { "test-dialect": "0.0.0" } },
      null,
      2,
    )}\n`,
  );
  return packageFile;
}

function caught(run: () => unknown) {
  let error: unknown;
  try {
    run();
  } catch (thrown) {
    error = thrown;
  }
  expect(error).toBeInstanceOf(TranslateError);
  const { file, line, column, message } = error as TranslateError;
  return { file, line, column, message };
}

describe("`lowerAstroMx` hands routing its target's host file kinds", () => {
  // The dialect package's `package.json`: `.astro.mx` is the second entry of
  // `mx.dialect.extensions`, on line 7.
  it("a dialect claiming `.astro.mx` is an error at its manifest", () => {
    const packageFile = claimingProject([".tst", ".astro.mx"]);
    expect(
      caught(() =>
        lowerAstroMx("---\n---\n<div/>\n", join(dir, "page.astro.mx")),
      ),
    ).toEqual({
      file: packageFile,
      line: 7,
      column: 6,
      message:
        "`mx.dialect.extensions` cannot claim `.astro.mx`: `.astro.mx` is a host's file kind, which MX owns; a dialect claims its own extensions (`.mesh.mx`)",
    });
  });
});
