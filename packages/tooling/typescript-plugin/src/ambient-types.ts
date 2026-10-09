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
 * (`TargetHost.ambientTypes`) answers for it. The hosts are those of each root
 * file's own lookup (`resolveTargetPolicy` from the file, as every other host
 * operation resolves it: the built-ins plus a third-party host the nearest
 * `package.json` above the file loads), then of `projectDir`'s. Each host's
 * package files resolve from the directory of the first root file whose lookup
 * holds it, then from `projectDir`, then from this tool's own install. Nothing
 * here names a host. Absolute paths, without duplicates, none already a root
 * file. `mx-tsc` and the tsserver plugin both call it.
 *
 * A host whose `ambientTypes` throws, or returns something that is not an
 * iterable of files, contributes nothing, and one message is pushed onto
 * `errors`: `host <package>: ambientTypes threw: <message>`, or `host
 * <package>: ambientTypes returned <type>, expected an iterable of files`.
 * The run goes on without that host's files; the caller reports the message
 * (see {@link ambientTypeDiagnostics}).
 */
export function ambientTypeFiles(
  rootNames: readonly string[],
  projectDir: string,
  errors: string[],
): string[] {
  const roots = new Set(rootNames);
  const toolDir = dirname(fileURLToPath(import.meta.url));
  // Each host once, with the directory its package files resolve from first.
  const hosts = new Map<TargetHost, { label: string; base: string }>();
  const collect = (policyFile: string, base: string) => {
    const lookup = lookupFor(resolveTargetPolicy(policyFile, { quiet: true }));
    for (const name of lookup.targetNames()) {
      const descriptor = lookup.target(name);
      const host = descriptor?.host;
      if (!host?.ambientTypes || hosts.has(host)) continue;
      hosts.set(host, { label: descriptor?.packageName ?? name, base });
    }
  };
  const asked = new Set<string>();
  for (const file of rootNames) {
    const dir = dirname(file);
    if (asked.has(dir)) continue;
    asked.add(dir);
    collect(file, dir);
  }
  collect(join(projectDir, "package.json"), projectDir);
  const added = new Set<string>();
  for (const [host, { label, base }] of hosts) {
    const bases = [...new Set([base, projectDir, toolDir])];
    const program = {
      rootNames,
      resolve: (packageFile: string) => packageFileIn(packageFile, bases),
    };
    let files: string[];
    try {
      // SAFETY: `ambientTypes` is typed, but a third-party host is plain
      // JavaScript; what it returned is checked before it is read.
      const returned: unknown = host.ambientTypes?.(program);
      if (!isIterable(returned)) {
        errors.push(
          `host ${label}: ambientTypes returned ${typeName(returned)}, expected an iterable of files`,
        );
        continue;
      }
      // Read inside the guard: a generator can throw while it is iterated.
      files = [...returned] as string[];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`host ${label}: ambientTypes threw: ${message}`);
      continue;
    }
    for (const file of files) {
      if (!roots.has(file)) added.add(file);
    }
  }
  return [...added];
}

/**
 * An iterable other than a string: a string iterates its characters, never
 * file paths.
 */
function isIterable(value: unknown): value is Iterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
      "function"
  );
}

/** `null`, or the `typeof` of `value` (`undefined`, `number`, `object`, …). */
function typeName(value: unknown): string {
  return value === null ? "null" : typeof value;
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
