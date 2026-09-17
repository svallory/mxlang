import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const HOSTS = ["html", "astro", "preact", "react", "hono", "solid"] as const;

/**
 * Four fixtures across the two layers and the two shapes of L2.
 *
 * `icon` and `icon-template` are the same `<icon>` written two ways — an L2
 * sidecar that builds IR with the tag builders, and an L1 template inlined
 * from `tags/icon.mx` — so asserting every row of both proves a template tag
 * reaches a host as ordinary IR, no emitter knowing which layer authored it.
 * `icon-sprite` and `table-of` are P5's pair: the first uses
 * `analyze`/`finalize`/`ctx.store` to emit one `<symbol>` per distinct icon
 * however many times the tag is called, the second is L2 with neither hook, so
 * the collecting pair is shown to be opt-in rather than the price of L2.
 */
const FIXTURES = ["icon", "icon-template", "icon-sprite", "table-of"] as const;

/**
 * Rows deliberately not compared, each with the reason the runner prints.
 *
 * Empty: the `table-of`/`solid` row that used to be skipped here (the
 * `@mxlang/solid` `<for>` accessor/value bug — see task `solid-for-accessor`)
 * is fixed; every fixture now compares on every host. See `run.ts` for the
 * fixture definitions.
 */
const SKIPPED: ReadonlyArray<readonly [string, string]> = [
  // A discovered template is a compilation unit the caller imports (decision
  // 95). A `.solid.mx` MX region is an expression with no module scope for that
  // import; the parser bridge writes it into the surrounding TypeScript module,
  // which is tag-unit phase 2. The reason is asserted from `run.ts`'s output
  // below, so this cannot quietly become permanent.
  ["icon-template", "solid"],
];

function isSkipped(fixture: string, host: string): boolean {
  return SKIPPED.some(([f, h]) => f === fixture && h === host);
}

// This test spawns `run.ts`, which compiles four fixtures through six hosts.
// Vitest's 5s default is a machine-load timeout, not a budget for the work.
it("runs every custom tag fixture through all six hosts", {
  timeout: 60_000,
}, () => {
  const result = spawnSync(
    "bun",
    [
      "run",
      "--tsconfig-override=tsconfig.base.json",
      "packages/oracle/fixtures-custom-tags/run.ts",
    ],
    { cwd: root, encoding: "utf8" },
  );

  expect(result.status).toBe(0);
  // Decision 55: assert the count, so a fixture or a host that silently
  // stopped running is a failure rather than an unnoticed absence.
  expect(result.stdout).toContain(
    `${FIXTURES.length * HOSTS.length - SKIPPED.length}/${FIXTURES.length * HOSTS.length} rows passed, ${SKIPPED.length} skipped(reason)`,
  );
  for (const fixture of FIXTURES) {
    for (const host of HOSTS) {
      // A skipped row must still appear, and must still say *why*: a skip
      // that stopped being printed is indistinguishable from a fixture that
      // stopped running, which is the failure decision 55 exists to catch.
      const status = isSkipped(fixture, host) ? "skipped — .+" : "pass";
      expect(result.stdout).toMatch(
        new RegExp(`^${fixture}\\s+${host}\\s+${status}$`, "m"),
      );
    }
  }
});
