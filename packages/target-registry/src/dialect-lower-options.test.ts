/**
 * A dialect's `structural`, `imports` and `unknownTags` through the tools'
 * check of a dialect file (`checkDialectFile`). The tools pass none of the
 * three to `lowerSource`, so the dialect's own values apply: the editor
 * checks a file as strictly as the dialect's own front end, which passes the
 * dialect object (`dialect: D`) to `lowerSource`.
 */

import { lowerSource } from "@mxlang/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupProbeProjects,
  PROBE_MANIFEST,
  probeProject,
} from "../../../test-fixtures/dialects/probe.ts";
import { checkDialectFile } from "./dialect-check.ts";

afterEach(() => cleanupProbeProjects());

const S = `import x from "./x"
entity
  field
  <if=true><field/></if>
widget
`;

const IF =
  "the data tree is static; this file's consumer does not evaluate `<if>`";
const UNKNOWN =
  "`<widget>` is not a known tag: it has no contract in `customTags`";
const CONTRACTS = { entity: {}, field: { parents: ["entity"] } };
const STRICT = {
  structural: "reject",
  imports: "pass",
  unknownTags: "reject",
} as const;

/** The dialect module (ES) with `fields` and the Mesh-shaped vocabulary. */
const moduleOf = (fields: Record<string, unknown>) =>
  `export default {
  tagRules: "none",
  table: {},
  contracts: ${JSON.stringify(CONTRACTS)},
  ...${JSON.stringify(fields)},
};
`;

const MANIFEST = { module: "./dialect.mjs" };

const project = (fields: Record<string, unknown>, manifest = {}) =>
  probeProject(
    { "dialect.mjs": moduleOf(fields) },
    { manifest: { ...MANIFEST, ...manifest } },
  );

const check = (file: string, text: string) =>
  checkDialectFile(file, text)?.diagnostics.map((d) => [
    d.message,
    d.line,
    d.column,
    d.code,
  ]);

describe("R8: the tools check a dialect file with the dialect's values", () => {
  it("a dialect without the fields: no diagnostic", () => {
    const { path } = project({});
    expect(checkDialectFile(path("a.probe"), S)).toEqual({
      source: "Probe",
      diagnostics: [],
    });
  });

  it("with the fields: the `<if>` and the unknown tag, the second with its code", () => {
    const { path } = project(STRICT);
    expect(checkDialectFile(path("a.probe"), S)).toEqual({
      source: "Probe",
      diagnostics: [
        {
          severity: "error",
          message: IF,
          line: 4,
          column: 2,
          offset: 37,
        },
        {
          severity: "error",
          message: UNKNOWN,
          line: 5,
          column: 0,
          offset: 60,
          code: "MX_UNKNOWN_TAG",
        },
      ],
    });
  });

  it("an invalid field is one diagnostic at the module, through `origin`", () => {
    const { path } = project({ structural: "strict" });
    const module = path("dialect.mjs");
    expect(checkDialectFile(path("a.probe"), S)).toEqual({
      source: "Probe",
      diagnostics: [
        {
          severity: "error",
          message: `\`structural\` must be "pass" or "reject" (in ${module}:1:1)`,
          line: 1,
          column: 0,
          offset: 0,
          origin: { file: module, line: 1, column: 0 },
        },
      ],
    });
  });

  it("the module is among what the check read: an edit re-checks", () => {
    const { path } = project(STRICT);
    const dependencies = new Set<string>();
    checkDialectFile(path("a.probe"), S, dependencies);
    expect(dependencies.has(path("dialect.mjs"))).toBe(true);
  });
});

describe("R9: the editor equals the dialect's own CLI", () => {
  /** The module's default export as the CLI passes it: the `dialect` option. */
  const dialect = () =>
    ({
      id: "probe",
      name: "Probe",
      table: {},
      tagRules: "none",
      contracts: CONTRACTS,
      ...STRICT,
    }) as never;

  const BAD: Array<[string, string]> = [
    ["an `<if>`", "entity\n  <if=true><field/></if>\n"],
    ["an interpolation", `entity\n  <field>\${x}</field>\n`],
    ["text", "entity\n  <field>hello</field>\n"],
    ["a misspelt tag", "<entiy/>\n"],
    ["a misspelt child under a closed parent", "entity\n  wiget\n"],
    ["a project-only tag", "<service/>\n"],
    ["a top-level `export`", "export const a = 1\nentity\n"],
  ];

  it.each(BAD)("%s: the same diagnostics", (_, text) => {
    const { path } = probeProject(
      { "dialect.mjs": moduleOf(STRICT) },
      {
        manifest: {
          ...PROBE_MANIFEST,
          ...MANIFEST,
          mxConfigTags: false,
          reservedTags: Object.keys(CONTRACTS),
        },
        contracts: true,
      },
    );
    const file = path("a.probe");
    const cli = lowerSource(text, file, { dialect: dialect() }).diagnostics.map(
      (d) => [d.message, d.line, d.column, d.code],
    );
    expect(cli.length).toBeGreaterThan(0);
    expect(check(file, text)).toEqual(cli);
  });

  it("a misspelt child under a closed parent is an unknown tag, as the compiler says", () => {
    const { path } = project({
      ...STRICT,
      contracts: {
        entity: { children: { field: {} } },
        field: { parents: ["entity"] },
      },
    });
    expect(check(path("a.probe"), "entity\n  wiget\n")).toEqual([
      [
        "`<wiget>` is not a known tag: it has no contract in `customTags`",
        2,
        2,
        "MX_UNKNOWN_TAG",
      ],
    ]);
  });

  it("a tool passes none of the options: the same file under the dialect's values only", () => {
    const { path } = project(STRICT);
    const file = path("a.probe");
    const viaTool = check(file, S);
    const viaCall = lowerSource(S, file).diagnostics.map((d) => [
      d.message,
      d.line,
      d.column,
      d.code,
    ]);
    const explicit = lowerSource(S, file, {
      dialect: dialect(),
    }).diagnostics.map((d) => [d.message, d.line, d.column, d.code]);
    expect(viaTool).toEqual(viaCall);
    expect(viaTool).toEqual(explicit);
    expect(viaTool?.map((d) => d[0])).toEqual([IF, UNKNOWN]);
  });
});
