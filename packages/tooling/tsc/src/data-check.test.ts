import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runInProcess } from "./in-process.ts";

/**
 * `mx-tsc` on a data package (decision 131, addendum 4): one command, every
 * `.mx` file the policy assigns to `data`, parsed with the package's tag map
 * (`mx.contracts` and `tags/` sidecars) and `structural`/`unknownTags` both
 * `"reject"` unless `package.json#mx.data` says otherwise. The language server,
 * TS plugin and Vite keep the staged error (TODO `data-target-tooling-dispatch`).
 */

const fixture = realpathSync(
  join(import.meta.dirname, "fixtures", "host-dispatch", "data-check"),
);
const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** The fixture package copied to a temp dir, so a test can edit it. */
function copyOfFixture(files: readonly string[] = []): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-tsc-data-")));
  scratch.push(dir);
  for (const name of ["package.json", "contracts.ts", ...files]) {
    cpSync(join(fixture, name), join(dir, name));
  }
  return dir;
}

function emptyPackage(manifest: object): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-tsc-data-")));
  scratch.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2));
  cpSync(join(fixture, "contracts.ts"), join(dir, "contracts.ts"));
  return dir;
}

const DATA = { target: "data", contracts: "./contracts.ts" };

/**
 * `mx-tsc -p .` run from `dir`, as an agent runs it: paths print relative to
 * the package, ANSI stripped.
 */
function check(dir: string, ...extra: string[]) {
  const saved = process.cwd();
  process.chdir(dir);
  try {
    const run = runInProcess(["-p", ".", ...extra]);
    return {
      status: run.status,
      output: stripVTControlCharacters(run.stderr + run.stdout),
    };
  } finally {
    process.chdir(saved);
  }
}

describe("mx-tsc on a data package", () => {
  it("prints every file's diagnostics in order and exits 1", async () => {
    const { status, output } = check(fixture);
    expect(status).toBe(1);
    await expect(output).toMatchFileSnapshot(
      join(import.meta.dirname, "fixtures", "data-check-output.golden.txt"),
    );
  });

  it("exits 0 and prints nothing for a clean package", () => {
    const dir = copyOfFixture(["clean.mx"]);
    expect(check(dir)).toEqual({ status: 0, output: "" });
  });

  it("positions are 1-based line and column, like host files", () => {
    const { output } = check(fixture);
    // `servce` opens at line 1, 0-based column 0: printed (1,1).
    expect(output).toContain("unknown-tag.mx(1,1): error TS80001:");
    expect(output).toContain("did you mean `<service>`?");
    // violation.mx: `service` with no `value` is at (1,1).
    expect(output).toMatch(/violation\.mx\(1,1\): error TS80001:/);
    expect(output).not.toContain("clean.mx");
  });

  it("needs no tsconfig and runs from the package directory", () => {
    const dir = copyOfFixture(["unknown-tag.mx"]);
    const saved = process.cwd();
    process.chdir(dir);
    try {
      const run = runInProcess([]);
      expect(run.status).toBe(1);
      expect(stripVTControlCharacters(run.stderr + run.stdout)).toContain(
        "unknown-tag.mx(1,1): error TS80001:",
      );
    } finally {
      process.chdir(saved);
    }
  });

  it("mx.data.unknownTags: allow silences the unknown tag, not the contract", () => {
    const dir = copyOfFixture(["unknown-tag.mx", "violation.mx"]);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ mx: { ...DATA, data: { unknownTags: "allow" } } }),
    );
    const { status, output } = check(dir);
    expect(status).toBe(1);
    expect(output).not.toContain("unknown-tag.mx");
    expect(output).toContain("violation.mx(1,1): error TS80001:");
  });

  it("mx.data.unknownTags: allow alone makes the unknown-tag file pass", () => {
    const dir = copyOfFixture(["unknown-tag.mx"]);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ mx: { ...DATA, data: { unknownTags: "allow" } } }),
    );
    expect(check(dir)).toEqual({ status: 0, output: "" });
  });

  it("structural defaults to reject; mx.data.structural: pass keeps it", () => {
    const open = { unknownTags: "allow" };
    const dir = emptyPackage({ mx: { target: "data", data: open } });
    writeFileSync(
      join(dir, "list.mx"),
      'service="api"\n  <if=true>\n    port="1"\n  </if>\n',
    );
    const rejected = check(dir);
    expect(rejected.status).toBe(1);
    expect(rejected.output).toContain("list.mx(2,3): error TS80001:");
    expect(rejected.output).toContain("does not evaluate `<if>`");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        mx: { target: "data", data: { ...open, structural: "pass" } },
      }),
    );
    expect(check(dir)).toEqual({ status: 0, output: "" });
  });

  it("an invalid mx.data value is a positioned error in package.json", () => {
    const dir = copyOfFixture(["clean.mx"]);
    writeFileSync(
      join(dir, "package.json"),
      `{\n  "mx": {\n    "target": "data",\n    "contracts": "./contracts.ts",\n    "data": { "unknownTags": "maybe" }\n  }\n}\n`,
    );
    const { status, output } = check(dir);
    expect(status).toBe(1);
    expect(output).toContain("package.json(5,30): error TS80003:");
    expect(output).toContain('mx.data.unknownTags must be "allow" or "reject"');
  });

  it("includes tags/ sidecars in the tag map", () => {
    const dir = emptyPackage({ mx: { target: "data" } });
    mkdirSync(join(dir, "tags"));
    writeFileSync(
      join(dir, "tags", "widget.tag.ts"),
      'export default { attributes: { size: { type: "string", required: true } } };\n',
    );
    writeFileSync(join(dir, "bare.mx"), "widget\n");
    writeFileSync(join(dir, "ok.mx"), 'widget size="s"\n');
    writeFileSync(join(dir, "typo.mx"), 'widgit size="s"\n');
    const { status, output } = check(dir);
    expect(status).toBe(1);
    expect(output).toContain("typo.mx(1,1): error TS80001:");
    expect(output).toContain("did you mean `<widget>`?");
    expect(output).not.toContain("ok.mx");
    // The sidecar's own contract is enforced too.
    expect(output).toContain("bare.mx(1,1): error TS80001:");
    expect(output).toContain("missing required attribute `size`");
  });

  it("checks files in sorted order, skips node_modules, dot dirs and other targets", () => {
    const dir = emptyPackage({ mx: { target: "data" } });
    for (const sub of ["b", "a", "node_modules/x", ".cache", "html-sub"]) {
      mkdirSync(join(dir, sub), { recursive: true });
      writeFileSync(join(dir, sub, "f.mx"), "<oops\n");
    }
    writeFileSync(
      join(dir, "html-sub", "package.json"),
      JSON.stringify({ mx: { target: "html" } }),
    );
    writeFileSync(join(dir, "z.mx"), "<oops\n");
    const { output } = check(dir);
    const files = [...output.matchAll(/^(\S+?\.mx)\(/gm)].map((m) => m[1]);
    expect(files).toEqual(["a/f.mx", "b/f.mx", "z.mx"]);
  });

  it("a data package found by @mxlang/data in dependencies is checked too", () => {
    const dir = emptyPackage({ dependencies: { "@mxlang/data": "*" } });
    writeFileSync(join(dir, "bad.mx"), "<oops\n");
    const { status, output } = check(dir);
    expect(status).toBe(1);
    expect(output).toContain("bad.mx(1,");
  });

  it("flags other than -p and --pretty fall through to tsc", () => {
    const dir = copyOfFixture(["clean.mx"]);
    const run = runInProcess(["--version"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/Version \d+\./);
    expect(check(dir, "--pretty", "false").status).toBe(0);
  });
});
