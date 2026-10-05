import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkConfiguredDefaultTag } from "./default-tag-check.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function project(manifest: string): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "mx-default-tag-check-")),
  );
  roots.push(root);
  writeFileSync(join(root, "package.json"), manifest);
  return join(root, "a.mx");
}

const lookup = {
  getTag: (name: string) =>
    name === "input"
      ? { parseOptions: { openTagOnly: true } }
      : name === "div" || name === "section"
        ? {}
        : undefined,
};

const manifest = (value: unknown) =>
  `{\n  "mx": {\n    "t": { "defaultTag": ${JSON.stringify(value)} }\n  }\n}`;

describe("checkConfiguredDefaultTag: read, then validate, then the value or the one diagnostic", () => {
  it("returns a valid value and no diagnostic", () => {
    expect(
      checkConfiguredDefaultTag(project(manifest("section")), "t", {
        scope: { lookup },
      }),
    ).toEqual({ value: "section" });
  });

  it("is empty when the package configures nothing", () => {
    expect(
      checkConfiguredDefaultTag(project("{}"), "t", { scope: { lookup } }),
    ).toEqual({});
  });

  it("drops an invalid value and reports it once, positioned at the value", () => {
    const result = checkConfiguredDefaultTag(project(manifest("input")), "t", {
      scope: { lookup },
    });
    expect(result.value).toBeUndefined();
    expect(result.diagnostic).toMatchObject({
      code: "invalid-default-tag",
      severity: "error",
      message:
        "invalid `defaultTag` value: `<input>` is a void tag, not a plain tag",
      line: 3,
      column: 25,
      length: 7,
    });
  });

  it("reports a non-string value as core's type error", () => {
    const result = checkConfiguredDefaultTag(project(manifest(4)), "t", {
      scope: { lookup },
    });
    expect(result.value).toBeUndefined();
    expect(result.diagnostic?.message).toContain("is a number");
  });

  it("a scope that throws skips the reachability check: the value stays, nothing throws", () => {
    const result = checkConfiguredDefaultTag(
      project(manifest("anything")),
      "t",
      {
        scope: () => {
          throw new Error("mx.contracts[0].module must be a string");
        },
      },
    );
    expect(result).toEqual({ value: "anything" });
  });

  it("builds the scope lazily: a package with no value never builds it", () => {
    let built = 0;
    checkConfiguredDefaultTag(project("{}"), "t", {
      scope: () => {
        built++;
        return { lookup };
      },
    });
    expect(built).toBe(0);
  });
});
