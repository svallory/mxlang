/**
 * `mx.dialect` is a dialect package's identity block, never project
 * configuration. A project whose own `package.json` carries it next to
 * project settings (a dialect package that is also a project: it routes its
 * own files) is read exactly as if the block were not there: every setting
 * keeps its value and nothing complains about the extra key.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { routeDialect } from "./dialect-discovery.ts";
import { resolveTargetPolicyDetailed } from "./host-policy.ts";
import { scanCustomTags } from "./scan.ts";
import { testTargetLookup } from "./test-targets.ts";

const lookup = testTargetLookup();

const DIALECT = {
  id: "mesh",
  name: "Mesh",
  extensions: [".mesh.mx"],
  module: "./index.mjs",
};

const scratches: string[] = [];
afterEach(() => {
  for (const dir of scratches.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A project with `tags/card.mx` and the settings below, with or without the identity block. */
function project(withDialect: boolean): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-identity-block-")));
  scratches.push(dir);
  mkdirSync(join(dir, "tags"), { recursive: true });
  writeFileSync(join(dir, "tags", "card.mx"), "<div/>\n");
  const mx = {
    ...(withDialect ? { dialect: DIALECT } : {}),
    target: "page",
    strict: "always",
    page: { defaultTag: "section" },
    tags: ["tags"],
    extensions: { ".mesh.mx": "mesh" },
  };
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "mesh", mx }, null, 2),
  );
  return dir;
}

describe("`mx.dialect` next to a project's own settings", () => {
  it("leaves the target policy and its default tag unchanged, with no diagnostic", () => {
    const without = project(false);
    const withBlock = project(true);
    const plain = resolveTargetPolicyDetailed(join(without, "a.mx"), lookup);
    const mixed = resolveTargetPolicyDetailed(join(withBlock, "a.mx"), lookup);
    expect(plain.policy.target).toBe("page");
    expect(plain.policy.defaultTag).toBe("section");
    expect(mixed.policy).toMatchObject({
      target: plain.policy.target,
      strict: plain.policy.strict,
      defaultTag: "section",
    });
    expect(mixed.diagnostics).toEqual([]);
  });

  it("leaves `mx.tags` discovery unchanged, with no diagnostic", () => {
    const dir = project(true);
    const result = scanCustomTags(join(dir, "a.mx"), { targets: lookup });
    expect([...result.tags.keys()]).toEqual(["card"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("routes by `mx.extensions` and by the block's own extensions, unchanged", () => {
    const dir = project(true);
    expect(routeDialect(join(dir, "page.mesh.mx"))?.id).toBe("mesh");
    // A name only `mx.extensions` could route is not routed by the block alone.
    const other = project(true);
    writeFileSync(
      join(other, "package.json"),
      JSON.stringify({
        name: "mesh",
        mx: { dialect: DIALECT, extensions: { ".other": "mesh" } },
      }),
    );
    expect(routeDialect(join(other, "page.other"))?.id).toBe("mesh");
    expect(routeDialect(join(other, "page.mesh.mx"))?.id).toBe("mesh");
  });

  it("is not a setting: a project reads its own `mx.dialect` only as the dialect's manifest", () => {
    const dir = project(true);
    // `mx.dialect` is not a target, host or extensions map: nothing about
    // `policy` or `routeDialect` changes when only the block is present.
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "mesh", mx: { dialect: DIALECT } }),
    );
    const { policy, diagnostics } = resolveTargetPolicyDetailed(
      join(dir, "a.mx"),
      lookup,
    );
    expect(diagnostics).toEqual([]);
    expect(policy.target).toBe(lookup.defaultTarget());
    expect(routeDialect(join(dir, "a.mx"))).toBeUndefined();
  });
});
