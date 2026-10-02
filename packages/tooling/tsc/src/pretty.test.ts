import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./in-process.ts";
import { fixtures, SPAWN_TIMEOUT_MS } from "./test-support.ts";

/**
 * Off a TTY `mx-tsc` prints tsc's compact `file(L,C): error …` lines, even
 * under `FORCE_COLOR`/`CI` (agent-feedback audit item 20: tsc's own `pretty`
 * mode, switched on by `FORCE_COLOR`, made the output 1.68x larger with a code
 * frame and declaration sites). An explicit `--pretty` or a tsconfig `pretty`
 * still wins, and a TTY is untouched.
 */
const dir = join(fixtures, "failing");
const COMPACT =
  "src/Widget.solid.mx(7,32): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.\n";

const ENV = ["NO_COLOR", "FORCE_COLOR", "CI"] as const;
const saved: Record<string, string | undefined> = {};
let ttyDescriptor: PropertyDescriptor | undefined;

/** The environment of a run: colour on every other switch, stdout a pipe or a TTY. */
function setup(options: { tty: boolean }): void {
  process.env.FORCE_COLOR = "1";
  process.env.CI = "true";
  delete process.env.NO_COLOR;
  Object.defineProperty(process.stdout, "isTTY", {
    value: options.tty,
    configurable: true,
    writable: true,
  });
}

/** Everything the run printed, ANSI stripped, cut to start at the fixture's own path. */
function check(args: readonly string[]): { status: number; text: string } {
  const run = runInProcess(args, dir);
  const text = stripVTControlCharacters(run.stdout + run.stderr);
  return {
    status: run.status,
    text: text.slice(Math.max(text.indexOf("src/Widget"), 0)),
  };
}

beforeEach(() => {
  for (const name of ENV) saved[name] = process.env[name];
  ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
});

afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  if (ttyDescriptor)
    Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
  return new Promise<void>((resolve) => setImmediate(resolve));
});

describe("mx-tsc pretty output", () => {
  it(
    "is compact off a TTY under FORCE_COLOR=1 CI=true, exit 2",
    () => {
      setup({ tty: false });
      expect(check(["--noEmit", "-p", "tsconfig.json"])).toEqual({
        status: 2,
        text: COMPACT,
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "leaves FORCE_COLOR as the caller had it once the run is over",
    () => {
      setup({ tty: false });
      check(["--noEmit", "-p", "tsconfig.json"]);
      expect(process.env.FORCE_COLOR).toBe("1");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "is pretty off a TTY when --pretty is on the command line",
    () => {
      setup({ tty: false });
      const { status, text } = check([
        "--noEmit",
        "--pretty",
        "-p",
        "tsconfig.json",
      ]);
      expect(status).toBe(2);
      expect(text).toContain("src/Widget.solid.mx:7:32 - error TS2345:");
      expect(text).toContain("~");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "is pretty off a TTY when the tsconfig sets pretty: true",
    () => {
      setup({ tty: false });
      const { status, text } = check([
        "--noEmit",
        "-p",
        "tsconfig.pretty.json",
      ]);
      expect(status).toBe(2);
      expect(text).toContain("src/Widget.solid.mx:7:32 - error TS2345:");
      expect(text).toContain("~");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "is pretty on a TTY, with or without FORCE_COLOR",
    () => {
      setup({ tty: true });
      const forced = check(["--noEmit", "-p", "tsconfig.json"]);
      delete process.env.FORCE_COLOR;
      const plain = check(["--noEmit", "-p", "tsconfig.json"]);
      for (const { status, text } of [forced, plain]) {
        expect(status).toBe(2);
        expect(text).toContain("src/Widget.solid.mx:7:32 - error TS2345:");
        expect(text).toContain("~");
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});
