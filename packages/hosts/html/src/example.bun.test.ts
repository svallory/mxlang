import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      const rendered = stdout.split(/^--- rendered with .*---$/m)[1]?.trim();
      expect(rendered).toBeTruthy();
    }, 30_000);
  }
});
