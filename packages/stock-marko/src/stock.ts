/**
 * `stockParse` / `stockEvents`: the stock parser and event rendering.
 */
import { createRequire } from "node:module";
import * as mxParser from "@mxlang/parser";
import { ensureStockParserExtracted } from "./vendor.ts";

// @ts-ignore: import outside rootDir (package references parser internals)
import {
  type ProbeOptions,
  type ProbeParserModule,
  renderProbe,
} from "../../parser/src/template/grammar-spec.cases.ts";

export interface StockParser {
  parse(code: string): void;
  read(range: { start: number; end: number }): string;
}

let moduleCache: ProbeParserModule | undefined;

export function stockParserModule(): ProbeParserModule {
  if (!moduleCache) {
    const { cjs } = ensureStockParserExtracted();
    moduleCache = createRequire(import.meta.url)(cjs) as ProbeParserModule;
  }
  return moduleCache;
}

export function stockParse(
  source: string,
  handlers: Record<string, (e: { start: number; end: number; [k: string]: unknown }) => unknown>,
): StockParser {
  const parser = (stockParserModule().createParser(handlers) as unknown) as StockParser;
  parser.parse(source);
  return parser;
}

export function stockEvents(source: string, options?: ProbeOptions): string[] {
  return renderProbe(stockParserModule() as unknown as ProbeParserModule, {
    id: "",
    input: source,
    options: (options ?? {}) as ProbeOptions,
    expected: [],
  } as import("../../parser/src/template/grammar-spec.cases.ts").Probe);
}

export function mxEvents(source: string, options?: ProbeOptions): string[] {
  return renderProbe(mxParser as unknown as ProbeParserModule, {
    id: "",
    input: source,
    options: (options ?? {}) as ProbeOptions,
    expected: [],
  } as import("../../parser/src/template/grammar-spec.cases.ts").Probe);
}
