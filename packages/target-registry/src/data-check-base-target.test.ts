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
  setupMesh(builtinLookup().target("data"), options);
  return meshProject("mx-base-target-mesh-", options);
}

describe("the base target of a lookup", () => {
  it("is each built-in target's own name, and `data` for a host that declares builtOn", () => {
    const lookup = builtinLookup();
    expect(
      Object.fromEntries(
        builtinTargets.map((t) => [t.name, lookup.baseTargetOf?.(t.name)]),
      ),
    ).toEqual(Object.fromEntries(builtinTargets.map((t) => [t.name, t.name])));
    const data = lookup.target("data");
    if (!data) throw new Error("no data descriptor");
    const withMesh = createTargetLookup([
      ...builtinTargets,
      {
        ...data,
        name: "mesh-data",
        packageName: "@fake/mx-mesh",
        host: { name: "mesh" },
        builtOn: "data",
      },
    ]);
    expect(withMesh.baseTargetOf?.("mesh-data")).toBe("data");
    expect(withMesh.baseTargetOf?.("nope")).toBeUndefined();
  });
});

describe("isDataProject keys on the resolved base target", () => {
  it("accepts mx.target: data", () => {
    expect(isDataProject(manifest({ mx: { target: "data" } }))).toBe(true);
  });

  it("accepts a third-party host built on data (mx.host)", () => {
    expect(isDataProject(mesh())).toBe(true);
  });

  it("rejects a third-party host that reuses declarations without data's base target", () => {
    expect(isDataProject(mesh({ notBuiltOnData: true }))).toBe(false);
  });

  it("rejects a built-in host and a built-in non-data target", () => {
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

describe("the base target's mx.<base>.defaultTag is a rung of the shared ladder", () => {
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

  it("mx.data.defaultTag is read for a host built on data", () => {
    expect(answer({ mx: { data: { defaultTag: "node" } } })).toEqual({
      tag: "node",
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

  it("a host not built on data never reads mx.data.defaultTag", () => {
    expect(
      answer({ notBuiltOnData: true, mx: { data: { defaultTag: "node" } } }),
    ).toEqual({ tag: "object", messages: [], codes: [] });
  });
});

describe("a host whose builtOn names no registered target", () => {
  const verdict = (builtOn: string) => {
    const file = join(mesh({ builtOn }), "post.mesh.mx");
    return resolveTargetPolicyDetailed(file).diagnostics.map((d) => d.message);
  };

  it("lists every registered target, the one the registry keeps from selection included", () => {
    const [message, ...rest] = verdict("dta");
    expect(rest).toEqual([]);
    expect(message).toContain(
      'target "mesh-data" is built on "dta", which is not a registered target (registered: html, astro-html, solid-jsx, preact-jsx, react-jsx, hono-jsx, angular-template, data, mesh-data)',
    );
  });

  it("names the target a host name stands for", () => {
    expect(verdict("solid")[0]).toContain(
      '"solid" is a host name, and builtOn takes a target name (did you mean "solid-jsx"?)',
    );
  });
});
