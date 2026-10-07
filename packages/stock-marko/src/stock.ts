/**
 * `stockParse` / `stockEvents`: the stock parser and event rendering.
 */
import { createRequire } from "node:module";
import * as mxParser from "@mxlang/parser";
import {
  type Probe,
  type ProbeOptions,
  type ProbeParserModule,
  renderProbe,
} from "./probe-render.ts";
import { ensureStockParserExtracted } from "./vendor.ts";

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

function probe(input: string, options?: ProbeOptions): Probe {
  return { id: "", input, options: options ?? {}, expected: [] };
}

export function stockParse(
  source: string,
  handlers: Record<string, (e: { start: number; end: number }) => unknown>,
): StockParser {
  const parser = stockParserModule().createParser(handlers);
  parser.parse(source);
  return parser;
}

export function stockEvents(source: string, options?: ProbeOptions): string[] {
  return renderProbe(stockParserModule(), probe(source, options));
}

export function mxEvents(source: string, options?: ProbeOptions): string[] {
  // SAFETY: the MX parser module satisfies the probe's structural subset (createParser/TagType).
  return renderProbe(
    mxParser as unknown as ProbeParserModule,
    probe(source, options),
  );
}
