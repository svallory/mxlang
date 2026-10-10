/**
 * A `.solid.mx` region reaches core only through `parseFragment`, from this
 * host's region and unit entries. Each must hand core the target lookup it
 * compiles under, so routing refuses a dialect that claims `.solid.mx`
 * instead of accepting the claim and dropping the file (review 492 r1, B1).
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
import { compileSolidMx, compileSolidUnit } from "./index.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-solid-host-claim-")));
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

describe.each([
  ["compileSolidMx", compileSolidMx],
  ["compileSolidUnit", compileSolidUnit],
] as const)("`%s` hands routing its target's host file kinds", (_, compile) => {
  // The dialect package's `package.json`: `.solid.mx` is the second entry of
  // `mx.dialect.extensions`, on line 7.
  it("a dialect claiming `.solid.mx` is an error at its manifest", () => {
    const packageFile = claimingProject([".tst", ".solid.mx"]);
    expect(
      caught(() => compile("<div/>", { filename: join(dir, "page.solid.mx") })),
    ).toEqual({
      file: packageFile,
      line: 7,
      column: 6,
      message:
        "`mx.dialect.extensions` cannot claim `.solid.mx`: `.solid.mx` is a host's file kind, which MX owns; a dialect claims its own extensions (`.mesh.mx`)",
    });
  });
});
