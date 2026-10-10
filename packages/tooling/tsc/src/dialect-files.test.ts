import { writeFileSync } from "node:fs";
import { relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupProbeProjects,
  PROBE_SOURCES,
  probeProject,
} from "../../../../test-fixtures/dialects/probe.ts";
import { runInProcess } from "./in-process.ts";

/**
 * `mx-tsc` checks a dialect's files with `lowerSource` and prints what it
 * reports: the dialect's own code where TypeScript prints `TS<number>`, at the
 * position in the dialect file. No JavaScript is generated for them.
 */

afterEach(() => cleanupProbeProjects());

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    noEmit: true,
    module: "esnext",
    moduleResolution: "bundler",
    target: "esnext",
    jsx: "preserve",
    types: [],
  },
  include: ["**/*.probe", "**/*.probe.mx", "**/*.mx"],
});

/** tsc prints a path relative to the working directory. */
const shown = (file: string) => relative(process.cwd(), file);

function run(files: Record<string, string>) {
  const project = probeProject({ "tsconfig.json": TSCONFIG, ...files });
  const result = runInProcess(["-p", project.dir, "--pretty", "false"]);
  return {
    project,
    status: result.status,
    output: stripVTControlCharacters(result.stderr + result.stdout),
  };
}

describe("mx-tsc on a dialect's files", () => {
  it("prints the dialect's diagnostic with its own code, at its position", {
    timeout: 120_000,
  }, () => {
    const { project, status, output } = run({ "a.probe": PROBE_SOURCES.bad });
    expect(status).toBe(1);
    expect(output).toBe(
      `${shown(project.path("a.probe"))}(1,4): error PROBE_BAD: bad probe\n`,
    );
  });

  it("a `.probe.mx` file is the dialect's, not an MX file", {
    timeout: 120_000,
  }, () => {
    const { project, status, output } = run({
      "a.probe.mx": PROBE_SOURCES.bad,
    });
    expect(status).toBe(1);
    expect(output).toBe(
      `${shown(project.path("a.probe.mx"))}(1,4): error PROBE_BAD: bad probe\n`,
    );
  });

  it("a diagnostic with no code prints as MX's own error", {
    timeout: 120_000,
  }, () => {
    const { project, status, output } = run({ "a.probe": "<y x=(/>\n" });
    expect(status).toBe(1);
    expect(output).toBe(
      `${shown(project.path("a.probe"))}(1,7): error TS80001: EOL reached while parsing regular expression\n`,
    );
  });

  it("checks under the dialect's tagRules: `<input>` is no void element", {
    timeout: 120_000,
  }, () => {
    const { project, status, output } = run({
      "a.probe": PROBE_SOURCES.noRules,
    });
    expect(status).toBe(1);
    expect(output).toBe(
      `${shown(project.path("a.probe"))}(1,1): error TS80001: Missing ending "input" tag\n`,
    );
  });

  it("a clean dialect file passes, and no JavaScript is written", {
    timeout: 120_000,
  }, () => {
    const { status, output } = run({ "a.probe": PROBE_SOURCES.ok });
    expect(status).toBe(0);
    expect(output).toBe("");
  });

  it("a plain .mx file in the same project is checked as before", {
    timeout: 120_000,
  }, () => {
    const { project, status, output } = run({ "page.mx": "<div>\n" });
    expect(status).toBe(1);
    expect(output).toContain(`${project.path("page.mx")}`);
    expect(output).toContain('Missing ending "div" tag');
    expect(output).not.toContain("PROBE_BAD");
  });

  it("a project with no dialect does not pick up the extension", {
    timeout: 120_000,
  }, () => {
    const project = probeProject(
      { "tsconfig.json": TSCONFIG, "a.probe": PROBE_SOURCES.bad },
      { manifest: null },
    );
    writeFileSync(project.path("ok.mx"), "<p>ok</p>\n");
    const result = runInProcess(["-p", project.dir, "--pretty", "false"]);
    expect(
      stripVTControlCharacters(result.stderr + result.stdout),
    ).not.toContain("PROBE_BAD");
  });
});
