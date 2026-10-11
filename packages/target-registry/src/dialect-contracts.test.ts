/**
 * `Dialect.contracts` and the manifest's `mxConfigTags` through the tools'
 * check of a dialect file (`checkDialectFile`): the dialect's vocabulary is
 * checked in the editor as in the dialect's own compiler, a broken contract
 * points at the dialect's module (`origin`), and `mxConfigTags: false` keeps
 * the project's `mx.tags`/`mx.contracts` away from the dialect's files.
 */
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupProbeProjects,
  PROBE_CONTRACT_MESSAGE,
  PROBE_MANIFEST,
  probeProject,
} from "../../../test-fixtures/dialects/probe.ts";
import { checkDialectFile } from "./dialect-check.ts";

afterEach(() => cleanupProbeProjects());

const CODE = "MX_INVALID_DIALECT_CONTRACT";

/** The probe dialect's module (ES), with `contracts` as its source text. */
const withContracts = (contracts: string) =>
  `export default {\n  tagRules: "none",\n  table: {},\n  contracts: ${contracts},\n};\n`;

const VOCABULARY =
  '{\n    entity: { attributes: { name: { type: "string", required: true } } },\n  }';

const MJS = { module: "./dialect.mjs" };

describe("R7: the tools check a dialect's vocabulary", () => {
  it("a call that breaks a dialect contract is reported, at the call", () => {
    const project = probeProject(
      { "dialect.mjs": withContracts(VOCABULARY) },
      { manifest: MJS },
    );
    expect(
      checkDialectFile(project.path("a.probe"), "<p/>\n<entity/>\n"),
    ).toEqual({
      source: "Probe",
      diagnostics: [
        {
          severity: "error",
          message: "`<entity>`: missing required attribute `name`",
          line: 2,
          column: 0,
          offset: 5,
        },
      ],
    });
    expect(
      checkDialectFile(project.path("a.probe"), '<entity name="x"/>\n'),
    ).toEqual({ source: "Probe", diagnostics: [] });
  });

  it("without the contract the same call was silent", () => {
    const project = probeProject(
      { "dialect.mjs": withContracts("{}") },
      { manifest: MJS },
    );
    expect(checkDialectFile(project.path("a.probe"), "<entity/>\n")).toEqual({
      source: "Probe",
      diagnostics: [],
    });
  });

  it("a contract that cannot register is reported at its key in the module, through `origin`", () => {
    const project = probeProject(
      { "dialect.mjs": withContracts("{\n    box: {},\n    if: {},\n  }") },
      { manifest: MJS },
    );
    const module = project.path("dialect.mjs");
    const dependencies = new Set<string>();
    const result = checkDialectFile(
      project.path("a.probe"),
      "<p/>\n",
      dependencies,
    );
    const reserved =
      "`contracts.if`: `<if>` cannot name a data tag: it is reserved — core consumes the structural names (`if`, `else`, `else-if`, `for`, `const`, `define`, `return`, `import`, `export`, `static`) and `<try>` before a target sees them";
    expect(result).toEqual({
      source: "Probe",
      diagnostics: [
        {
          severity: "error",
          message: `${reserved} (in ${module}:6:5)`,
          line: 1,
          column: 0,
          offset: 0,
          code: CODE,
          origin: { file: module, line: 6, column: 4 },
        },
      ],
    });
    // The module is among what the check read: editing it re-checks.
    expect(dependencies.has(module)).toBe(true);
  });
});

describe("R9: `mxConfigTags` in the tools", () => {
  /** A project whose `mx.contracts` defines `<service>`, and `tags/` `<svc>`. */
  function project(mxConfigTags?: unknown) {
    return probeProject(
      {
        "tags/svc.tag.ts":
          'export default { attributes: { v: { type: "string", required: true } } };\n',
      },
      {
        contracts: true,
        manifest:
          mxConfigTags === undefined ? {} : { ...PROBE_MANIFEST, mxConfigTags },
      },
    );
  }
  const SVC = "`<svc>`: missing required attribute `v`";
  const messages = (file: string, text: string) =>
    checkDialectFile(file, text)?.diagnostics.map((d) => [d.message, d.line]);

  it.each([
    ["`true`", true],
    ["absent", undefined],
  ])("%s: `mx.contracts` and `tags/` both apply", (_, value) => {
    const { path } = project(value);
    expect(messages(path("a.probe"), "<service/>\n<svc/>\n")).toEqual([
      [PROBE_CONTRACT_MESSAGE, 1],
      [SVC, 2],
    ]);
  });

  it("`false`: `mx.contracts` is absent with no diagnostic; `tags/` still applies", () => {
    const { path } = project(false);
    expect(messages(path("a.probe"), "<service/>\n<svc/>\n")).toEqual([
      [SVC, 2],
    ]);
  });

  it("flipping the field re-checks with the project's contracts", () => {
    const { path } = project(false);
    const file = path("a.probe");
    expect(messages(file, "<service/>\n")).toEqual([]);
    const manifest = JSON.parse(readFileSync(path("package.json"), "utf8"));
    manifest.mx.dialect.mxConfigTags = true;
    writeFileSync(path("package.json"), JSON.stringify(manifest));
    const later = new Date(Date.now() + 10_000);
    utimesSync(path("package.json"), later, later);
    expect(messages(file, "<service/>\n")).toEqual([
      [PROBE_CONTRACT_MESSAGE, 1],
    ]);
  });
});
