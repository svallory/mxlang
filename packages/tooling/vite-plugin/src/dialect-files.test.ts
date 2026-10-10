import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupProbeProjects,
  PROBE_DIALECT_MODULE,
  PROBE_SOURCES,
  probeProject,
} from "../../../../test-fixtures/dialects/probe.ts";
import mx, { MX_SUFFIX } from "./index";

/**
 * A dialect file is built by its dialect, and a dialect registers no emit, so
 * the plugin refuses to import one: at the import (`resolveId`), and for an
 * entry or a hand-built id (`transform`). Every refusal is positioned in the
 * dialect file. A non-dialect `.mx` file is unaffected (index.test.ts pins
 * its output).
 */

afterEach(() => cleanupProbeProjects());

/** The slice of Vite's plugin context `resolveId` uses: relative ids against the importer. */
const context = {
  async resolve(id: string, importer?: string) {
    if (!id.startsWith(".") || !importer) return null;
    return { id: resolvePath(dirname(importer), id) };
  },
};

type Hook = (this: unknown, ...args: string[]) => Promise<unknown>;

function hooks() {
  const plugin = mx();
  return {
    resolveId: plugin.resolveId as unknown as Hook,
    transform: plugin.transform as unknown as Hook,
  };
}

interface Refusal {
  message: string;
  id: string;
  loc: { file: string; line: number; column: number };
  frame?: string;
  stack: string;
}

async function refusal(run: () => Promise<unknown>): Promise<Refusal> {
  try {
    await run();
  } catch (error) {
    return error as Refusal;
  }
  throw new Error("expected a refusal, got a result");
}

const NO_EMIT = "Probe files cannot be imported: the dialect registers no emit";

/** A TypeScript importer whose third line imports `specifier`. */
const importer = (specifier: string) =>
  `// entry\nconst before = 1;\nimport ${JSON.stringify(specifier)};\n`;

describe("importing a dialect file", () => {
  it.each([
    ["an extension of its own", "./a.probe"],
    ["an extension that ends in .mx", "./a.probe.mx"],
  ])(
    "is refused with the exact text, at the import in the importing file (%s)",
    async (_, specifier) => {
      const project = probeProject({
        "a.probe": PROBE_SOURCES.ok,
        "a.probe.mx": PROBE_SOURCES.ok,
        "main.ts": importer(specifier),
      });
      const main = project.path("main.ts");
      const error = await refusal(() =>
        hooks().resolveId.call(context, specifier, main),
      );
      expect(error.message).toBe(NO_EMIT);
      expect(error.id).toBe(main);
      expect(error.loc).toEqual({ file: main, line: 3, column: 7 });
      expect(error.frame).toBe(`3 | import "${specifier}";\n           ^`);
      // Rolldown prints the stack after the position: only name and message.
      expect(error.stack).toBe(`Error: ${NO_EMIT}`);
      expect((error as unknown as { pluginCode: string }).pluginCode).toBe(
        importer(specifier),
      );
    },
  );

  it("an .mx importer is pointed at in its authored source, not the module this plugin mints", async () => {
    const project = probeProject({
      "a.probe": PROBE_SOURCES.ok,
      "page.mx": 'import "./a.probe"\n<p/>\n',
    });
    const page = project.path("page.mx");
    const error = await refusal(() =>
      hooks().resolveId.call(context, "./a.probe", `${page}${MX_SUFFIX}`),
    );
    expect(error.message).toBe(NO_EMIT);
    expect(error.id).toBe(page);
    expect(error.loc).toEqual({ file: page, line: 1, column: 7 });
    expect(error.frame).toBe('1 | import "./a.probe"\n           ^');
  });

  it("the refusal is the text even when the dialect file has an error of its own", async () => {
    const project = probeProject({
      "a.probe": PROBE_SOURCES.bad,
      "main.ts": importer("./a.probe"),
    });
    const main = project.path("main.ts");
    const error = await refusal(() =>
      hooks().resolveId.call(context, "./a.probe", main),
    );
    expect(error.message).toBe(NO_EMIT);
    expect(error.loc).toEqual({ file: main, line: 3, column: 7 });
  });

  it("falls back to the head of the dialect file when the import is not written in the importer", async () => {
    // No importer on disk (a hand-built id, an import the emitter added).
    const project = probeProject({ "a.probe": PROBE_SOURCES.ok });
    const file = project.path("a.probe");
    const error = await refusal(() =>
      hooks().resolveId.call(context, "./a.probe", project.path("main.ts")),
    );
    expect(error.message).toBe(NO_EMIT);
    expect(error.id).toBe(file);
    expect(error.loc).toEqual({ file, line: 1, column: 0 });
    expect(error.frame).toBe("1 | <y !ok/>\n    ^");
  });

  it("an entry or a hand-built id reaches transform, which refuses at the head of the file", async () => {
    const project = probeProject({ "a.probe.mx": PROBE_SOURCES.bad });
    const file = project.path("a.probe.mx");
    const error = await refusal(() =>
      hooks().transform.call({}, PROBE_SOURCES.bad, `${file}${MX_SUFFIX}`),
    );
    expect(error.message).toBe(NO_EMIT);
    expect(error.loc).toEqual({ file, line: 1, column: 0 });
  });

  it("names the dialect by its name, not its id or package", async () => {
    const project = probeProject(
      { "a.probe": PROBE_SOURCES.ok },
      { manifest: { name: "Probe Lang" } },
    );
    const error = await refusal(() =>
      hooks().resolveId.call(context, "./a.probe", project.path("main.ts")),
    );
    expect(error.message).toBe(
      "Probe Lang files cannot be imported: the dialect registers no emit",
    );
  });

  it("a warning-free empty dialect file is still refused", async () => {
    const project = probeProject({ "a.probe": "" });
    const error = await refusal(() =>
      hooks().resolveId.call(context, "./a.probe", project.path("main.ts")),
    );
    expect(error.message).toBe(NO_EMIT);
    expect(error.loc).toEqual({
      file: project.path("a.probe"),
      line: 1,
      column: 0,
    });
  });

  it("two dialects claim the extension: no dialect has a name, so the routing error is the refusal", async () => {
    const project = probeProject(
      { "a.probe": PROBE_SOURCES.ok, "main.ts": importer("./a.probe") },
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
            extensions: [".probe"],
            module: "./index.cjs",
          },
        },
      }),
    );
    writeFileSync(join(other, "index.cjs"), PROBE_DIALECT_MODULE);
    const file = project.path("a.probe");
    const error = await refusal(() =>
      hooks().resolveId.call(context, "./a.probe", project.path("main.ts")),
    );
    expect(error.message).toMatch(
      /^two dialects claim `\.probe`: `probe` \(probe-dialect\) and `other` \(other-dialect\)\./,
    );
    expect(error.loc).toEqual({ file, line: 1, column: 0 });
  });

  it("a query does not hide the file", async () => {
    const project = probeProject({ "a.probe": PROBE_SOURCES.ok });
    const error = await refusal(() =>
      hooks().resolveId.call(
        context,
        "./a.probe?import",
        project.path("main.ts"),
      ),
    );
    expect(error.message).toBe(NO_EMIT);
  });

  it("`?raw` is the file's text, not a build of it: left to Vite", async () => {
    const project = probeProject({ "a.probe": PROBE_SOURCES.ok });
    expect(
      await hooks().resolveId.call(
        context,
        "./a.probe?raw",
        project.path("main.ts"),
      ),
    ).toBeNull();
  });
});

describe("what is not a dialect file", () => {
  it("a plain .mx file in a dialect project resolves as before", async () => {
    const project = probeProject({ "page.mx": "<p/>\n" });
    expect(
      await hooks().resolveId.call(
        context,
        "./page.mx",
        project.path("main.ts"),
      ),
    ).toBe(`${project.path("page.mx")}${MX_SUFFIX}`);
  });

  it("a .probe file in a project with no dialect is left alone", async () => {
    const project = probeProject(
      { "a.probe": PROBE_SOURCES.ok },
      { manifest: null },
    );
    expect(
      await hooks().resolveId.call(
        context,
        "./a.probe",
        project.path("main.ts"),
      ),
    ).toBeNull();
  });

  it("other imports of a dialect project are left alone", async () => {
    const project = probeProject({ "util.ts": "export {};\n" });
    expect(
      await hooks().resolveId.call(
        context,
        "./util.ts",
        join(project.dir, "main.ts"),
      ),
    ).toBeNull();
  });
});
