import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { lineAndColumn } from "@mxlang/typescript-plugin";
import ts from "typescript";
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

  describe("mx.data.imports", () => {
    const source = 'import a from "a"\nservice="api"\n';
    const manifest = (data: object) =>
      JSON.stringify({ mx: { target: "data", data } });

    it("defaults to reject: a top-level import is the structural error", () => {
      const dir = emptyPackage({
        mx: { target: "data", data: { unknownTags: "allow" } },
      });
      writeFileSync(join(dir, "imp.mx"), source);
      const { status, output } = check(dir);
      expect(status).toBe(1);
      expect(output).toContain("imp.mx(1,1): error TS80001:");
      expect(output).toContain("does not evaluate `import`");
    });

    it('"pass" lets the import through while control flow stays rejected', () => {
      const dir = emptyPackage({});
      writeFileSync(
        join(dir, "package.json"),
        manifest({ unknownTags: "allow", imports: "pass" }),
      );
      writeFileSync(join(dir, "imp.mx"), source);
      expect(check(dir)).toEqual({ status: 0, output: "" });
      writeFileSync(
        join(dir, "imp.mx"),
        `${source}<if=true>\n  port="1"\n</if>\n`,
      );
      const { status, output } = check(dir);
      expect(status).toBe(1);
      expect(output).toContain("does not evaluate `<if>`");
    });

    it('"reject" is the explicit strict value', () => {
      const dir = emptyPackage({});
      writeFileSync(
        join(dir, "package.json"),
        manifest({ unknownTags: "allow", imports: "reject" }),
      );
      writeFileSync(join(dir, "imp.mx"), source);
      const { status, output } = check(dir);
      expect(status).toBe(1);
      expect(output).toContain("does not evaluate `import`");
    });

    it("an invalid value is a positioned error in package.json and stays strict, even under structural: pass", () => {
      const dir = emptyPackage({});
      writeFileSync(
        join(dir, "package.json"),
        `{\n  "mx": {\n    "target": "data",\n    "data": { "unknownTags": "allow", "imports": "yes", "structural": "pass" }\n  }\n}\n`,
      );
      writeFileSync(join(dir, "imp.mx"), source);
      const { status, output } = check(dir);
      expect(status).toBe(1);
      expect(output).toContain("package.json(4,50): error TS80003:");
      expect(output).toContain(
        'mx.data.imports must be "pass" or "reject", got "yes"',
      );
      expect(output).toContain("does not evaluate `import`");
      expect(output).not.toContain("unknown mx.data key");
    });
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

  describe("mx.data.defaultTag (decision 145)", () => {
    const manifest = (value: unknown) =>
      `{\n  "mx": {\n    "target": "data",\n    "contracts": "./contracts.ts",\n    "data": { "defaultTag": ${JSON.stringify(value)} }\n  }\n}\n`;

    it("a shorthand with no config is the built-in `object`, known under reject", () => {
      const dir = copyOfFixture();
      writeFileSync(join(dir, "shorthand.mx"), "<#a.b/>\n");
      expect(check(dir)).toEqual({ status: 0, output: "" });
    });

    it("an unreachable value is a positioned TS80003 error at the package.json value", () => {
      const dir = copyOfFixture();
      writeFileSync(join(dir, "shorthand.mx"), "<#a/>\n");
      writeFileSync(join(dir, "package.json"), manifest("nope"));
      const { status, output } = check(dir);
      expect(status).toBe(1);
      expect(output).toContain("package.json(5,29): error TS80003:");
      expect(output).toContain(
        "invalid `defaultTag` value: `<nope>` is not a tag reachable from this package",
      );
    });

    it("is a known mx.data key: no unknown-key warning beside the real error", () => {
      const dir = copyOfFixture(["clean.mx"]);
      writeFileSync(join(dir, "package.json"), manifest("nope"));
      expect(check(dir).output).not.toContain("unknown mx.data key");
      writeFileSync(join(dir, "package.json"), manifest("port"));
      expect(check(dir)).toEqual({ status: 0, output: "" });
    });

    it("is reported even when no file uses the shorthand", () => {
      const dir = copyOfFixture(["clean.mx"]);
      writeFileSync(join(dir, "package.json"), manifest("nope"));
      const { status, output } = check(dir);
      expect(status).toBe(1);
      expect(output).toContain("invalid `defaultTag` value");
    });

    it("a declared contract tag becomes the shorthand's tag: its parents error is positioned at the shorthand", () => {
      const dir = copyOfFixture();
      writeFileSync(join(dir, "package.json"), manifest("port"));
      // `port` declares parents: ["service"], so at the root the shorthand
      // is a parent-contract error naming `port`, at the shorthand.
      writeFileSync(join(dir, "shorthand.mx"), '\n<#a value="x"/>\n');
      const { status, output } = check(dir);
      expect(status).toBe(1);
      expect(output).toContain("shorthand.mx(2,1): error TS80001:");
      expect(output).toContain("`<port>`");
    });

    it("E1: a class shorthand on a tag whose closed attributes lack `class` is positioned at the shorthand", () => {
      const dir = copyOfFixture();
      writeFileSync(join(dir, "package.json"), manifest("port"));
      writeFileSync(
        join(dir, "shorthand.mx"),
        '<service value="s">\n  <.x value="y"/>\n</service>\n',
      );
      const { status, output } = check(dir);
      expect(status).toBe(1);
      expect(output).toContain("shorthand.mx(2,3): error TS80001:");
      expect(output).toContain("`class`");
    });

    it("E2: a closed parent children that lists neither the default nor anything matching is positioned at the shorthand", () => {
      const dir = copyOfFixture();
      writeFileSync(
        join(dir, "shorthand.mx"),
        '<service value="s">\n  <#a/>\n</service>\n',
      );
      const { status, output } = check(dir);
      expect(status).toBe(1);
      expect(output).toContain("shorthand.mx(2,3): error TS80001:");
      expect(output).toContain("`<service>`: `<object>` is not allowed here");
    });

    it("a malformed mx.contracts beside defaultTag prints the positioned contracts error, never a stack trace", () => {
      const dir = copyOfFixture(["clean.mx"]);
      writeFileSync(
        join(dir, "package.json"),
        `{\n  "mx": {\n    "target": "data",\n    "contracts": { "item": {} },\n    "data": { "defaultTag": "object" }\n  }\n}\n`,
      );
      const { output } = check(dir);
      expect(output).not.toMatch(/\n\s+at /);
      expect(output).toContain("package.json(");
      expect(output).toMatch(/error TS800\d\d:.*mx\.contracts/);
    });
  });

  describe("a parent contract's defaultTag (decision 145 PR 3)", () => {
    const withContracts = (
      contracts: string,
      files: Record<string, string>,
    ) => {
      const dir = emptyPackage({ mx: DATA });
      writeFileSync(join(dir, "contracts.ts"), contracts);
      for (const [name, text] of Object.entries(files))
        writeFileSync(join(dir, name), text);
      return dir;
    };
    const mesh = (extra = "", attribute = "attributes: { id: {}, type: {} }") =>
      `export default {
  attributes: { defaultTag: "attribute", children: { attribute: { repeatable: true } }${extra} },
  attribute: { ${attribute} },
};\n`;

    it("the Mesh example is clean", () => {
      const dir = withContracts(mesh(), {
        "doc.mx": '<attributes><#title type="string"/></attributes>\n',
      });
      expect(check(dir)).toEqual({ status: 0, output: "" });
    });

    it("E2: the resolved name missing from a closed children is positioned at the shorthand", () => {
      const dir = withContracts(
        `export default {
  attributes: { defaultTag: "attribute", children: { other: {} } },
  attribute: { attributes: { id: {} } },
  other: {},
};\n`,
        { "doc.mx": "<attributes>\n  <#title/>\n</attributes>\n" },
      );
      const { status, output } = check(dir);
      expect(status).toBe(1);
      expect(output).toContain("doc.mx(2,3): error TS80001:");
      expect(output).toContain("`<attribute>` is not allowed here");
    });

    it("E1: a closed attributes without id is positioned at the shorthand", () => {
      const dir = withContracts(mesh("", "attributes: { type: {} }"), {
        "doc.mx": "<attributes>\n  <#title/>\n</attributes>\n",
      });
      const { status, output } = check(dir);
      expect(status).toBe(1);
      expect(output).toContain("doc.mx(2,3): error TS80001:");
      expect(output).toContain("unknown attribute `id`");
    });

    it("an invalid contract defaultTag is one error however many files use it (review round 2)", () => {
      const dir = withContracts(
        `export default { attributes: { defaultTag: "nope" }, attribute: {} };\n`,
        {
          "a.mx": "<attributes><#x/></attributes>\n",
          "b.mx": "<attributes><#x/></attributes>\n",
        },
      );
      const { status, output } = check(dir);
      expect(status).toBe(1);
      const errors = output
        .split("\n")
        .filter((line) => line.includes("error TS"));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("contracts.ts(1,1): error TS80003:");
    });

    it("with a closed children that lists only the invalid value's intended tag, the next rung (object) is a legitimate E2 at each use", () => {
      const dir = withContracts(
        `export default { attributes: { defaultTag: "nope", children: { attribute: {} } }, attribute: {} };\n`,
        { "a.mx": "<attributes><#x/></attributes>\n" },
      );
      const errors = check(dir)
        .output.split("\n")
        .filter((line) => line.includes("error TS"));
      expect(errors).toHaveLength(2);
      expect(errors[0]).toContain("contracts.ts(1,1): error TS80003:");
      expect(errors[1]).toContain("`<object>` is not allowed here");
      expect(errors[1]).toContain(
        "(the parent's `defaultTag` `nope` is invalid; see the declaration)",
      );
    });

    it("an invalid contract defaultTag is TS80003 at the declaring contracts module", () => {
      const dir = withContracts(
        `export default { attributes: { defaultTag: "nope" } };\n`,
        { "doc.mx": "<attributes/>\n" },
      );
      const { status, output } = check(dir);
      expect(status).toBe(1);
      expect(output).toContain("contracts.ts(1,1): error TS80003:");
      expect(output).toContain(
        "invalid `defaultTag` value: `<nope>` is not a tag reachable from this package (contract of `<attributes>`)",
      );
    });
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

  it("checks files in full-path sorted order, skips node_modules, dot dirs and other targets", () => {
    const dir = emptyPackage({ mx: { target: "data" } });
    writeFileSync(join(dir, "a-.mx"), "<oops\n");
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
    expect(files).toEqual(["a-.mx", "a/f.mx", "b/f.mx", "z.mx"]);
  });

  it("flags other than -p and --pretty fall through to tsc", () => {
    const dir = copyOfFixture(["clean.mx"]);
    const run = runInProcess(["--version"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/Version \d+\./);
    expect(check(dir, "--pretty", "false").status).toBe(0);
  });
  describe("only an explicit mx.target: data takes the data path (rule 5 does not)", () => {
    const TSCONFIG = JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        module: "esnext",
        moduleResolution: "bundler",
        target: "esnext",
        types: [],
      },
      include: ["**/*.ts"],
    });

    it("a TS-only package that merely depends on @mxlang/data keeps its tsc run", () => {
      const dir = emptyPackage({ dependencies: { "@mxlang/data": "*" } });
      writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
      writeFileSync(join(dir, "bad.ts"), 'export const n: number = "bad";\n');
      const { status, output } = check(dir);
      expect(status).toBe(2);
      expect(output).toContain("bad.ts(1,14): error TS2322:");
    });

    it("a mixed monorepo root keeps its TS run", () => {
      const root = emptyPackage({ dependencies: { "@mxlang/data": "*" } });
      writeFileSync(join(root, "tsconfig.json"), TSCONFIG);
      writeFileSync(join(root, "bad.ts"), 'export const n: number = "bad";\n');
      const data = join(root, "packages", "data");
      mkdirSync(data, { recursive: true });
      writeFileSync(
        join(data, "package.json"),
        JSON.stringify({ mx: { target: "data" } }),
      );
      writeFileSync(join(data, "clean.mx"), "<oops\n");
      const { status, output } = check(root);
      expect(status).toBe(2);
      expect(output).toContain("bad.ts(1,14): error TS2322:");
    });

    it("a nested package that declares mx.target: data is checked when named", () => {
      const root = emptyPackage({ dependencies: { "@mxlang/data": "*" } });
      const data = join(root, "packages", "data");
      mkdirSync(data, { recursive: true });
      writeFileSync(
        join(data, "package.json"),
        JSON.stringify({ mx: { target: "data" } }),
      );
      writeFileSync(join(data, "bad.mx"), "<oops\n");
      const run = runInProcess(["-p", data]);
      expect(run.status).toBe(1);
      expect(stripVTControlCharacters(run.stderr)).toContain("bad.mx(1,");
    });
  });

  describe("policy diagnostics of the resolution are printed", () => {
    it("a target/host mismatch is an error even with no .mx file", () => {
      const dir = emptyPackage({ mx: { target: "data", host: "solid" } });
      const { status, output } = check(dir);
      expect(status).toBe(1);
      expect(output).toMatch(/^package\.json\(\d+,\d+\): error TS80003: /m);
      expect(output).toContain("mx.host");
    });

    it("an invalid nested target that falls back to data is reported, once", () => {
      const dir = emptyPackage({ mx: { target: "data" } });
      mkdirSync(join(dir, "sub"));
      writeFileSync(
        join(dir, "sub", "package.json"),
        '{\n  "mx": { "target": "dtaa" },\n  "dependencies": { "@mxlang/data": "*" }\n}\n',
      );
      writeFileSync(join(dir, "sub", "a.mx"), "<oops\n");
      writeFileSync(join(dir, "sub", "b.mx"), "<oops\n");
      const { status, output } = check(dir);
      expect(status).toBe(1);
      const lines = output
        .split("\n")
        .filter((line) => line.startsWith("sub/package.json("));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^sub\/package\.json\(2,\d+\): error TS80003: /);
    });

    it("an unknown mx.host stays a warning, positioned in the manifest", () => {
      const dir = emptyPackage({ mx: { target: "data", host: "bogus" } });
      writeFileSync(join(dir, "ok.mx"), "x\n");
      const { output } = check(dir);
      expect(output).toMatch(/^package\.json\(\d+,\d+\): warning TS80003: /m);
    });
  });

  describe("mx.data is located by a structural walk", () => {
    it("a decoy mx.example.data is not the invalid value", () => {
      const dir = emptyPackage({});
      writeFileSync(
        join(dir, "package.json"),
        [
          "{",
          '  "mx": {',
          '    "example": {',
          '      "data": { "unknownTags": "allow" }',
          "    },",
          '    "target": "data",',
          '    "data": {',
          '      "unknownTags": "oops"',
          "    }",
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      const { status, output } = check(dir);
      expect(status).toBe(1);
      expect(output).toContain("package.json(8,22): error TS80003:");
    });

    it("an escaped key is found at its own position", () => {
      const dir = emptyPackage({});
      writeFileSync(
        join(dir, "package.json"),
        '{\n  "mx": {\n    "target": "data",\n    "d\\u0061ta": {\n      "unknownTags": "oops"\n    }\n  }\n}\n',
      );
      const { output } = check(dir);
      expect(output).toContain("package.json(5,22): error TS80003:");
    });

    it("a duplicate key resolves like JSON.parse: the last one wins", () => {
      const dir = emptyPackage({});
      writeFileSync(
        join(dir, "package.json"),
        '{\n  "mx": {\n    "target": "data",\n    "data": { "unknownTags": "oops" },\n    "data": { "unknownTags": "bad" }\n  }\n}\n',
      );
      const { output } = check(dir);
      expect(output).toContain("package.json(5,30): error TS80003:");
      expect(output).not.toContain("package.json(4,");
    });

    it("a key full of regex metacharacters is an unknown-key warning, not a crash", () => {
      const dir = emptyPackage({
        mx: { target: "data", data: { "[": true, "(a+)+$": 1, "\\": 2 } },
      });
      const { status, output } = check(dir);
      expect(status).toBe(0);
      expect(
        output.match(/warning TS80003: unknown mx\.data key/g),
      ).toHaveLength(3);
    });

    it("an invalid mx.data is reported for a package with no .mx file", () => {
      const dir = emptyPackage({
        mx: { target: "data", data: { unknownTags: "typo" } },
      });
      const { status, output } = check(dir);
      expect(status).toBe(1);
      expect(output).toContain("error TS80003:");
      expect(output).toContain(
        'mx.data.unknownTags must be "allow" or "reject"',
      );
    });
  });

  describe("discovery failures are diagnostics, never a green empty map", () => {
    it("a missing mx.contracts module is printed at its key, and independent packages still run", () => {
      const dir = emptyPackage({
        mx: { target: "data", contracts: "./missing.ts" },
      });
      writeFileSync(join(dir, "a.mx"), "thing\n");
      const other = join(dir, "other");
      mkdirSync(other);
      writeFileSync(
        join(other, "package.json"),
        JSON.stringify({ mx: { target: "data" } }),
      );
      writeFileSync(join(other, "b.mx"), "<oops\n");
      const { status, output } = check(dir);
      expect(status).toBe(1);
      expect(output).toMatch(
        /^package\.json\(\d+,\d+\): error TS80001: .*missing\.ts/m,
      );
      expect(output.match(/^package\.json\(/gm)).toHaveLength(1);
      expect(output).toContain("other/b.mx(1,");
      expect(output).not.toContain("a.mx");
      expect(output.replaceAll(dir, "<pkg>")).toBe(
        [
          "package.json(4,5): error TS80001: `mx.contracts[0].module` could not resolve `./missing.ts` from <pkg>",
          "other/b.mx(1,1): error TS80001: EOF reached while parsing open tag",
          "",
        ].join("\n"),
      );
    });

    it("an invalid contract declaration is printed with its own position", () => {
      const dir = emptyPackage({
        mx: { target: "data", contracts: "./bad.ts" },
      });
      writeFileSync(
        join(dir, "bad.ts"),
        'export default { thing: { attributes: { x: { type: "string", requried: true } } } };\n',
      );
      writeFileSync(join(dir, "a.mx"), "thing\n");
      const { status, output } = check(dir);
      expect(status).toBe(1);
      expect(output.replaceAll(dir, "<pkg>")).toBe(
        'bad.ts(1,1): error TS80001: Unknown key "requried" in the "x" attribute declaration of tag "thing"; allowed: type, items, required, enum, default, literalOnly, values, pattern, ref\n',
      );
    });
  });

  describe("discovery is bounded and survives the file system", () => {
    it("never walks an excluded package, so its broken links cannot fail the check", () => {
      const dir = copyOfFixture(["clean.mx"]);
      mkdirSync(join(dir, "other"));
      writeFileSync(
        join(dir, "other", "package.json"),
        JSON.stringify({ mx: { target: "html" } }),
      );
      symlinkSync("missing", join(dir, "other", "broken.mx"));
      expect(check(dir)).toEqual({ status: 0, output: "" });
    });

    it("a broken or looping .mx link is an error diagnostic and the rest still runs", () => {
      const dir = emptyPackage({ mx: { target: "data" } });
      symlinkSync("missing", join(dir, "broken.mx"));
      symlinkSync("loop.mx", join(dir, "loop.mx"));
      writeFileSync(join(dir, "z.mx"), "<oops\n");
      const { status, output } = check(dir);
      expect(status).toBe(1);
      expect(output).toMatch(/^broken\.mx: error TS80001: /m);
      expect(output).toMatch(/^loop\.mx: error TS80001: /m);
      expect(output).toContain("z.mx(1,");
    });

    it("an unreadable directory is an error diagnostic, not a crash", () => {
      const dir = emptyPackage({ mx: { target: "data" } });
      mkdirSync(join(dir, "locked"));
      writeFileSync(join(dir, "z.mx"), "<oops\n");
      chmodSync(join(dir, "locked"), 0o000);
      try {
        const { status, output } = check(dir);
        expect(status).toBe(1);
        expect(output).toMatch(/^locked: error TS80001: /m);
        expect(output).toContain("z.mx(1,");
      } finally {
        chmodSync(join(dir, "locked"), 0o755);
      }
    });
  });

  it("a diagnostic in a readable but empty foreign file keeps that file's name", () => {
    const dir = emptyPackage({ mx: { target: "data", contracts: "./c.ts" } });
    writeFileSync(join(dir, "empty.txt"), "");
    writeFileSync(
      join(dir, "c.ts"),
      `export default {
  thing: {
    analyze(calls: { loc: object }[], ctx: { fail(m: string, l: object): never }) {
      ctx.fail("empty foreign error", { line: 1, column: 0, file: ${JSON.stringify(
        join(dir, "empty.txt"),
      )} });
    },
  },
};
`,
    );
    writeFileSync(join(dir, "a.mx"), "thing\n");
    const { status, output } = check(dir);
    expect(status).toBe(1);
    expect(output).toMatch(
      /^empty\.txt\(1,1\): error TS80001: .*empty foreign error/m,
    );
  });
  describe("manifest positions use the printer's own line rules", () => {
    const manifest = (...lines: string[]) => lines;

    it("a lone CR before the first LF is a line break", () => {
      const dir = emptyPackage({});
      writeFileSync(
        join(dir, "package.json"),
        '{\r  "mx": {\n    "target": "data",\n    "data": {\n      "unknownTags": "oops"\n    }\n  }\n}\n',
      );
      expect(check(dir).output).toContain("package.json(5,22): error TS80003:");
    });

    it.each([
      ["U+2028", "\u2028"],
      ["U+2029", "\u2029"],
    ])("a literal %s inside a JSON string before the value", (_name, sep) => {
      const dir = emptyPackage({});
      writeFileSync(
        join(dir, "package.json"),
        manifest(
          "{",
          '  "mx": {',
          '    "target": "data",',
          `    "note": "a${sep}b",`,
          '    "data": { "unknownTags": "oops" }',
          "  }",
          "}",
          "",
        ).join("\n"),
      );
      expect(check(dir).output).toContain("package.json(6,30): error TS80003:");
    });

    it("CRLF files and unrelated CR inside the object still agree", () => {
      const dir = emptyPackage({});
      writeFileSync(
        join(dir, "package.json"),
        '{\r\n  "mx": {\r\n    "target": "data",\r\n    "data": { "unknownTags": "oops" }\r\n  }\r\n}\r\n',
      );
      expect(check(dir).output).toContain("package.json(4,30): error TS80003:");
    });
  });

  it("a deeply nested unrelated value cannot overflow the stack: the positioned error still prints", () => {
    const dir = emptyPackage({});
    const depth = 12_000;
    writeFileSync(
      join(dir, "package.json"),
      `{\n  "noise": ${"[".repeat(depth)}${"]".repeat(depth)},\n  "mx": {\n    "target": "data",\n    "data": { "unknownTags": "oops" }\n  }\n}\n`,
    );
    const { status, output } = check(dir);
    expect(status).toBe(1);
    expect(output).toContain("package.json(5,30): error TS80003:");
  });

  it("an unreadable entry directory prints `.` as its path", () => {
    const dir = emptyPackage({ mx: { target: "data" } });
    chmodSync(dir, 0o111);
    try {
      const { status, output } = check(dir);
      expect(status).toBe(1);
      expect(output).toBe(".: error TS80001: cannot read directory: EACCES\n");
    } finally {
      chmodSync(dir, 0o755);
    }
  });
  it("lineAndColumn agrees with ts.createSourceFile on every line-break mix", () => {
    const pieces = [
      "a",
      "\n",
      "\r",
      "\r\n",
      "\u2028",
      "\u2029",
      "é",
      "\u0085",
      " ",
    ];
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let round = 0; round < 300; round++) {
      let text = "";
      for (let i = next() % 24; i > 0; i--)
        text += pieces[next() % pieces.length];
      const file = ts.createSourceFile("x.json", text, ts.ScriptTarget.Latest);
      for (let offset = 0; offset <= text.length; offset++) {
        const expected = ts.getLineAndCharacterOfPosition(file, offset);
        expect(
          lineAndColumn(text, offset),
          JSON.stringify({ text, offset }),
        ).toEqual({ line: expected.line + 1, column: expected.character });
      }
    }
  });
  describe("core's LF-only policy positions print where the value is", () => {
    const lines = [
      "{",
      ' "mx": {',
      '  "target": "data",',
      '  "host": "solid"',
      " }",
      "}",
    ];
    it.each([
      ["CR only", "\r", "package.json(3,13)"],
      ["LF", "\n", "package.json(3,13)"],
      ["CRLF", "\r\n", "package.json(3,13)"],
    ])("a target/host mismatch in a %s manifest", (_name, eol, expected) => {
      const dir = emptyPackage({});
      writeFileSync(join(dir, "package.json"), lines.join(eol));
      const { status, output } = check(dir);
      expect(status).toBe(1);
      expect(output).toContain(`${expected}: error TS80003:`);
    });
  });
  describe("a foreign-file diagnostic keeps the coordinates its producer gave", () => {
    it.each([
      [
        "CR only",
        "const first=0;\rconst second=1;\rconst third=2;",
        2,
        9,
        "(2,10)",
      ],
      ["mixed CR/LF", "a\rbbbb\ncccc", 2, 3, "(2,4)"],
      ["U+2028", "a\u2028bbbb\ncccc", 2, 3, "(2,4)"],
      ["LF", "a\nbbbb\ncccc", 2, 3, "(2,4)"],
      ["CRLF", "a\r\nbbbb\r\ncccc", 2, 3, "(2,4)"],
    ])("%s", (_name, text, line, column, shown) => {
      const dir = emptyPackage({ mx: { target: "data", contracts: "./c.ts" } });
      writeFileSync(join(dir, "foreign.ts"), text);
      writeFileSync(
        join(dir, "c.ts"),
        `export default {
  thing: {
    analyze(calls: { loc: object }[], ctx: { fail(m: string, l: object): never }) {
      ctx.fail("foreign failure", { line: ${line}, column: ${column}, file: ${JSON.stringify(join(dir, "foreign.ts"))} });
    },
  },
};
`,
      );
      writeFileSync(join(dir, "a.mx"), "thing\n");
      const { status, output } = check(dir);
      expect(status).toBe(1);
      expect(output).toContain(`foreign.ts${shown}: error TS80001:`);
    });
  });
  describe("a missing mx.contracts module is positioned where the key is, by any line break", () => {
    const lines = [
      "{",
      ' "mx": {',
      '  "target": "data",',
      '  "contracts": "./missing.ts"',
      " }",
      "}",
    ];
    it.each([
      ["CR only", lines.join("\r"), "package.json(4,3)"],
      [
        "mixed CR/LF",
        ["{", ' "mx": {'].join("\r") + "\n" + lines.slice(2).join("\n"),
        "package.json(4,3)",
      ],
      [
        "U+2028 inside a string",
        [
          "{",
          ' "mx": {',
          '  "target": "data",',
          '  "note": "x\u2028y",',
          '  "contracts": "./missing.ts"',
          " }",
          "}",
        ].join("\n"),
        "package.json(6,3)",
      ],
      ["LF", lines.join("\n"), "package.json(4,3)"],
      ["CRLF", lines.join("\r\n"), "package.json(4,3)"],
    ])("%s", (_name, text, shown) => {
      const dir = emptyPackage({});
      writeFileSync(join(dir, "package.json"), text);
      writeFileSync(join(dir, "a.mx"), "thing\n");
      const { status, output } = check(dir);
      expect(status).toBe(1);
      expect(output).toContain(`${shown}: error TS80001:`);
      expect(output).toContain("missing.ts");
    });

    it("an invalid contract declaration is positioned in its module, whatever the manifest's line breaks", () => {
      const dir = emptyPackage({});
      writeFileSync(
        join(dir, "package.json"),
        lines.join("\r").replace("missing", "bad"),
      );
      writeFileSync(
        join(dir, "bad.ts"),
        'export default { thing: { attributes: { x: { type: "string", requried: true } } } };\n',
      );
      writeFileSync(join(dir, "a.mx"), "thing\n");
      const { status, output } = check(dir);
      expect(status).toBe(1);
      expect(output).toContain("bad.ts(1,1): error TS80001:");
    });
  });
});

describe("mx-tsc on a data package: wildcard children (decision 147)", () => {
  const withContracts = (contracts: string, doc: string) => {
    const dir = emptyPackage({ mx: DATA });
    writeFileSync(join(dir, "contracts.ts"), contracts);
    writeFileSync(join(dir, "doc.mx"), doc);
    return dir;
  };
  const wildcard = (explicit: string) => `export default {
  attribute: { attributes: { value: {} } },
  resource: {
    children: { ${explicit}"*": [{ pattern: "[a-z]+", contract: "attribute" }] },
  },
};\n`;

  it("a claimed child passes, and unknownTags: reject counts it as known", () => {
    const dir = withContracts(
      wildcard(""),
      '<resource>\n  <title value="a"/>\n</resource>\n',
    );
    expect(check(dir)).toEqual({ status: 0, output: "" });
  });

  it("the near-explicit guard is an error here, as on every target", () => {
    const dir = withContracts(
      wildcard("attribute: {}, "),
      '<resource>\n  <attribut value="a"/>\n</resource>\n',
    );
    const { status, output } = check(dir);
    expect(status).toBe(1);
    expect(output).toContain("doc.mx(2,3): error TS80001:");
  });
});
