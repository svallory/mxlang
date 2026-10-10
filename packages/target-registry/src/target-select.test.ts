import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTargetPolicyDetailed as coreResolve } from "@mxlang/core";
import { afterEach, expect, it } from "vitest";
import { diagnoseDocument } from "../../tooling/language-server/src/diagnose.ts";
import { builtinLookup, resolveTargetPolicyDetailed } from "./index.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function project(mx: unknown, dependencies = {}) {
  const root = mkdtempSync(join(tmpdir(), "mx-registry-target-"));
  roots.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ mx, dependencies }, null, 2),
  );
  return join(root, "a.mx");
}
it.each([{}, { "@mxlang/host-solid": "1" }])(
  "explicit tree (removed, decision 204) is a positioned error naming lowerSource, with the unknown-target fallback (%j)",
  (deps) => {
    const file = project({ target: "tree" }, deps);
    const { policy, diagnostics } = resolveTargetPolicyDetailed(file);
    // Core's own answer is the generic unknown target; the registry words it.
    expect(coreResolve(file, builtinLookup())).toMatchObject({
      diagnostics: [{ code: "unknown-target", value: "tree" }],
    });
    expect(policy.target).toBe(Object.keys(deps).length ? "solid-jsx" : "html");
    expect(diagnostics).toEqual([
      {
        code: "unknown-target",
        severity: "error",
        value: "tree",
        file: join(file, "../package.json"),
        line: 3,
        column: 14,
        length: 6,
        message:
          'mx.target "tree" was removed (decision 204); a consumer that reads the tree calls lowerSource from @mxlang/core',
      },
    ]);
    const related: Parameters<typeof diagnoseDocument>[6] = [];
    const reported = diagnoseDocument(
      "<p>ok</p>",
      file,
      policy,
      undefined,
      "mx",
      undefined,
      related,
      undefined,
      diagnostics,
    );
    expect(reported[0]?.severity).toBe(1);
    expect(reported[0]?.message).toContain("lowerSource from @mxlang/core");
    expect(related[0]?.diagnostics[0]).toMatchObject({
      severity: 1,
      range: {
        start: { line: 2, character: 14 },
        end: { line: 2, character: 20 },
      },
    });
  },
);
it('mx.target: "data" is refused as the reserved name (decision 187)', () => {
  const { diagnostics } = resolveTargetPolicyDetailed(
    project({ target: "data" }, { "@mxlang/host-solid": "1" }),
  );
  expect(diagnostics[0]).toMatchObject({
    code: "unknown-target",
    severity: "error",
    value: "data",
    // The range of the `mx.target` value, `"data"` in package.json line 3.
    line: 3,
    column: 14,
    length: 6,
  });
  expect(diagnostics[0]?.message).toContain(
    '"data" is reserved for the evaluated tree target (decision 187); a consumer that reads the tree calls lowerSource from @mxlang/core',
  );
});
it("tree is neither advertised nor suggested for an unknown target", () => {
  const { diagnostics } = resolveTargetPolicyDetailed(
    project({ target: "dta" }),
  );
  expect(diagnostics[0]?.message).not.toContain("data");
  expect(diagnostics[0]?.message).not.toContain('Did you mean "data"?');
  expect(diagnostics[0]?.message).not.toContain("tree");
  expect(builtinLookup().targetNames()).not.toContain("tree");
});
it("tree plus an explicit host uses the host, as unknown-target does", () => {
  expect(
    resolveTargetPolicyDetailed(project({ target: "tree", host: "solid" }))
      .policy.target,
  ).toBe("solid-jsx");
});
it("a leftover @mxlang/data dependency selects nothing and stays silent", () => {
  expect(
    resolveTargetPolicyDetailed(project({}, { "@mxlang/data": "1" })),
  ).toEqual({ policy: { target: "html", host: undefined }, diagnostics: [] });
});
it("legacy agreement remains silent; disagreement keeps the explicit target", () => {
  expect(
    resolveTargetPolicyDetailed(project({ host: "html", target: "html" }))
      .diagnostics,
  ).toEqual([]);
  expect(
    resolveTargetPolicyDetailed(
      project({ host: "html", target: "astro-html" }),
    ),
  ).toMatchObject({
    policy: { target: "astro-html", host: "astro" },
    diagnostics: [{ code: "target-host-mismatch", severity: "error" }],
  });
});

// TODO dialect-check (PR 1c): decision 204 removed the tree target; the dialect
// check re-keys `dataWired`.
it.skip.each([{}, { "@mxlang/host-solid": "1" }])(
  "dataWired answers the real data policy; the default stays staged (%j)",
  (deps) => {
    const file = project({ target: "tree" }, deps);
    expect(resolveTargetPolicyDetailed(file, { dataWired: true })).toEqual({
      policy: { target: "tree", host: undefined },
      diagnostics: [],
    });
    // The option is opt-in: the same call without it is still the staged error.
    expect(resolveTargetPolicyDetailed(file).diagnostics).toHaveLength(1);
  },
);

// TODO dialect-check (PR 1c): decision 204 removed the tree target; the dialect
// check re-keys `dataWired`.
it.skip("dataWired also resolves a dependency-inferred data package (rule 5)", () => {
  const file = project(undefined, { "@mxlang/data": "*" });
  expect(resolveTargetPolicyDetailed(file).policy.target).toBe("html");
  expect(
    resolveTargetPolicyDetailed(file, { dataWired: true }).policy.target,
  ).toBe("tree");
});
