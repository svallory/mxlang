/**
 * `Dialect.diagnosticCodes` through the tools' check of a dialect file
 * (`checkDialectFile`): the language server, the TypeScript plugin and `mx-tsc`
 * all report what it returns, so the dialect's codes reach all three.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupProbeProjects,
  PROBE_MANIFEST,
  probeProject,
} from "../../../test-fixtures/dialects/probe.ts";
import { checkDialectFile } from "./dialect-check.ts";

afterEach(() => cleanupProbeProjects());

const SOURCE = `entity
  <if=true><field/></if>
widget
<div a=1 a=2/>
`;

const moduleOf = (fields: Record<string, unknown>) =>
  `export default {
  tagRules: "none",
  table: {},
  structural: "reject",
  unknownTags: "reject",
  contracts: { entity: {}, field: { parents: ["entity"] } },
  ...${JSON.stringify(fields)},
};
`;

const project = (fields: Record<string, unknown>) =>
  probeProject(
    { "dialect.mjs": moduleOf(fields) },
    { manifest: { module: "./dialect.mjs" } },
  );

const MAP = {
  MX_STRUCTURAL_CONSTRUCT: "PROBE_STRUCTURAL",
  MX_UNKNOWN_TAG: "PROBE_UNKNOWN",
};

describe("checkDialectFile reports the dialect's codes", () => {
  it("renames the codes the map names and nothing else about the diagnostics", () => {
    const plain = project({});
    const mapped = project({ diagnosticCodes: MAP });
    const before = checkDialectFile(plain.path("a.probe"), SOURCE);
    const after = checkDialectFile(mapped.path("a.probe"), SOURCE);
    expect(before?.diagnostics.map((d) => d.code)).toEqual([
      "MX_STRUCTURAL_CONSTRUCT",
      "MX_UNKNOWN_TAG",
      "MX_UNKNOWN_TAG",
    ]);
    expect(after?.diagnostics.map((d) => d.code)).toEqual([
      "PROBE_STRUCTURAL",
      "PROBE_UNKNOWN",
      "PROBE_UNKNOWN",
    ]);
    const strip = (check: typeof before) =>
      check?.diagnostics.map(({ code: _code, ...rest }) => rest);
    expect(strip(after)).toEqual(strip(before));
  });

  it("a code the map does not name keeps its MX code", () => {
    const { path } = project({
      diagnosticCodes: { MX_STRUCTURAL_CONSTRUCT: "PROBE_STRUCTURAL" },
    });
    const codes = checkDialectFile(path("a.probe"), SOURCE)?.diagnostics.map(
      (d) => d.code,
    );
    expect(codes).toEqual([
      "PROBE_STRUCTURAL",
      "MX_UNKNOWN_TAG",
      "MX_UNKNOWN_TAG",
    ]);
  });

  it("a dialect without the map reports MX codes", () => {
    const { path } = project({});
    const codes = checkDialectFile(path("a.probe"), SOURCE)?.diagnostics.map(
      (d) => d.code,
    );
    expect(codes).not.toContain(undefined);
    expect(codes?.every((code) => code?.startsWith("MX_"))).toBe(true);
  });
});

/** A dialect module whose map renames every code the scan reports. */
const SCAN_MAP = {
  MX_RESERVED_TAG: "PROBE_RESERVED",
  MX_MISPLACED_TAG_FILE: "PROBE_MISPLACED",
  MX_SIDECAR_IGNORED: "PROBE_SIDECAR",
  MX_DOTTED_TAG_FILE_NAME: "PROBE_DOTTED",
  MX_IGNORED_CONFIG: "PROBE_CONFIG",
  MX_MODULE_LOAD_FAILED: "PROBE_LOAD",
  MX_UNKNOWN_TAG: "PROBE_UNKNOWN",
};

const scanModule = (map: object | undefined) =>
  `module.exports.default = { tagRules: "none", table: {}, ${
    map === undefined ? "" : `diagnosticCodes: ${JSON.stringify(map)},`
  } };\n`;

/** The codes of the checked file, in order. */
const codesOf = (file: string, text = "<p/>\n") =>
  checkDialectFile(file, text)?.diagnostics.map((d) => d.code);

describe("checkDialectFile renames the codes of the project scan", () => {
  const cases: Array<{
    name: string;
    code: string;
    renamed: string;
    build: (map: object | undefined) => ReturnType<typeof probeProject>;
  }> = [
    {
      name: "a contracts key that is a reserved tag",
      code: "MX_RESERVED_TAG",
      renamed: "PROBE_RESERVED",
      build: (map) =>
        probeProject(
          {
            "dialect.cjs": scanModule(map),
            "contracts.mjs": "export default { if: { attributes: {} } };\n",
          },
          {
            packageJson: {
              mx: { dialect: PROBE_MANIFEST, contracts: "./contracts.mjs" },
            },
          },
        ),
    },
    {
      name: "a dotted tag file name",
      code: "MX_DOTTED_TAG_FILE_NAME",
      renamed: "PROBE_DOTTED",
      build: (map) =>
        probeProject(
          {
            "dialect.cjs": scanModule(map),
            "components/money.component.probe": "<x/>\n",
          },
          { manifest: { tagDirs: ["components"] } },
        ),
    },
    {
      name: "a sidecar the dialect does not read",
      code: "MX_SIDECAR_IGNORED",
      renamed: "PROBE_SIDECAR",
      build: (map) =>
        probeProject(
          {
            "dialect.cjs": scanModule(map),
            "components/x.tag.ts": "export default {};\n",
          },
          { manifest: { tagDirs: ["components"], sidecars: false } },
        ),
    },
    {
      name: "a file of another dialect in `tags/`",
      code: "MX_MISPLACED_TAG_FILE",
      renamed: "PROBE_MISPLACED",
      build: (map) => {
        const project = probeProject({
          "dialect.cjs": scanModule(map),
          "tags/m.other": "<x/>\n",
        });
        const other = join(project.dir, "node_modules", "other-dialect");
        mkdirSync(other, { recursive: true });
        writeFileSync(
          join(other, "package.json"),
          JSON.stringify({
            name: "other-dialect",
            mx: {
              dialect: {
                id: "other",
                name: "Other",
                extensions: [".other"],
                module: "./index.cjs",
                tagDirs: ["things"],
              },
            },
          }),
        );
        writeFileSync(join(other, "index.cjs"), scanModule(undefined));
        writeFileSync(
          project.path("package.json"),
          JSON.stringify({
            name: "probe-dialect",
            mx: { dialect: PROBE_MANIFEST },
            dependencies: { "other-dialect": "*" },
          }),
        );
        return project;
      },
    },
    {
      name: "an `mx.tags` entry naming a directory that is not there",
      code: "MX_IGNORED_CONFIG",
      renamed: "PROBE_CONFIG",
      build: (map) =>
        probeProject(
          { "dialect.cjs": scanModule(map) },
          {
            packageJson: {
              mx: {
                dialect: PROBE_MANIFEST,
                tags: [{ dir: "./nowhere" }],
              },
            },
          },
        ),
    },
    {
      name: "a contracts module that cannot be loaded (a scan error)",
      code: "MX_MODULE_LOAD_FAILED",
      renamed: "PROBE_LOAD",
      build: (map) =>
        probeProject(
          {
            "dialect.cjs": scanModule(map),
            "contracts.cjs": "throw new Error('boom');\n",
          },
          {
            packageJson: {
              mx: { dialect: PROBE_MANIFEST, contracts: "./contracts.cjs" },
            },
          },
        ),
    },
  ];

  it.each(cases)("$name: $code", ({ code, renamed, build }) => {
    const before = codesOf(build(undefined).path("a.probe"));
    expect(before).toContain(code);
    const mapped = codesOf(build(SCAN_MAP).path("a.probe"));
    expect(mapped).toEqual(before?.map((c) => (c === code ? renamed : c)));
    expect(mapped).not.toContain(code);
  });

  it("a scan diagnostic and a lowering error are each renamed once", () => {
    const project = probeProject(
      {
        "dialect.cjs": `module.exports.default = { tagRules: "none", table: {}, unknownTags: "reject", diagnosticCodes: ${JSON.stringify(SCAN_MAP)} };\n`,
        "contracts.mjs": "export default { if: { attributes: {} } };\n",
      },
      {
        packageJson: {
          mx: { dialect: PROBE_MANIFEST, contracts: "./contracts.mjs" },
        },
      },
    );
    expect(codesOf(project.path("a.probe"), "<nope/>\n")).toEqual([
      "PROBE_RESERVED",
      "PROBE_UNKNOWN",
    ]);
  });

  it("MX_DIALECT_WARNING loads in the map and is ignored: MX keeps it", () => {
    const project = probeProject({
      "dialect.cjs": `module.exports.default = { tagRules: "none", table: {}, afterLower: (unit) => { unit.warn("careful"); }, diagnosticCodes: { MX_DIALECT_WARNING: "PROBE_WARN" } };\n`,
    });
    expect(codesOf(project.path("a.probe"), "<x/>\n")).toEqual([
      "MX_DIALECT_WARNING",
    ]);
  });

  it("MX_DIALECT_ERROR loads in the map and is ignored: MX keeps it", () => {
    const project = probeProject({
      "dialect.cjs": `module.exports.default = { tagRules: "none", table: {}, unknownTags: "reject", explainUnknownTag: () => ({ message: "no" }), diagnosticCodes: { MX_DIALECT_ERROR: "PROBE_ERR" } };\n`,
    });
    expect(codesOf(project.path("a.probe"), "<x/>\n")).toEqual([
      "MX_DIALECT_ERROR",
    ]);
  });
});
