// Guards the VSIX contents (see `stage-vsix.ts` for why the plugin must ship).
//
//   bun run scripts/check-vsix.ts [path/to/mxlang.vsix]   (default: ./mxlang.vsix)
//
// Unpacks the VSIX and asserts, from the extension root (`extension/`, where VS
// Code's TypeScript extension resolves `typescriptServerPlugins`):
//   - every `typescriptServerPlugins[].name` resolves to a loadable entry;
//   - the plugin ships every `dist/*.cjs` its own build emits (not a fixed list);
//   - the plugin's runtime requires resolve from its install location;
//   - `@angular/compiler-cli` (and `typescript`) are not shipped.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginBuiltDist = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../tooling/typescript-plugin/dist",
);

/** Never ship: resolved from the user's project / handed over by tsserver. */
const FORBIDDEN = ["@angular/compiler-cli", "typescript"];
/** Resolved lazily at runtime by the bundled plugin. */
const RUNTIME_REQUIRES = ["@marko/compiler", "@astrojs/compiler/sync"];

export function checkExtensionRoot(
  root: string,
  builtPluginDist: string | undefined = pluginBuiltDist,
): string[] {
  const problems: string[] = [];
  root = realpathSync(root); // resolution reports real paths (macOS /var -> /private/var)
  const manifest = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ) as {
    contributes?: { typescriptServerPlugins?: { name: string }[] };
  };
  const plugins = manifest.contributes?.typescriptServerPlugins ?? [];
  if (plugins.length === 0) {
    problems.push("package.json declares no typescriptServerPlugins");
  }
  const requireFromRoot = createRequire(join(root, "package.json"));
  for (const { name } of plugins) {
    let entry: string;
    try {
      entry = requireFromRoot.resolve(name);
    } catch {
      problems.push(
        `typescriptServerPlugins "${name}" does not resolve from ${root}/node_modules`,
      );
      continue;
    }
    if (!entry.startsWith(resolve(root, "node_modules"))) {
      problems.push(`"${name}" resolved outside the extension: ${entry}`);
      continue;
    }
    const pluginRoot = join(root, "node_modules", name);
    if (builtPluginDist && existsSync(builtPluginDist)) {
      for (const file of readdirSync(builtPluginDist)) {
        if (
          file.endsWith(".cjs") &&
          !existsSync(join(pluginRoot, "dist", file))
        ) {
          problems.push(`"${name}" is missing dist/${file}`);
        }
      }
    }
    const requireFromPlugin = createRequire(entry);
    for (const dependency of RUNTIME_REQUIRES) {
      try {
        requireFromPlugin.resolve(dependency);
      } catch {
        problems.push(`"${name}" cannot resolve runtime require ${dependency}`);
      }
    }
  }
  for (const name of FORBIDDEN) {
    if (existsSync(join(root, "node_modules", name))) {
      problems.push(`${name} must not be shipped (found node_modules/${name})`);
    }
  }
  return problems;
}

export function checkVsix(vsix: string): string[] {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-vsix-check-")));
  try {
    execFileSync("unzip", ["-q", resolve(vsix), "-d", dir]);
    return checkExtensionRoot(join(dir, "extension"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const vsix = process.argv[2] ?? "mxlang.vsix";
  const problems = checkVsix(vsix);
  if (problems.length > 0) {
    console.error(`VSIX check failed for ${vsix}:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`VSIX check passed for ${vsix}`);
}
