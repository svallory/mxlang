import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { diagnoseDocument } from "../../language-server/src/diagnose.ts";
import { runInProcess } from "./in-process.ts";

/**
 * An unknown `mx.host` resolves to a derived or default host. The language
 * server and `mx-tsc` must compile an `.mx` page under that same host, so
 * they report the same compile error at the same position.
 */
const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true });
});

// `@mxlang/core` is the language server's dependency, not this package's:
// resolve it from the server so both sides use the copy the server runs.
const lsRequire = createRequire(
  join(import.meta.dirname, "../../language-server/package.json"),
);
const { resolveHostPolicyDetailed } = (await import(
  pathToFileURL(lsRequire.resolve("@mxlang/core")).href
)) as {
  resolveHostPolicyDetailed(file: string): {
    policy: Parameters<typeof diagnoseDocument>[2];
    diagnostics: NonNullable<
      Parameters<typeof diagnoseDocument>[8]
    > extends readonly (infer D)[]
      ? D[]
      : never;
  };
};

/**
 * The compiler's code frame: everything from the `> 1 |` marker on, without
 * colour. CI colourises the frame (agent shells inject NO_COLOR, CI does not),
 * which hides the marker from a raw `indexOf`; strip ANSI first, and fail
 * loudly when the marker is missing rather than slicing from -1.
 */
function frameOf(text: string): string {
  const plain = stripVTControlCharacters(text);
  const at = plain.indexOf("> 1 |");
  expect(at, `no "> 1 |" code frame in: ${plain}`).toBeGreaterThanOrEqual(0);
  // Dedent to the marker, as the LS's `data.codeFrame` is: mx-tsc indents the
  // frame under its `at` line, the LS carries it bare.
  const indent = at - (plain.lastIndexOf("\n", at) + 1);
  return plain
    .slice(at)
    .split("\n")
    .map((l, i) => (i === 0 ? l : l.replace(new RegExp(`^ {0,${indent}}`), "")))
    .join("\n");
}

const fixtures = join(import.meta.dirname, "fixtures");

describe("unknown mx.host: language server and mx-tsc agree", () => {
  // Runs `mx-tsc` in this process; under a loaded machine (the whole package's
  // files in parallel) it can pass vitest's 5 s default.
  it("report the same compile error, message and position, for an .mx page", {
    timeout: 60_000,
  }, () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-unknown-host-")));
    created.push(dir);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "tmp", mx: { host: "vue" } }),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      readFileSync(join(fixtures, "ng-mx-passing", "tsconfig.json"), "utf8"),
    );
    mkdirSync(join(dir, "src"));
    const page = join(dir, "src", "page.mx");
    const source = "<div>\n  <p>hi</p>\n";
    writeFileSync(page, source);
    writeFileSync(
      join(dir, "src", "main.ts"),
      'import render from "./page.mx";\nconsole.log(render({}));\n',
    );

    const { policy, diagnostics: policyDiagnostics } =
      resolveHostPolicyDetailed(page);
    const ls = diagnoseDocument(
      source,
      pathToFileURL(page).href,
      policy,
      undefined,
      "",
      undefined,
      undefined,
      undefined,
      policyDiagnostics,
    );
    const lsError = ls.find((d) => d.severity === 1);

    const run = runInProcess(["--noEmit", "-p", "tsconfig.json"], dir);
    const tsc = { stdout: run.stdout + run.stderr };

    // Same position: LS is 0-based, mx-tsc prints `page.mx(line,col)`.
    expect(lsError).toBeDefined();
    const start = lsError?.range.start;
    const at = `page.mx(${(start?.line ?? -1) + 1},${(start?.character ?? -1) + 1})`;
    const atPretty = `page.mx:${(start?.line ?? -1) + 1}:${(start?.character ?? -1) + 1}`;
    const plainTsc = stripVTControlCharacters(tsc.stdout);
    const tscLine = plainTsc
      .split("\n")
      .find((l) => l.includes(at) || l.includes(atPretty));
    expect(tscLine, plainTsc).toContain("error TS80001");

    // Same message: the LS keeps the compact error text in `message` and the
    // compiler's frame in `data.codeFrame`; mx-tsc prints both in one
    // diagnostic. The compact text must be mx-tsc's own, and the frame must
    // be the very frame mx-tsc prints.
    expect(lsError?.message).toBe('Missing ending "div" tag');
    // mx-tsc prints that text on the frame's caret line, after the carets.
    expect(stripVTControlCharacters(tsc.stdout)).toMatch(
      new RegExp(`^\\s*\\|\\s*\\^+ ${lsError?.message}$`, "m"),
    );
    const lsFrame = (lsError?.data as { codeFrame?: string } | undefined)
      ?.codeFrame;
    expect(lsFrame, "LS diagnostic carries data.codeFrame").toBeDefined();
    expect(lsFrame).toBe(stripVTControlCharacters(lsFrame ?? ""));
    expect(lsFrame).toContain('Missing ending "div" tag');
    expect(frameOf(tsc.stdout)).toContain(lsFrame?.trimEnd());
  });
});

describe("frameOf", () => {
  it("finds the frame in a colourised message, as CI renders it", () => {
    const coloured = "\n    at x.mx:1:1\n    \u001b[31m>\u001b[0m 1 |";
    // A raw `indexOf("> 1 |")` misses this: the colour splits the marker.
    expect(coloured.indexOf("> 1 |")).toBe(-1);
    expect(frameOf(`${coloured} <div>`)).toBe("> 1 | <div>");
  });
});
