import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CompilerCliUnavailableError,
  createAngularChecker,
  resolveCompilerCli,
  resolveTypescript,
  SUPPORTED_COMPILER_CLI_RANGE,
} from "./index.ts";

const PROJECT_DIR = path.resolve(import.meta.dirname, "..");
const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A throwaway project dir, optionally with a fake `@angular/compiler-cli`. */
function project(
  fake?: { version: string; main?: string },
  pkgName = "@angular/compiler-cli",
): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mx-ngcli-")));
  created.push(dir);
  writeFileSync(path.join(dir, "package.json"), '{ "name": "fixture" }');
  if (fake) {
    const pkgDir = path.join(dir, "node_modules", ...pkgName.split("/"));
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: pkgName,
        version: fake.version,
        main: "index.js",
      }),
    );
    writeFileSync(
      path.join(pkgDir, "index.js"),
      fake.main ?? "module.exports = { NgtscProgram: class {} };",
    );
  }
  return dir;
}

describe("resolveCompilerCli", () => {
  it("resolves the real compiler-cli from the project dir", () => {
    const r = resolveCompilerCli(PROJECT_DIR);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.version).toMatch(/^22\./);
    expect(typeof r.module.NgtscProgram).toBe("function");
  });

  it("resolves from the PROJECT, not from the checker's own location", () => {
    // A fake 22.x in the fixture must win over the workspace's real one.
    const dir = project({ version: "22.9.9" });
    const r = resolveCompilerCli(dir);
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.version).toBe("22.9.9");
  });

  it("reports `missing` with an actionable message", () => {
    const r = resolveCompilerCli(project());
    expect(r.status).toBe("missing");
    if (r.status !== "missing") return;
    expect(r.message).toContain("@angular/compiler-cli");
    expect(r.message).toContain(SUPPORTED_COMPILER_CLI_RANGE);
    expect(r.message).toContain('"mx.angular.diagnostics": "off"');
  });

  it.each([
    ["an older major", "21.2.0"],
    ["a newer major", "23.0.0"],
    ["an unparseable version", "banana"],
  ])("reports `out-of-range` for %s", (_label, version) => {
    const r = resolveCompilerCli(project({ version }));
    expect(r.status).toBe("out-of-range");
    if (r.status !== "out-of-range") return;
    expect(r.version).toBe(version);
    expect(r.message).toContain(version);
    expect(r.message).toContain(SUPPORTED_COMPILER_CLI_RANGE);
    expect(r.message).toContain('"mx.angular.diagnostics": "off"');
  });

  it("does not load a compiler-cli that is out of range", () => {
    // Loading an unsupported version could throw or misbehave; the version
    // check must come first.
    const dir = project({
      version: "21.0.0",
      main: 'throw new Error("must not be loaded");',
    });
    expect(resolveCompilerCli(dir).status).toBe("out-of-range");
  });

  it("accepts the range edges and a prerelease of the lower bound", () => {
    for (const version of ["22.0.0", "22.99.99", "22.0.0-rc.1"]) {
      expect(resolveCompilerCli(project({ version })).status).toBe("ok");
    }
  });

  it("reports `load-failed` when an in-range compiler-cli throws on load", () => {
    const dir = project({
      version: "22.0.0",
      main: 'throw new Error("boom from fixture");',
    });
    const r = resolveCompilerCli(dir);
    expect(r.status).toBe("load-failed");
    if (r.status !== "load-failed") return;
    expect(r.message).toContain("boom from fixture");
  });
});

describe("createAngularChecker without a usable compiler-cli", () => {
  it("throws CompilerCliUnavailableError carrying the status", () => {
    const dir = project();
    let caught: unknown;
    try {
      createAngularChecker({ projectDir: dir });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CompilerCliUnavailableError);
    const err = caught as CompilerCliUnavailableError;
    expect(err.status).toBe("missing");
    expect(err.message).toContain("@angular/compiler-cli");
  });

  it("throws for an out-of-range version too", () => {
    expect(() =>
      createAngularChecker({ projectDir: project({ version: "21.0.0" }) }),
    ).toThrow(CompilerCliUnavailableError);
  });
});

describe("resolveTypescript", () => {
  it("resolves from the PROJECT, not from the checker's own location", () => {
    // The workspace's own TypeScript must not win over the project's.
    const dir = project({ version: "9.9.9" }, "typescript");
    const r = resolveTypescript(dir);
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.version).toBe("9.9.9");
  });

  it("reports `missing`, naming typescript and how to fix it", () => {
    const r = resolveTypescript(project());
    expect(r.status).toBe("missing");
    if (r.status !== "missing") return;
    expect(r.message).toContain("typescript was not found from");
    expect(r.message).toContain('"mx.angular.diagnostics": "off"');
  });

  it("reports `load-failed` when typescript throws on load", () => {
    const r = resolveTypescript(
      project(
        { version: "6.0.0", main: 'throw new Error("ts boom");' },
        "typescript",
      ),
    );
    expect(r.status).toBe("load-failed");
    if (r.status === "load-failed") expect(r.message).toContain("ts boom");
  });
});

describe("createAngularChecker without typescript in the project", () => {
  it("throws CompilerCliUnavailableError naming typescript, not compiler-cli", () => {
    // A usable compiler-cli, but no typescript beside it.
    const dir = project({ version: "22.0.0" });
    let caught: unknown;
    try {
      createAngularChecker({ projectDir: dir });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CompilerCliUnavailableError);
    const err = caught as CompilerCliUnavailableError;
    expect(err.status).toBe("missing");
    expect(err.message).toContain("typescript was not found");
    expect(err.message).not.toContain("@angular/compiler-cli was not found");
  });
});
