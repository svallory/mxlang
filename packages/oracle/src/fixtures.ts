import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface FixtureFileNames {
  input: string;
  expected: string;
}

const DEFAULT_FIXTURE_FILES: FixtureFileNames = {
  input: "input.solid.mx",
  expected: "twin.tsx",
};

/**
 * Lists fixture directory names under `fixturesRoot`, sorted. A fixture
 * directory must contain both `files.input` and `files.expected` (default:
 * input.solid.mx / twin.tsx); a directory with only one of the two is a
 * malformed fixture and throws.
 */
export function discoverFixtures(
  fixturesRoot: string,
  files: FixtureFileNames = DEFAULT_FIXTURE_FILES,
): string[] {
  const dirs = readdirSync(fixturesRoot)
    .filter((entry) => statSync(join(fixturesRoot, entry)).isDirectory())
    .filter((entry) => entry !== "__golden__")
    .sort();

  for (const dir of dirs) {
    const hasInput = existsSync(join(fixturesRoot, dir, files.input));
    const hasExpected = existsSync(join(fixturesRoot, dir, files.expected));
    if (hasInput !== hasExpected) {
      throw new Error(
        `fixture "${dir}" has only one of ${files.input} / ${files.expected}; both are required`,
      );
    }
  }

  return dirs.filter((dir) =>
    existsSync(join(fixturesRoot, dir, files.expected)),
  );
}
