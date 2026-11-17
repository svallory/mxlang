import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Inputs,
  install,
  NATIVE_PREFIX,
  SUPPORTED_VERSIONS,
} from "./test-affected-cache.ts";
import {
  expectedSelection,
  makeBaseline,
  nativeReason,
  nativeRunProblem,
  planShards,
  ROWS,
  runRowAlone,
} from "./test-affected-parity.ts";

describe("test:affected parity verifier rows", () => {
  // One fixture repository for the file, copied per row.
  let baseline = "";
  beforeAll(() => {
    baseline = makeBaseline();
  });
  afterAll(() => {
    if (baseline) rmSync(baseline, { recursive: true, force: true });
  });

  // One test per row: a failure names its row, and a slow one is visible.
  it.each(ROWS.map((r) => [r.name, r] as const))(
    "%s",
    async (_name, row) => {
      expect(await runRowAlone(row, baseline)).toEqual([]);
    },
    60_000,
  );
});

describe("the fixture repository", () => {
  // A background `git maintenance run --auto` started by `git commit` can
  // change `.git/objects` while a row copies the repository (mx-cgjy).
  it("starts no git auto-maintenance on commit, and the check sees one when it is on", () => {
    const baseline = makeBaseline();
    const commit = (...override: string[]) =>
      spawnSync(
        "git",
        [
          "-c",
          "user.name=parity",
          "-c",
          "user.email=parity@example.com",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=/dev/null",
          ...override,
          "commit",
          "-q",
          "--allow-empty",
          "--no-verify",
          "-m",
          "x",
        ],
        {
          cwd: baseline,
          encoding: "utf8",
          env: { ...process.env, GIT_TRACE: "1" },
        },
      );
    try {
      // Control: maintenance on, in the foreground so nothing is left running.
      const on = commit(
        "-c",
        "maintenance.auto=true",
        "-c",
        "maintenance.autoDetach=false",
        "-c",
        "gc.autoDetach=false",
      );
      expect(on.status).toBe(0);
      expect(on.stderr).toMatch(/maintenance run --auto/);

      const off = commit();
      expect(off.status).toBe(0);
      expect(off.stderr).not.toMatch(/maintenance run --auto/);
      expect(off.stderr).not.toMatch(/gc --auto/);
    } finally {
      rmSync(baseline, { recursive: true, force: true });
    }
  });
});

describe("nativeReason (the verifier's reading of a native fallback)", () => {
  it("reads the line install() warns with", () => {
    const lines: string[] = [];
    const inputs = {
      versions: SUPPORTED_VERSIONS,
      inventory: undefined,
      linkEscape: "a -> /x",
    } as unknown as Inputs;
    install([], inputs, "/nowhere", (m) =>
      lines.push(`test:affected cache: ${m}`),
    );
    expect(lines).toHaveLength(1);
    const line = lines[0];
    if (line === undefined) throw new Error("install() warned once");
    expect(nativeReason(line)).toMatch(
      /symlink leaves the repository.*a -> \/x/,
    );
  });

  it("reads the line the reporter's catch path warns with", () => {
    expect(nativeReason(`test:affected cache: ${NATIVE_PREFIX}: boom`)).toBe(
      "boom",
    );
  });

  it("fails a real run that went native with the reason, for both emitters", () => {
    const viaInstall = [] as string[];
    install(
      [],
      {
        versions: SUPPORTED_VERSIONS,
        inventory: undefined,
      } as unknown as Inputs,
      "/nowhere",
      (m) => viaInstall.push(`test:affected cache: ${m}`),
    );
    const line = viaInstall[0];
    if (line === undefined) throw new Error("install() warned once");
    expect(nativeRunProblem(line)).toMatch(
      /^cache is native here: file inventory unavailable; parity cannot/,
    );
    expect(
      nativeRunProblem(`test:affected cache: ${NATIVE_PREFIX}: boom`),
    ).toBe("cache is native here: boom; parity cannot be proven");
    expect(nativeRunProblem("selection 5 ms, 0 hits")).toBeUndefined();
  });

  it("is undefined for a normal summary line", () => {
    expect(
      nativeReason("test:affected cache: selection 5 ms, 3 hits, 0 misses"),
    ).toBeUndefined();
  });
});

describe("expectedSelection (the sampled-edit model of native)", () => {
  const deps = new Map([
    ["p a.test.ts", ["/r/lib.ts"]],
    ["p b.test.ts", ["/r/other.ts"]],
  ]);

  it("selects the tests that import the file, and the file's own test", () => {
    expect(expectedSelection(deps, "/r/lib.ts", false, "lib.ts")).toEqual([
      "p a.test.ts",
    ]);
    expect(expectedSelection(deps, "/r/b.test.ts", false, "b.test.ts")).toEqual(
      ["p b.test.ts"],
    );
  });

  it("selects every test for a force-rerun trigger", () => {
    expect(
      expectedSelection(deps, "/r/package.json", true, "package.json"),
    ).toEqual(["p a.test.ts", "p b.test.ts"]);
  });
});

describe("planShards", () => {
  it("places @mxlang/core-isolated in the same shard as @mxlang/core, once", () => {
    const shards = planShards(3);
    const all = shards.flat();
    expect(all.filter((n) => n === "@mxlang/core-isolated")).toHaveLength(1);
    const k = shards.findIndex((p) => p.includes("@mxlang/core"));
    expect(shards[k]).toContain("@mxlang/core-isolated");
  });
});
