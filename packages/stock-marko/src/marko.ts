/**
 * `stockMarkoTree` / `stockMarkoCompile`: `@marko/compiler` 5.42.10 run
 * with the stock htmljs-parser 5.18.0 — the Marko this workspace cannot
 * otherwise run, because the install patches every `htmljs-parser` it
 * resolves.
 *
 * Isolation: the wiring lives in a child process (`run-stock-marko.cjs`)
 * whose CommonJS resolution hook maps the bare specifier `htmljs-parser`
 * to the vendored stock build for that process only. No install, no other
 * package, and not even this process's own resolution changes; the
 * `lexAtom` assertion in `marko.test.ts` proves packages/core still
 * reaches the patched parser. This is the same hook shape
 * `packages/core/src/stock-parser.test.ts` uses.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ensureStockParserExtracted } from "./vendor.ts";

export interface StockMarkoError {
  message: string;
  label?: string;
  loc?: { line: number; column: number; index: number };
}

export interface StockMarkoOptions {
  /** The filename handed to the compiler (errors point at it). */
  filename?: string;
}

export interface StockMarkoCompileResult {
  ok: boolean;
  /** The compiled module, when it compiled. */
  code?: string;
  error?: StockMarkoError;
}

export interface StockMarkoTreeResult {
  ok: boolean;
  /**
   * The compiler's Program node after parse, JSON-shaped (`loc`, comments
   * and tokens dropped; every node keeps `type`, `start`, `end`).
   */
  tree?: unknown;
  error?: StockMarkoError;
}

const RUNNER_PATH = fileURLToPath(
  new URL("./run-stock-marko.cjs", import.meta.url),
);

const require = createRequire(import.meta.url);

function compilerEntry(): string {
  return require.resolve("@marko/compiler");
}

function translatorEntry(): string {
  // `marko/translator` is ESM; resolution is enough (the child import()s it).
  return require.resolve("marko/translator");
}

function run(
  request: { mode: "compile" | "tree"; source: string; filename?: string },
  // biome-ignore lint/suspicious/noExplicitAny: the child's JSON shape is checked by the callers below
): any {
  const run = spawnSync(process.execPath, [RUNNER_PATH], {
    env: {
      ...process.env,
      MX_STOCK_PARSER_CJS: ensureStockParserExtracted().cjs,
      MX_MARKO_COMPILER: compilerEntry(),
      MX_MARKO_TRANSLATOR: translatorEntry(),
    },
    input: JSON.stringify(request),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0 || run.error) {
    throw new Error(
      `stock-marko child failed (status ${run.status}): ${run.stderr || run.error}`,
    );
  }
  return JSON.parse(run.stdout);
}

/**
 * Does stock Marko compile `source`? Runs `@marko/compiler` with Marko
 * 6.3.51's real translator over the stock parser; on failure the error
 * carries the compiler's message, label and range (`loc`).
 */
export function stockMarkoCompile(
  source: string,
  options?: StockMarkoOptions,
): StockMarkoCompileResult {
  return run({ mode: "compile", source, filename: options?.filename });
}

/**
 * The Marko AST (`@marko/compiler`'s Babel tree with its Marko node
 * types) for `source`, parsed by the stock parser, captured at `Program`
 * enter with an empty translator so nothing is lowered away first.
 */
export function stockMarkoTree(
  source: string,
  options?: StockMarkoOptions,
): StockMarkoTreeResult {
  return run({ mode: "tree", source, filename: options?.filename });
}
