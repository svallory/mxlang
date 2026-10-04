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
it.each([{}, { "@mxlang/solid": "1" }])(
  "explicit data is a positioned registry-only error, with the unknown-target fallback (%j)",
  (deps) => {
    const file = project({ target: "data" }, deps);
    const { policy, diagnostics } = resolveTargetPolicyDetailed(file);
    expect(coreResolve(file, builtinLookup())).toMatchObject({
      policy: { target: "data" },
      diagnostics: [],
    });
    expect(policy.target).toBe(Object.keys(deps).length ? "solid-jsx" : "html");
    expect(diagnostics).toEqual([
      {
        code: "unknown-target",
        severity: "error",
        value: "data",
        file: join(file, "../package.json"),
        line: 3,
        column: 14,
        length: 6,
        message:
          'mx.target "data" is not wired into the editor and build tools yet (TODO data-target-tooling-dispatch); call parseData from @mxlang/data instead',
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
    expect(reported[0]?.message).toContain("parseData from @mxlang/data");
    expect(related[0]?.diagnostics[0]).toMatchObject({
      severity: 1,
      range: {
        start: { line: 2, character: 14 },
        end: { line: 2, character: 20 },
      },
    });
  },
);
it("staged data is neither advertised nor suggested for an unknown target", () => {
  const { diagnostics } = resolveTargetPolicyDetailed(
    project({ target: "dta" }),
  );
  expect(diagnostics[0]?.message).not.toContain("data");
  expect(diagnostics[0]?.message).not.toContain('Did you mean "data"?');
  // Registration and package inference still know the staged target.
  expect(builtinLookup().targetNames()).toContain("data");
});
it("data plus an explicit host uses the host, as unknown-target does", () => {
  expect(
    resolveTargetPolicyDetailed(project({ target: "data", host: "solid" }))
      .policy.target,
  ).toBe("solid-jsx");
});
it("the rule-2 data shim stays silent and unchanged", () => {
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

it.each([{}, { "@mxlang/solid": "1" }])(
  "dataWired answers the real data policy; the default stays staged (%j)",
  (deps) => {
    const file = project({ target: "data" }, deps);
    expect(resolveTargetPolicyDetailed(file, { dataWired: true })).toEqual({
      policy: { target: "data", host: undefined },
      diagnostics: [],
    });
    // The option is opt-in: the same call without it is still the staged error.
    expect(resolveTargetPolicyDetailed(file).diagnostics).toHaveLength(1);
  },
);

it("dataWired also resolves a dependency-inferred data package (rule 5)", () => {
  const file = project(undefined, { "@mxlang/data": "*" });
  expect(resolveTargetPolicyDetailed(file).policy.target).toBe("html");
  expect(
    resolveTargetPolicyDetailed(file, { dataWired: true }).policy.target,
  ).toBe("data");
});
