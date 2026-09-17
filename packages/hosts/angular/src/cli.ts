/**
 * `mx-angular` CLI (design note A3). `build` and `map` (this package's task
 * 1.5a); `watch` is task 1.5b, not yet built.
 */

import { resolve } from "node:path";
import { TranslateError } from "@mxlang/core";
import { build } from "./build.ts";
import { readMap, resolvePosition } from "./map-file.ts";
import { startWatch } from "./watch.ts";

function usage(): string {
  return [
    "Usage:",
    "  mx-angular build [--project <dir>] [--config <file>]",
    "  mx-angular watch [--project <dir>] [--config <file>] [--once]",
    "  mx-angular map <file.html:line:col>   (also file.ts for a .ng.mx)",
  ].join("\n");
}

interface Flags {
  project?: string;
  config?: string;
  once?: boolean;
}

const KNOWN_FLAGS = new Set(["--project", "--config", "--once"]);
const BOOLEAN_FLAGS = new Set(["--once"]);

/** Parses `--project <dir>`/`--config <file>`/`--once` in either `--flag value` or `--flag=value` form (`--once` takes no value). Unknown flags are rejected. */
function parseFlags(args: string[]): { flags: Flags; rest: string[] } {
  const flags: Flags = {};
  const rest: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    const eq = arg.indexOf("=");
    const isFlag = arg.startsWith("--");
    const name = isFlag ? (eq === -1 ? arg : arg.slice(0, eq)) : undefined;

    if (!isFlag) {
      rest.push(arg);
      i++;
      continue;
    }
    if (!KNOWN_FLAGS.has(name as string)) {
      throw new Error(`unknown flag: ${name}`);
    }

    if (BOOLEAN_FLAGS.has(name as string)) {
      if (name === "--once") flags.once = true;
      i++;
      continue;
    }

    let value: string;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
      i++;
    } else {
      const next = args[i + 1];
      if (next === undefined) {
        throw new Error(`${name} requires a value`);
      }
      value = next;
      i += 2;
    }

    if (name === "--project") flags.project = value;
    else flags.config = value;
  }
  return { flags, rest };
}

function runBuild(args: string[]): number {
  const { flags } = parseFlags(args);
  const projectDir = flags.project ? resolve(flags.project) : process.cwd();
  if (flags.config) {
    // Task 1.5a reads package.json#mx.angular only (A3); an explicit
    // --config file is accepted on the command line for A3 parity but not
    // yet wired to a different config source.
    console.warn(
      `--config is accepted but not yet used; mx-angular reads package.json#mx.angular in ${projectDir}`,
    );
  }
  const result = build(projectDir);

  for (const warning of result.warnings) {
    console.warn(formatMessage("warning", warning));
  }
  for (const error of result.errors) {
    console.error(formatMessage("error", error));
  }

  return result.ok ? 0 : 1;
}

function formatMessage(
  kind: "warning" | "error",
  m: { file: string; line?: number; column?: number; message: string },
): string {
  const position = m.line !== undefined ? `:${m.line}:${m.column}` : "";
  return `${m.file}${position} ${kind}: ${m.message}`;
}

/**
 * Runs `mx-angular watch`. With `--once`, runs the initial build only and
 * resolves once it's done (for tests and CI, A3). Without it, starts the
 * incremental watcher and resolves only when it's asked to stop — via
 * `SIGINT`/`SIGTERM` (`Ctrl-C`, exit 0, A3).
 */
function runWatch(args: string[]): Promise<number> {
  const { flags } = parseFlags(args);
  const projectDir = flags.project ? resolve(flags.project) : process.cwd();
  if (flags.config) {
    console.warn(
      `--config is accepted but not yet used; mx-angular reads package.json#mx.angular in ${projectDir}`,
    );
  }

  const handle = startWatch(projectDir, {
    once: flags.once,
    onLine: (line) => console.log(line),
  });

  if (flags.once) {
    return handle.onIdle.then(() => {
      handle.close();
      return 0;
    });
  }

  return new Promise<number>((resolvePromise) => {
    const stop = () => {
      handle.close();
      resolvePromise(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

/** Parses `file.html:line:col`. */
function parseMapArg(arg: string): {
  file: string;
  line: number;
  column: number;
} {
  const match = /^(.+):(\d+):(\d+)$/.exec(arg);
  if (!match) {
    throw new Error(`invalid position, expected file:line:col, got "${arg}"`);
  }
  const [, file, line, column] = match;
  return { file: file as string, line: Number(line), column: Number(column) };
}

function runMap(args: string[]): number {
  const arg = args[0];
  if (!arg) {
    console.error(usage());
    return 1;
  }
  const { file, line, column } = parseMapArg(arg);
  const mapPath = `${file}.map`;
  try {
    const map = readMap(mapPath);
    const resolved = resolvePosition(map, line, column);
    // `file:line:col` when the position resolves, so the output is the same
    // shape the argument took and an editor can jump to it.
    console.log(
      resolved.line !== undefined
        ? `${resolved.file}:${resolved.line}:${resolved.column}`
        : resolved.file,
    );
    if (resolved.line === undefined) {
      console.log(
        resolved.hasFineGrainedMapping
          ? "that position came from no source text (generated punctuation)"
          : "no fine-grained mapping in this sidecar (mappings empty)",
      );
    }
    return 0;
  } catch (err) {
    console.error(
      `could not read ${mapPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}

function handleCliError(err: unknown): number {
  if (err instanceof TranslateError) {
    console.error(
      formatMessage("error", {
        file: err.file ?? "<unknown>",
        line: err.line,
        column: err.column,
        message: err.message,
      }),
    );
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  return 1;
}

export function runCli(argv: string[]): number | Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "build":
        return runBuild(rest);
      case "watch":
        return runWatch(rest).catch(handleCliError);
      case "map":
        return runMap(rest);
      default:
        console.error(usage());
        return 1;
    }
  } catch (err) {
    return handleCliError(err);
  }
}
