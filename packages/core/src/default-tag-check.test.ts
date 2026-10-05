import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTranslator } from "./compile.ts";
import { CORE_TAGLIB } from "./core-taglib.ts";
import {
  checkConfiguredDefaultTag,
  defaultTagScopeFor,
} from "./default-tag-check.ts";
import { lookup as targets } from "./test-targets.ts";

/** A real translator over Marko's html taglibs plus the core tags (await, try, define, effect). */
const translator = createTranslator({
  taglibs: [["mx-translator-core", CORE_TAGLIB]],
  tagDiscoveryDirs: [],
  targets,
});

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

  it("a scope builder that throws is no scan failure: it throws as before", () => {
    expect(() =>
      checkConfiguredDefaultTag(project(manifest("anything")), "t", {
        scope: () => {
          throw new Error("taglib failed to load");
        },
      }),
    ).toThrow("taglib failed to load");
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

describe("a scan failure: only the custom tags become unknown (round 3)", () => {
  const failing = () => {
    throw new Error("mx.contracts[0].module must be a string");
  };
  const check = (value: string) =>
    checkConfiguredDefaultTag(project(manifest(value)), "t", {
      scope: () =>
        defaultTagScopeFor({ dir: tmpdir(), translator, customTags: failing }),
    });

  it("still runs the parse-shape check: `input` is the void-tag error", () => {
    expect(check("input").diagnostic?.message).toBe(
      "invalid `defaultTag` value: `<input>` is a void tag, not a plain tag",
    );
  });

  it("skips a verdict that needs the custom tags: an unknown name is kept", () => {
    expect(check("nope")).toEqual({ value: "nope" });
  });

  it("a plain lookup tag is kept", () => {
    expect(check("section")).toEqual({ value: "section" });
  });
});

describe("defaultTagScopeFor: an element needs the host's say and Marko's html flag (round 3)", () => {
  const build = (declarations?: { isElement: (n: string) => boolean }) =>
    defaultTagScopeFor({
      dir: tmpdir(),
      translator,
      ...(declarations ? { declarations: declarations as never } : {}),
    });

  it("a host that calls every lowercase name an element still loses to the html flag", () => {
    const scope = build({ isElement: (n) => !/^[A-Z]/.test(n) });
    expect(scope.isElement?.("div")).toBe(true);
    for (const name of ["await", "try", "define", "effect"]) {
      expect(scope.isElement?.(name), name).toBe(false);
    }
  });

  it("a target with no declarations: the html flag alone answers", () => {
    const scope = build();
    expect(scope.isElement?.("div")).toBe(true);
    for (const name of ["await", "try", "define", "effect"]) {
      expect(scope.isElement?.(name), name).toBe(false);
    }
  });

  it("the host's `false` still wins (data)", () => {
    expect(build({ isElement: () => false }).isElement?.("div")).toBe(false);
  });

  it("a custom-tag thunk that throws makes the custom tags unknown, nothing else", () => {
    const scope = defaultTagScopeFor({
      dir: tmpdir(),
      translator,
      customTags: () => {
        throw new Error("scan failed");
      },
    });
    expect(scope.customTagsUnknown).toBe(true);
    expect(scope.customTags).toBeUndefined();
    expect(scope.lookup).toBeDefined();
  });

  it("an error from the translator or lookup is not a scan failure: it throws", () => {
    expect(() =>
      defaultTagScopeFor({
        dir: tmpdir(),
        translator: {
          get taglibs(): never {
            throw new Error("taglib failed to load");
          },
        },
      }),
    ).toThrow();
  });
});
