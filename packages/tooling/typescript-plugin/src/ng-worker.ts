/**
 * Entry point of the Angular checker worker process, bundled next to the
 * plugin as `ng-worker.cjs` (see `ng-diagnostics.ts`). `@angular/compiler-cli`
 * is not bundled: the worker resolves it from the user's project.
 */
import { runCheckerWorker } from "@mxlang/angular-checker";

runCheckerWorker();
