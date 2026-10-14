import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupProbeProjects,
  PROBE_FIX_DIALECT_MODULE,
  PROBE_FIX_SOURCE,
  probeProject,
} from "../../../../test-fixtures/dialects/probe.ts";
import { formatFixLines } from "./fix-lines.ts";
import { runInProcess } from "./in-process.ts";

/**
 * A diagnostic that carries quick fixes prints them under its own line, one
 * `  fix: <title>: <edit>; <edit>` line per fix, so an agent reading the
 * compiler output can apply them without an editor.
 */
const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true });
  cleanupProbeProjects();
});

/** The lines `mx-tsc` prints for a one-file html project, colour-free. */
function output(file: string, source: string, flags: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "mx-fix-output-"));
  created.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ mx: { host: "html" } }),
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        skipLibCheck: true,
        types: [],
        module: "ESNext",
        moduleResolution: "Bundler",
      },
      files: [file],
    }),
  );
  writeFileSync(join(dir, file), source);
  const run = runInProcess(["--noEmit", ...flags, "-p", "tsconfig.json"], dir);
  // tsc prints the path relative to the working directory; keep from `file(`.
  return stripVTControlCharacters(run.stdout + run.stderr).replace(
    new RegExp(`^.*?(?=${file.replace(".", "\\.")}\\()`),
    "",
  );
}

describe("mx-tsc prints the fixes a diagnostic carries", () => {
  it("`<effect>`: the rename, one edit per tag, 1-based positions", {
    timeout: 120_000,
  }, () => {
    expect(output("page.mx", "<div>\n  <effect>go()</effect>\n</div>\n")).toBe(
      'page.mx(2,4): error MX_RESERVED_EFFECT_TAG: `<effect>` is not an MX tag. Use `<script>`: its body runs after render and again when a value it reads changes.\n  fix: Rename to `<script>`: replace 2:4-2:10 with "script"; replace 2:17-2:23 with "script"\n',
    );
  });

  it("`--pretty` and the plain output carry the same fix line", {
    timeout: 120_000,
  }, () => {
    const source = "<div>\n  <effect>go()</effect>\n</div>\n";
    const plain = output("page.mx", source, ["--pretty", "false"]);
    expect(output("page.mx", source, ["--pretty"])).toBe(plain);
    expect(plain).toContain(
      '  fix: Rename to `<script>`: replace 2:4-2:10 with "script"; replace 2:17-2:23 with "script"\n',
    );
  });

  it("CRLF line ends and a character outside the BMP: columns count UTF-16 units", {
    timeout: 120_000,
  }, () => {
    const text = output(
      "page.mx",
      "<div>\r\n  <p>\u{1F600}</p><effect>go()</effect>\r\n</div>\r\n",
    );
    // `  <p>` is 5 units, the emoji 2, `</p>` 4: `<effect>` starts at column 12.
    expect(text).toBe(
      'page.mx(2,13): error MX_RESERVED_EFFECT_TAG: `<effect>` is not an MX tag. Use `<script>`: its body runs after render and again when a value it reads changes.\n  fix: Rename to `<script>`: replace 2:13-2:19 with "script"; replace 2:26-2:32 with "script"\n',
    );
  });

  it("a file with no fix prints no fix line", { timeout: 120_000 }, () => {
    const text = output("page.mx", "<for|x|/>\n");
    expect(text).toContain("error MX_INVALID_FOR: ");
    expect(text).not.toContain("  fix:");
  });

  it("a dialect's diagnostic prints its fix", { timeout: 120_000 }, () => {
    const project = probeProject({
      "dialect.cjs": PROBE_FIX_DIALECT_MODULE,
      "a.probe": PROBE_FIX_SOURCE,
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          noEmit: true,
          module: "esnext",
          moduleResolution: "bundler",
          target: "esnext",
          types: [],
        },
        include: ["**/*.probe"],
      }),
    });
    const result = runInProcess(["-p", project.dir, "--pretty", "false"]);
    const text = stripVTControlCharacters(result.stderr + result.stdout);
    expect(result.status).toBe(1);
    expect(
      text.endsWith(
        '(1,4): error PROBE_FIXABLE: fixable probe\n  fix: Replace with `!ok`: replace 1:4-1:8 with "!ok"\n',
      ),
    ).toBe(true);
  });
});

describe("formatFixLines", () => {
  const position = (offset: number) => ({ line: 0, character: offset });

  it("an insertion, a deletion and a replacement", () => {
    expect(
      formatFixLines(
        [
          {
            title: "Tidy",
            edits: [
              { offset: 0, end: 0, newText: "a" },
              { offset: 2, end: 5, newText: "" },
              { offset: 6, end: 7, newText: "b" },
            ],
          },
        ],
        position,
      ),
    ).toBe(
      '  fix: Tidy: insert at 1:1 "a"; delete 1:3-1:6; replace 1:7-1:8 with "b"\n',
    );
  });

  it("new text is JSON-quoted: newlines, quotes and backslashes stay on one line", () => {
    expect(
      formatFixLines(
        [{ title: "Q", edits: [{ offset: 0, end: 1, newText: 'a\n"b"\\' }] }],
        position,
      ),
    ).toBe('  fix: Q: replace 1:1-1:2 with "a\\n\\"b\\"\\\\"\n');
  });

  it("one line per fix, in order; no fixes, no text", () => {
    expect(
      formatFixLines(
        [
          { title: "One", edits: [{ offset: 0, end: 1, newText: "x" }] },
          { title: "Two", edits: [{ offset: 1, end: 2, newText: "y" }] },
        ],
        position,
      ),
    ).toBe(
      '  fix: One: replace 1:1-1:2 with "x"\n  fix: Two: replace 1:2-1:3 with "y"\n',
    );
    expect(formatFixLines([], position)).toBe("");
  });
});
