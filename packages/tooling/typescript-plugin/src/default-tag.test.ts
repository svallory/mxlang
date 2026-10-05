import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTargetPolicyRecorder } from "./host-policy-diagnostics.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function project(manifest: object): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mx-tsp-default-tag-")));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(root, "page.mx"), "<#a/>\n");
  return join(root, "page.mx");
}

describe("the policy recorder and an invalid defaultTag", () => {
  it("records the diagnostic but never calls the target 'not loaded' (review finding 6)", () => {
    const file = project({
      mx: { target: "html", html: { defaultTag: "input" } },
    });
    const recorder = createTargetPolicyRecorder();
    recorder.resolve(file, "<#a/>\n");
    expect(recorder.get(file).map((d) => d.code)).toEqual([
      "invalid-default-tag",
    ]);
    // The package.json diagnostic carries the error: no per-file pointer.
    expect(recorder.errors(file)).toEqual([]);
  });

  it("still points at a target that really failed to load", () => {
    const file = project({ mx: { target: "nonesuch-target" } });
    const recorder = createTargetPolicyRecorder();
    recorder.resolve(file, "<#a/>\n");
    expect(recorder.errors(file)).toHaveLength(1);
  });

  it("a malformed mx.contracts beside a defaultTag does not throw from the policy call (review finding 1)", () => {
    const file = project({
      mx: {
        target: "html",
        contracts: { item: {} },
        html: { defaultTag: "section" },
      },
    });
    const recorder = createTargetPolicyRecorder();
    expect(() => recorder.resolve(file, "<#a/>\n")).not.toThrow();
  });
});
