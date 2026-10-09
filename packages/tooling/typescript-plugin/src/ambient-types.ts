import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TargetHost } from "@mxlang/core";
import { lookupFor, resolveTargetPolicy } from "@mxlang/target-registry";
import type * as ts from "typescript";

/**
 * The diagnostic code of a host whose `ambientTypes` throws (file-less, an
 * error). Next to `TS80001`-`TS80003` (`mx-tsc`'s own codes).
 */
export const AMBIENT_TYPES_THREW_CODE = 80004;

/**
 * The ambient declaration files a program holding `rootNames` needs beyond
 * its `tsconfig.json`: what each host's `ambientTypes`
 * (`TargetHost.ambientTypes`) answers for it. The hosts are those of the
 * project's lookup, the built-ins plus a third-party host the project's
 * `package.json` loads, as for every other host operation. Package files
 * resolve from `projectDir` first, then from this tool's own install. Nothing
 * here names a host. Absolute paths, without duplicates, none already a root
 * file. `mx-tsc` and the tsserver plugin both call it.
 *
 * A host whose `ambientTypes` throws contributes nothing, and one message
 * is pushed onto `errors`: `host <package>: ambientTypes threw: <message>`.
 * The run goes on without that host's files; the caller reports the message
 * (see {@link ambientTypeDiagnostics}).
 */
export function ambientTypeFiles(
  rootNames: readonly string[],
  projectDir: string,
  errors: string[],
): string[] {
  const roots = new Set(rootNames);
  const bases = [projectDir, dirname(fileURLToPath(import.meta.url))];
  const program = {
    rootNames,
    resolve: (packageFile: string) => packageFileIn(packageFile, bases),
  };
  const lookup = lookupFor(
    resolveTargetPolicy(join(projectDir, "package.json"), { quiet: true }),
  );
  const asked = new Set<TargetHost>();
  const added = new Set<string>();
  for (const name of lookup.targetNames()) {
    const descriptor = lookup.target(name);
    const host = descriptor?.host;
    if (!host?.ambientTypes || asked.has(host)) continue;
    asked.add(host);
    let files: readonly string[];
    try {
      files = host.ambientTypes(program);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(
        `host ${descriptor?.packageName ?? name}: ambientTypes threw: ${message}`,
      );
      continue;
    }
    for (const file of files) {
      if (!roots.has(file)) added.add(file);
    }
  }
  return [...added];
}

/**
 * The {@link ambientTypeFiles} errors as file-less error diagnostics: the
 * editor shows them with the project's own compiler-option diagnostics.
 */
export function ambientTypeDiagnostics(
  typescript: typeof ts,
  messages: readonly string[],
): ts.Diagnostic[] {
  return messages.map((messageText) => ({
    file: undefined,
    start: undefined,
    length: undefined,
    category: typescript.DiagnosticCategory.Error,
    code: AMBIENT_TYPES_THREW_CODE,
    source: "mxlang",
    messageText,
  }));
}

/**
 * Makes `host.getScriptFileNames` (a tsserver project, the language service
 * host Volar's plugin sees) also list the ambient declaration files of
 * {@link ambientTypeFiles}, as a framework's own editor tooling adds them.
 * Recomputed only when the project's root list changes; `errors` then holds
 * that recomputation's errors.
 */
export function withAmbientTypes(
  host: { getScriptFileNames(): string[] },
  projectDir: () => string,
  errors: string[],
): void {
  const original = host.getScriptFileNames.bind(host);
  let last: { names: readonly string[]; result: string[] } | undefined;
  host.getScriptFileNames = () => {
    const names = original();
    if (
      !last ||
      last.names.length !== names.length ||
      last.names.some((name, index) => name !== names[index])
    ) {
      errors.length = 0;
      last = {
        names: [...names],
        result: [...names, ...ambientTypeFiles(names, projectDir(), errors)],
      };
    }
    return last.result;
  };
}

/**
 * `<package>/<file>` (`some-framework/env.d.ts`, `@scope/name/types/x.d.ts`)
 * in the nearest `node_modules` above each base, in order: the first base
 * where the package is installed answers, and `undefined` when the file is
 * not in it. A package's own files, not its `exports`: a declaration file is
 * rarely an exported entry.
 */
function packageFileIn(
  packageFile: string,
  bases: readonly string[],
): string | undefined {
  const parts = packageFile.split("/");
  const nameLength = packageFile.startsWith("@") ? 2 : 1;
  const name = parts.slice(0, nameLength).join("/");
  const rest = parts.slice(nameLength).join("/");
  for (const base of bases) {
    for (let dir = base; ; dir = dirname(dir)) {
      const installed = join(dir, "node_modules", name);
      if (existsSync(join(installed, "package.json"))) {
        const file = join(realpathSync(installed), rest);
        return existsSync(file) ? file : undefined;
      }
      if (dirname(dir) === dir) break;
    }
  }
  return undefined;
}
