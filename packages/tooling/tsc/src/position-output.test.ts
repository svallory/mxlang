import {
  cpSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../../hosts/angular/src/cli.ts";
import { runInProcess } from "./in-process.ts";
import { fixtures, SPAWN_TIMEOUT_MS } from "./test-support.ts";

/**
 * Where `mx-tsc` and `mx-angular build` point for the same `.ng.mx` problem
 * (agent-feedback audit item 13): one location per line, and the same 1-based
 * column on both surfaces.
 */
const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true });
  vi.restoreAllMocks();
  return new Promise<void>((resolve) => setImmediate(resolve));
});

/** A copy of a fixture project outside the repo, so a build writes no files into it. */
function copyOf(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-position-")));
  created.push(dir);
  cpSync(join(fixtures, name), dir, { recursive: true });
  // `mx-angular build` takes its host and file set from `package.json#mx`.
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name,
      mx: {
        host: "angular",
        angular: { include: ["src/**/*.mx"], diagnostics: "off" },
      },
    }),
  );
  return dir;
}

function tscLines(dir: string): { status: number; lines: string[] } {
  const run = runInProcess(["--noEmit", "-p", "tsconfig.json"], dir);
  return {
    status: run.status,
    lines: stripVTControlCharacters(run.stdout + run.stderr)
      .split("\n")
      .filter((line) => line !== "")
      // tsc prints the path relative to the cwd, which differs per runner.
      .map((line) => line.slice(Math.max(line.indexOf("src/x.component"), 0))),
  };
}

/** What `mx-angular build` prints for a project, one entry per line. */
async function buildLines(
  dir: string,
): Promise<{ status: number; lines: string[] }> {
  const lines: string[] = [];
  const push = (text: unknown) => void lines.push(String(text));
  vi.spyOn(console, "warn").mockImplementation(push);
  vi.spyOn(console, "error").mockImplementation(push);
  vi.spyOn(console, "log").mockImplementation(push);
  const status = await runCli(["build", "--project", dir]);
  return { status, lines };
}

describe("TS80001 carries one location", () => {
  it(
    "mx-tsc prints `file(L,C)` and no second `(L:C)` at the end of the message",
    () => {
      const { status, lines } = tscLines(
        join(fixtures, "ng-structural-attr-failing"),
      );
      expect(lines).toEqual([
        "src/x.component.ng.mx(5,28): error TS80001: `*ngIf` cannot follow another attribute: after `class=…`, Marko reads it as a multiplication, so this does not parse. Make it the first attribute of the tag, or write `<if=cond>…</if>` instead.",
      ]);
      expect(status).toBe(1);
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe("mx-tsc and mx-angular build agree on the column", () => {
  it(
    "a `{{ n }}` literal-syntax warning is at 5,16 (1-based) on both",
    async () => {
      const dir = copyOf("ng-literal-syntax");
      const message = `\`{{ n }}\` is literal text in an MX template, not an Angular interpolation. Write \`\${n}\`, or use \`\${"{{"}\` for literal braces.`;

      const tsc = tscLines(join(fixtures, "ng-literal-syntax"));
      expect(tsc.lines).toEqual([
        `src/x.component.ng.mx(5,16): warning TS80002: ${message}`,
      ]);
      expect(tsc.status).toBe(0);

      const build = await buildLines(dir);
      expect(build.lines.map((l) => l.replace(`${dir}/`, ""))).toContain(
        `src/x.component.ng.mx:5:16 warning: ${message}`,
      );
      expect(build.status).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "a `*ngIf` placed after another attribute is at 5,28 (1-based) on both",
    async () => {
      const dir = copyOf("ng-structural-attr-failing");
      const tsc = tscLines(join(fixtures, "ng-structural-attr-failing"));
      expect(tsc.lines[0]).toMatch(
        /^src\/x\.component\.ng\.mx\(5,28\): error TS80001/,
      );
      const build = await buildLines(dir);
      expect(build.lines).toHaveLength(1);
      expect(build.lines[0]?.replace(`${dir}/`, "")).toMatch(
        /^src\/x\.component\.ng\.mx:5:28 error: `\*ngIf` cannot follow another attribute/,
      );
      expect(build.status).toBe(1);
    },
    SPAWN_TIMEOUT_MS,
  );
});
