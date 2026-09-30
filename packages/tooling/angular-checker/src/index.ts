/**
 * `@mxlang/angular-checker` -- Angular template type-check diagnostics for MX.
 *
 * The public surface is deliberately free of TypeScript's own types: `check`
 * returns plain records, never a `ts.Diagnostic`, so consumers stay off
 * TypeScript's object graph. See `checker.ts`.
 */

import { createAngularChecker, typescriptVersion } from "./checker.ts";
import {
  type CompilerCliModule,
  type CompilerCliResolution,
  CompilerCliUnavailableError,
  resolveCompilerCli,
  SUPPORTED_COMPILER_CLI_RANGE,
} from "./compiler-cli.ts";
import { diagnoseNgMx, type NgMxDiagnostic } from "./diagnose.ts";

export type {
  AngularChecker,
  AngularCheckerOptions,
  CancellationToken,
  Diagnostic,
  DiagnosticCategory,
} from "./types.ts";
export {
  type CompilerCliModule,
  type CompilerCliResolution,
  CompilerCliUnavailableError,
  createAngularChecker,
  diagnoseNgMx,
  type NgMxDiagnostic,
  resolveCompilerCli,
  SUPPORTED_COMPILER_CLI_RANGE,
  typescriptVersion,
};
