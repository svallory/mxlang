import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinTargets } from "@mxlang/target-registry";

/**
 * The ambient declaration files a program holding `rootNames` needs, beyond
 * its `tsconfig.json`: each built-in host's `ambientTypes`
 * (`TargetHost.ambientTypes`), for a host one of whose file kinds
 * (`.<segment>.mx`) is among the root files. Package files resolve from
 * `projectDir` first, then from this tool's own install. Nothing here names a
 * host. Absolute paths, without duplicates, none already a root file.
 */
export function ambientTypeFiles(
  rootNames: readonly string[],
  projectDir: string,
): string[] {
  const roots = new Set(rootNames);
  const lower = rootNames.map((name) => name.toLowerCase());
  const bases = [projectDir, dirname(fileURLToPath(import.meta.url))];
  const resolve = (packageFile: string) => packageFileIn(packageFile, bases);
  const added = new Set<string>();
  for (const target of builtinTargets) {
    const host = target.host;
    if (!host?.ambientTypes) continue;
    const holdsKind = (host.fileKinds ?? []).some((kind) =>
      lower.some((name) => name.endsWith(`.${kind.segment}.mx`)),
    );
    if (!holdsKind) continue;
    for (const file of host.ambientTypes(resolve)) {
      if (!roots.has(file)) added.add(file);
    }
  }
  return [...added];
}

/**
 * `<package>/<file>` (`astro/env.d.ts`, `@scope/name/types/x.d.ts`) in the
 * nearest `node_modules` above each base, in order: the first base where the
 * package is installed answers, and `undefined` when the file is not in it. A
 * package's own files, not its `exports`: a declaration file is rarely an
 * exported entry.
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
