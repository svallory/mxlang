/**
 * `@mxlang/angular-checker` -- Angular template type-check diagnostics for MX.
 *
 * The public surface is deliberately free of TypeScript's own types: `check`
 * returns plain records, never a `ts.Diagnostic`, so consumers stay off
 * TypeScript's object graph. See `checker.ts`.
 */

import {
  createAngularChecker,
  TsconfigError,
  typescriptVersion,
} from "./checker.ts";
import {
  type CompilerCliModule,
  type CompilerCliResolution,
  CompilerCliUnavailableError,
  resolveCompilerCli,
  SUPPORTED_COMPILER_CLI_RANGE,
} from "./compiler-cli.ts";
import {
  diagnoseNgMx,
  type NgMxDiagnostic,
  type NgMxMapped,
} from "./diagnose.ts";
import { runCheckerWorker } from "./worker.ts";
import {
  type CheckerWorker,
  type CheckerWorkerOptions,
  type CheckOutcome,
  createCheckerWorker,
  DEFAULT_GRACE_MS,
  isProcessAlive,
} from "./worker-client.ts";

export type {
  AngularChecker,
  AngularCheckerOptions,
  CancellationToken,
  Diagnostic,
  DiagnosticCategory,
} from "./types.ts";
export {
  type CheckerWorker,
  type CheckerWorkerOptions,
  type CheckOutcome,
  type CompilerCliModule,
  type CompilerCliResolution,
  CompilerCliUnavailableError,
  createAngularChecker,
  createCheckerWorker,
  DEFAULT_GRACE_MS,
  diagnoseNgMx,
  isProcessAlive,
  type NgMxDiagnostic,
  type NgMxMapped,
  resolveCompilerCli,
  runCheckerWorker,
  SUPPORTED_COMPILER_CLI_RANGE,
  TsconfigError,
  typescriptVersion,
};
