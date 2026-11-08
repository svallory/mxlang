import { describe, expect, it } from "vitest";
import {
  type Inputs,
  install,
  NATIVE_PREFIX,
  SUPPORTED_VERSIONS,
} from "./test-affected-cache.ts";
import {
  expectedSelection,
  nativeReason,
  ROWS,
  runRowAlone,
} from "./test-affected-parity.ts";

describe("test:affected parity verifier rows", () => {
  // One test per row: a failure names its row, and a slow one is visible.
  it.each(ROWS.map((r) => [r.name, r] as const))(
    "%s",
    async (_name, row) => {
      expect(await runRowAlone(row)).toEqual([]);
    },
    60_000,
  );
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
    expect(nativeReason(lines[0])).toMatch(
      /symlink leaves the repository.*a -> \/x/,
    );
  });

  it("reads the line the reporter's catch path warns with", () => {
    expect(nativeReason(`test:affected cache: ${NATIVE_PREFIX}: boom`)).toBe(
      "boom",
    );
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
