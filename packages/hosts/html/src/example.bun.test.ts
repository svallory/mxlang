import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

// `bun run example <fixture>` is advertised in the README and is the first
// thing a reader runs. It executes the emitted module, so it breaks whenever
// that module's shape changes and the compile-only suites stay green. This
// runs the real script against every fixture that is meant to run.

const pkg = join(import.meta.dirname, "..");
const fixtures = join(pkg, "fixtures-marko");

/** Fixtures whose `meta.json` says stock Marko skips or rejects them never render. */
function isRunnable(name: string): boolean {
  const meta = join(fixtures, name, "meta.json");
  if (!existsSync(meta)) return true;
  const { marko } = JSON.parse(readFileSync(meta, "utf8")) as {
    marko?: string;
  };
  return marko !== "skip" && marko !== "error";
}

async function runExample(name: string) {
  const proc = Bun.spawn(["bun", "src/example.ts", name], {
    cwd: pkg,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/**
 * Every fixture must run silent, except where it deliberately trips a warning.
 * `spread-between-props` writes `name` before and after a spread, and the
 * earlier one is dead on every host, so it is a real duplicate attribute.
 * `src/example.ts` compiles each fixture twice (once to print the module,
 * line 19, and once in the Bun loader's onLoad, line 44), so the one warning
 * per compile shows up as two identical lines. Columns in the text are 1-based.
 */
const DUPLICATE_NAME =
  "fixtures-marko/spread-between-props/input.marko:3:38: duplicate attribute `name`: also written at 3:11; keep one, because which value wins depends on the target";
const EXPECTED_STDERR: Record<string, string> = {
  "spread-between-props": `${DUPLICATE_NAME}\n${DUPLICATE_NAME}`,
};

/** ANSI-stripped stderr with the machine-specific path prefix cut off each line. */
function normalizeStderr(stderr: string): string {
  return stripVTControlCharacters(stderr)
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const at = line.indexOf("fixtures-marko/");
      return at < 0 ? line : line.slice(at);
    })
    .join("\n");
}

const runnable = readdirSync(fixtures).filter(isRunnable);

describe("bun run example", () => {
  test("has fixtures to run", () => {
    expect(runnable).toContain("class-object");
    expect(runnable).toContain("nested-layout");
  });

  test("every example the README names is a runnable fixture", () => {
    const readme = readFileSync(join(pkg, "README.md"), "utf8");
    const named = [...readme.matchAll(/bun run example\s+([\w-]+)/g)].map(
      (m) => m[1] as string,
    );
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) expect(runnable).toContain(name);
  });

  for (const name of runnable) {
    test(`renders ${name}`, async () => {
      const { stdout, stderr, exitCode } = await runExample(name);
      expect({ exitCode, stderr: normalizeStderr(stderr) }).toEqual({
        exitCode: 0,
        stderr: EXPECTED_STDERR[name] ?? "",
      });
      const rendered = stdout.split(/^--- rendered with .*---$/m)[1]?.trim();
      expect(rendered).toBeTruthy();
    }, 30_000);
  }
});
