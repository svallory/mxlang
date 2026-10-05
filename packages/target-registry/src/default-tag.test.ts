import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TargetDescriptor } from "@mxlang/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  builtinTargets,
  effectiveDefaultTag,
  resolveTargetPolicyDetailed,
} from "./index.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** A project whose package.json is `manifest` and that holds `files`. */
function project(
  manifest: object | string,
  files: Record<string, string> = {},
): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mx-default-tag-")));
  roots.push(root);
  writeFileSync(
    join(root, "package.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2),
  );
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return join(root, "a.mx");
}

const html = (defaultTag: unknown) => ({
  mx: { target: "html", html: { defaultTag } },
});

describe("mx.<target>.defaultTag validation, once per package", () => {
  it.each(["section", "div", "span", "svg"])(
    "accepts the built-in plain tag %s",
    (name) => {
      const { policy, diagnostics } = resolveTargetPolicyDetailed(
        project(html(name)),
      );
      expect(diagnostics).toEqual([]);
      expect(policy.defaultTag).toBe(name);
    },
  );

  it("accepts a custom tag the package's tags/ directory defines", () => {
    const file = project(html("my-card"), {
      "tags/my-card.mx": "<div><${input.renderBody}/></div>\n",
    });
    const { policy, diagnostics } = resolveTargetPolicyDetailed(file);
    expect(diagnostics).toEqual([]);
    expect(policy.defaultTag).toBe("my-card");
  });

  it("rejects a name nothing in the package provides, at the value", () => {
    const text = `{
  "mx": {
    "target": "html",
    "html": { "defaultTag": "my-crd" }
  }
}`;
    const { policy, diagnostics } = resolveTargetPolicyDetailed(project(text));
    expect(policy.defaultTag).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "invalid-default-tag",
      severity: "error",
      message:
        "invalid `defaultTag` value: `<my-crd>` is not a tag reachable from this package",
      line: 4,
      column: text.split("\n")[3]?.indexOf('"my-crd"'),
      length: '"my-crd"'.length,
    });
  });

  it.each([
    ["input", "a void tag"],
    ["br", "a void tag"],
    ["img", "a void tag"],
    ["script", "a text tag"],
    ["style", "a text tag"],
    ["textarea", "a text tag"],
    ["title", "a text tag"],
    ["pre", "a whitespace-preserving tag"],
  ])("rejects <%s>: %s, not a plain tag", (name, kind) => {
    const { policy, diagnostics } = resolveTargetPolicyDetailed(
      project(html(name)),
    );
    expect(policy.defaultTag).toBeUndefined();
    expect(diagnostics[0]).toMatchObject({
      code: "invalid-default-tag",
      severity: "error",
      message: `invalid \`defaultTag\` value: \`<${name}>\` is ${kind}, not a plain tag`,
    });
  });

  it("reports even when no file in the package uses the shorthand", () => {
    // No .mx file exists besides the path asked about; nothing is compiled.
    const { diagnostics } = resolveTargetPolicyDetailed(project(html("nope")));
    expect(diagnostics.map((d) => d.code)).toEqual(["invalid-default-tag"]);
  });

  it("answers the same on the data target, which has its own taglib", () => {
    const accept = resolveTargetPolicyDetailed(
      project({ mx: { target: "data", data: { defaultTag: "object" } } }),
      { dataWired: true },
    );
    expect(accept.diagnostics).toEqual([]);
    expect(accept.policy.defaultTag).toBe("object");

    // The data taglib makes `input` an ordinary tag, so it is a legal default there.
    const plain = resolveTargetPolicyDetailed(
      project({ mx: { target: "data", data: { defaultTag: "input" } } }),
      { dataWired: true },
    );
    expect(plain.diagnostics).toEqual([]);

    const reject = resolveTargetPolicyDetailed(
      project({ mx: { target: "data", data: { defaultTag: "nope" } } }),
      { dataWired: true },
    );
    expect(reject.diagnostics[0]?.message).toBe(
      "invalid `defaultTag` value: `<nope>` is not a tag reachable from this package",
    );
  });

  it("a non-string value is still core's diagnostic, once", () => {
    const { diagnostics } = resolveTargetPolicyDetailed(project(html(3)));
    expect(diagnostics.map((d) => d.code)).toEqual(["invalid-default-tag"]);
  });
});

describe("every built-in descriptor's own default is a plain tag", () => {
  it.each(builtinTargets.map((t) => [t.name, t] as const))(
    "%s",
    (_name, descriptor) => {
      // The descriptor's values pass the same check a package's value does.
      const file = project({ mx: { target: descriptor.name } });
      const { diagnostics } = resolveTargetPolicyDetailed(file, {
        dataWired: true,
      });
      expect(
        diagnostics.filter((d) => d.code === "invalid-default-tag"),
      ).toEqual([]);
      expect(effectiveDefaultTag({ target: descriptor.name }, descriptor)).toBe(
        descriptor.defaultTag,
      );
    },
  );
});

describe("the ladder's lower rungs: config, then host override, then target built-in", () => {
  const target = (extra: Partial<TargetDescriptor> = {}): TargetDescriptor => ({
    descriptorVersion: 0,
    name: "t",
    packageName: "@t/t",
    defaultTag: "div",
    ...extra,
  });
  const hosted = (defaultTag?: string) =>
    target({ host: { name: "h", ...(defaultTag ? { defaultTag } : {}) } });

  it("the target's built-in answers when nothing else does", () => {
    expect(effectiveDefaultTag({ target: "t" }, target())).toBe("div");
    expect(effectiveDefaultTag({ target: "t" }, hosted())).toBe("div");
  });

  it("a host override beats the target's built-in", () => {
    expect(effectiveDefaultTag({ target: "t" }, hosted("section"))).toBe(
      "section",
    );
  });

  it("the user's config beats the host override", () => {
    expect(
      effectiveDefaultTag(
        { target: "t", defaultTag: "main" },
        hosted("section"),
      ),
    ).toBe("main");
  });

  it("the user's config beats the built-in", () => {
    expect(
      effectiveDefaultTag({ target: "t", defaultTag: "main" }, target()),
    ).toBe("main");
  });
});
