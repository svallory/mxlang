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
import * as core from "@mxlang/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  builtinLookup,
  builtinTargets,
  defaultTagFor,
  effectiveDefaultTag,
  getCustomTags,
  lookupFor,
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
  entry = "a.mx",
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
  return join(root, entry);
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
      expect(effectiveDefaultTag({}, descriptor)).toBe(descriptor.defaultTag);
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
    expect(effectiveDefaultTag({}, target())).toBe("div");
    expect(effectiveDefaultTag({}, hosted())).toBe("div");
  });

  it("a host override beats the target's built-in", () => {
    expect(effectiveDefaultTag({}, hosted("section"))).toBe("section");
  });

  it("the user's config beats the host override", () => {
    expect(effectiveDefaultTag({ defaultTag: "main" }, hosted("section"))).toBe(
      "main",
    );
  });

  it("the user's config beats the built-in", () => {
    expect(effectiveDefaultTag({ defaultTag: "main" }, target())).toBe("main");
  });
});

describe("a host module file kind reads its own target's config", () => {
  const manifest = (value: unknown) => ({
    mx: { target: "html", "solid-jsx": { defaultTag: value } },
  });

  it("defaultTagFor answers the file kind's target, not the page target's", () => {
    const file = project(manifest("section"), {}, "a.solid.mx");
    expect(defaultTagFor(file)).toBe("section");
    expect(resolveTargetPolicyDetailed(file).diagnostics).toEqual([]);
  });

  it("a page file in the same package ignores the other target's key", () => {
    const file = project(manifest("section"));
    expect(defaultTagFor(file)).toBe("div");
  });

  it("an invalid value is reported for that file kind, and the built-in answers", () => {
    const file = project(manifest("nope"), {}, "a.solid.mx");
    const { diagnostics } = resolveTargetPolicyDetailed(file);
    expect(diagnostics).toMatchObject([
      {
        code: "invalid-default-tag",
        severity: "error",
        message:
          "invalid `defaultTag` value: `<nope>` is not a tag reachable from this package",
      },
    ]);
    expect(defaultTagFor(file)).toBe("div");
  });

  it("a non-string value for that target is core's one diagnostic", () => {
    const file = project(manifest(4), {}, "a.solid.mx");
    expect(
      resolveTargetPolicyDetailed(file).diagnostics.map((d) => d.code),
    ).toEqual(["invalid-default-tag"]);
  });
});

describe("mx.html.defaultTag reaches the compile", () => {
  /** What the real tool path does: policy, scan, ladder, then the target's compile. */
  function compile(file: string, source: string): string {
    const policy = resolveTargetPolicyDetailed(file).policy;
    const targets = lookupFor(policy);
    const descriptor = targets.target(policy.target);
    const customTags = getCustomTags(file, { targets });
    return descriptor?.load?.(core).compileModule(source, file, {
      customTags,
      defaultTag: defaultTagFor(file),
      targets: builtinLookup(),
    }).code as string;
  }

  const card = {
    "tags/my-card.mx": "<section><${input.renderBody}/></section>\n",
  };

  it("resolves <#a> to the custom tag", () => {
    const file = project(html("my-card"), card);
    const code = compile(file, "<#a>hi</>\n");
    expect(code).toMatch(/my-card|myCard|MyCard/);
    expect(code).toContain("id");
  });

  it("without config the same source is a div, byte for byte", () => {
    const file = project({ mx: { target: "html" } }, card);
    const explicit = compile(file, '<div id="a">hi</div>\n');
    expect(compile(file, "<#a>hi</>\n")).toBe(explicit);
  });

  it("an invalid config compiles with the built-in and the one error is the policy's", () => {
    const file = project(html("input"), card);
    expect(compile(file, "<#a>hi</>\n")).toBe(
      compile(project({ mx: { target: "html" } }, card), "<#a>hi</>\n"),
    );
  });
});
