/**
 * `Dialect.diagnosticCodes` through the tools' check of a dialect file
 * (`checkDialectFile`): the language server, the TypeScript plugin and `mx-tsc`
 * all report what it returns, so the dialect's codes reach all three.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupProbeProjects,
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
