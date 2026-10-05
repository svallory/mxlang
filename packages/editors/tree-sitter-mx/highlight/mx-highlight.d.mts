import type { Tree } from "web-tree-sitter";

/** A run of source text carrying one class (`null`: no class). */
export interface Span {
  text: string;
  cls: string | null;
}

/** The docmd plugin object (default export). */
export interface DocmdPlugin {
  plugin: { name: string; version: string; capabilities: string[] };
  markdownSetup(md: unknown): void;
}

declare const plugin: DocmdPlugin;
export default plugin;

/** Capture name -> CSS class (`punctuation.bracket` -> `ts-punctuation-bracket`); `null` for unstyled captures. */
export declare function classOf(name: string): string | null;
/** Every capture name the MX and the injected-language queries can produce. */
export declare const captureNames: string[];
/** Parse `source` as MX. */
export declare function parseMx(source: string): Tree;
/** The class of each UTF-16 unit of `source`. */
export declare function classesOf(
  source: string,
  tree?: Tree,
): Array<string | null>;
/** Contiguous runs of one class; concatenating `text` rebuilds `source`. */
export declare function spansOf(source: string): Span[];
export declare function escapeHtml(text: string): string;
/**
 * The highlighted inner HTML of `source`. `ownerAt` returns the opening tag of
 * the wrapper that owns a UTF-16 offset (or `""`).
 */
export declare function renderMx(
  source: string,
  ownerAt?: (offset: number) => string,
): string;
/** The whole `<pre>` an ordinary ```mx fence renders to. */
export declare function renderFence(source: string): string;
