import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAngularChecker } from "./index.ts";

const PROJECT_DIR = path.resolve(import.meta.dirname, "..");
const VIRTUAL = path.join(PROJECT_DIR, "x.component.ts");
const STRICT = path.join(PROJECT_DIR, "fixtures", "strict");

const CLEAN = `import { Component } from "@angular/core";
@Component({ selector: "a", standalone: true, template: "<p>{{ n }}</p>" })
export class A { n = 1; }
`;

function withChecker<T>(
  tsconfig: string | undefined,
  run: (c: ReturnType<typeof createAngularChecker>) => T,
): T {
  const checker = createAngularChecker({
    projectDir: PROJECT_DIR,
    ...(tsconfig ? { tsconfigPath: path.join(STRICT, tsconfig) } : {}),
  });
  try {
    return run(checker);
  } finally {
    checker.dispose();
  }
}

describe("configDiagnostics (compiler option errors)", () => {
  it("surfaces `extendedDiagnostics` together with `strictTemplates: false`, against the tsconfig", () => {
    // `ng build` fails on this combination; it has no template position, so
    // `check()` never sees it. It must not be silently dropped.
    const { records, perFile } = withChecker("ext.json", (c) => {
      const perFile = c.check(VIRTUAL, CLEAN);
      return { records: c.configDiagnostics(), perFile };
    });
    expect(perFile).toEqual([]);
    expect(records).toHaveLength(1);
    const [d] = records;
    expect(d?.category).toBe("error");
    expect(d?.message).toContain("extendedDiagnostics");
    expect(d?.message).toContain("strictTemplates");
    expect(d?.file).toBe(path.join(STRICT, "ext.json"));
  });

  it("reports each option problem once, however many files are checked", () => {
    const records = withChecker("ext.json", (c) => {
      c.check(VIRTUAL, CLEAN);
      c.check(path.join(PROJECT_DIR, "y.component.ts"), CLEAN);
      c.check(VIRTUAL, CLEAN);
      return c.configDiagnostics();
    });
    expect(records).toHaveLength(1);
  });

  it("reports the option error even when called before any check (no silent [] )", () => {
    // Builds a program on demand: an empty list must never mean "not
    // computed yet".
    const records = withChecker("ext.json", (c) => c.configDiagnostics());
    expect(records).toHaveLength(1);
    expect(records[0]?.message).toContain("extendedDiagnostics");
  });

  it("is empty before any check for valid options, and does not disturb later checks", () => {
    withChecker("on.json", (c) => {
      expect(c.configDiagnostics()).toEqual([]);
      expect(c.check(VIRTUAL, CLEAN)).toEqual([]);
      expect(c.configDiagnostics()).toEqual([]);
    });
  });

  it.each(["on.json", "off.json", "unset.json"])(
    "reports nothing for valid options (%s)",
    (name) => {
      const records = withChecker(name, (c) => {
        c.check(VIRTUAL, CLEAN);
        return c.configDiagnostics();
      });
      expect(records).toEqual([]);
    },
  );

  it("reports nothing without a tsconfig", () => {
    const records = withChecker(undefined, (c) => {
      c.check(VIRTUAL, CLEAN);
      return c.configDiagnostics();
    });
    expect(records).toEqual([]);
  });
});
