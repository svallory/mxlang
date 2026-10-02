import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runInProcess } from "./in-process.ts";
import { fixtures, SPAWN_TIMEOUT_MS } from "./test-support.ts";

/**
 * `mx-tsc` prints one location per `TS80001` line (agent-feedback audit item
 * 13), not `file(L,C)` plus a second `(L:C)` at the end of the message.
 */
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

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
