import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { compileHonoMx } from "./index.ts";

/**
 * Regression: `<try><@catch|error|>` must type-check against the *real*
 * `MxErrorBoundary` runtime types under `strict`. The generated
 * `<__mxErrorBoundary fallback={(error) => ...}>` uses the tag as a JSX
 * component and the `fallback` arrow relies on contextual typing, so an
 * `unknown` return type or a `((error: Error) => unknown) | unknown` union
 * (which collapses to `unknown`) fails with TS2786 and TS7006 respectively.
 * Runs mx-tsc on a scratch project — exactly the lane `examples/hono-app`'s
 * `typecheck` script runs in CI — after checking the generated text shape
 * with `compileHonoMx`.
 */

const here = import.meta.dirname;
const pkg = join(here, "..");
const repo = join(pkg, "..", "..", "..");

const SOURCE =
  "<main><try><p>ok</p><@catch|error|><p>caught: ${(error as Error).message}</p></@catch></try></main>";

let project = "";

beforeAll(() => {
  const work = mkdtempSync(join(tmpdir(), "mx-hono-try-typecheck-"));
  project = join(work, "project");
  mkdirSync(join(project, "node_modules", "@mxlang"), { recursive: true });
  symlinkSync(
    join(repo, "node_modules/hono"),
    join(project, "node_modules/hono"),
  );
  symlinkSync(pkg, join(project, "node_modules/@mxlang/host-hono"));
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ mx: { host: "hono" } }),
  );
  writeFileSync(
    join(project, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        jsx: "react-jsx",
        jsxImportSource: "hono/jsx",
        module: "esnext",
        moduleResolution: "bundler",
        allowImportingTsExtensions: true,
        types: [],
      },
      include: ["*.mx"],
    }),
  );
  const { code } = compileHonoMx(SOURCE, "/try-typecheck/app.mx");
  // The lowered text must still be the boundary shape the runtime owns.
  expect(code).toContain("__mxErrorBoundary");
  writeFileSync(join(project, "app.mx"), SOURCE);
});

afterAll(() => {
  if (project) rmSync(join(project, ".."), { recursive: true, force: true });
});

it("type-checks a <try><@catch|error|> program against the runtime types", () => {
  const result = spawnSync(
    process.execPath,
    [
      join(repo, "packages/tooling/tsc/dist/bin.cjs"),
      "--noEmit",
      "--pretty",
      "false",
    ],
    { encoding: "utf8", cwd: project },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  expect(output, output).not.toMatch(/TS2786|TS7006/);
  expect(result.status).toBe(0);
});
