import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TargetHost } from "@mxlang/core";
import { lookupFor, resolveTargetPolicy } from "@mxlang/target-registry";
import type * as ts from "typescript";

/**
 * The diagnostic code of a host whose `ambientTypes` misbehaves: it throws,
 * or returns anything but an iterable of file paths (file-less, an error).
 * Next to `TS80001`-`TS80003` (`mx-tsc`'s own codes).
 */
export const AMBIENT_TYPES_THREW_CODE = 80004;

/**
 * The ambient declaration files a program holding `rootNames` needs beyond
 * its `tsconfig.json`: what each host's `ambientTypes`
 * (`TargetHost.ambientTypes`) answers for it. The hosts are those of each root
 * file's own lookup (`resolveTargetPolicy` from the file, as every other host
 * operation resolves it: the built-ins plus a third-party host the nearest
 * `package.json` above the file loads), then of `projectDir`'s. Each host's
 * package files resolve from the directory of the first root file whose
 * policy selects that host (the target it compiles under is the host's), else
 * from `projectDir`; then from `projectDir`, then from this tool's own
 * install. So a host present in every lookup (a built-in) resolves from a
 * package that uses it, never from whichever root file comes first. Nothing
 * here names a host. Absolute paths, without duplicates, none already a root
 * file. `mx-tsc` and the tsserver plugin both call it.
 *
 * A host whose `ambientTypes` throws, or returns something that is not an
 * iterable of file paths, contributes nothing, and one message is pushed onto
 * `errors`: `host <package>: ambientTypes threw: <message>`, `host <package>:
 * ambientTypes returned <type>, expected an iterable of files`, or `host
 * <package>: ambientTypes returned a non-path entry (<entry>), expected an
 * iterable of files`.
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
  // Each host once, with its label; and the directory its package files
  // resolve from first: that of the first root file whose policy selects it.
  const hosts = new Map<TargetHost, string>();
  const selectedFrom = new Map<TargetHost, string>();
  const collect = (policyFile: string, dir: string) => {
    const policy = resolveTargetPolicy(policyFile, { quiet: true });
    const lookup = lookupFor(policy);
    const selected = lookup.target(policy.target)?.host;
    if (selected && !selectedFrom.has(selected))
      selectedFrom.set(selected, dir);
    for (const name of lookup.targetNames()) {
      const descriptor = lookup.target(name);
      const host = descriptor?.host;
      if (!host?.ambientTypes || hosts.has(host)) continue;
      hosts.set(host, descriptor?.packageName ?? name);
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
  for (const [host, label] of hosts) {
    const base = selectedFrom.get(host) ?? projectDir;
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
      const entries = [...returned];
      // An entry tsc cannot take as a root file (`[resolve(...)]` of a file
      // the package lacks is `[undefined]`) would crash the program.
      const bad = entries.findIndex(
        (entry) => typeof entry !== "string" || entry === "",
      );
      if (bad !== -1) {
        errors.push(
          `host ${label}: ambientTypes returned a non-path entry (${entryName(entries[bad])}), expected an iterable of files`,
        );
        continue;
      }
      files = entries as string[];
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
 * An entry that is no file path, named for the message: `undefined`, `null`,
 * `empty string`, `number 42`, `object`, ….
 */
function entryName(entry: unknown): string {
  if (entry === "") return "empty string";
  if (typeof entry === "number" || typeof entry === "boolean")
    return `${typeof entry} ${entry}`;
  return typeName(entry);
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
