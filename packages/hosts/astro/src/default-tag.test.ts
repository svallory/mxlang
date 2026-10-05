import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { astroDefaultTag } from "./default-tag.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function file(value: unknown): string {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "mx-astro-default-tag-")),
  );
  dirs.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ mx: { "astro-html": { defaultTag: value } } }),
  );
  return join(dir, "a.astro.mx");
}

describe("the Astro template Vite plugin's defaultTag", () => {
  it("returns a valid value", () => {
    expect(astroDefaultTag(file("section"), undefined, () => {})).toBe(
      "section",
    );
  });

  it.each(["input", "pre", "nope", "await"])(
    "drops %s and reports one error at the value",
    (name) => {
      const reports: Array<{ code: string; line: number }> = [];
      const result = astroDefaultTag(file(name), undefined, (d) =>
        reports.push(d),
      );
      expect(result).toBeUndefined();
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        code: "invalid-default-tag",
        line: 1,
      });
    },
  );

  it("accepts a scanned custom tag", () => {
    expect(astroDefaultTag(file("my-card"), { "my-card": {} }, () => {})).toBe(
      "my-card",
    );
  });
});
