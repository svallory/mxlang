import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import type { StrictTscPool } from "./strict-tsc.ts";

export default async function setup(project: TestProject) {
  const pool: StrictTscPool = {
    directory: await mkdtemp(join(tmpdir(), "mx-preact-strict-tsc-")),
    limit: Math.min(2, project.globalConfig.maxWorkers),
  };
  project.provide("strictTscPool", pool);
  console.log(
    `preact strict-tsc pool: ${pool.limit} in-process checks shared across workers`,
  );
  return () => rm(pool.directory, { recursive: true, force: true });
}
