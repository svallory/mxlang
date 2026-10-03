/** Run after the root build: Bun can exit zero while omitting an entry. */
import {
  missingRuntimeEntries,
  PACKED_PACKAGES,
  pkgDirOf,
  readPackageJson,
} from "./pack-hygiene.ts";

let failed = false;
for (const pkg of PACKED_PACKAGES) {
  const dir = pkgDirOf(pkg);
  for (const entry of missingRuntimeEntries(dir, readPackageJson(dir))) {
    console.error(`[build] ${pkg.name}: missing required JS artifact ${entry}`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
