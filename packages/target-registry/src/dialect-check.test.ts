import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupProbeProjects,
  PROBE_DIALECT_MODULE,
  PROBE_SOURCES,
  probeProject,
} from "../../../test-fixtures/dialects/probe.ts";
import {
  checkDialectFile,
  dialectExtensions,
  dialectOf,
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
