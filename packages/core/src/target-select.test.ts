import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTargetPolicyDetailed } from "./host-policy.ts";
import { hostRestrictionDiagnostics } from "./scan.ts";
import { createTargetLookup } from "./target-descriptor.ts";

// Invented names prove core remains open-set (decision 126).
const lookup = createTargetLookup([
  {
    descriptorVersion: 0,
    name: "page",
    packageName: "@t/page",
    legacyHostValues: [{ value: "page" }],
  },
  {
    descriptorVersion: 0,
    name: "unit-jsx",
    packageName: "@t/unit",
    host: { name: "unit", default: true },
  },
  {
    descriptorVersion: 0,
    name: "unit-dom",
    packageName: "@t/unit",
    host: { name: "unit" },
  },
  {
    descriptorVersion: 0,
    name: "view-jsx",
    packageName: "@t/view",
    host: { name: "view" },
  },
  { descriptorVersion: 0, name: "tree", packageName: "@t/tree" },
]);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function resolve(mx: unknown, dependencies = {}, text?: string) {
  const root = mkdtempSync(join(tmpdir(), "mx-target-select-"));
  roots.push(root);
  const file = join(root, "package.json");
  writeFileSync(file, text ?? JSON.stringify({ mx, dependencies }));
  return { ...resolveTargetPolicyDetailed(join(root, "a.mx"), lookup), file };
}

describe("mx.target resolution table (§4.1)", () => {
  it.each([
    ["neither, default", {}, {}, "page", undefined, []],
    ["neither, rule 2", {}, { "@t/unit": "1" }, "unit-jsx", "unit", []],
    ["host alone", { host: "unit" }, {}, "unit-jsx", "unit", []],
    ["legacy alone", { host: "page" }, {}, "page", undefined, []],
    ["target alone", { target: "page" }, {}, "page", undefined, []],
    [
      "explicit beats dependency",
      { target: "page" },
      { "@t/unit": "1" },
      "page",
      undefined,
      [],
    ],
    [
      "host-bearing target alone",
      { target: "unit-jsx" },
      {},
      "unit-jsx",
      "unit",
      [],
    ],
    [
      "hostless registered target",
      { target: "tree" },
      {},
      "tree",
      undefined,
      [],
    ],
    ["agree", { host: "unit", target: "unit-jsx" }, {}, "unit-jsx", "unit", []],
    [
      "non-default target of same host",
      { host: "unit", target: "unit-dom" },
      {},
      "unit-dom",
      "unit",
      [],
    ],
    [
      "legacy agree",
      { host: "page", target: "page" },
      {},
      "page",
      undefined,
      [],
    ],
    [
      "another host",
      { host: "unit", target: "view-jsx" },
      {},
      "view-jsx",
      "view",
      ["target-host-mismatch"],
    ],
    [
      "hostless mismatch",
      { host: "unit", target: "page" },
      {},
      "page",
      undefined,
      ["target-host-mismatch"],
    ],
    [
      "legacy mismatch",
      { host: "page", target: "view-jsx" },
      {},
      "view-jsx",
      "view",
      ["target-host-mismatch"],
    ],
    [
      "unknown host, valid target",
      { host: "bogus", target: "unit-jsx" },
      {},
      "unit-jsx",
      "unit",
      ["unknown-host"],
    ],
    [
      "host used as target",
      { target: "unit" },
      {},
      "page",
      undefined,
      ["unknown-target"],
    ],
    [
      "unknown target, rule 2",
      { target: "bogus" },
      { "@t/view": "1" },
      "view-jsx",
      "view",
      ["unknown-target"],
    ],
    [
      "unknown target, valid host",
      { host: "unit", target: "bogus" },
      {},
      "unit-jsx",
      "unit",
      ["unknown-target"],
    ],
    [
      "both unknown",
      { host: "bogus", target: "missing" },
      {},
      "page",
      undefined,
      ["unknown-host", "unknown-target"],
    ],
  ])("%s", (_label, mx, deps, target, host, codes) => {
    const result = resolve(mx, deps);
    expect(result.policy).toMatchObject({ target, host });
    expect(result.diagnostics.map((d) => d.code)).toEqual(codes);
    for (const diagnostic of result.diagnostics) {
      if (diagnostic.code !== "unknown-host")
        expect(diagnostic.severity).toBe("error");
    }
  });

  it.each(["unit", "missing", "@t/target"])(
    "carries the offending string %s on unknown-target diagnostics",
    (target) => {
      expect(resolve({ target }).diagnostics[0]).toMatchObject({
        code: "unknown-target",
        value: target,
      });
    },
  );

  it("reads strict from an explicit target", () => {
    expect(resolve({ target: "unit-jsx", strict: true }).policy.strict).toBe(
      true,
    );
  });
  it.each(["@acme/mx-view", "x/y", ".local", "/absolute"])(
    "package specifier %s is a positioned error",
    (target) => {
      const { policy, diagnostics } = resolve({ target }, { "@t/unit": "1" });
      expect(policy.target).toBe("unit-jsx");
      expect(diagnostics[0]).toMatchObject({
        code: "unknown-target",
        severity: "error",
        length: JSON.stringify(target).length,
        message: `mx.target ${JSON.stringify(target)}: loading a target package is not supported yet.`,
      });
    },
  );
  it.each([null, 5, false, ["page"], { name: "page" }])(
    "invalid non-string target %j",
    (target) => {
      expect(resolve({ target }).diagnostics[0]).toMatchObject({
        code: "unknown-target",
        severity: "error",
        length: JSON.stringify(target).length,
      });
    },
  );
  it("offers a host hint only for host names, and a two-edit target suggestion otherwise", () => {
    expect(resolve({ target: "unit" }).diagnostics[0]?.message).toContain(
      '"unit" is a host, not a target: its default target is "unit-jsx" (use mx.host "unit" or mx.target "unit-jsx").',
    );
    expect(resolve({ target: "unit-js" }).diagnostics[0]?.message).toContain(
      'Did you mean "unit-jsx"?',
    );
    expect(resolve({ target: "bogus" }).diagnostics[0]?.message).not.toContain(
      "Did you mean",
    );
  });
  it.each([
    [
      "unit",
      "view-jsx",
      'mx.target "view-jsx" belongs to host "view", but mx.host is "unit". Remove one of them: mx.host "unit" selects target "unit-jsx"; mx.target "view-jsx" selects host "view".',
    ],
    [
      "unit",
      "page",
      'mx.target "page" has no host, but mx.host is "unit". Remove one of them: mx.host "unit" selects target "unit-jsx"; mx.target "page" needs no mx.host.',
    ],
    [
      "page",
      "view-jsx",
      'mx.host "page" is the legacy spelling of mx.target "page", but mx.target is "view-jsx" (host "view"). Remove mx.host: mx.target alone selects the target.',
    ],
  ])("exact mismatch message %s/%s", (host, target, message) => {
    expect(resolve({ host, target }).diagnostics[0]?.message).toBe(message);
  });
  it("positions the target and related host values, skipping nested keys and escaped spelling (CRLF/UTF-16)", () => {
    const text =
      '{\r\n  "other": {"mx":{"target":"view-jsx"}},\r\n  "mx": {\r\n    "nested": {"host":"unit","target":"view-jsx"},\r\n    "host": "unit",\r\n    "target": "view-js\\u0078"\r\n  }\r\n}';
    const { diagnostics, file } = resolve({}, {}, text);
    expect(diagnostics[0]).toMatchObject({
      code: "target-host-mismatch",
      line: 6,
      column: 14,
      length: 15,
      relatedInformation: [{ file, line: 5, column: 12, length: 6 }],
    });
  });
  it("warns when a target is used as a host restriction", () => {
    const restriction = {
      file: "/p/package.json",
      line: 1,
      column: 0,
      host: "unit-jsx",
    };
    expect(hostRestrictionDiagnostics([restriction], lookup)[0]?.message).toBe(
      '`mx.tags` names an unknown host in `hosts`: unit-jsx ("unit-jsx" is a target; hosts filters by host: use "unit")',
    );
  });
});
