import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NgtscProgram } from "@angular/compiler-cli";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createAngularChecker, getMetadataProgramCount } from "./checker.ts";

const projectDir = resolve(import.meta.dirname, "..");
const file = join(projectDir, "metadata.component.ts");
const child = `import { Component, Input } from "@angular/core";
@Component({selector: 'app-child', template: ''})
export class Child { @Input('label') caption = ''; }`;
const parent = `import { Component } from "@angular/core";
@Component({selector: 'app-parent', imports: [Child], template: '<app-child [lable]="title"/>'})
export class Parent { title = 'hi'; }`;
const message =
  "Can't bind to 'lable' since it isn't a known property of 'app-child'. Did you mean 'label'?";

describe("input-hint metadata cache", () => {
  it("constructs one metadata program for repeated identical checks, per checker", () => {
    const checker = createAngularChecker({ projectDir });
    const before = getMetadataProgramCount();
    try {
      for (let i = 0; i < 3; i++) {
        expect(
          checker.check(file, child + parent).find((d) => d.code === -998002)
            ?.message,
        ).toBe(message);
      }
      expect(getMetadataProgramCount() - before).toBe(1);
      const other = createAngularChecker({ projectDir });
      try {
        other.check(file, child + parent);
      } finally {
        other.dispose();
      }
      expect(getMetadataProgramCount() - before).toBe(2);
      expect(
        checker
          .check(file.replace("metadata.", "other."), child + parent)
          .find((d) => d.code === -998002)?.message,
      ).toBe(message);
      expect(getMetadataProgramCount() - before).toBe(3);
    } finally {
      checker.dispose();
    }
  });

  it("refreshes metadata on check and update, never suggesting an old input alias", () => {
    const checker = createAngularChecker({ projectDir });
    try {
      expect(
        checker.check(file, child + parent).find((d) => d.code === -998002)
          ?.message,
      ).toBe(message);
      const changed = child.replace("'label'", "'ladle'") + parent;
      checker.update(file, changed);
      expect(
        checker.check(file, changed).find((d) => d.code === -998002)?.message,
      ).toBe(message.replace("'label'?", "'ladle'?"));
      expect(
        checker.check(file, child + parent).find((d) => d.code === -998002)
          ?.message,
      ).toBe(message);
    } finally {
      checker.dispose();
    }
  });

  it("refreshes an imported directive after a same-size on-disk edit", () => {
    const dir = mkdtempSync(join(projectDir, ".metadata-"));
    const dependency = join(dir, "child.ts");
    const entry = join(dir, "parent.ts");
    const source = `import { Child } from './child';\n${parent}`;
    const checker = createAngularChecker({ projectDir });
    try {
      writeFileSync(dependency, child);
      expect(
        checker.check(entry, source).find((d) => d.code === -998002)?.message,
      ).toBe(message);
      writeFileSync(dependency, child.replace("'label'", "'ladle'"));
      expect(
        checker.check(entry, source).find((d) => d.code === -998002)?.message,
      ).toBe(message.replace("'label'?", "'ladle'?"));
      rmSync(dependency);
      expect(
        checker
          .check(entry, source)
          .map((d) => d.message)
          .join("\n"),
      ).not.toContain("Did you mean");
      writeFileSync(dependency, child);
      expect(
        checker.check(entry, source).find((d) => d.code === -998002)?.message,
      ).toBe(message);
      checker.update(dependency, child.replace("'label'", "'ladle'"));
      expect(
        checker.check(entry, source).find((d) => d.code === -998002)?.message,
      ).toBe(message.replace("'label'?", "'ladle'?"));
    } finally {
      checker.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("refreshes package exports even when the source graph has the same files and contents", () => {
    const dir = mkdtempSync(join(projectDir, ".metadata-exports-"));
    const pkg = join(dir, "node_modules", "hint-child");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "a.ts"), child);
    writeFileSync(join(pkg, "b.ts"), child.replace("'label'", "'ladle'"));
    const manifest = join(pkg, "package.json");
    const exportsFor = (a: string, b: string) =>
      JSON.stringify({ name: "hint-child", exports: { ".": a, "./other": b } });
    writeFileSync(manifest, exportsFor("./a.ts", "./b.ts"));
    const source = `import { Child } from 'hint-child';\nimport { Child as Other } from 'hint-child/other';\n${parent.replace("title = 'hi';", "title = 'hi'; other = Other;")}`;
    const checker = createAngularChecker({ projectDir });
    try {
      const entry = join(dir, "parent.ts");
      expect(
        checker.check(entry, source).find((d) => d.code === -998002)?.message,
      ).toBe(message);
      writeFileSync(manifest, exportsFor("./b.ts", "./a.ts"));
      expect(
        checker.check(entry, source).find((d) => d.code === -998002)?.message,
      ).toBe(message.replace("'label'?", "'ladle'?"));
    } finally {
      checker.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refreshes metadata when inherited compiler options change without a source edit", () => {
    const dir = mkdtempSync(join(projectDir, ".metadata-options-"));
    const base = join(dir, "base.json");
    const config = join(dir, "tsconfig.json");
    writeFileSync(
      config,
      JSON.stringify({ extends: "./base.json", files: [] }),
    );
    writeFileSync(
      base,
      JSON.stringify({ angularCompilerOptions: { strictInputTypes: true } }),
    );
    const checker = createAngularChecker({ projectDir, tsconfigPath: config });
    const before = getMetadataProgramCount();
    try {
      expect(
        checker.check(file, child + parent).find((d) => d.code === -998002)
          ?.message,
      ).toBe(message);
      writeFileSync(
        base,
        JSON.stringify({ angularCompilerOptions: { strictInputTypes: false } }),
      );
      expect(
        checker.check(file, child + parent).find((d) => d.code === -998002)
          ?.message,
      ).toBe(message);
      expect(getMetadataProgramCount() - before).toBe(2);
    } finally {
      checker.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it("pins compiler-cli's non-public metadata APIs with loud upgrade failures", () => {
  const options = {
    noEmit: true,
    skipLibCheck: true,
    _enableTemplateTypeChecker: true,
  };
  const program = new NgtscProgram([], options, ts.createCompilerHost(options));
  expect(
    typeof program.compiler.getTemplateTypeChecker,
    "compiler-cli input hints require NgCompiler.getTemplateTypeChecker (upgrade broke the API)",
  ).toBe("function");
  let checker: ReturnType<typeof program.compiler.getTemplateTypeChecker>;
  try {
    checker = program.compiler.getTemplateTypeChecker();
  } catch (error) {
    throw new Error(
      "compiler-cli input hints require _enableTemplateTypeChecker to enable getTemplateTypeChecker",
      { cause: error },
    );
  }
  for (const api of ["getTemplate", "getDirectivesOfNode"] as const) {
    expect(
      typeof checker[api],
      `compiler-cli input hints require TemplateTypeChecker.${api} (upgrade broke the API)`,
    ).toBe("function");
  }
  const functional = createAngularChecker({ projectDir });
  try {
    expect(
      functional.check(file, child + parent).find((d) => d.code === -998002)
        ?.message,
      "compiler-cli input hints require _enableTemplateTypeChecker, getTemplateTypeChecker, getTemplate and getDirectivesOfNode to expose public input metadata (upgrade contract)",
    ).toBe(message);
  } finally {
    functional.dispose();
  }
});
