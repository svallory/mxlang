/**
 * Test support: a project that uses a fixture dialect the way a consumer does.
 * The project's `package.json` lists a dialect package
 * as a dependency, and that package's `package.json#mx.dialect` names its own
 * `./index.cjs`, which re-exports the fixture module: a manifest's `module`
 * stays inside its package, so the package carries the module, not a path
 * out to it. Not exported from the package.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The extension the test dialect claims: `.member.mx`. */
export const FIXTURE_EXTENSIONS = [".member.mx"];

/**
 * Writes the project at `dir` and its dialect package
 * `dir/node_modules/fixture-dialect`, whose module re-exports `module` (an
 * absolute path) and whose `id` and `name` are the module's own.
 */
export function dialectPackage(
  dir: string,
  module: string,
  identity: { id: string; name: string },
): void {
  const packageDir = join(dir, "node_modules", "fixture-dialect");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({
      name: "fixture-dialect",
      mx: {
        dialect: {
          ...identity,
          extensions: FIXTURE_EXTENSIONS,
          module: "./index.cjs",
        },
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
      name: "fixture-app",
      devDependencies: { "fixture-dialect": "0.0.0" },
    }),
  );
}
