import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTargetLookup } from "@mxlang/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  type MeshOptions,
  meshProject,
  setupMesh,
  teardownMesh,
} from "../../../test-fixtures/third-party-targets/mesh.ts";
import { isDataProject } from "./data-check.ts";
import {
  builtinLookup,
  builtinTargets,
  defaultTagFor,
  resolveTargetPolicyDetailed,
} from "./index.ts";

const scratch: string[] = [];

afterEach(() => {
  teardownMesh();
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function manifest(json: object): string {
  const dir = mkdtempSync(join(tmpdir(), "mx-base-target-"));
  scratch.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify(json));
  return dir;
}

function mesh(options: MeshOptions = {}): string {
  setupMesh(builtinLookup().target("tree"), options);
  return meshProject("mx-base-target-mesh-", options);
}

// TODO dialect-check (PR 1c): decision 204 removed the tree target; the dialect
// check re-keys this suite.
describe.skip("the base target of a lookup", () => {
  it("is each built-in target's own name, and `tree` for a host that declares builtOn", () => {
    const lookup = builtinLookup();
    expect(
      Object.fromEntries(
        builtinTargets.map((t) => [t.name, lookup.baseTargetOf?.(t.name)]),
      ),
    ).toEqual(Object.fromEntries(builtinTargets.map((t) => [t.name, t.name])));
    const data = lookup.target("tree");
    if (!data) throw new Error("no tree descriptor");
    const withMesh = createTargetLookup([
      ...builtinTargets,
      {
        ...data,
        name: "mesh-data",
        packageName: "@fake/mx-mesh",
        host: { name: "mesh" },
        builtOn: "tree",
        // A copy of the tree descriptor reads config under its own name; the
        // base target's `mx.data` stays the base rung, not this host's key.
        configKey: undefined,
      },
    ]);
    expect(withMesh.baseTargetOf?.("mesh-data")).toBe("tree");
    expect(withMesh.baseTargetOf?.("nope")).toBeUndefined();
  });
});

// TODO dialect-check (PR 1c): decision 204 removed the tree target; the dialect
// check re-keys this suite.
describe.skip("isDataProject keys on the resolved base target", () => {
  it("accepts mx.target: tree", () => {
    expect(isDataProject(manifest({ mx: { target: "tree" } }))).toBe(true);
  });

  it("accepts a third-party host built on tree (mx.host)", () => {
    expect(isDataProject(mesh())).toBe(true);
  });

  it("rejects a third-party host that reuses declarations without tree's base target", () => {
    expect(isDataProject(mesh({ notBuiltOnData: true }))).toBe(false);
  });

  it("rejects a built-in host and a built-in non-tree target", () => {
    expect(isDataProject(manifest({ mx: { host: "solid" } }))).toBe(false);
    expect(isDataProject(manifest({ mx: { target: "html" } }))).toBe(false);
  });

  it("rejects a host that cannot be loaded", () => {
    expect(
      isDataProject(manifest({ mx: { host: "@fake/not-installed" } })),
    ).toBe(false);
  });

  it("does not infer from an @mxlang/data dependency or a missing manifest", () => {
    expect(
      isDataProject(manifest({ dependencies: { "@mxlang/data": "*" } })),
    ).toBe(false);
    expect(isDataProject(manifest({}))).toBe(false);
    expect(isDataProject(join(tmpdir(), "mx-base-target-nonexistent"))).toBe(
      false,
    );
  });
});

// TODO dialect-check (PR 1c): decision 204 removed the tree target; the dialect
// check re-keys this suite.
describe.skip("the base target's mx.<base>.defaultTag is a rung of the shared ladder", () => {
  const TAGS = { "tags/node.mx": "", "tags/leaf.mx": "" };
  const answer = (options: MeshOptions) => {
    const file = join(mesh({ files: TAGS, ...options }), "post.mesh.mx");
    const resolution = resolveTargetPolicyDetailed(file);
    return {
      tag: defaultTagFor(file, resolution.policy),
      messages: resolution.diagnostics.map((d) => d.message),
      codes: resolution.diagnostics.map((d) => d.code),
    };
  };

  it("mx.data.defaultTag is read for a host built on tree", () => {
    expect(answer({ mx: { data: { defaultTag: "node" } } })).toEqual({
      tag: "node",
      messages: [],
      codes: [],
    });
  });

  it("the target's own name is never its config key: mx.tree.defaultTag is not read", () => {
    expect(answer({ mx: { tree: { defaultTag: "node" } } })).toEqual({
      tag: "object",
      messages: [],
      codes: [],
    });
  });

  it("it outranks the host's override and the descriptor's defaultTag", () => {
    expect(
      answer({
        mx: { data: { defaultTag: "node" } },
        hostDefaultTag: "leaf",
        defaultTag: "leaf",
      }).tag,
    ).toBe("node");
  });

  it("the host's own key outranks it, and a differing pair is one warning naming both", () => {
    expect(
      answer({
        mx: {
          "mesh-data": { defaultTag: "leaf" },
          data: { defaultTag: "node" },
        },
      }),
    ).toEqual({
      tag: "leaf",
      messages: [
        'mx.data.defaultTag "node" is ignored: mx["mesh-data"].defaultTag "leaf" takes precedence',
      ],
      codes: ["default-tag-overridden"],
    });
  });

  it("the same value under both keys is silent", () => {
    expect(
      answer({
        mx: {
          "mesh-data": { defaultTag: "node" },
          data: { defaultTag: "node" },
        },
      }),
    ).toEqual({ tag: "node", messages: [], codes: [] });
  });

  it("an invalid mx.data.defaultTag is one error and the next rung answers", () => {
    const { tag, codes } = answer({
      mx: { data: { defaultTag: "nonexistent" } },
      hostDefaultTag: "leaf",
    });
    expect(tag).toBe("leaf");
    expect(codes).toEqual(["invalid-default-tag"]);
  });

  it("a host not built on tree never reads mx.data.defaultTag", () => {
    expect(
      answer({ notBuiltOnData: true, mx: { data: { defaultTag: "node" } } }),
    ).toEqual({ tag: "object", messages: [], codes: [] });
  });
});

// TODO dialect-check (PR 1c): decision 204 removed the tree target; the dialect
// check re-keys this suite.
describe.skip("a host whose builtOn names no registered target", () => {
  const verdict = (builtOn: string) => {
    const file = join(mesh({ builtOn }), "post.mesh.mx");
    return resolveTargetPolicyDetailed(file).diagnostics.map((d) => d.message);
  };

  it("lists every registered target, the one the registry keeps from selection included", () => {
    const [message, ...rest] = verdict("dta");
    expect(rest).toEqual([]);
    expect(message).toContain(
      'target "mesh-data" is built on "dta", which is not a registered target (registered: html, astro-html, solid-jsx, preact-jsx, react-jsx, hono-jsx, angular-template, tree, mesh-data)',
    );
  });

  it('refuses the reserved literal "data" with the decision-187 hint', () => {
    const [message, ...rest] = verdict("data");
    expect(rest).toEqual([]);
    expect(message).toContain(
      '"data" is reserved for the evaluated tree target (decision 187); a consumer that reads the tree calls lowerSource from @mxlang/core',
    );
  });

  it('refuses the reserved literal "data" at the mx.host value that loaded the descriptor', () => {
    const file = join(mesh({ builtOn: "data" }), "post.mesh.mx");
    const [diagnostic] = resolveTargetPolicyDetailed(file).diagnostics;
    expect(diagnostic).toMatchObject({
      code: "target-invalid-descriptor",
      severity: "error",
      // The range of the `mx.host` value, `"@fake/mx-mesh"` in package.json
      // line 3, where the descriptor with the offending `builtOn` came from.
      line: 3,
      column: 12,
      length: 15,
    });
  });

  it("names the target a host name stands for", () => {
    expect(verdict("solid")[0]).toContain(
      '"solid" is a host name, and builtOn takes a target name (did you mean "solid-jsx"?)',
    );
  });
});
