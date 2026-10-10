import { dirname, join, resolve as resolvePath } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupProbeProjects,
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

describe("importing a dialect file", () => {
  it.each([
    ["an extension of its own", "./a.probe"],
    ["an extension that ends in .mx", "./a.probe.mx"],
  ])(
    "is refused with the exact text, at the head of the file (%s)",
    async (_, specifier) => {
      const project = probeProject({
        "a.probe": PROBE_SOURCES.ok,
        "a.probe.mx": PROBE_SOURCES.ok,
      });
      const file = project.path(specifier.slice(2));
      const error = await refusal(() =>
        hooks().resolveId.call(context, specifier, project.path("main.ts")),
      );
      expect(error.message).toBe(NO_EMIT);
      expect(error.id).toBe(file);
      expect(error.loc).toEqual({ file, line: 1, column: 0 });
      expect(error.frame).toBe("1 | <y !ok/>\n    ^");
      // Rolldown prints the stack after the position: only name and message.
      expect(error.stack).toBe(`Error: ${NO_EMIT}`);
    },
  );

  it("an entry or a hand-built id reaches transform, which refuses the same way", async () => {
    const project = probeProject({ "a.probe.mx": PROBE_SOURCES.ok });
    const file = project.path("a.probe.mx");
    const error = await refusal(() =>
      hooks().transform.call({}, PROBE_SOURCES.ok, `${file}${MX_SUFFIX}`),
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

  it("a dialect file with an error reports that error first, at its position", async () => {
    const project = probeProject({ "a.probe": PROBE_SOURCES.bad });
    const file = project.path("a.probe");
    const error = await refusal(() =>
      hooks().resolveId.call(context, "./a.probe", project.path("main.ts")),
    );
    expect(error.message).toBe("bad probe");
    expect(error.loc).toEqual({ file, line: 1, column: 3 });
    expect(error.frame).toBe("1 | <y !bad/>\n       ^");
  });

  it("a warning-free empty dialect file is still refused", async () => {
    const project = probeProject({ "a.probe": "" });
    const error = await refusal(() =>
      hooks().resolveId.call(context, "./a.probe", project.path("main.ts")),
    );
    expect(error.message).toBe(NO_EMIT);
    expect(error.loc.line).toBe(1);
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
