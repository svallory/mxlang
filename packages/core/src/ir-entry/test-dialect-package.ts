/**
 * Test support: a project that uses one of core's reference dialects the way
 * decision 212 has it. The project's `package.json` lists a dialect package
 * as a dependency, and that package's `package.json#mxDialect` names its own
 * `./index.cjs`, which re-exports the reference module: a manifest's `module`
 * stays inside its package, so the package carries the module, not a path
 * out to it. Not exported from the package.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The extensions the test dialect claims: Mesh's two. */
export const MESH_EXTENSIONS = [".mesh", ".mesh.mx"];

/**
 * Writes the project at `dir` and its dialect package
 * `dir/node_modules/mesh-dialect`, whose module re-exports `module` (an
 * absolute path) and whose `id` and `name` are the module's own.
 */
export function dialectPackage(
  dir: string,
  module: string,
  identity: { id: string; name: string },
): void {
  const packageDir = join(dir, "node_modules", "mesh-dialect");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({
      name: "mesh-dialect",
      mxDialect: {
        ...identity,
        extensions: MESH_EXTENSIONS,
        module: "./index.cjs",
      },
    }),
  );
  writeFileSync(
    join(packageDir, "index.cjs"),
    `module.exports = require(${JSON.stringify(module)});\n`,
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "mesh-app",
      devDependencies: { "mesh-dialect": "0.0.0" },
    }),
  );
}
