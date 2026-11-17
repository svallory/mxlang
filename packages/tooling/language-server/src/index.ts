/**
 * `@mxlang/language-server` — diagnostics-only LSP server for MX hosts.
 * See `README.md` for what it does and does not do.
 */

export { resolveTargetPolicy } from "@mxlang/core";
export { diagnoseDocument, type TargetPolicy } from "./diagnose.ts";
export { startServer } from "./server.ts";
