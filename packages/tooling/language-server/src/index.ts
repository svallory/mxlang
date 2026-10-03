/**
 * `@mxlang/language-server` — diagnostics-only LSP server for MX hosts
 * (decision 71/72). See `README.md` for what it does and does not do.
 */

// Bun 1.3.14 (the build pin) drops the bindings of a re-export-only entry
// when the bundled lazy descriptor graph is reachable: dist/index.js shrinks
// to a 69-byte export barrel whose named exports have no definitions, so Node
// ESM rejects it before loading the server. Explicit exported value bindings
// keep the full bundle; dist-build.test.ts pins loading and target dispatch.
// TODO bun-export-binding-drop: remove this workaround once a fixed Bun is
// pinned and the re-export-only entry passes that same plain-Node regression.
import { resolveTargetPolicy as resolvePolicy } from "@mxlang/core";
import { diagnoseDocument as diagnose } from "./diagnose.ts";
import { startServer as start } from "./server.ts";

export const resolveTargetPolicy = resolvePolicy;
export const diagnoseDocument = diagnose;
export const startServer = start;
export type { TargetPolicy } from "./diagnose.ts";
