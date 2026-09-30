import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileNgMx } from "@mxlang/angular";
import type { AngularChecker, Diagnostic } from "@mxlang/angular-checker";
import type { CompiledNgMx } from "@mxlang/typescript-plugin";
import { afterEach, describe, expect, it } from "vitest";
import { reportNgDiagnostics } from "./index.ts";
import {
  checkNgMxFiles,
  type NgDiagnosticsDeps,
  resolveProjectTsconfig,
} from "./ng-diagnostics.ts";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A project dir whose package.json carries `mx.angular` config. */
function project(angular?: Record<string, unknown>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-ngdiag-")));
  created.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "p", ...(angular ? { mx: { angular } } : {}) }),
  );
  mkdirSync(join(dir, "src"));
  return dir;
}

const SOURCE = [
  'import { Component } from "@angular/core";',
  "@Component({ selector: 'app-x', template: <p>${user.nmae}</p> })",
  "export class X { user = { name: 'a' }; }",
].join("\n");

function compiled(dir: string, name = "x.component.ng.mx"): CompiledNgMx {
  const fileName = join(dir, "src", name);
  return { fileName, source: SOURCE, result: compileNgMx(SOURCE, fileName) };
}

/** A module-absolute ngtsc record at the `user.nmae` expression. */
function ngtscRecord(entry: CompiledNgMx): Diagnostic {
  const m = entry.result.mappings.find(
    (x) => SOURCE.slice(x.sourceStart, x.sourceEnd) === "user.nmae",
  );
  return {
    file: "v",
    start: m?.generatedStart ?? -1,
    length: 9,
    code: 2339,
    message: "Property 'nmae' does not exist",
    category: "error",
    source: "ngtsc",
  };
}

interface Spy {
  resolved: string[];
  created: string[];
  checked: string[];
  disposed: string[];
}

function deps(
  spy: Spy,
  over: {
    status?: "ok" | "missing" | "out-of-range";
    records?: (path: string) => Diagnostic[];
    throwOnCheck?: boolean;
  } = {},
): NgDiagnosticsDeps {
  return {
    resolveCompilerCli: (projectDir) => {
      spy.resolved.push(projectDir);
      if (over.status === "missing") {
        return { status: "missing", message: "MISSING-MESSAGE" };
      }
      if (over.status === "out-of-range") {
        return {
          status: "out-of-range",
          version: "21.0.0",
          message: "RANGE-MESSAGE",
        };
      }
      return { status: "ok", version: "22.1.7", module: {} as never };
    },
    createChecker: (options): AngularChecker => {
      spy.created.push(options.projectDir);
      return {
        check: (path) => {
          spy.checked.push(path);
          if (over.throwOnCheck) throw new Error("ngtsc exploded");
          return over.records?.(path) ?? [];
        },
        update: () => {},
        dispose: () => {
          spy.disposed.push(options.projectDir);
        },
      };
    },
  };
}

const spyOf = (): Spy => ({
  resolved: [],
  created: [],
  checked: [],
  disposed: [],
});

describe("checkNgMxFiles", () => {
  it("never touches compiler-cli when there are no .ng.mx files", () => {
    const spy = spyOf();
    const result = checkNgMxFiles([], deps(spy));
    expect(spy.resolved).toEqual([]);
    expect(result).toEqual({ reports: [], errors: [] });
  });

  it("skips a project whose diagnostics are off, without resolving", () => {
    const spy = spyOf();
    const entry = compiled(project({ diagnostics: "off" }));
    const result = checkNgMxFiles([entry], deps(spy, { status: "missing" }));
    expect(spy.resolved).toEqual([]);
    expect(result).toEqual({ reports: [], errors: [] });
  });

  it.each(["idle", "save"])("treats diagnostics=%s as on", (mode) => {
    const spy = spyOf();
    const entry = compiled(project({ diagnostics: mode }));
    checkNgMxFiles([entry], deps(spy));
    expect(spy.checked).toHaveLength(1);
  });

  it("reports mapped diagnostics at the .ng.mx position", () => {
    const spy = spyOf();
    const entry = compiled(project());
    const result = checkNgMxFiles(
      [entry],
      deps(spy, { records: () => [ngtscRecord(entry)] }),
    );
    expect(result.errors).toEqual([]);
    expect(result.reports).toHaveLength(1);
    const [report] = result.reports;
    expect(report?.fileName).toBe(entry.fileName);
    expect(report?.source).toBe(SOURCE);
    expect(report?.diagnostics[0]?.start).toBe(SOURCE.indexOf("user.nmae"));
    expect(report?.diagnostics[0]?.source).toBe("angular");
  });

  it("presents the module beside the .ng.mx so imports and @angular/core resolve", () => {
    const spy = spyOf();
    const entry = compiled(project());
    checkNgMxFiles([entry], deps(spy));
    expect(spy.checked).toEqual([`${entry.fileName}.ts`]);
  });

  it("creates one checker per project, not per file, and disposes it", () => {
    const spy = spyOf();
    const dir = project();
    checkNgMxFiles(
      [compiled(dir, "a.ng.mx"), compiled(dir, "b.ng.mx")],
      deps(spy),
    );
    expect(spy.created).toEqual([dir]);
    expect(spy.checked).toHaveLength(2);
    expect(spy.disposed).toEqual([dir]);
    expect(spy.resolved).toEqual([dir]);
  });

  it("creates one checker for each of two projects", () => {
    const spy = spyOf();
    const a = project();
    const b = project();
    checkNgMxFiles([compiled(a), compiled(b)], deps(spy));
    expect([...spy.created].sort()).toEqual([a, b].sort());
    expect([...spy.disposed].sort()).toEqual([a, b].sort());
  });

  it("returns one error per project when compiler-cli is missing, and checks nothing", () => {
    const spy = spyOf();
    const dir = project();
    const result = checkNgMxFiles(
      [compiled(dir, "a.ng.mx"), compiled(dir, "b.ng.mx")],
      deps(spy, { status: "missing" }),
    );
    expect(spy.created).toEqual([]);
    expect(result.reports).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("MISSING-MESSAGE");
    expect(result.errors[0]).toContain("2 .ng.mx files");
  });

  it("returns the out-of-range message too", () => {
    const spy = spyOf();
    const result = checkNgMxFiles(
      [compiled(project())],
      deps(spy, { status: "out-of-range" }),
    );
    expect(result.errors[0]).toContain("RANGE-MESSAGE");
    expect(result.errors[0]).toContain("1 .ng.mx file");
    expect(result.errors[0]).not.toContain("1 .ng.mx files");
  });

  it("reports a thrown check as an error, never silently, and still disposes", () => {
    const spy = spyOf();
    const dir = project();
    const entry = compiled(dir);
    const result = checkNgMxFiles([entry], deps(spy, { throwOnCheck: true }));
    expect(result.reports).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("ngtsc exploded");
    expect(result.errors[0]).toContain(entry.fileName);
    expect(spy.disposed).toEqual([dir]);
  });

  it("reports an unreadable mx.angular config as an error instead of defaulting", () => {
    const spy = spyOf();
    const dir = project({ diagnostics: "sometimes" });
    const result = checkNgMxFiles([compiled(dir)], deps(spy));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("mx.angular.diagnostics");
    expect(spy.resolved).toEqual([]);
  });
});

describe("checkNgMxFiles tsconfig", () => {
  it("hands the given tsconfigPath to the checker, not <projectDir>/tsconfig.json", () => {
    const dir = project();
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    const seen: Array<string | undefined> = [];
    const d = deps(spyOf());
    checkNgMxFiles(
      [compiled(dir)],
      {
        ...d,
        createChecker: (options) => {
          seen.push(options.tsconfigPath);
          return (d.createChecker as NonNullable<typeof d.createChecker>)(
            options,
          );
        },
      },
      { tsconfigPath: join(dir, "tsconfig.app.json") },
    );
    expect(seen).toEqual([join(dir, "tsconfig.app.json")]);
  });
});

describe("resolveProjectTsconfig", () => {
  it("follows -p, --project and --project=, file or directory", () => {
    const dir = project();
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    writeFileSync(join(dir, "tsconfig.app.json"), "{}");
    const app = join(dir, "tsconfig.app.json");
    expect(resolveProjectTsconfig(["-p", app], "/")).toBe(app);
    expect(resolveProjectTsconfig(["--project", app], "/")).toBe(app);
    expect(resolveProjectTsconfig([`--project=${app}`], "/")).toBe(app);
    expect(resolveProjectTsconfig(["-p", dir], "/")).toBe(
      join(dir, "tsconfig.json"),
    );
    expect(
      resolveProjectTsconfig(["--noEmit", "-p", "tsconfig.app.json"], dir),
    ).toBe(app);
  });

  it("without -p, finds the nearest tsconfig.json at or above cwd, like tsc", () => {
    const dir = project();
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    expect(resolveProjectTsconfig(["--noEmit"], join(dir, "src"))).toBe(
      join(dir, "tsconfig.json"),
    );
  });

  it("is undefined when -p names nothing that exists", () => {
    expect(
      resolveProjectTsconfig(["-p", "/nonexistent/tsconfig.json"], "/"),
    ).toBeUndefined();
  });
});

describe("checkNgMxFiles when the checker cannot be created", () => {
  it("reports the failure (e.g. an unusable tsconfig) and still checks other projects", () => {
    const spy = spyOf();
    const bad = project();
    const good = project();
    const d = deps(spy, { records: () => [] });
    const result = checkNgMxFiles(
      [compiled(bad), compiled(good)],
      {
        ...d,
        createChecker: (options) => {
          if (options.projectDir === bad) {
            throw new Error("/x/tsconfig.app.json: cannot read file");
          }
          return (d.createChecker as NonNullable<typeof d.createChecker>)(
            options,
          );
        },
      },
      { tsconfigPath: "/x/tsconfig.app.json" },
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(
      "/x/tsconfig.app.json: cannot read file",
    );
    expect(spy.checked).toEqual([`${compiled(good).fileName}.ts`]);
  });
});

describe("reportNgDiagnostics", () => {
  it("marks a degraded position as approximate, and leaves an exact one alone", () => {
    const writes: string[] = [];
    const orig = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const base = {
        length: 0,
        code: 2339,
        category: "error",
        source: "angular",
      } as const;
      reportNgDiagnostics({
        errors: [],
        reports: [
          {
            fileName: "/p/x.ng.mx",
            source: "abc\ndef\n",
            diagnostics: [
              { ...base, start: 0, message: "exact one", mapped: "exact" },
              { ...base, start: 4, message: "region one", mapped: "region" },
              { ...base, start: 4, message: "map one", mapped: "sourcemap" },
              { ...base, start: 0, message: "none one", mapped: "none" },
            ],
          },
        ],
      });
    } finally {
      process.stderr.write = orig;
    }
    const out = writes.join("");
    expect(out).toContain("exact one\n");
    for (const m of ["region one", "map one", "none one"]) {
      expect(out).toContain(`${m} (approximate location)`);
    }
  });
});
