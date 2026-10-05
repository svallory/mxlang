/**
 * Where the package's grammar artifacts live on disk, for tools that load them
 * themselves (`Language.load(wasmPath)` in web-tree-sitter, an editor
 * integration reading the queries). Paths only: nothing is read or parsed here.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The compiled MX grammar, for `Language.load`. */
export const wasmPath = join(root, "tree-sitter-mx.wasm");
/** `queries/highlights.scm`: the capture names the docmd plugin turns into classes. */
export const highlightsPath = join(root, "queries", "highlights.scm");
/** `queries/injections.scm`: which ranges hold another language (TypeScript, CSS, ...). */
export const injectionsPath = join(root, "queries", "injections.scm");
