// Shared by the VSIX stage for every package it ships beside a bundle (the
// plugin's and the language server's un-bundleable dependencies): copy an
// installed package and its dependency closure out of the workspace install, so
// the shipped versions are exactly the ones `bun.lock` pins and no registry is
// touched.
import { cpSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}
export const readManifest = (dir: string) =>
  JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;

/** The directory of `name` as installed for a package living in `fromDir`. */
export function findPackage(name: string, fromDir: string): string | undefined {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) {
      return realpathSync(candidate);
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * Copy `realDir` (an installed package) and its dependency closure into the
 * stage, hoisting each name once; a second version of a name nests under its
 * dependent so Node resolution still finds it.
 */
export function place(realDir: string, into: string): void {
  const manifest = readManifest(realDir);
  const target = join(into, manifest.name);
  if (existsSync(target)) {
    if (readManifest(target).version === manifest.version) return;
    throw new Error(`unexpected version clash placing ${manifest.name}`);
  }
  cpSync(realDir, target, {
    recursive: true,
    dereference: true,
    // A package's own node_modules would be a second, unpinned copy.
    filter: (src) => basename(src) !== "node_modules",
  });
  const deps = { ...manifest.dependencies, ...manifest.optionalDependencies };
  for (const dep of Object.keys(deps)) {
    const depDir = findPackage(dep, realDir);
    if (!depDir) {
      // An optional dependency that is not installed for this platform.
      if (manifest.optionalDependencies?.[dep]) continue;
      throw new Error(
        `${manifest.name} needs ${dep}, not found from ${realDir}`,
      );
    }
    const hoisted = join(into, dep);
    if (
      existsSync(hoisted) &&
      readManifest(hoisted).version !== readManifest(depDir).version
    ) {
      place(depDir, join(target, "node_modules"));
    } else {
      place(depDir, into);
    }
  }
}
