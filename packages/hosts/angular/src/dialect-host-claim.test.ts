/**
 * A `.ng.mx` region reaches core only through `parseFragment`, from
 * `compileNgMx`. It must hand core the target lookup it compiles under, so
 * routing refuses a dialect that claims `.ng.mx` instead of accepting the
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileNgMx } from "./index.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-angular-host-claim-")));
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

const MODULE = `import { Component } from "@angular/core";

@Component({ selector: "app-page", template: <div/> })
export class Page {}
`;

describe("`compileNgMx` hands routing its target's host file kinds", () => {
  // The parser bridge re-raises a region's error as a positioned
  // `SyntaxError` in the `.ng.mx` module (`tsx-bridge` `mx/bridge.ts`), which
  // keeps the message but not `TranslateError.file`: the text is the pin.
  it("a dialect claiming `.ng.mx` is an error naming the claim", () => {
    claimingProject([".tst", ".ng.mx"]);
    let message: string | undefined;
    try {
      compileNgMx(MODULE, join(dir, "page.ng.mx"));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(
      "`mx.dialect.extensions` cannot claim `.ng.mx`: `.ng.mx` is a host's file kind, which MX owns; a dialect claims its own extensions (`.mesh.mx`)",
    );
  });
});
