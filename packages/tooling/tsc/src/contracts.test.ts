import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { mxTsc, SPAWN_TIMEOUT_MS } from "./test-support.ts";

/**
 * `mx.contracts` (decision 142) through `mx-tsc`: a contract-only tag
 * declared by a package-level contracts module reports the compiler's
 * positioned error in tsc's own output shape, and a module edit is picked up
 * by the next run — each `mx-tsc` invocation is a fresh process, so Node's
 * stale-ESM-exports limitation for long-lived processes (TODO
 * `sync-esm-reload-node`) does not apply here; a fresh process re-reads the
 * edited module. Trees are built in a temp dir like the other mx-tsc tests.
 *
 * The contract rides `<style>`, a name the html host claims: a contract-only
 * tag is only valid where the active target delegates the name.
 */

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    noEmit: true,
    strict: true,
    module: "esnext",
    moduleResolution: "bundler",
    target: "esnext",
    jsx: "preserve",
    types: [],
    allowImportingTsExtensions: true,
    experimentalDecorators: true,
  },
  include: ["src"],
});

function project(moduleSource: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-tsc-contracts-")));
  created.push(dir);
  const files: Record<string, string> = {
    "tsconfig.json": TSCONFIG,
    "package.json": JSON.stringify({
      name: "tsc-contracts-fixture",
      mx: { host: "html", contracts: "./contracts.ts" },
    }),
    "contracts.ts": moduleSource,
    "src/pages/page.mx": "<style>\n  .x { color: red }\n</style>\n",
    "src/main.ts":
      'import render from "./pages/page.mx";\nconsole.log(render({}));\n',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function check(dir: string): { status: number; text: string } {
  const child = spawnSync(
    process.execPath,
    [mxTsc, "--noEmit", "-p", "tsconfig.json"],
    { cwd: dir, encoding: "utf8" },
  );
  return {
    status: child.status ?? -1,
    text: stripVTControlCharacters(child.stdout + child.stderr).replace(
      new RegExp(`(?:\\.\\./)*${dir.replaceAll("/", "\\/")}`, "g"),
      "<dir>",
    ),
  };
}

const MODULE_NONCE =
  "export default { style: { attributes: { nonce: { type: 'string', required: true } } } };\n";
const MODULE_MEDIA =
  "export default { style: { attributes: { media: { type: 'string', required: true } } } };\n";

describe("mx-tsc reports mx.contracts module errors", () => {
  it(
    "reports a positioned module contract error and reloads the edited module on the next Node CLI run",
    () => {
      const dir = project(MODULE_NONCE);

      const { status, text } = check(dir);

      // Core reports the call at 1:0; tsc's printed shape is 1-based on both
      // axes. The message is the compiler's, verbatim.
      expect(text).toContain(
        "src/pages/page.mx(1,1): error TS80001: `<style>`: missing required attribute `nonce`",
      );
      expect(status).not.toBe(0);

      // The same edit a long-lived tsserver would serve stale (TODO
      // `sync-esm-reload-node`); a CLI run is a fresh process and reloads.
      writeFileSync(join(dir, "contracts.ts"), MODULE_MEDIA);
      const second = check(dir);

      expect(second.text).toContain(
        "src/pages/page.mx(1,1): error TS80001: `<style>`: missing required attribute `media`",
      );
      expect(second.text).not.toContain("missing required attribute `nonce`");
      expect(second.status).not.toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );
});
