import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { build } from "../src/build.ts";

const exampleDir = fileURLToPath(
  new URL("../../../../examples/angular-app", import.meta.url),
);

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "mx-angular-example-test-"));
  cpSync(join(exampleDir, "src"), join(projectDir, "src"), {
    recursive: true,
    filter: (path) => !path.endsWith("app.component.html"),
  });
  cpSync(join(exampleDir, "package.json"), join(projectDir, "package.json"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("examples/angular-app", () => {
  // `ng build` of the example fails with TS2339 `__mxOn` when a page binds an
  // event handler but its hand-written class lacks the invoker members. The
  // build reads each page's sibling class and stays silent when it provides
  // them, so a warning here means the example regressed. Independently, each
  // page whose emitted template calls `__mxOn` has its class type-checked: it
  // must have both members, whether pasted or inherited from `MxHandlers`. A
  // comment or a stray string cannot pass.
  it("gives every page that binds an event handler a class with the invoker, and warns about none", () => {
    const result = build(projectDir);
    expect(result.errors).toEqual([]);
    expect(
      result.warnings.filter((w) =>
        w.message.includes("binds an event handler"),
      ),
    ).toEqual([]);
    const pages = readdirSync(projectDir, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".html"))
      .map((f) => join(projectDir, f))
      .filter((f) => readFileSync(f, "utf8").includes("__mxOn"))
      .map((f) => f.replace(projectDir, exampleDir).replace(/\.html$/, ".mx"));
    expect(pages.length).toBeGreaterThan(0);

    const config = ts.getParsedCommandLineOfConfigFile(
      join(exampleDir, "tsconfig.app.json"),
      {},
      { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
    );
    const classFiles = pages.map((page) => page.replace(/\.mx$/, ".ts"));
    const program = ts.createProgram(classFiles, config?.options ?? {});
    const checker = program.getTypeChecker();
    for (const classFile of classFiles) {
      const sourceFile = program.getSourceFile(classFile);
      expect(sourceFile, `${classFile} is not in the program`).toBeDefined();
      const classes = (sourceFile as ts.SourceFile).statements.filter(
        ts.isClassDeclaration,
      );
      expect(classes.length, `${classFile} declares no class`).toBeGreaterThan(
        0,
      );
      for (const decl of classes) {
        const type = checker.getTypeAtLocation(decl);
        for (const member of ["__mxOn", "__mxOnAt"]) {
          expect(
            type.getProperty(member),
            `${classFile}: class lacks ${member}`,
          ).toBeDefined();
        }
      }
    }
  });
});
