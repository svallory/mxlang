/**
 * The html module of a template whose source has a keyword-less top-level
 * form: what stock Marko 6.4.4 compiles must also pass Bun's TypeScript strip
 * (a refused form would not: two default exports are `Multiple exports with
 * the same name "default"`). Probed on stock with
 * `bun run --cwd packages/stock-marko probe '<source>'`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "./index.ts";

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(homedir(), "tmp", "bare-top-level-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let count = 0;
/** Bun's strip of `code` as TypeScript: exit status and its message. */
function bunStrip(code: string): { ok: boolean; message: string } {
  const file = join(dir, `t${count++}.ts`);
  writeFileSync(file, code);
  const run = spawnSync("bun", ["build", "--no-bundle", file], {
    encoding: "utf8",
  });
  return { ok: run.status === 0, message: `${run.stderr}${run.stdout}` };
}

describe("html: accepted bare top-level forms strip cleanly with Bun", () => {
  it.each([
    ["a lone static", "static\n<div/>\n"],
    ["a lone static at end of file", "<div/>\nstatic\n"],
    [
      "a lone static beside a static statement",
      "static\nstatic const a = 1\n<div/>\n",
    ],
    [
      "a named re-export of default",
      'export { default as foo } from "./x"\n<div/>\n',
    ],
    ["a named export", "static const a = 1\nexport { a }\n<div/>\n"],
  ])("%s", (_name, source) => {
    const { code } = compile(source, "/f/t.mx");
    expect(code.match(/export default/g)).toHaveLength(1);
    const stripped = bunStrip(code);
    expect(stripped.message).not.toContain("Multiple exports");
    expect(stripped.ok).toBe(true);
  });

  it("control: two default exports are what Bun's strip refuses", () => {
    const stripped = bunStrip("export default 1;\nexport default 2;\n");
    expect(stripped.ok).toBe(false);
    expect(stripped.message).toContain(
      'Multiple exports with the same name "default"',
    );
  });
});

describe("html: refused bare top-level forms never reach an emitted module", () => {
  it.each([
    "export default function f() {}\n<div/>\n",
    "static const q = 1\nexport { q as default }\n<div/>\n",
  ])("%j", (source) => {
    expect(() => compile(source, "/f/t.mx")).toThrow(
      /already its own default export/,
    );
  });
});
