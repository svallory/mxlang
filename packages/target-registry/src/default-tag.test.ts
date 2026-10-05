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
  cleanupProjects,
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

  it("on data, reachable means the built-in `object` plus the custom tags", () => {
    const dataPackage = (name: string) =>
      resolveTargetPolicyDetailed(
        project({ mx: { target: "data", data: { defaultTag: name } } }),
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

  it("enumerating html's whole lookup: accepted exactly the plain elements Marko flags html", () => {
    const lookup = builtinLookup();
    const descriptor = lookup.target("html");
    const dir = project({ mx: { target: "html" } });
    const markoLookup = core.buildMarkoLookup(
      join(dir, ".."),
      descriptor?.translator,
    ) as unknown as {
      merged: {
        tags: Record<
          string,
          { html?: boolean; parseOptions?: Record<string, unknown> }
        >;
      };
    };
    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const [name, tag] of Object.entries(markoLookup.merged.tags)) {
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
    // The lookup has 109 html + 59 svg + 42 math elements and 26 core tags;
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
      [target]: { defaultTag: target === "data" ? "object" : "section" },
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

  it("data: the policy call does not throw either", () => {
    const file = project(broken("data"));
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

  it.each(builtinTargets.map((t) => t.name).filter((n) => n !== "data"))(
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

  it("data rejects them as well (and falls back to object)", () => {
    for (const name of CORE) {
      const file = project({
        mx: { target: "data", data: { defaultTag: name } },
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

  it("re-enumerating html's lookup still gives 193 accepted and 43 rejected", () => {
    const descriptor = builtinLookup().target("html");
    const dir = join(project({ mx: { target: "html" } }), "..");
    const lookup = core.buildMarkoLookup(
      dir,
      descriptor?.translator,
    ) as unknown as {
      merged: { tags: Record<string, unknown> };
    };
    const scope = core.defaultTagScopeFor({
      dir,
      translator: descriptor?.translator,
      declarations: descriptor?.declarations?.default,
    });
    const names = Object.keys(lookup.merged.tags);
    const accepted = names.filter(
      (n) => core.validateDefaultTag(n, scope) === undefined,
    );
    expect([accepted.length, names.length - accepted.length]).toEqual([
      193, 43,
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

  it("on data, `object` and declared tags are valid; html elements are not", () => {
    const data = (name: string) =>
      project(
        { mx: { target: "data", contracts: "./contracts.ts" } },
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
    const out = (
      descriptor?.load?.(core) as { compileModule: Function }
    ).compileModule("<my-list><.a>x</></my-list>", file, {
      customTags,
      defaultTag: "main",
      targets: lookupFor(resolution.policy),
    }) as { code: string };
    expect(out.code).toBe("elements:main");
  });
});
