import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { currentLane, laneTest, SLOW_LANE_FILES } from "./vitest-lanes.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("currentLane", () => {
  it("runs everything when unset or empty", () => {
    expect(currentLane({})).toBe("all");
    expect(currentLane({ MX_TEST_LANE: "" })).toBe("all");
    expect(currentLane({ MX_TEST_LANE: "all" })).toBe("all");
  });
  it("accepts fast and slow", () => {
    expect(currentLane({ MX_TEST_LANE: "fast" })).toBe("fast");
    expect(currentLane({ MX_TEST_LANE: "slow" })).toBe("slow");
  });
  it("rejects a typo instead of silently running a subset", () => {
    expect(() => currentLane({ MX_TEST_LANE: "fats" })).toThrow(
      /must be "all", "fast" or "slow"/,
    );
  });
});

describe("laneTest", () => {
  const slow = ["src/a.test.ts"];
  it("all: no slow glob is excluded and include is left alone", () => {
    const cfg = laneTest(slow, { lane: "all", exclude: ["x"] });
    expect(cfg).toEqual({ exclude: ["x"] });
  });
  it("all keeps the project's own include", () => {
    const cfg = laneTest(slow, { lane: "all", include: ["src/**"] });
    expect(cfg.include).toEqual(["src/**"]);
  });
  it("fast: adds the slow globs to exclude", () => {
    const cfg = laneTest(slow, { lane: "fast", exclude: ["x"] });
    expect(cfg.exclude).toEqual(["x", "src/a.test.ts"]);
  });
  it("slow: includes only the slow globs and keeps the excludes", () => {
    const cfg = laneTest(slow, {
      lane: "slow",
      include: ["src/**"],
      exclude: ["x"],
    });
    expect(cfg).toEqual({ include: slow, exclude: ["x"] });
  });
  it("defaults to vitest's own excludes", () => {
    expect(laneTest(slow, { lane: "all" }).exclude).toContain(
      "**/node_modules/**",
    );
  });
});

// A slow-listed file that no longer exists means the lane silently changed
// shape (a renamed file): the slow lane would drop it while "fast + slow ==
// all" stays trivially true. The lists themselves live in vitest-lanes.ts so
// this one module is the single source of truth.
describe("the declared slow lanes", () => {
  for (const [dir, files] of Object.entries(SLOW_LANE_FILES)) {
    it(`${dir}: every slow-lane file exists`, () => {
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        expect(existsSync(resolve(root, dir, f)), `${dir}/${f}`).toBe(true);
      }
    });
    it(`${dir}: slow files stay out of the fast lane`, () => {
      const cfg = laneTest(files, { lane: "fast" });
      for (const f of files) {
        expect(cfg.exclude).toContain(f);
      }
    });
  }
});
