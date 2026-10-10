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
  type MeshOptions,
  meshProject,
  setupMesh,
  teardownMesh,
} from "../../../test-fixtures/third-party-targets/mesh.ts";
import {
  cleanupProjects,
  type FakeTarget,
  fakeProject,
  specifier,
} from "../../../test-fixtures/third-party-targets/support.ts";
import {
  builtinLookup,
  builtinTargets,
  defaultTagFor,
  effectiveDefaultTag,
  getCustomTags,
  lookupFor,
  regionFileKind,
  resolveTargetPolicyDetailed,
} from "./index.ts";

/** The registry's rungs for a file, resolving its policy first, as a tool does. */
const tagFor = (file: string): string =>
  defaultTagFor(file, resolveTargetPolicyDetailed(file).policy);

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

/**
 * Every name the html target's tag table defines: its native elements and
 * core's taglib entries, which is what Marko's lookup held for it.
 */
const htmlTableNames = (descriptor: TargetDescriptor | undefined): string[] => [
  ...new Set([
    ...(descriptor?.declarations?.default?.nativeTags?.keys() ?? []),
    ...Object.keys(core.CORE_TAGLIB as object)
      .filter((key) => key.startsWith("<") && key.endsWith(">"))
      .map((key) => key.slice(1, -1)),
  ]),
];

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

  // TODO dialect-check (PR 1): decision 204 removed the tree target; the dialect
  // check re-keys this case.
  it.skip("on tree, reachable means the built-in `object` plus the custom tags", () => {
    const dataPackage = (name: string) =>
      resolveTargetPolicyDetailed(
        project({ mx: { target: "tree", data: { defaultTag: name } } }),
        { dataWired: true },
      );
    const accept = dataPackage("object");
    expect(accept.diagnostics).toEqual([]);
    expect(accept.policy.defaultTag).toBe("object");

    // Marko's lookup answers parse shape only: html's elements are no data tags.
    for (const name of ["div", "section", "pre", "input", "nope"]) {
      const { policy, diagnostics } = dataPackage(name);
      expect(policy.defaultTag).toBeUndefined();
      expect(diagnostics[0]).toMatchObject({
        code: "invalid-default-tag",
        severity: "error",
      });
      expect(diagnostics[0]?.message).toContain("not");
    }
    expect(dataPackage("nope").diagnostics[0]?.message).toBe(
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
    expect(tagFor(file)).toBe("section");
    expect(resolveTargetPolicyDetailed(file).diagnostics).toEqual([]);
  });

  it("a page file in the same package ignores the other target's key", () => {
    const file = project(manifest("section"));
    expect(tagFor(file)).toBe("div");
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
    expect(tagFor(file)).toBe("div");
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
      defaultTag: tagFor(file),
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

describe("only elements of the target are valid built-ins", () => {
  it.each(["await", "try", "define", "effect", "let", "id", "log", "return"])(
    "html rejects the core tag <%s> at the value",
    (name) => {
      const { policy, diagnostics } = resolveTargetPolicyDetailed(
        project(html(name)),
      );
      expect(policy.defaultTag).toBeUndefined();
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.code).toBe("invalid-default-tag");
      expect(diagnostics[0]?.message).toMatch(
        /not an element of this target|void tag/,
      );
    },
  );

  it("enumerating html's whole tag table: accepted exactly the plain elements it flags html", () => {
    const lookup = builtinLookup();
    const descriptor = lookup.target("html");
    const dir = project({ mx: { target: "html" } });
    const table = core.tagTable(
      descriptor?.translator,
      descriptor?.declarations?.default?.nativeTags,
    );
    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const name of htmlTableNames(descriptor)) {
      const tag: core.TagEntry = table.getTag(name) ?? { taglibId: "" };
      const plain =
        !tag.parseOptions ||
        !(
          tag.parseOptions.openTagOnly ||
          tag.parseOptions.text ||
          tag.parseOptions.preserveWhitespace ||
          tag.parseOptions.statement ||
          tag.parseOptions.controlFlow
        );
      const expected = tag.html === true && plain;
      const scope = core.defaultTagScopeFor({
        dir: join(dir, ".."),
        translator: descriptor?.translator,
        declarations: descriptor?.declarations?.default,
      });
      const reason = core.validateDefaultTag(name, scope);
      (reason === undefined ? accepted : rejected).push(name);
      expect(reason === undefined, name).toBe(expected);
    }
    // The table has 109 html + 59 svg + 42 math elements and 26 core tags;
    // every core tag is rejected (script/style/html-script/html-style by shape).
    expect(accepted).toContain("div");
    expect(accepted).toContain("svg");
    for (const name of ["await", "try", "define", "effect", "if", "import"]) {
      expect(rejected).toContain(name);
    }
    expect(accepted.length + rejected.length).toBeGreaterThan(200);
  });
});

describe("a scan failure never escapes a policy call (reviewer finding 1)", () => {
  const broken = (target: string) => ({
    mx: {
      target,
      contracts: { item: {} },
      [target]: { defaultTag: target === "tree" ? "object" : "section" },
    },
  });

  it("html: returns the policy, keeps the value, throws nothing", () => {
    const file = project(broken("html"));
    expect(() => resolveTargetPolicyDetailed(file)).not.toThrow();
    const { policy, diagnostics } = resolveTargetPolicyDetailed(file);
    expect(policy.defaultTag).toBe("section");
    expect(diagnostics.map((d) => d.code)).not.toContain("invalid-default-tag");
    expect(() => defaultTagFor(file, policy)).not.toThrow();
  });

  it("tree: the policy call does not throw either", () => {
    const file = project(broken("tree"));
    expect(() =>
      resolveTargetPolicyDetailed(file, { dataWired: true }),
    ).not.toThrow();
  });
});

describe("a loaded descriptor's own values are checked against the target's lookup", () => {
  afterEach(() => cleanupProjects());

  it('`defaultTag: "nonexistent"` is an error at the mx.target value, not a tautology', () => {
    const text = `{\n  "mx": { "target": "${specifier("bad-default-tag")}" }\n}`;
    const proj = fakeProject({
      manifestText: text,
      install: ["bad-default-tag"],
    });
    const { diagnostics } = resolveTargetPolicyDetailed(proj.path("a.mx"));
    const own = diagnostics.filter((d) => d.code === "invalid-default-tag");
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ severity: "error", line: 2 });
    expect(own[0]?.message).toBe(
      'invalid `defaultTag` value: `<nonexistent>` is not a tag reachable from this package (defaultTag of "fake-bad-default")',
    );
  });
});

// TODO dialect-check (PR 1): decision 204 removed the tree target; the dialect
// check re-keys this suite.
describe.skip("a third-party host on the tree target (decision 148)", () => {
  afterEach(() => teardownMesh());

  const MESH_KIND = [{ segment: "mesh", diagnosticSource: "mesh" }];
  const setup = (options: MeshOptions = {}) => {
    setupMesh(builtinLookup().target("tree"), options);
    const dir = meshProject("mx-registry-mesh-", options);
    return join(dir, "post.mesh.mx");
  };
  const invalid = (file: string) =>
    resolveTargetPolicyDetailed(file).diagnostics.filter(
      (d) => d.code === "invalid-default-tag",
    );

  it("keeps tree's built-in `object`: no diagnostic, and it is the rung the compile gets", () => {
    const file = setup({ fileKinds: MESH_KIND });
    const { policy, diagnostics } = resolveTargetPolicyDetailed(file);
    expect(diagnostics).toEqual([]);
    expect(policy).toMatchObject({ target: "mesh-data", host: "mesh" });
    expect(defaultTagFor(file, policy)).toBe("object");
  });

  it("the host's override outranks the built-in; the package's config outranks both", () => {
    const file = setup({
      hostDefaultTag: "object",
      mx: { "mesh-data": { defaultTag: "object" } },
    });
    const { policy, diagnostics } = resolveTargetPolicyDetailed(file);
    expect(diagnostics).toEqual([]);
    expect(policy.defaultTag).toBe("object");
    expect(defaultTagFor(file, policy)).toBe("object");
  });

  it("an override the target cannot reach is still one error at the mx.host value", () => {
    const file = setup({ hostDefaultTag: "nonexistent" });
    const own = invalid(file);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ severity: "error", line: 3 });
    expect(own[0]?.message).toBe(
      'invalid `defaultTag` value: `<nonexistent>` is not a tag reachable from this package (host.defaultTag of "mesh-data")',
    );
  });

  it("a built-in the declarations do not provide is rejected, not waved through", () => {
    const file = setup({ defaultTag: "nonexistent" });
    const own = invalid(file);
    expect(own).toHaveLength(1);
    expect(own[0]?.message).toBe(
      'invalid `defaultTag` value: `<nonexistent>` is not a tag reachable from this package (defaultTag of "mesh-data")',
    );
  });

  it("the declared file kind is a whole-file kind of host `mesh`, never a region kind", () => {
    const file = setup({ fileKinds: MESH_KIND });
    const { policy } = resolveTargetPolicyDetailed(file);
    const lookup = lookupFor(policy);
    expect(lookup.moduleSegments()).toContain("mesh");
    expect(lookup.hostOf("mesh-data")).toBe("mesh");
    expect(lookup.hostTarget("mesh")?.target).toBe("mesh-data");
    expect(regionFileKind(file, lookup)).toBeUndefined();
    expect(builtinLookup().moduleSegments()).not.toContain("mesh");
  });

  it("a file kind's key is the one `defaultTagFor` reads for a file of that kind", () => {
    const file = setup({
      fileKinds: MESH_KIND,
      mx: { "mesh-data": { defaultTag: "nonexistent" } },
    });
    const own = invalid(file);
    expect(own).toHaveLength(1);
    expect(own[0]?.line).toBe(5);
  });
});

describe("a host override reaches the compile through defaultTagFor", () => {
  afterEach(() => cleanupProjects());

  const setup = (extra: Record<string, unknown> = {}) => {
    const proj = fakeProject({
      mx: { target: specifier("host-override"), ...extra },
      install: ["host-override"],
    });
    const file = proj.path("a.mx");
    const resolution = resolveTargetPolicyDetailed(file);
    const descriptor = lookupFor(resolution.policy).target(
      resolution.policy.target,
    );
    const compile = (): string => {
      const load = descriptor?.load;
      if (!load) throw new Error("fixture has no load");
      return (
        load(core).compileModule("", file, {
          defaultTag: defaultTagFor(file, resolution.policy),
          targets: lookupFor(resolution.policy),
        }) as { code: string }
      ).code;
    };
    return { file, resolution, compile };
  };

  it("the host override beats the target's built-in", () => {
    const { file, resolution, compile } = setup();
    expect(
      resolution.diagnostics.filter((d) => d.code === "invalid-default-tag"),
    ).toEqual([]);
    expect(defaultTagFor(file, resolution.policy)).toBe("section");
    expect(compile()).toBe("default-tag:section");
  });

  it("the user's config beats the host override", () => {
    const { file, resolution, compile } = setup({
      "fake-override": { defaultTag: "main" },
    });
    expect(defaultTagFor(file, resolution.policy)).toBe("main");
    expect(compile()).toBe("default-tag:main");
  });
});

describe("Marko core tags are no valid default on any target (round 3)", () => {
  const CORE = ["await", "try", "define", "effect"];

  it.each(builtinTargets.map((t) => t.name).filter((n) => n !== "tree"))(
    "%s rejects every core tag and the file falls back to the built-in",
    (target) => {
      for (const name of CORE) {
        const file = project({
          mx: { target, [target]: { defaultTag: name } },
        });
        const { policy, diagnostics } = resolveTargetPolicyDetailed(file);
        expect(
          diagnostics.map((d) => d.code),
          `${target} ${name}`,
        ).toEqual(["invalid-default-tag"]);
        expect(policy.defaultTag).toBeUndefined();
        expect(tagFor(file)).toBe("div");
      }
    },
  );

  it("a .solid.mx file reads solid-jsx's key and rejects them too", () => {
    for (const name of CORE) {
      const file = project(
        { mx: { target: "html", "solid-jsx": { defaultTag: name } } },
        {},
        "a.solid.mx",
      );
      const { diagnostics } = resolveTargetPolicyDetailed(file);
      expect(
        diagnostics.map((d) => d.code),
        name,
      ).toEqual(["invalid-default-tag"]);
      expect(tagFor(file)).toBe("div");
    }
  });

  // TODO dialect-check (PR 1): decision 204 removed the tree target; the dialect
  // check re-keys this case.
  it.skip("tree rejects them as well (and falls back to object)", () => {
    for (const name of CORE) {
      const file = project({
        mx: { target: "tree", data: { defaultTag: name } },
      });
      const { diagnostics } = resolveTargetPolicyDetailed(file, {
        dataWired: true,
      });
      expect(
        diagnostics.map((d) => d.code),
        name,
      ).toEqual(["invalid-default-tag"]);
    }
  });

  describe("a third-party descriptor with no declarations", () => {
    afterEach(() => cleanupProjects());
    it.each(CORE)("rejects <%s>", (name) => {
      const proj = fakeProject({
        mx: { target: specifier("ok"), "fake-ok": { defaultTag: name } },
        install: ["ok"],
      });
      const { diagnostics } = resolveTargetPolicyDetailed(proj.path("a.mx"));
      expect(
        diagnostics.filter((d) => d.code === "invalid-default-tag"),
      ).toHaveLength(1);
    });

    it("still accepts a plain element", () => {
      const proj = fakeProject({
        mx: { target: specifier("ok"), "fake-ok": { defaultTag: "section" } },
        install: ["ok"],
      });
      expect(
        resolveTargetPolicyDetailed(proj.path("a.mx")).diagnostics,
      ).toEqual([]);
    });
  });

  // 194, not 193 as with @marko/compiler 5.42.5: 5.42.10's native-tag taglib
  // adds the HTML `<search>` element, a plain element, so it is accepted.
  it("re-enumerating html's tag table still gives 194 accepted and 43 rejected", () => {
    const descriptor = builtinLookup().target("html");
    const dir = join(project({ mx: { target: "html" } }), "..");
    const scope = core.defaultTagScopeFor({
      dir,
      translator: descriptor?.translator,
      declarations: descriptor?.declarations?.default,
    });
    const names = htmlTableNames(descriptor);
    const accepted = names.filter(
      (n) => core.validateDefaultTag(n, scope) === undefined,
    );
    expect([accepted.length, names.length - accepted.length]).toEqual([
      194, 43,
    ]);
  });
});

describe("a scan failure keeps the parse-shape check (round 3)", () => {
  const broken = (value: string) => ({
    mx: {
      target: "html",
      contracts: { item: {} },
      html: { defaultTag: value },
    },
  });

  it("`input` is still the void-tag error, with no throw", () => {
    const file = project(broken("input"));
    const { policy, diagnostics } = resolveTargetPolicyDetailed(file);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toBe(
      "invalid `defaultTag` value: `<input>` is a void tag, not a plain tag",
    );
    expect(policy.defaultTag).toBeUndefined();
    expect(tagFor(file)).toBe("div");
  });

  it("a plain element is kept", () => {
    const file = project(broken("section"));
    const { policy, diagnostics } = resolveTargetPolicyDetailed(file);
    expect(diagnostics).toEqual([]);
    expect(policy.defaultTag).toBe("section");
    expect(tagFor(file)).toBe("section");
  });

  it("a name only a custom tag could provide is kept: that verdict needs the custom tags", () => {
    const file = project(broken("my-card"));
    const { policy, diagnostics } = resolveTargetPolicyDetailed(file);
    expect(diagnostics).toEqual([]);
    expect(policy.defaultTag).toBe("my-card");
  });
});

describe("a contract's defaultTag is checked at registration, at the declaration (decision 145, PR 3)", () => {
  afterEach(() => cleanupProjects());

  const contracts = (body: string) =>
    project(
      { mx: { target: "html", contracts: "./contracts.ts" } },
      { "contracts.ts": `export default {\n${body}\n};\n` },
    );
  const own = (file: string) =>
    resolveTargetPolicyDetailed(file).diagnostics.filter(
      (d) => d.code === "invalid-default-tag",
    );

  it("accepts an element, and a custom tag the package declares", () => {
    const file = contracts(
      `  list: { defaultTag: "item", children: { item: {} } },\n  item: {},`,
    );
    expect(own(file)).toEqual([]);
    expect(own(contracts(`  list: { defaultTag: "section" },`))).toEqual([]);
  });

  it.each([
    ["nope", "`<nope>` is not a tag reachable from this package"],
    ["input", "`<input>` is a void tag, not a plain tag"],
    ["pre", "`<pre>` is a whitespace-preserving tag, not a plain tag"],
    ["await", "`<await>` is not an element of this target"],
  ])("rejects %s, positioned at the contracts module", (name, reason) => {
    const file = contracts(`  list: { defaultTag: "${name}" },`);
    const found = own(file);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      severity: "error",
      file: join(file, "..", "contracts.ts"),
      message: `invalid \`defaultTag\` value: ${reason} (contract of \`<list>\`)`,
    });
  });

  it("an attribute-tag declaration's value is checked too, naming the chain", () => {
    const file = contracts(
      `  list: { attributeTags: { items: { attributeTags: { sub: { defaultTag: "nope" } } } } },`,
    );
    const found = own(file);
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("`<list>`");
    expect(found[0]?.message).toContain("<@items>");
    expect(found[0]?.message).toContain("<@sub>");
  });

  it("a sidecar's value is checked at the sidecar", () => {
    const file = project(
      { mx: { target: "html" } },
      {
        "tags/list.tag.ts": `export default { defaultTag: "nope", transform: () => [] };\n`,
      },
    );
    const found = own(file);
    expect(found).toHaveLength(1);
    expect(found[0]?.file).toBe(join(file, "..", "tags", "list.tag.ts"));
  });

  it("a name only a custom tag could provide is kept when the scan fails", () => {
    const file = project({
      mx: { target: "html", contracts: { item: {} } },
    });
    expect(() => resolveTargetPolicyDetailed(file)).not.toThrow();
  });

  // TODO dialect-check (PR 1): decision 204 removed the tree target; the dialect
  // check re-keys this case.
  it.skip("on tree, `object` and declared tags are valid; html elements are not", () => {
    const data = (name: string) =>
      project(
        { mx: { target: "tree", contracts: "./contracts.ts" } },
        {
          "contracts.ts": `export default { list: { defaultTag: "${name}" }, item: {} };\n`,
        },
      );
    const check = (name: string) =>
      resolveTargetPolicyDetailed(data(name), {
        dataWired: true,
      }).diagnostics.filter((d) => d.code === "invalid-default-tag");
    expect(check("object")).toEqual([]);
    expect(check("item")).toEqual([]);
    expect(check("div")).toHaveLength(1);
  });

  it("a host that forbids it: every declaration is a registration error naming the host", () => {
    const proj = fakeProject({
      mx: {
        target: specifier("forbids-contract"),
        contracts: "./contracts.ts",
      },
      install: ["forbids-contract"],
      files: {
        "contracts.ts": `export default { "my-list": { defaultTag: "div", attributeTags: { items: { defaultTag: "div" } } } };\n`,
      },
    });
    const found = resolveTargetPolicyDetailed(
      proj.path("a.mx"),
    ).diagnostics.filter((d) => d.code === "invalid-default-tag");
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({
      severity: "error",
      file: proj.path("contracts.ts"),
      message:
        "`defaultTag` in the contract of `<my-list>` is not allowed: host `fake-forbid-host` does not permit per-tag default tags",
    });
    expect(found[1]?.message).toContain("<@items>");
    expect(found[1]?.message).toContain("fake-forbid-host");
  });
});

describe("a host that forbids the contract rung, through a compile (review round 2)", () => {
  afterEach(() => cleanupProjects());

  it("never resolves the unnamed tag through the contract; the next rung answers, and registration still errors", () => {
    const proj = fakeProject({
      mx: { target: specifier("forbids-contract") },
      install: ["forbids-contract"],
    });
    mkdirSync(proj.path("tags"));
    writeFileSync(
      proj.path("tags/my-list.tag.ts"),
      'export default { defaultTag: "div", transform: (call) => call.content?.children ?? [] };\n',
    );
    const file = proj.path("a.mx");
    const resolution = resolveTargetPolicyDetailed(file);
    const registration = resolution.diagnostics.filter(
      (d) => d.code === "invalid-default-tag",
    );
    expect(registration).toHaveLength(1);
    expect(registration[0]?.message).toContain("fake-forbid-host");

    const descriptor = lookupFor(resolution.policy).target(
      resolution.policy.target,
    );
    const customTags = getCustomTags(file, {
      targets: lookupFor(resolution.policy),
    });
    // The contract says `div`; the config says `main`. A forbidding host
    // answers the config, never the contract.
    const load = descriptor?.load;
    if (!load) throw new Error("fixture has no load");
    const out = (load(core) as { compileModule: Function }).compileModule(
      "<my-list><.a>x</></my-list>",
      file,
      {
        customTags,
        defaultTag: "main",
        targets: lookupFor(resolution.policy),
      },
    ) as { code: string };
    expect(out.code).toBe("elements:main");
  });
});

describe("a dependency's contract (review round 2, the unprobed note)", () => {
  /** A consumer whose mx.contracts names a library module; the library holds a private tag. */
  function library(contractBody: string, extra: Record<string, string> = {}) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mx-lib-contract-")));
    roots.push(root);
    const lib = join(root, "node_modules", "lib");
    mkdirSync(join(lib, "tags"), { recursive: true });
    writeFileSync(
      join(lib, "package.json"),
      '{"name":"lib","exports":{"./contracts":"./index.mjs"}}',
    );
    writeFileSync(
      join(lib, "index.mjs"),
      `export default {\n${contractBody}\n};\n`,
    );
    for (const [name, text] of Object.entries(extra))
      writeFileSync(join(lib, name), text);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ mx: { target: "html", contracts: "lib/contracts" } }),
    );
    return { file: join(root, "a.mx"), libIndex: join(lib, "index.mjs") };
  }
  const own = (file: string) =>
    resolveTargetPolicyDetailed(file).diagnostics.filter(
      (d) => d.code === "invalid-default-tag",
    );

  it("a library contract naming a tag the library's own module declares is valid for the consumer", () => {
    const { file } = library(
      `  "lib-list": { defaultTag: "lib-item" },\n  "lib-item": {},`,
    );
    expect(own(file)).toEqual([]);
  });

  it("a library contract naming a library-private element is judged by the consuming compile's tags", () => {
    // `lib-private` lives only in the library's tags/ and is not registered by
    // the consumer: a compile in the consumer cannot resolve it, so the error
    // is real, and it points at the library's declaring module.
    const { file, libIndex } = library(
      `  "lib-list": { defaultTag: "lib-private" },`,
      {
        "tags/lib-private.mx": "<div/>\n",
      },
    );
    const found = own(file);
    expect(found).toHaveLength(1);
    expect(found[0]?.file).toBe(libIndex);
    expect(found[0]?.message).toContain(
      "`<lib-private>` is not a tag reachable",
    );
  });
});

describe("a dashed custom-element name, per target, as measured (decision 145, round 2 addition)", () => {
  // Measured: what an unknown `<sl-card class="a">x</sl-card>` compiles to today.
  //   html, astro-html (page)  : error, Marko's "Unable to find entry point for custom tag"
  //   solid-jsx, preact-jsx, react-jsx, hono-jsx, angular-template : a native element
  //   data : not a tag
  const NATIVE = [
    "solid-jsx",
    "preact-jsx",
    "react-jsx",
    "hono-jsx",
    "angular-template",
  ];
  const REJECTED = ["html", "astro-html"];

  afterEach(() => cleanupProjects());

  it.each(NATIVE)(
    "%s accepts it as mx.<target>.defaultTag and as a contract's value",
    (target) => {
      const config = project({
        mx: { target, [target]: { defaultTag: "sl-card" } },
      });
      const policy = resolveTargetPolicyDetailed(config);
      expect(policy.diagnostics).toEqual([]);
      expect(tagFor(config)).toBe("sl-card");
      const contract = project(
        { mx: { target, contracts: "./contracts.ts" } },
        {
          "contracts.ts": `export default { list: { defaultTag: "sl-card" } };\n`,
        },
      );
      expect(resolveTargetPolicyDetailed(contract).diagnostics).toEqual([]);
    },
  );

  it.each(REJECTED)(
    "%s still rejects it (Marko refuses an unresolved dashed tag there)",
    (target) => {
      const config = project({
        mx: { target, [target]: { defaultTag: "sl-card" } },
      });
      const { diagnostics } = resolveTargetPolicyDetailed(config);
      expect(diagnostics.map((d) => d.code)).toEqual(["invalid-default-tag"]);
      expect(diagnostics[0]?.message).toContain(
        "`<sl-card>` is not a tag reachable",
      );
      expect(tagFor(config)).toBe("div");
    },
  );

  // TODO dialect-check (PR 1): decision 204 removed the tree target; the dialect
  // check re-keys this case.
  it.skip("tree rejects it, config and contract", () => {
    const config = project({
      mx: { target: "tree", data: { defaultTag: "sl-card" } },
    });
    expect(
      resolveTargetPolicyDetailed(config, { dataWired: true }).diagnostics.map(
        (d) => d.code,
      ),
    ).toEqual(["invalid-default-tag"]);
    const contract = project(
      { mx: { target: "tree", contracts: "./contracts.ts" } },
      {
        "contracts.ts": `export default { list: { defaultTag: "sl-card" } };\n`,
      },
    );
    expect(
      resolveTargetPolicyDetailed(contract, {
        dataWired: true,
      }).diagnostics.map((d) => d.code),
    ).toEqual(["invalid-default-tag"]);
  });

  it("non-dashed unknown names and Marko core tags stay rejected on a native-element target", () => {
    for (const name of ["nope", "await", "annotation-xml"]) {
      const file = project({
        mx: { target: "preact-jsx", "preact-jsx": { defaultTag: name } },
      });
      expect(
        resolveTargetPolicyDetailed(file).diagnostics.map((d) => d.code),
        name,
      ).toEqual(["invalid-default-tag"]);
    }
  });
});

describe("one source for the permit flag: the declarations (review round 3)", () => {
  afterEach(() => cleanupProjects());

  /** A project whose contract says `span`, and a config saying `main`; returns registration and compile. */
  function run(fixture: FakeTarget, targetName: string) {
    const proj = fakeProject({
      mx: { target: specifier(fixture), [targetName]: { defaultTag: "main" } },
      install: [fixture],
    });
    mkdirSync(proj.path("tags"));
    writeFileSync(
      proj.path("tags/my-list.tag.ts"),
      'export default { defaultTag: "span", transform: (call) => call.content?.children ?? [] };\n',
    );
    const file = proj.path("a.mx");
    const resolution = resolveTargetPolicyDetailed(file);
    const descriptor = lookupFor(resolution.policy).target(
      resolution.policy.target,
    );
    const load = descriptor?.load;
    if (!load) throw new Error("fixture has no load");
    const compiled = (load(core) as { compileModule: Function }).compileModule(
      "<my-list><.a>x</></my-list>",
      file,
      {
        customTags: getCustomTags(file, {
          targets: lookupFor(resolution.policy),
        }),
        defaultTag: resolution.policy.defaultTag,
        targets: lookupFor(resolution.policy),
      },
    ) as { code: string };
    return {
      registration: resolution.diagnostics
        .filter((d) => d.code === "invalid-default-tag")
        .map((d) => d.message),
      elements: compiled.code,
    };
  }

  it("a host whose declarations forbid it: the error names the host and the compile ignores the contract", () => {
    const { registration, elements } = run("forbids-contract", "fake-forbid");
    expect(registration).toEqual([
      "`defaultTag` in the contract of `<my-list>` is not allowed: host `fake-forbid-host` does not permit per-tag default tags",
    ]);
    expect(elements).toBe("elements:main");
  });

  it("a target with no host: the error names the target, and the compile ignores the contract (never silent)", () => {
    const { registration, elements } = run("forbids-nohost", "fake-nohost");
    expect(registration).toEqual([
      "`defaultTag` in the contract of `<my-list>` is not allowed: target `fake-nohost` does not permit per-tag default tags",
    ]);
    expect(elements).toBe("elements:main");
  });

  it("a host whose declarations permit it: no error, and the compile honours the contract", () => {
    const { registration, elements } = run("permits-host", "fake-permits");
    expect(registration).toEqual([]);
    expect(elements).toBe("elements:span");
  });
});

describe("dashed Marko core tags: registration and compile agree on every non-html target (review round 3)", () => {
  const NAMES = ["else-if", "html-script", "html-style", "html-comment"];
  const TARGETS = builtinTargets
    .map((t) => t.name)
    .filter((n) => n !== "html" && n !== "tree");

  it.each(TARGETS)(
    "%s rejects them as config and as a contract value",
    (target) => {
      for (const name of NAMES) {
        const config = project({
          mx: { target, [target]: { defaultTag: name } },
        });
        expect(
          resolveTargetPolicyDetailed(config).diagnostics.map((d) => d.code),
          `${target} config ${name}`,
        ).toEqual(["invalid-default-tag"]);
        expect(tagFor(config)).toBe("div");
        const contract = project(
          { mx: { target, contracts: "./contracts.ts" } },
          {
            "contracts.ts": `export default { list: { defaultTag: "${name}" } };\n`,
          },
        );
        expect(
          resolveTargetPolicyDetailed(contract).diagnostics.map((d) => d.code),
          `${target} contract ${name}`,
        ).toEqual(["invalid-default-tag"]);
      }
    },
  );

  it("sl-card on .astro.mx: registration refuses it, config and contract, as the template's compile does", () => {
    const config = project(
      { mx: { target: "html", "astro-html": { defaultTag: "sl-card" } } },
      {},
      "a.astro.mx",
    );
    expect(
      resolveTargetPolicyDetailed(config).diagnostics.map((d) => d.code),
    ).toEqual(["invalid-default-tag"]);
    const contract = project(
      { mx: { target: "html", contracts: "./contracts.ts" } },
      {
        "contracts.ts": `export default { list: { defaultTag: "sl-card" } };\n`,
      },
      "a.astro.mx",
    );
    // The page target (html) refuses a dashed name; the template's compile
    // refuses it too (astro's own test), so the two agree.
    expect(
      resolveTargetPolicyDetailed(contract).diagnostics.map((d) => d.code),
    ).toEqual(["invalid-default-tag"]);
  });
});
