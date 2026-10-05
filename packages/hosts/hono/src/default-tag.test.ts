import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanCached } from "@mxlang/core";
import { afterEach, describe, expect, it } from "vitest";
import { honoDefaultTag } from "./default-tag.ts";
import { honoTargets } from "./index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function file(value: unknown): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-hono-default-tag-")));
  dirs.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ mx: { "hono-jsx": { defaultTag: value } } }),
  );
  return join(dir, "a.mx");
}

describe("the Hono Bun loader's defaultTag", () => {
  it("returns a valid value", () => {
    expect(honoDefaultTag(file("section"), undefined, () => {})).toBe(
      "section",
    );
  });

  it.each(["input", "pre", "nope", "await"])(
    "drops %s and reports one error at the value",
    (name) => {
      const reports: Array<{ code: string; message: string }> = [];
      const result = honoDefaultTag(file(name), undefined, (d) =>
        reports.push(d),
      );
      expect(result).toBeUndefined();
      expect(reports).toHaveLength(1);
      expect(reports[0]?.code).toBe("invalid-default-tag");
    },
  );

  it("accepts a scanned custom tag", () => {
    expect(honoDefaultTag(file("my-card"), { "my-card": {} }, () => {})).toBe(
      "my-card",
    );
  });
});

describe("the contracts' defaultTag from the hono path that scans for itself (review round 2)", () => {
  function withContract(value: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-hono-contract-")));
    dirs.push(dir);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ mx: { contracts: "./contracts.ts" } }),
    );
    writeFileSync(
      join(dir, "contracts.ts"),
      `export default { "my-list": { defaultTag: "${value}" } };\n`,
    );
    return join(dir, "a.mx");
  }
  const scanOf = (file: string) =>
    scanCached(file, { host: "hono", targets: honoTargets });

  it("an invalid value is reported once, at the contracts module", () => {
    const file = withContract("nope");
    const reports: Array<{ file: string; message: string }> = [];
    const scan = scanOf(file);
    honoDefaultTag(file, scan.customTags, (d) => reports.push(d), scan.tags);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.file).toBe(join(file, "..", "contracts.ts"));
    expect(reports[0]?.message).toContain("`<nope>` is not a tag reachable");
  });

  it("a valid value reports nothing", () => {
    const file = withContract("section");
    const reports: unknown[] = [];
    const scan = scanOf(file);
    honoDefaultTag(file, scan.customTags, (d) => reports.push(d), scan.tags);
    expect(reports).toEqual([]);
  });
});
