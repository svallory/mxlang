import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BuildPassProbe } from "./build-cache.ts";
import {
  APP_ERROR,
  BROKEN,
  CASE_TIMEOUT_MS,
  here,
  mxTsc,
  mxTscIn,
  mxTscSpawn,
  type Run,
  refsFixture,
  scratch,
  setBody,
  setTemplate,
  solutionFixture,
  templateErrors,
  unlinkProjects,
} from "./build-uptodate-support.ts";

/**
 * The `-b` template pass's sidecar cache (`build-cache.ts`) end to end, over
 * the ng-build fixtures. A hit is proven by the seam counters
 * (a `BuildPassProbe` passed to the in-process run: the per-project program
 * and the Angular checker),
 * never by timing; every miss is shown by its counters and by the new output
 * it prints. Each case works on its own scratch copy and makes its own cold
 * run, so cases are independent of order. These are whole `mx-tsc -b` runs
 * (tens of seconds), so the file is in the slow lane (`scripts/vitest-lanes.ts`);
 * the key, identity, store and sidecar rules are unit-tested in
 * `build-cache.test.ts`.
 */
interface Pass extends Run {
  compiles: number;
  checkers: number;
}

async function pass(cwd: string, args: string[] = ["-b", "."]): Promise<Pass> {
  const probe: BuildPassProbe = { compiles: 0, checkers: 0 };
  const run = await mxTscIn(cwd, args, { probe });
  return { ...run, ...probe };
}

/** The spawned case runs `dist/bin.cjs`: it must be built from these sources. */
function expectFreshBuild() {
  const built = statSync(mxTsc).mtimeMs;
  const stale = readdirSync(here).filter(
    (name) =>
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      statSync(join(here, name)).mtimeMs > built,
  );
  if (stale.length > 0) {
    throw new Error(
      `dist/bin.cjs is older than src/${stale[0]}: run \`bun run build\` in packages/tooling/tsc first`,
    );
  }
}

const sidecar = (dir: string, project: "lib" | "app") =>
  join(dir, project, "out", "tsconfig.tsbuildinfo.mx-ng.json");

interface Json {
  compilerOptions: Record<string, unknown>;
  [key: string]: unknown;
}

const editJson = (file: string, edit: (json: Json) => void) => {
  const json = JSON.parse(readFileSync(file, "utf8")) as Json;
  edit(json);
  writeFileSync(file, JSON.stringify(json, null, 2));
};

// biome-ignore lint/suspicious/noTemplateCurlyInString: MX interpolation, not a JS template
const NULLISH = '<p>${user.name ?? "x"}</p>';
const NG8102 = "warning TS-998102: NG8102:";
const SUPPRESS_NG8102 = {
  extendedDiagnostics: { checks: { nullishCoalescingNotNullable: "suppress" } },
};

describe("mx-tsc -b template cache: ng-build-refs", () => {
  /**
   * One scratch copy and one cold run, then each step changes one input and
   * runs again, starting from the state the step before left. The steps:
   * hit and replay, a sidecar the read path refuses, --force, package.json
   * mx.angular (and a nearer one), a host-policy warning, the tsconfig and
   * its extends parent, a failed TypeScript pass, and the built binary.
   */
  it(
    "replays an unchanged project, misses on each input, never stores what it must not, and the built binary stores too",
    async () => {
      const dir = scratch(refsFixture);
      const app = join(dir, "app");
      const appSidecar = () => readFileSync(sidecar(dir, "app"), "utf8");
      const libSidecar = () => readFileSync(sidecar(dir, "lib"), "utf8");

      // Hit: a no-change run replays both projects.
      const cold = await pass(app);
      expect(cold.status).toBe(0);
      expect(cold.output).toBe("");
      expect([cold.compiles, cold.checkers]).toEqual([2, 2]);
      expect(existsSync(sidecar(dir, "lib"))).toBe(true);
      const warm = await pass(app);
      expect([warm.compiles, warm.checkers]).toEqual([0, 0]);
      expect(warm.output).toBe("");

      // A broken template is stored and replayed with its exact text.
      setTemplate(dir, "app", BROKEN);
      const broken = await pass(app);
      // lib is a hit; app's own text changed.
      expect([broken.compiles, broken.checkers]).toEqual([1, 1]);
      expect(broken.status).toBe(1);
      expect(templateErrors(broken.output)).toEqual([APP_ERROR]);
      expect(broken.output).toContain(
        "error TS2339: Property 'nmae' does not exist on type '{ name: string; }'.",
      );
      const replay = await pass(app);
      expect([replay.compiles, replay.checkers]).toEqual([0, 0]);
      expect(replay.status).toBe(1);
      expect(replay.output).toBe(broken.output);

      // A truncated sidecar is a miss and is rewritten (the other refusals
      // of the read path are unit rows below).
      const valid = appSidecar();
      writeFileSync(sidecar(dir, "app"), valid.slice(0, 40));
      const truncated = await pass(app);
      expect([truncated.compiles, truncated.checkers]).toEqual([1, 1]);
      expect(truncated.output).toBe(broken.output);
      expect(appSidecar()).toBe(valid);

      const forced = await pass(app, ["-b", "--force", "."]);
      expect([forced.compiles, forced.checkers]).toEqual([2, 2]);
      expect(forced.output).toBe(broken.output);

      // package.json mx.angular is an input; "off" is never stored, so the
      // original manifest replays the stored answer again.
      const manifest = join(app, "package.json");
      const original = readFileSync(manifest, "utf8");
      editJson(manifest, (json) => {
        json.mx = { angular: { diagnostics: "off" } };
      });
      const off = await pass(app);
      expect(off.compiles).toBe(1);
      expect([off.status, off.output]).toEqual([0, ""]);
      expect(appSidecar()).toBe(valid);
      writeFileSync(manifest, original);
      const back = await pass(app);
      expect(back.compiles).toBe(0);
      expect(back.output).toBe(broken.output);

      // A nearer package.json created later is an input.
      const nearer = join(app, "src", "package.json");
      writeFileSync(
        nearer,
        JSON.stringify({
          name: "nearer",
          mx: { angular: { diagnostics: "off" } },
        }),
      );
      const nearerOff = await pass(app);
      expect(nearerOff.compiles).toBe(1);
      expect([nearerOff.status, nearerOff.output]).toEqual([0, ""]);
      rmSync(nearer);

      // A pass that printed a host-policy warning is not stored, and prints
      // it again.
      editJson(manifest, (json) => {
        json.mx = { host: "bogus" };
      });
      const policy = await pass(app);
      expect(
        policy.output
          .split("\n")
          .filter((line) => line.includes("warning TS80003")),
      ).toEqual([
        expect.stringContaining('warning TS80003: unknown mx.host "bogus"'),
      ]);
      expect(appSidecar()).toBe(valid);
      const policyAgain = await pass(app);
      expect(policyAgain.compiles).toBe(1);
      expect(policyAgain.output).toBe(policy.output);
      expect(appSidecar()).toBe(valid);
      writeFileSync(manifest, original);

      // The tsconfig and its extends parent are inputs.
      setTemplate(dir, "app", NULLISH);
      writeFileSync(
        join(app, "tsconfig.base.json"),
        JSON.stringify({ angularCompilerOptions: SUPPRESS_NG8102 }),
      );
      editJson(join(app, "tsconfig.json"), (json) => {
        json.extends = "./tsconfig.base.json";
      });
      const suppressed = await pass(app);
      expect(suppressed.compiles).toBe(1);
      expect(suppressed.output).toBe("");
      writeFileSync(join(app, "tsconfig.base.json"), "{}");
      const parent = await pass(app);
      expect(parent.compiles).toBe(1);
      expect(parent.output).toContain(`app.component.ng.mx(5,18): ${NG8102}`);
      editJson(join(app, "tsconfig.json"), (json) => {
        json.angularCompilerOptions = SUPPRESS_NG8102;
      });
      const own = await pass(app);
      expect(own.compiles).toBe(1);
      expect(own.output).toBe("");

      // A run whose TypeScript pass failed reads and stores nothing.
      const stored = [libSidecar(), appSidecar()];
      const extra = join(dir, "lib", "src", "extra.ts");
      writeFileSync(extra, 'export const x: number = "s";\n');
      const failed = await pass(app);
      expect(failed.output).toContain("error TS2322");
      expect(failed.status).not.toBe(0);
      expect(failed.compiles).toBe(2);
      expect([libSidecar(), appSidecar()]).toEqual(stored);
      rmSync(extra);

      // The built binary (CommonJS bundle, its own tool identity) is a miss
      // here, and must compute a key and store under it: a key it cannot
      // build leaves the sidecar as the sources wrote it.
      expectFreshBuild();
      const keyOf = () => (JSON.parse(appSidecar()) as { key: string }).key;
      const sourceKey = keyOf();
      const built = await mxTscSpawn(app, ["-b", "."]);
      expect(built.status).toBe(0);
      expect(templateErrors(built.output)).toEqual([]);
      expect(keyOf()).not.toBe(sourceKey);
    },
    CASE_TIMEOUT_MS,
  );
});

describe("mx-tsc -b template cache: ownership chain", () => {
  it(
    "a change to an earlier project makes a later one with an overlapping include a miss",
    async () => {
      const dir = scratch(refsFixture);
      unlinkProjects(dir);
      editJson(join(dir, "app", "tsconfig.json"), (json) => {
        json.include = ["src", "../lib/src"];
        json.compilerOptions.rootDir = "..";
      });
      const roots = ["-b", join(dir, "lib"), join(dir, "app")];
      const cold = await pass(dir, roots);
      expect(cold.output).toBe("");
      expect(cold.compiles).toBe(2);
      expect((await pass(dir, roots)).compiles).toBe(0);

      // Nothing app reads changes: only lib's own tsconfig.
      editJson(join(dir, "lib", "tsconfig.json"), (json) => {
        json.compilerOptions.removeComments = true;
      });
      const after = await pass(dir, roots);
      expect(after.compiles).toBe(2);
      expect(after.output).toBe("");
    },
    CASE_TIMEOUT_MS,
  );
});

describe("mx-tsc -b template cache: ng-build-solution", () => {
  it(
    "a .ts file the component imports is an input: a type change and a body-only change are misses",
    async () => {
      const dir = scratch(solutionFixture);
      // The fixture's lib lists only `.ts` (TS6307); a failed tsc pass
      // disables the cache, so list the templates too.
      editJson(join(dir, "lib", "tsconfig.json"), (json) => {
        json.include = ["src"];
      });
      setBody(join(dir, "lib", "src", "lib.component.ng.mx"), NULLISH);
      const model = join(dir, "lib", "src", "model.ts");

      const cold = await pass(dir);
      expect(cold.status).toBe(0);
      expect(cold.output).toContain(`lib.component.ng.mx(6,18): ${NG8102}`);
      expect((await pass(dir)).compiles).toBe(0);

      // Nullable now: the template's `??` is needed, and the warning goes.
      writeFileSync(
        model,
        "export interface Item {\n  name: string | null;\n}\n",
      );
      const typed = await pass(dir);
      expect(typed.compiles).toBeGreaterThan(0);
      expect(typed.output).toBe("");

      writeFileSync(
        model,
        "export interface Item {\n  name: string | null;\n}\nexport const unused = 1;\n",
      );
      const body = await pass(dir);
      expect(body.compiles).toBeGreaterThan(0);
      expect(body.output).toBe("");
    },
    CASE_TIMEOUT_MS,
  );
});
