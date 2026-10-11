import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { routeDialect } from "@mxlang/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupProbeProjects,
  PROBE_CONTRACT_MESSAGE,
  PROBE_DIALECT_MODULE,
  PROBE_MANIFEST,
  PROBE_SOURCES,
  PROBE_TAG_DIALECT,
  probeProject,
  tagDiscoveryProject,
} from "../../../test-fixtures/dialects/probe.ts";
import {
  checkDialectFile,
  dialectExtensions,
  dialectExtensionsUnder,
  dialectOf,
  emitOf,
  isDialectFile,
} from "./dialect-check.ts";

afterEach(() => cleanupProbeProjects());

describe("checkDialectFile", () => {
  it("a valid dialect file is clean, and the source names the dialect", () => {
    const project = probeProject();
    expect(checkDialectFile(project.path("a.probe"), PROBE_SOURCES.ok)).toEqual(
      { source: "Probe", diagnostics: [] },
    );
  });

  it("reports lowerSource's diagnostic with its code, position and offset, exactly", () => {
    const project = probeProject();
    expect(
      checkDialectFile(project.path("a.probe"), PROBE_SOURCES.bad),
    ).toEqual({
      source: "Probe",
      diagnostics: [
        {
          severity: "error",
          message: "bad probe",
          line: 1,
          column: 3,
          offset: 3,
          code: "PROBE_BAD",
        },
      ],
    });
  });

  it("the offset counts UTF-16 units past a CRLF and a surrogate pair", () => {
    const project = probeProject();
    const text = "<a t='😀'/>\r\n<😀 />\r\n<y !bad/>\r\n";
    const [diagnostic] =
      checkDialectFile(project.path("a.probe"), text)?.diagnostics ?? [];
    expect(diagnostic).toMatchObject({ line: 3, column: 3, code: "PROBE_BAD" });
    expect(text.slice(diagnostic?.offset)).toMatch(/^!bad/);
  });

  it("a diagnostic with no code carries none", () => {
    const project = probeProject();
    const [diagnostic] =
      checkDialectFile(project.path("a.probe"), "<y x=(/>\n")?.diagnostics ??
      [];
    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic).not.toHaveProperty("code");
  });

  it("honours the dialect's tagRules: <input> is no void element under `none`", () => {
    const project = probeProject();
    expect(
      checkDialectFile(project.path("a.probe"), PROBE_SOURCES.noRules),
    ).toEqual({
      source: "Probe",
      diagnostics: [
        {
          severity: "error",
          message: 'Missing ending "input" tag',
          line: 1,
          column: 0,
          offset: 0,
        },
      ],
    });
    // The same text is clean in an MX file of a project with no dialect, so the
    // error above is the dialect's rules and nothing else.
    const plain = probeProject({}, { manifest: null });
    expect(
      checkDialectFile(plain.path("a.mx"), PROBE_SOURCES.noRules),
    ).toBeUndefined();
  });

  it("checks a call against the project's contracts, as it does for an MX file", () => {
    const project = probeProject({}, { contracts: true });
    expect(checkDialectFile(project.path("a.probe"), "<service/>\n")).toEqual({
      source: "Probe",
      diagnostics: [
        {
          severity: "error",
          message: PROBE_CONTRACT_MESSAGE,
          line: 1,
          column: 0,
          offset: 0,
        },
      ],
    });
    expect(
      checkDialectFile(project.path("a.probe"), '<service value="x"/>\n'),
    ).toEqual({ source: "Probe", diagnostics: [] });
    // Without `mx.contracts` the same call is just a tag.
    const plain = probeProject();
    expect(
      checkDialectFile(plain.path("a.probe"), "<service/>\n")?.diagnostics,
    ).toEqual([]);
  });

  it("a local tag template is seen: lowerSource says a dialect file cannot call it", () => {
    const project = probeProject({ "tags/card.mx": "<p/>\n" });
    expect(
      checkDialectFile(project.path("a.probe"), "<card/>\n")?.diagnostics,
    ).toEqual([
      {
        severity: "error",
        message:
          "`<card>` calls a template tag; a data file cannot call a template tag",
        line: 1,
        column: 0,
        offset: 0,
      },
    ]);
  });

  it("the scan's warning (a template shadows a contract) is the file's, under the dialect's source", () => {
    const project = probeProject(
      { "tags/service.mx": "<p/>\n" },
      { contracts: true },
    );
    const check = checkDialectFile(project.path("a.probe"), PROBE_SOURCES.ok);
    expect(check?.source).toBe("Probe");
    expect(check?.diagnostics).toHaveLength(1);
    expect(check?.diagnostics[0]).toMatchObject({
      severity: "warning",
      line: 1,
      column: 0,
      offset: 0,
    });
    expect(check?.diagnostics[0]?.message).toBe(
      `\`<service>\` from \`mx.contracts\` (${project.path("contracts.cjs")}) is shadowed by ${project.path("tags/service.mx")}; the module's contract does not apply (in ${project.path("tags/service.mx")}:1:1)`,
    );
  });

  it("a contract module that cannot load is reported on the file, not swallowed", () => {
    const project = probeProject(
      { "contracts.cjs": "module.exports = { default: 1 };\n" },
      { contracts: true },
    );
    const [diagnostic] =
      checkDialectFile(project.path("a.probe"), PROBE_SOURCES.ok)
        ?.diagnostics ?? [];
    expect(diagnostic).toMatchObject({ line: 1, column: 0, offset: 0 });
    expect(diagnostic?.message).toBe(
      `contracts module must \`export default\` a plain ContractMap object (in ${project.path("contracts.cjs")}:1:1)`,
    );
  });

  describe("a dialect's `explainUnknownTag`", () => {
    /** The probe dialect, with a hook that explains a name written against its tag. */
    const HOOK_MODULE = `module.exports.default = {
  tagRules: "none",
  table: {},
  explainUnknownTag(tag) {
    const colon = tag.name.indexOf(":");
    if (colon < 0) return undefined;
    if (tag.name === "boom:x") throw new Error("boom");
    return {
      code: "PROBE_UNSPACED",
      at: tag.nameSpan,
      message: "\\u0060" + tag.name + "\\u0060 writes the name against the tag: \\u0060" + tag.name.slice(0, colon) + " " + tag.name.slice(colon) + "\\u0060",
    };
  },
};
`;
    const explained = (
      name: string,
      line: number,
      column: number,
      offset: number,
    ) => ({
      severity: "error",
      message: `\`${name}\` writes the name against the tag: \`${name.slice(0, name.indexOf(":"))} ${name.slice(name.indexOf(":"))}\``,
      line,
      column,
      offset,
      code: "PROBE_UNSPACED",
    });

    it("gives its code and position through checkDialectFile, with the dialect named", () => {
      const project = probeProject({ "dialect.cjs": HOOK_MODULE });
      expect(
        checkDialectFile(
          project.path("a.probe"),
          "<y>\n  <entity:Todo/>\n</y>\n",
        ),
      ).toEqual({
        source: "Probe",
        diagnostics: [explained("entity:Todo", 2, 3, 7)],
      });
      expect(
        checkDialectFile(project.path("a.probe"), "entity:Todo\n")?.diagnostics,
      ).toEqual([explained("entity:Todo", 1, 0, 0)]);
    });

    it("runs in a file that also has a contract error: both diagnostics, the tag's one first", () => {
      const project = probeProject(
        { "dialect.cjs": HOOK_MODULE },
        { contracts: true },
      );
      const text = "entity:Todo\n<service/>\n";
      expect(
        checkDialectFile(project.path("a.probe"), text)?.diagnostics,
      ).toEqual([
        explained("entity:Todo", 1, 0, 0),
        {
          severity: "error",
          message: PROBE_CONTRACT_MESSAGE,
          line: 2,
          column: 0,
          offset: 12,
        },
      ]);
    });

    it("a name the hook leaves alone is no diagnostic in a dialect file (the open set)", () => {
      const project = probeProject({ "dialect.cjs": HOOK_MODULE });
      expect(
        checkDialectFile(project.path("a.probe"), "<entity/>\n")?.diagnostics,
      ).toEqual([]);
    });

    it("a hook that throws is one MX_DIALECT_HOOK_ERROR at the tag, not a thrown error", () => {
      const project = probeProject({ "dialect.cjs": HOOK_MODULE });
      expect(
        checkDialectFile(project.path("a.probe"), "<boom:x/>\n")?.diagnostics,
      ).toEqual([
        {
          severity: "error",
          message:
            "the dialect's `explainUnknownTag` threw while explaining `<boom:x>`: boom",
          line: 1,
          column: 0,
          offset: 0,
          code: "MX_DIALECT_HOOK_ERROR",
        },
      ]);
    });
  });

  it("`.probe.mx` is a dialect file too, by the longest extension", () => {
    const project = probeProject();
    expect(
      checkDialectFile(project.path("a.probe.mx"), PROBE_SOURCES.bad)
        ?.diagnostics[0]?.code,
    ).toBe("PROBE_BAD");
  });

  it.each([
    ["a plain .mx file", "page.mx"],
    ["a TypeScript file", "page.ts"],
    ["a .solid.mx file", "page.solid.mx"],
    ["a file named like the extension", ".probe"],
    ["a different extension", "page.probes"],
  ])("%s is not a dialect file", (_, name) => {
    const project = probeProject();
    expect(
      checkDialectFile(project.path(name), PROBE_SOURCES.bad),
    ).toBeUndefined();
    expect(isDialectFile(project.path(name))).toBe(false);
  });

  it("a project without a dialect has none, and an empty file is a clean dialect file", () => {
    const plain = probeProject({}, { manifest: null });
    expect(
      checkDialectFile(plain.path("a.probe"), PROBE_SOURCES.bad),
    ).toBeUndefined();
    const project = probeProject();
    expect(checkDialectFile(project.path("a.probe"), "")).toEqual({
      source: "Probe",
      diagnostics: [],
    });
  });

  it("a diagnostic measured in another file sits at the head of this one and says where it is", () => {
    // The module has no default export: the error is the module's (line 1,
    // column 0), not the dialect file's.
    const project = probeProject({ "dialect.cjs": "module.exports = {};\n" });
    expect(checkDialectFile(project.path("a.probe"), PROBE_SOURCES.ok)).toEqual(
      {
        source: "Probe",
        diagnostics: [
          {
            severity: "error",
            message: `dialect must \`export default\` a dialect object (\`{ table, lowerTrigger?, … }\`) (in ${project.path("dialect.cjs")}:1:1)`,
            line: 1,
            column: 0,
            offset: 0,
            origin: { file: project.path("dialect.cjs"), line: 1, column: 0 },
          },
        ],
      },
    );
  });

  describe("a dialect whose manifest is invalid", () => {
    // `tagDirs: 7` is a field error: the manifest says which extensions it
    // claims, so its files are still dialect files, and show the error.
    const invalid = () =>
      probeProject({}, { manifest: { tagDirs: 7 as never } });

    it("a non-.mx file of it shows the manifest field error, positioned in package.json", () => {
      const project = invalid();
      const packageFile = project.path("package.json");
      expect(
        checkDialectFile(project.path("a.probe"), PROBE_SOURCES.ok),
      ).toEqual({
        source: "mxlang",
        diagnostics: [
          {
            severity: "error",
            message: `\`mx.dialect.tagDirs\` must be an array of the directory names the dialect's files discover tags in (\`["components"]\`), or \`[]\` for none (in ${packageFile}:1:131)`,
            line: 1,
            column: 0,
            offset: 0,
            origin: { file: packageFile, line: 1, column: 130 },
          },
        ],
      });
      expect(isDialectFile(project.path("a.probe"))).toBe(true);
      expect(isDialectFile(project.path("a.ts"))).toBe(false);
    });

    it.each([
      [
        "reservedTags",
        5,
        '`mx.dialect.reservedTags` must be an array of the tag names only the dialect may define (`["entity"]`)',
      ],
      [
        "tagExtensions",
        "oops",
        '`mx.dialect.tagExtensions` must be an array of the extra file extensions the dialect\'s tag files use (`[".component.mesh.mx"]`)',
      ],
      [
        "tagExtensions",
        [".probe"],
        "`mx.dialect.tagExtensions` lists `.probe`, which `mx.dialect.extensions` already claims",
      ],
      [
        "sidecars",
        "no",
        "`mx.dialect.sidecars` must be a boolean: whether `<name>.tag.ts` sidecars index in the dialect's `tagDirs`",
      ],
      ["tagDirs", ["a", "a"], "`mx.dialect.tagDirs` lists `a` twice"],
      [
        "mxConfigTags",
        "no",
        "`mx.dialect.mxConfigTags` must be a boolean: whether the dialect's files take tag definitions from the project's `mx.tags` and `mx.contracts`",
      ],
    ])(
      "an invalid `%s` field (%j) is shown on the dialect file, at that field",
      (field, value, reason) => {
        const project = probeProject({}, { manifest: { [field]: value } });
        const packageFile = project.path("package.json");
        expect(
          checkDialectFile(project.path("a.probe"), PROBE_SOURCES.ok),
        ).toEqual({
          source: "mxlang",
          diagnostics: [
            {
              severity: "error",
              message: `${reason} (in ${packageFile}:1:131)`,
              line: 1,
              column: 0,
              offset: 0,
              origin: { file: packageFile, line: 1, column: 130 },
            },
          ],
        });
      },
    );

    it("the error is the one an .mx file of the project reaches: same message, same package.json position", () => {
      const project = invalid();
      const viaProbe = checkDialectFile(project.path("a.probe"), "")
        ?.diagnostics[0];
      let viaMx: unknown;
      try {
        routeDialect(project.path("a.mx"));
      } catch (error) {
        viaMx = error;
      }
      expect(viaMx).toMatchObject({
        message: viaProbe?.message.replace(/ \(in .*\)$/s, ""),
        file: viaProbe?.origin?.file,
        line: viaProbe?.origin?.line,
        column: viaProbe?.origin?.column,
      });
    });

    it("an .mx file is left to the ordinary compile, which reports the same error", () => {
      const project = invalid();
      expect(
        checkDialectFile(project.path("a.probe.mx"), PROBE_SOURCES.ok),
      ).toBeUndefined();
    });

    it("a dialect from a dependency with an invalid manifest shows the error in that package.json", () => {
      const project = probeProject({}, { manifest: null });
      const dependency = join(project.dir, "node_modules", "kit");
      mkdirSync(dependency, { recursive: true });
      writeFileSync(
        join(dependency, "package.json"),
        JSON.stringify({
          name: "kit",
          mx: {
            dialect: { ...PROBE_MANIFEST, tagDirs: ["../out"] },
          },
        }),
      );
      writeFileSync(join(dependency, "dialect.cjs"), PROBE_DIALECT_MODULE);
      writeFileSync(
        project.path("package.json"),
        JSON.stringify({ name: "app", dependencies: { kit: "0.0.0" } }),
      );
      const check = checkDialectFile(project.path("a.probe"), PROBE_SOURCES.ok);
      const manifestFile = join(dependency, "package.json");
      expect(check).toEqual({
        source: "mxlang",
        diagnostics: [
          {
            severity: "error",
            message: `\`mx.dialect.tagDirs\`: "../out" is a path; write a directory name (\`components\`) (in ${manifestFile}:1:121)`,
            line: 1,
            column: 0,
            offset: 0,
            origin: { file: manifestFile, line: 1, column: 120 },
          },
        ],
      });
    });

    it("emitOf calls the file unsettled, and dialectExtensions still lists what the manifest claims", () => {
      const project = invalid();
      expect(emitOf(project.path("a.probe"))).toEqual({
        name: "mxlang",
        emit: undefined,
        settled: false,
      });
      expect(dialectExtensions(project.dir)).toEqual([".probe", ".probe.mx"]);
    });

    it.each([
      ["a native extension", [".ts"]],
      ["MX's own extension", [".mx"]],
      ["a non-string entry", [".probe", 3]],
      ["a double dot", ["..probe"]],
      ["a space", [".pro be"]],
      ["a duplicate", [".probe", ".probe"]],
      ["not an array", "oops"],
      ["an empty array", []],
    ])(
      "an `extensions` list core would refuse (%s) claims nothing, with a bad tagDirs too",
      (_what, extensions) => {
        const project = probeProject(
          {},
          { manifest: { extensions, tagDirs: 7 } as never },
        );
        expect(dialectExtensions(project.dir)).toEqual([]);
        expect(isDialectFile(project.path("a.ts"))).toBe(false);
        expect(isDialectFile(project.path("a.probe"))).toBe(false);
        expect(checkDialectFile(project.path("a.ts"), "")).toBeUndefined();
        expect(checkDialectFile(project.path("a.probe"), "")).toBeUndefined();
      },
    );

    it("a `tagExtensions` list repeating one `extensions` entry (so core refuses it) is not claimed, `.concept` included", () => {
      const project = probeProject(
        {},
        { manifest: { tagExtensions: [".probe", ".concept"], tagDirs: 7 } },
      );
      expect(dialectExtensions(project.dir)).toEqual([".probe", ".probe.mx"]);
    });
  });

  describe("two dialects claim one extension", () => {
    const clash = () => {
      const project = probeProject(
        {},
        { packageJson: { devDependencies: { "other-dialect": "0.0.0" } } },
      );
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
              extensions: [".probe", ".probe.mx"],
              module: "./index.cjs",
            },
          },
        }),
      );
      writeFileSync(join(other, "index.cjs"), PROBE_DIALECT_MODULE);
      return project;
    };

    it("a non-.mx file gets the routing error under the fallback source", () => {
      const project = clash();
      const check = checkDialectFile(project.path("a.probe"), PROBE_SOURCES.ok);
      expect(check?.source).toBe("mxlang");
      expect(check?.diagnostics).toHaveLength(1);
      expect(check?.diagnostics[0]).toMatchObject({
        severity: "error",
        line: 1,
        column: 0,
        offset: 0,
      });
      expect(check?.diagnostics[0]?.message).toMatch(
        /^two dialects claim `\.probe`: `probe` \(probe-dialect\) and `other` \(other-dialect\)\. Choose one in `mx\.extensions` in MX's config: `"extensions": \{ "\.probe": "probe" \}` \(in .*package\.json:\d+:\d+\)$/s,
      );
      expect(dialectOf(project.path("a.probe"))).toBeUndefined();
      // Still a dialect file: the tools must not read it as TypeScript.
      expect(isDialectFile(project.path("a.probe"))).toBe(true);
      expect(isDialectFile(project.path("a.probe.mx"))).toBe(false);
    });

    it("an .mx file is left to the ordinary compile, which reports the same error", () => {
      const project = clash();
      expect(
        checkDialectFile(project.path("a.probe.mx"), PROBE_SOURCES.ok),
      ).toBeUndefined();
    });

    it("emitOf: a non-.mx file is unsettled, with no name and no emit; an .mx file is core's", () => {
      const project = clash();
      expect(emitOf(project.path("a.probe"))).toEqual({
        name: "mxlang",
        emit: undefined,
        settled: false,
      });
      const mx = emitOf(project.path("a.probe.mx"));
      expect(mx.name).toBe("MX");
      expect(mx.settled).toBe(true);
      expect(typeof mx.emit).toBe("function");
    });

    it("`mx.extensions` settles it", () => {
      const project = clash();
      writeFileSync(
        project.path("mx.config.json"),
        JSON.stringify({
          extensions: { ".probe": "probe", ".probe.mx": "probe" },
        }),
      );
      expect(
        checkDialectFile(project.path("a.probe"), PROBE_SOURCES.ok),
      ).toEqual({
        source: "Probe",
        diagnostics: [],
      });
    });
  });
});

/** A second dialect that discovers tags in `things/`, to meet a file in `tags/`. */
function withOtherDialect(project: ReturnType<typeof probeProject>): void {
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
  writeFileSync(join(other, "index.cjs"), PROBE_DIALECT_MODULE);
  writeFileSync(
    project.path("package.json"),
    JSON.stringify({
      name: "probe-dialect",
      mx: { dialect: PROBE_MANIFEST },
      devDependencies: { "other-dialect": "0.0.0" },
    }),
  );
}

describe("checkDialectFile: tag discovery diagnostics", () => {
  it("a call to a tag whose tag file has an error: MX_TAG_FILE_ERROR at the call, the file's own diagnostic with its file", () => {
    const project = tagDiscoveryProject({
      "concepts/money.thing.probe": "<x/>\n<!-- BAD -->\n",
    });
    const text = "<p/>\n<money/>\n";
    const check = checkDialectFile(project.path("a.probe"), text);
    expect(check?.source).toBe("Probe");
    expect(check?.diagnostics).toEqual([
      {
        severity: "error",
        message:
          "`<money>`'s definition has errors (concepts/money.thing.probe:2:5)",
        line: 2,
        column: 0,
        offset: 5,
        code: "MX_TAG_FILE_ERROR",
      },
      {
        severity: "error",
        message: `bad concept (in ${project.path("concepts/money.thing.probe")}:2:5)`,
        line: 1,
        column: 0,
        offset: 0,
        code: "KIT_BAD",
        origin: {
          file: project.path("concepts/money.thing.probe"),
          line: 2,
          column: 4,
        },
      },
    ]);
    // The call is at the offset the first diagnostic names.
    expect(text.slice(5)).toMatch(/^<money\/>/);
  });

  it("a tag file that is fine, in either tag directory, is a clean call", () => {
    const project = tagDiscoveryProject({
      "concepts/money.thing.probe": "<x/>\n",
      "kinds/unit.thing.probe": "<x/>\n",
    });
    expect(
      checkDialectFile(project.path("a.probe"), "<money/>\n<unit/>\n"),
    ).toEqual({ source: "Probe", diagnostics: [] });
  });

  it("a two-file cycle: MX_TAG_FILE_CYCLE with the file it was found in, and the definitions' errors at the calls", () => {
    const project = tagDiscoveryProject({
      "concepts/a.thing.probe": "<x/>\n<b/>\n",
      "concepts/b.thing.probe": "<a/>\n",
    });
    const check = checkDialectFile(project.path("a.probe"), "<p/>\n<a/>\n");
    const cycle = check?.diagnostics.find(
      (diagnostic) => diagnostic.code === "MX_TAG_FILE_CYCLE",
    );
    expect(cycle).toEqual({
      severity: "error",
      message: `tag files call each other in a cycle: concepts/a.thing.probe → concepts/b.thing.probe → concepts/a.thing.probe (in ${project.path("concepts/b.thing.probe")}:1:1)`,
      line: 1,
      column: 0,
      offset: 0,
      code: "MX_TAG_FILE_CYCLE",
      origin: {
        file: project.path("concepts/b.thing.probe"),
        line: 1,
        column: 0,
      },
    });
    // The caller's own call is reported at the call, with its own code.
    expect(check?.diagnostics[0]).toEqual({
      severity: "error",
      message: "`<a>`'s definition has errors (concepts/a.thing.probe:2:1)",
      line: 2,
      column: 0,
      offset: 5,
      code: "MX_TAG_FILE_ERROR",
    });
    expect(check?.diagnostics.every((d) => d.severity === "error")).toBe(true);
  });

  it("a file of another dialect in `tags/`: MX_MISPLACED_TAG_FILE keeps its warning severity, code and file", () => {
    // `Probe` has no `tagDirs`, so it walks `tags/` and meets `Other`'s file there.
    const project = tagDiscoveryProject({ "tags/m.other": "<x/>\n" });
    withOtherDialect(project);
    const check = checkDialectFile(project.path("a.probe"), "<p/>\n");
    expect(check?.diagnostics).toEqual([
      {
        severity: "warning",
        message: `\`tags/m.other\` is a Other file in \`tags/\`; Other discovers tags in \`things/\`. (in ${project.path("tags/m.other")}:1:1)`,
        line: 1,
        column: 0,
        offset: 0,
        code: "MX_MISPLACED_TAG_FILE",
        origin: { file: project.path("tags/m.other"), line: 1, column: 0 },
      },
    ]);
  });

  it("a registration error in the contracts module keeps the dialect's code, its severity and its file", () => {
    // The dialect's `checkContract` refuses the contracts module's entry,
    // with a code of its own, at the call of the tag.
    const project = tagDiscoveryProject({
      "dialect.cjs": `module.exports.default = {
  table: {},
  contractFields: { tag: ["relations"] },
  checkContract(tag, contract, ctx) { ctx.fail("no contract for " + tag, { code: "PROBE_CONTRACT" }); },
};
`,
      "contracts.cjs":
        "module.exports = { default: { service: { relations: 'many' } } };\n",
    });
    writeFileSync(
      project.path("package.json"),
      JSON.stringify({
        name: "probe-dialect",
        mx: {
          dialect: { ...PROBE_MANIFEST, ...PROBE_TAG_DIALECT },
          contracts: "./contracts.cjs",
        },
      }),
    );
    expect(
      checkDialectFile(project.path("a.probe"), "<service/>\n")?.diagnostics,
    ).toEqual([
      {
        severity: "error",
        message: `no contract for service (in ${project.path("contracts.cjs")}:1:1)`,
        line: 1,
        column: 0,
        offset: 0,
        code: "PROBE_CONTRACT",
        origin: { file: project.path("contracts.cjs"), line: 1, column: 0 },
      },
    ]);
  });

  it("records the files it read as dependencies: the tag files, and the contracts module", () => {
    const project = tagDiscoveryProject({
      "concepts/money.thing.probe": "<x/>\n",
    });
    const dependencies = new Set<string>();
    checkDialectFile(project.path("a.probe"), "<money/>\n", dependencies);
    expect([...dependencies]).toContain(
      project.path("concepts/money.thing.probe"),
    );
  });
});

describe("emitOf", () => {
  it("core's own files and files no dialect claims get core's emit", () => {
    const project = probeProject();
    for (const file of ["page.mx", "page.solid.mx", "util.ts"]) {
      const found = emitOf(project.path(file));
      expect(found.name).toBe("MX");
      expect(found.settled).toBe(true);
      expect(typeof found.emit).toBe("function");
    }
  });

  it("a dialect file gets its dialect's name and no emit", () => {
    const project = probeProject();
    for (const file of ["a.probe", "a.probe.mx"]) {
      expect(emitOf(project.path(file))).toEqual({
        name: "Probe",
        emit: undefined,
        settled: true,
      });
    }
  });
});

describe("dialectOf", () => {
  it("names the dialect of a dialect file, and nothing for any other", () => {
    const project = probeProject();
    expect(dialectOf(project.path("a.probe"))?.id).toBe("probe");
    expect(dialectOf(project.path("a.probe.mx"))?.name).toBe("Probe");
    expect(dialectOf(project.path("a.mx"))).toBeUndefined();
  });

  it("never throws for a path outside any package", () => {
    expect(dialectOf("/")).toBeUndefined();
    expect(dialectOf("")).toBeUndefined();
  });
});

describe("dialectExtensions", () => {
  it("lists what the project's dialects claim", () => {
    const project = probeProject();
    expect(dialectExtensions(project.dir)).toEqual([".probe", ".probe.mx"]);
    // From a nested directory, through the nearest package.json.
    expect(dialectExtensions(project.path("src/deep"))).toEqual([
      ".probe",
      ".probe.mx",
    ]);
  });

  it("adds an extension `mx.extensions` routes to a dialect", () => {
    const project = probeProject({
      "mx.config.json": JSON.stringify({ extensions: { ".tpl": "probe" } }),
    });
    expect(dialectExtensions(project.dir)).toEqual([
      ".probe",
      ".probe.mx",
      ".tpl",
    ]);
    expect(
      checkDialectFile(project.path("a.tpl"), PROBE_SOURCES.bad)?.diagnostics[0]
        ?.code,
    ).toBe("PROBE_BAD");
  });

  it("is empty without a dialect, without a package, and for a malformed manifest", () => {
    expect(dialectExtensions(probeProject({}, { manifest: null }).dir)).toEqual(
      [],
    );
    expect(dialectExtensions("/")).toEqual([]);
    const broken = probeProject({ "package.json": "{ not json" });
    expect(dialectExtensions(broken.dir)).toEqual([]);
  });
});

describe("dialectExtensions: tag files", () => {
  const withKinds = () =>
    probeProject(
      {},
      { manifest: { tagDirs: ["concepts"], tagExtensions: [".concept"] } },
    );

  it("lists a dialect's `tagExtensions` after its `extensions`, even one no claimed extension ends", () => {
    const project = withKinds();
    expect(dialectExtensions(project.dir)).toEqual([
      ".probe",
      ".probe.mx",
      ".concept",
    ]);
    expect(isDialectFile(project.path("concepts/money.concept"))).toBe(true);
    expect(isDialectFile(project.path("concepts/money.conceptual"))).toBe(
      false,
    );
  });

  it("lists the `tagExtensions` of every package under the root, and only of those", () => {
    const project = probeProject(
      {
        "pkg/package.json": JSON.stringify({
          name: "pkg",
          mx: {
            dialect: {
              ...PROBE_MANIFEST,
              tagDirs: ["concepts"],
              tagExtensions: [".concept"],
            },
          },
        }),
        "pkg/dialect.cjs": PROBE_DIALECT_MODULE,
        "other/package.json": JSON.stringify({ name: "other" }),
      },
      { manifest: null },
    );
    expect(dialectExtensionsUnder(project.dir)).toEqual([
      ".probe",
      ".probe.mx",
      ".concept",
    ]);
    expect(dialectExtensionsUnder(project.path("other"))).toEqual([]);
  });
});

describe("dialectExtensionsUnder", () => {
  it("unions the extensions of every package under the root, and only of those", () => {
    const project = probeProject(
      {
        "tsconfig.json": "{}",
        "pkg/package.json": JSON.stringify({
          name: "pkg",
          mx: { dialect: PROBE_MANIFEST },
        }),
        "pkg/dialect.cjs": PROBE_DIALECT_MODULE,
        "other/package.json": JSON.stringify({ name: "other" }),
        "node_modules/dep/package.json": JSON.stringify({
          name: "dep",
          mx: { dialect: { ...PROBE_MANIFEST, extensions: [".dep"] } },
        }),
        ".hidden/package.json": JSON.stringify({
          name: "hidden",
          mx: { dialect: { ...PROBE_MANIFEST, extensions: [".hid"] } },
        }),
      },
      { manifest: null },
    );
    // The root itself declares nothing: the package below it does.
    expect(dialectExtensions(project.dir)).toEqual([]);
    expect(dialectExtensionsUnder(project.dir)).toEqual([
      ".probe",
      ".probe.mx",
    ]);
    expect(dialectExtensionsUnder(project.path("other"))).toEqual([]);
  });

  it("is the root's own extensions, once, when the root declares the dialect", () => {
    const project = probeProject();
    expect(dialectExtensionsUnder(project.dir)).toEqual([
      ".probe",
      ".probe.mx",
    ]);
  });
});
