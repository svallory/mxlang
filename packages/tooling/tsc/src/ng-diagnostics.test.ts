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
import {
  type AngularChecker,
  createAngularChecker,
  type Diagnostic,
} from "@mxlang/angular-checker";
import type { CompiledNgMx } from "@mxlang/typescript-plugin";
import { afterEach, describe, expect, it } from "vitest";
import { reportNgDiagnostics } from "./index.ts";
import {
  checkNgMxFiles,
  checkNgMxProjects,
  type NgDiagnosticsDeps,
  resolveProjectTsconfig,
  resolveProjectTsconfigs,
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
    config?: (projectDir: string) => Diagnostic[];
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
      return {
        status: "ok",
        version: "22.1.7",
        module: {} as never,
        packageJson: "",
      };
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
        configDiagnostics: () => over.config?.(options.projectDir) ?? [],
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
    expect(result).toEqual({ reports: [], errors: [], warnings: [] });
  });

  it("skips a project whose diagnostics are off, without resolving", () => {
    const spy = spyOf();
    const entry = compiled(project({ diagnostics: "off" }));
    const result = checkNgMxFiles([entry], deps(spy, { status: "missing" }));
    expect(spy.resolved).toEqual([]);
    expect(result).toEqual({ reports: [], errors: [], warnings: [] });
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

  it("reports a project without typescript once, naming typescript, using the real checker", () => {
    // A usable (fake) compiler-cli, but no typescript in the project: the
    // checker resolves typescript from the project, like compiler-cli.
    const dir = project();
    const cli = join(dir, "node_modules/@angular/compiler-cli");
    mkdirSync(cli, { recursive: true });
    writeFileSync(
      join(cli, "package.json"),
      '{"name":"@angular/compiler-cli","version":"22.0.0","main":"index.js"}',
    );
    writeFileSync(
      join(cli, "index.js"),
      "module.exports = { NgtscProgram: class {} };",
    );
    const result = checkNgMxFiles(
      [compiled(dir, "a.ng.mx"), compiled(dir, "b.ng.mx")],
      { createChecker: createAngularChecker },
    );
    expect(result.reports).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("typescript was not found");
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
  it("follows -p and --project, file or directory", () => {
    const dir = project();
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    writeFileSync(join(dir, "tsconfig.app.json"), "{}");
    const app = join(dir, "tsconfig.app.json");
    expect(resolveProjectTsconfig(["-p", app], "/")).toBe(app);
    expect(resolveProjectTsconfig(["--project", app], "/")).toBe(app);
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

  it("reads -p case-insensitively, like TypeScript's own option parser", () => {
    const dir = project();
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    writeFileSync(join(dir, "tsconfig.app.json"), "{}");
    const app = join(dir, "tsconfig.app.json");
    expect(resolveProjectTsconfig(["-P", app], "/")).toBe(app);
    expect(resolveProjectTsconfig(["--PROJECT", app], "/")).toBe(app);
  });

  it("ignores --project=<path>: tsc rejects that spelling (TS5023) and never reads it", () => {
    const dir = project();
    writeFileSync(join(dir, "tsconfig.app.json"), "{}");
    // No -p was understood, so this is the no-argument case: the nearest
    // tsconfig.json, never the one the rejected flag named.
    expect(
      resolveProjectTsconfig(
        [`--project=${join(dir, "tsconfig.app.json")}`],
        dir,
      ),
    ).toBeUndefined();
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    expect(
      resolveProjectTsconfig(
        [`--project=${join(dir, "tsconfig.app.json")}`],
        dir,
      ),
    ).toBe(join(dir, "tsconfig.json"));
  });

  it("follows a -p inside a response file (@args.txt)", () => {
    const dir = project();
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    writeFileSync(join(dir, "tsconfig.app.json"), "{}");
    writeFileSync(join(dir, "args.txt"), "--noEmit -p tsconfig.app.json\n");
    expect(resolveProjectTsconfig(["@args.txt"], dir)).toBe(
      join(dir, "tsconfig.app.json"),
    );
  });

  it("uses no tsconfig when input files are named without -p, like tsc", () => {
    const dir = project();
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    expect(
      resolveProjectTsconfig(["src/a.ts"], join(dir, "src")),
    ).toBeUndefined();
  });

  it("is undefined when -p names a directory with no tsconfig.json (TS5057)", () => {
    const dir = project();
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    expect(resolveProjectTsconfig(["-p", "src"], dir)).toBeUndefined();
    expect(resolveProjectTsconfig(["-p", "src/"], dir)).toBeUndefined();
  });

  it("uses no tsconfig for --help, --version and --init", () => {
    const dir = project();
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    for (const flag of ["--help", "--version", "--init"]) {
      expect(resolveProjectTsconfig([flag], dir)).toBeUndefined();
    }
  });

  describe("-b / --build", () => {
    it("resolves the one project (default '.', a directory or a file), like tsc -b", () => {
      const dir = project();
      writeFileSync(join(dir, "tsconfig.json"), "{}");
      writeFileSync(join(dir, "tsconfig.app.json"), "{}");
      const root = join(dir, "tsconfig.json");
      const app = join(dir, "tsconfig.app.json");
      expect(resolveProjectTsconfig(["-b"], dir)).toBe(root);
      expect(resolveProjectTsconfig(["--build", "."], dir)).toBe(root);
      expect(resolveProjectTsconfig(["-b", "tsconfig.app.json"], dir)).toBe(
        app,
      );
      expect(resolveProjectTsconfig(["-b", "--verbose", dir], "/")).toBe(root);
    });

    it("does not walk up from a nested cwd: tsc -b looks only at '.'", () => {
      const dir = project();
      writeFileSync(join(dir, "tsconfig.json"), "{}");
      expect(resolveProjectTsconfig(["-b"], join(dir, "src"))).toBeUndefined();
    });

    it("returns every project, in the order given", () => {
      const dir = project();
      writeFileSync(join(dir, "tsconfig.json"), "{}");
      writeFileSync(join(dir, "tsconfig.app.json"), "{}");
      expect(
        resolveProjectTsconfigs(["-b", "tsconfig.app.json", "."], dir),
      ).toEqual([join(dir, "tsconfig.app.json"), join(dir, "tsconfig.json")]);
    });

    it("drops a project that has no tsconfig (tsc reports TS5083 itself)", () => {
      const dir = project();
      writeFileSync(join(dir, "tsconfig.json"), "{}");
      expect(resolveProjectTsconfigs(["-b", "src", "."], dir)).toEqual([
        join(dir, "tsconfig.json"),
      ]);
    });
  });
});

describe("checkNgMxProjects", () => {
  /** Two sibling projects under one root, each with its own tsconfig. */
  function twoProjects() {
    const root = project();
    const dirs = ["a", "b"].map((name) => {
      const dir = join(root, name);
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
      writeFileSync(join(dir, "tsconfig.json"), "{}");
      return dir;
    });
    return { root, a: dirs[0] as string, b: dirs[1] as string };
  }

  it("under -b a b, checks each project's files once, in the order given", () => {
    const { root, a, b } = twoProjects();
    const spy = spyOf();
    const result = checkNgMxProjects(
      [compiled(b), compiled(a)],
      ["-b", "b", "a"],
      root,
      deps(spy),
    );
    expect(spy.created).toEqual([b, a]);
    expect(spy.checked).toEqual([
      `${join(b, "src", "x.component.ng.mx")}.ts`,
      `${join(a, "src", "x.component.ng.mx")}.ts`,
    ]);
    expect(result.errors).toEqual([]);
  });

  it("under -b a b, skips a project with no .ng.mx and a file owned by neither", () => {
    const { root, a, b } = twoProjects();
    const spy = spyOf();
    checkNgMxProjects(
      [compiled(a), { ...compiled(root), fileName: join(root, "stray.ng.mx") }],
      ["-b", "a", "b"],
      root,
      deps(spy),
    );
    expect(spy.created).toEqual([a]);
    expect(spy.checked).toHaveLength(1);
    expect(b).toBeTruthy();
  });

  it("never resolves a tsconfig when there is nothing to check", () => {
    const spy = spyOf();
    const result = checkNgMxProjects([], ["-b", "x", "y"], "/", deps(spy));
    expect(result).toEqual({ reports: [], errors: [], warnings: [] });
    expect(spy.resolved).toEqual([]);
  });
});

describe("resolveProjectTsconfig (continued)", () => {
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
        warnings: [],
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

describe("checkNgMxFiles compiler option errors", () => {
  const optionError = (file: string): Diagnostic => ({
    file,
    start: 0,
    length: 0,
    code: -991014,
    message:
      'Angular compiler option "extendedDiagnostics" requires strictTemplates',
    category: "error",
    source: "ngtsc",
  });

  it("reports a config error once per project, against the tsconfig, however many files", () => {
    const spy = spyOf();
    const dir = project();
    const tsconfigPath = join(dir, "tsconfig.app.json");
    const result = checkNgMxFiles(
      [compiled(dir, "a.ng.mx"), compiled(dir, "b.ng.mx")],
      deps(spy, { config: () => [optionError(tsconfigPath)] }),
      { tsconfigPath },
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(tsconfigPath);
    expect(result.errors[0]).toContain("extendedDiagnostics");
    expect(spy.checked).toHaveLength(2);
    expect(spy.disposed).toEqual([dir]);
  });

  it("does not turn a config warning into a failure, and does not drop it", () => {
    const spy = spyOf();
    const dir = project();
    const result = checkNgMxFiles(
      [compiled(dir)],
      deps(spy, {
        config: () => [{ ...optionError("/x"), category: "warning" }],
      }),
      { tsconfigPath: "/x" },
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("/x");
    expect(result.warnings[0]).toContain("extendedDiagnostics");
  });

  it("leaves TypeScript's own option errors to the TypeScript pass (no double report)", () => {
    const spy = spyOf();
    const dir = project();
    const result = checkNgMxFiles(
      [compiled(dir)],
      deps(spy, {
        config: () => [{ ...optionError("/x"), source: "ts", code: 5089 }],
      }),
      { tsconfigPath: "/x" },
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("names the project when no tsconfig was given", () => {
    const spy = spyOf();
    const dir = project();
    const result = checkNgMxFiles(
      [compiled(dir)],
      deps(spy, { config: () => [optionError("")] }),
    );
    expect(result.errors[0]).toContain(dir);
  });
});

describe("reportNgDiagnostics warnings", () => {
  it("prints config warnings as warnings", () => {
    const writes: string[] = [];
    const orig = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      reportNgDiagnostics({
        reports: [],
        errors: [],
        warnings: ["/x/tsconfig.json: be careful"],
      });
    } finally {
      process.stderr.write = orig;
    }
    expect(writes.join("")).toBe(
      "warning mxlang: /x/tsconfig.json: be careful\n",
    );
  });
});
