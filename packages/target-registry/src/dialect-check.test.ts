import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupProbeProjects,
  PROBE_CONTRACT_MESSAGE,
  PROBE_DIALECT_MODULE,
  PROBE_MANIFEST,
  PROBE_SOURCES,
  probeProject,
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
          },
        ],
      },
    );
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
