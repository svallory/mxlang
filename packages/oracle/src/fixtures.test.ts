import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { discoverFixtures } from "./fixtures";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oracle-fixtures-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("discoverFixtures", () => {
  test("discovers a fixture with custom input/expected file names", () => {
    const dir = join(root, "angular-fixture");
    mkdirSync(dir);
    writeFileSync(join(dir, "input.mx"), "");
    writeFileSync(join(dir, "expected.html"), "");

    const fixtures = discoverFixtures(root, {
      input: "input.mx",
      expected: "expected.html",
    });

    expect(fixtures).toEqual(["angular-fixture"]);
  });

  test("throws on a half pair with custom file names", () => {
    const dir = join(root, "angular-fixture");
    mkdirSync(dir);
    writeFileSync(join(dir, "input.mx"), "");

    expect(() =>
      discoverFixtures(root, {
        input: "input.mx",
        expected: "expected.html",
      }),
    ).toThrow(/angular-fixture/);
  });
});
