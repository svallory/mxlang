/**
 * `@mxlang/angular-checker` -- Angular template type-check diagnostics for MX.
 *
 * The public surface is deliberately free of TypeScript's own types: `check`
 * returns plain records, never a `ts.Diagnostic`, so consumers stay off
 * TypeScript's object graph. See `checker.ts`.
 */

import { createAngularChecker, typescriptVersion } from "./checker.ts";

export type {
  AngularChecker,
  AngularCheckerOptions,
  CancellationToken,
  Diagnostic,
  DiagnosticCategory,
} from "./types.ts";
export { createAngularChecker, typescriptVersion };
