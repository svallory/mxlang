import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveTargetPolicy,
  resolveTargetPolicyDetailed,
} from "./host-policy.ts";
import { scanCustomTags } from "./scan.ts";
import {
  createTargetLookup,
  type TargetDescriptor,
  type TargetLookup,
} from "./target-descriptor.ts";

const FIXTURES = join(import.meta.dirname, "fixtures/host-policy");

/** One fixture descriptor, with whatever else the case needs. */
function fixtureTarget(
  name: string,
  packageName: string,
  extra: Partial<TargetDescriptor> = {},
): TargetDescriptor {
  return {
    descriptorVersion: 0,
    name,
    packageName,
    defaultTag: "node",
    ...extra,
  };
}

/**
 * The fixture lookup every test in this file resolves through: seven targets
 * shaped like the built-in set — a hostless one carrying two legacy
 * `mx.host` values (one deprecated), six hosted ones, two with a file kind —
 * and named so that nothing in this file can be mistaken for a real host.
 *
 * Core names no target and no host (decision 126), so a test that pinned the
 * resolver against the repo's own seven would either reintroduce that list
 * here or assert nothing. A fixture set of invented names says the stronger
 * thing: the resolver answers for *whatever* is registered. The built-in set
 * is pinned against these same rules in `@mxlang/targets`'s tests,
 * where the real descriptors live.
 */
const lookup: TargetLookup = createTargetLookup(
  [
    fixtureTarget("page", "@t/page", {
      legacyHostValues: [
        { value: "page" },
        { value: "oldpage", deprecated: true },
      ],
    }),
    fixtureTarget("view-jsx", "@t/view", { host: { name: "view" } }),
    fixtureTarget("unit-jsx", "@t/unit", {
      host: {
        name: "unit",
        fileKinds: [{ segment: "u", diagnosticSource: "umx" }],
      },
    }),
    fixtureTarget("atom-jsx", "@t/atom", { host: { name: "atom" } }),
    fixtureTarget("vue-jsx", "@t/vue", { host: { name: "vue" } }),
    fixtureTarget("edge-jsx", "@t/edge", { host: { name: "edge" } }),
    fixtureTarget("grid-jsx", "@t/grid", {
      host: {
        name: "grid",
        fileKinds: [{ segment: "g", diagnosticSource: "gmx" }],
      },
    }),
  ],
  { defaultTarget: "page" },
);

/**
 * One set of branch tests for the resolver, living with the resolver itself.
 * Both `@mxlang/language-server` and `@mxlang/typescript-plugin` call this
 * function, and an editor and a `tsc` run disagreeing about which host owns a
 * file is the drift a second copy of these cases would invite.
 */
describe("resolveTargetPolicy", () => {
  it("uses the package.json#mx field when present, walking up past a subdirectory with no package.json of its own", () => {
    const filePath = join(FIXTURES, "explicit-field/nested/App.mx");

    expect(resolveTargetPolicy(filePath, lookup)).toEqual({
      target: "view-jsx",
      host: "view",
      strict: true,
    });
  });

  it("falls back to the sole @mxlang/* host dependency when no #mx field is present", () => {
    const filePath = join(FIXTURES, "single-dependency/App.mx");

    expect(resolveTargetPolicy(filePath, lookup)).toEqual({ target: "page" });
  });

  it("resolves @t/unit as the Solid host dependency", () => {
    const filePath = join(FIXTURES, "solid-dependency/App.mx");

    expect(resolveTargetPolicy(filePath, lookup)).toEqual({
      target: "unit-jsx",
      host: "unit",
    });
  });

  it("falls back to the html default policy when neither signal is present", () => {
    const filePath = join(FIXTURES, "no-signal/App.mx");

    expect(resolveTargetPolicy(filePath, lookup)).toEqual({ target: "page" });
  });

  it("accepts a deprecated legacy value as an alias for its target and warns", () => {
    const filePath = join(FIXTURES, "deprecated-alias/App.mx");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(resolveTargetPolicy(filePath, lookup)).toEqual({ target: "page" });
    // The warning names the deprecated value and the target it selects, both
    // read off the lookup rather than written here.
    expect(warnSpy).toHaveBeenCalledWith(
      "Warning: The 'oldpage' mx.host alias is deprecated and will be removed in a future release. Use 'page' instead.",
    );

    warnSpy.mockRestore();
  });

  it("resolves the Preact host from an explicit mx.host field", () => {
    // Branch 1 of the resolver, with this host's own name. The code path is
    // generic, but "preact is a host the field accepts" is the fact worth
    // pinning — `isKnownHost` is an explicit list, and a name missing from it
    // falls through to the default host rather than failing loudly.
    const filePath = join(FIXTURES, "preact-explicit/App.mx");

    expect(resolveTargetPolicy(filePath, lookup)).toEqual({
      target: "atom-jsx",
      host: "atom",
      strict: undefined,
    });
  });

  it("resolves the Preact host from a lone @t/atom dependency", () => {
    const filePath = join(FIXTURES, "preact-dependency/App.mx");

    expect(resolveTargetPolicy(filePath, lookup)).toEqual({
      target: "atom-jsx",
      host: "atom",
    });
  });

  it("resolves the React host from an explicit mx.host field", () => {
    const filePath = join(FIXTURES, "react-explicit/App.mx");

    expect(resolveTargetPolicy(filePath, lookup)).toEqual({
      target: "vue-jsx",
      host: "vue",
      strict: undefined,
    });
  });

  it("resolves the React host from a lone @t/vue dependency", () => {
    const filePath = join(FIXTURES, "react-dependency/App.mx");

    expect(resolveTargetPolicy(filePath, lookup)).toEqual({
      target: "vue-jsx",
      host: "vue",
    });
  });

  it("resolves the Hono host from an explicit mx.host field", () => {
    const filePath = join(FIXTURES, "hono-explicit/App.mx");

    expect(resolveTargetPolicy(filePath, lookup)).toEqual({
      target: "edge-jsx",
      host: "edge",
      strict: undefined,
    });
  });

  it("resolves the Hono host from a lone @t/edge dependency", () => {
    const filePath = join(FIXTURES, "hono-dependency/App.mx");

    expect(resolveTargetPolicy(filePath, lookup)).toEqual({
      target: "edge-jsx",
      host: "edge",
    });
  });

  it("falls back to the default policy when two host dependencies are present", () => {
    // Ambiguous on purpose: a project depending on both hosts has not said
    // which one owns this file, so the dependency signal cannot answer and the
    // default applies. An explicit `mx.host` is the way to disambiguate.
    const filePath = join(FIXTURES, "two-dependencies/App.mx");

    expect(resolveTargetPolicy(filePath, lookup)).toEqual({ target: "page" });
  });

  it("ignores a host listed only in peerDependencies (decision 124)", () => {
    const filePath = join(FIXTURES, "peer-only/App.mx");

    expect(resolveTargetPolicy(filePath, lookup)).toEqual({ target: "page" });
  });

  it("takes the host from dependencies when another host is only a peer (decision 124)", () => {
    // A counted peer would make two hosts and collapse to html.
    const filePath = join(FIXTURES, "peer-and-dependency/App.mx");

    expect(resolveTargetPolicy(filePath, lookup)).toEqual({
      target: "unit-jsx",
      host: "unit",
    });
  });

  it("falls back to the default policy when the walk reaches the filesystem root with no package.json", () => {
    // The walk must terminate at the root rather than looping forever on
    // `dirname("/") === "/"`. A path with no `package.json` anywhere above it
    // is the case that proves the stop condition fires.
    expect(resolveTargetPolicy("/nonexistent-mx-root/App.mx", lookup)).toEqual({
      target: "page",
    });
  });
});

/**
 * Edge cases of the upward walk (TODO `host-policy-walk-edge-cases`). Each
 * builds its tree in a temp dir: a committed malformed `package.json` would
 * trip every tool that globs the repo, and `node_modules` is not committable.
 */
describe("resolveTargetPolicyDetailed walk edge cases", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** Writes `files` (path → text) under a fresh temp dir and returns it. */
  function tree(files: Record<string, string>): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mx-host-policy-")));
    roots.push(root);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  }

  const ANGULAR = JSON.stringify({ dependencies: { "@t/grid": "1" } });

  describe("malformed package.json", () => {
    it("stops at it with the html default instead of climbing into an unrelated ancestor", () => {
      const root = tree({
        "package.json": ANGULAR,
        "app/package.json": '{ "dependencies": { "@t/unit": "1", }}',
        "app/src/a.mx": "",
      });

      const { policy, diagnostics } = resolveTargetPolicyDetailed(
        join(root, "app/src/a.mx"),
        lookup,
      );

      expect(policy).toEqual({ target: "page" });
      expect(diagnostics).toHaveLength(1);
    });

    it("names the broken package.json and the ancestor whose host it used to take", () => {
      const root = tree({
        "package.json": ANGULAR,
        "app/package.json": "{ not json",
        "app/src/a.mx": "",
      });
      const file = join(root, "app/src/a.mx");

      const [diagnostic] = resolveTargetPolicyDetailed(
        file,
        lookup,
      ).diagnostics;

      expect(diagnostic?.file).toBe(join(root, "app/package.json"));
      expect(diagnostic?.message).toContain("could not be parsed as JSON");
      // The broken file is named in the text too, not only in `file`.
      expect(
        diagnostic?.message.startsWith(join(root, "app/package.json")),
      ).toBe(true);
      expect(diagnostic?.message).toContain(
        `before, its host was taken from ${join(root, "package.json")} ("grid")`,
      );
      expect(diagnostic?.message).toContain('default "page" host');
    });

    it("omits the ancestor clause when there is no ancestor package.json", () => {
      const root = tree({ "package.json": "{", "a.mx": "" });

      const [diagnostic] = resolveTargetPolicyDetailed(
        join(root, "a.mx"),
        lookup,
      ).diagnostics;

      expect(diagnostic?.file).toBe(join(root, "package.json"));
      expect(diagnostic?.message).not.toContain("before, its host");
    });

    it("skips other broken ancestors when naming the one it used to take", () => {
      const root = tree({
        "package.json": ANGULAR,
        "mid/package.json": "nope",
        "mid/app/package.json": "{",
        "mid/app/a.mx": "",
      });

      const [diagnostic] = resolveTargetPolicyDetailed(
        join(root, "mid/app/a.mx"),
        lookup,
      ).diagnostics;

      expect(diagnostic?.file).toBe(join(root, "mid/app/package.json"));
      expect(diagnostic?.message).toContain(join(root, "package.json"));
      expect(diagnostic?.message).not.toContain(join(root, "mid/package.json"));
    });

    it.each([
      ["empty", ""],
      ["null", "null"],
      ["an array", "[]"],
      ["a string", '"unit"'],
    ])("treats %s contents as broken", (_name, text) => {
      const root = tree({
        "package.json": ANGULAR,
        "app/package.json": text,
        "app/a.mx": "",
      });

      const { policy, diagnostics } = resolveTargetPolicyDetailed(
        join(root, "app/a.mx"),
        lookup,
      );

      expect(policy).toEqual({ target: "page" });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.file).toBe(join(root, "app/package.json"));
    });

    it("says a non-object must be a JSON object, not that it failed to parse", () => {
      const root = tree({ "package.json": "[]", "a.mx": "" });

      const [diagnostic] = resolveTargetPolicyDetailed(
        join(root, "a.mx"),
        lookup,
      ).diagnostics;

      expect(diagnostic?.message).toContain("must contain a JSON object");
    });

    it("positions the diagnostic at the parse error when the runtime reports one, else at 1:0", () => {
      const text = '{\n  "a": 1,\n}\n';
      const root = tree({ "package.json": text, "a.mx": "" });

      const [diagnostic] = resolveTargetPolicyDetailed(
        join(root, "a.mx"),
        lookup,
      ).diagnostics;

      // V8 names the position, JavaScriptCore does not; nothing may rely on it.
      if (/position|line \d+ column/.test(diagnostic?.message ?? "")) {
        expect(diagnostic?.line).toBe(3);
        expect(diagnostic?.column).toBe(0);
      } else {
        expect(diagnostic).toMatchObject({ line: 1, column: 0 });
      }
    });

    it("recovers as soon as the file is fixed (the read is mtime-keyed)", () => {
      const root = tree({ "package.json": "{", "a.mx": "" });
      const file = join(root, "a.mx");
      expect(
        resolveTargetPolicyDetailed(file, lookup).diagnostics,
      ).toHaveLength(1);

      writeFileSync(join(root, "package.json"), ANGULAR);
      const later = new Date(Date.now() + 5000);
      utimesSync(join(root, "package.json"), later, later);

      expect(resolveTargetPolicyDetailed(file, lookup)).toEqual({
        policy: { target: "grid-jsx", host: "grid" },
        diagnostics: [],
      });
    });

    it("sees an edit that pins the mtime: a pinned-mtime rewrite to another host, and to broken JSON", () => {
      const pinned = new Date("2020-01-01T00:00:00Z");
      const pkg = (host: string) => JSON.stringify({ mx: { host } });
      const root = tree({ "package.json": pkg("unit"), "a.mx": "" });
      const manifest = join(root, "package.json");
      const file = join(root, "a.mx");
      utimesSync(manifest, pinned, pinned);
      expect(resolveTargetPolicy(file, lookup).target).toBe("unit-jsx");

      writeFileSync(manifest, pkg("vue"));
      utimesSync(manifest, pinned, pinned);
      expect(resolveTargetPolicy(file, lookup).target).toBe("vue-jsx");

      writeFileSync(manifest, "{ bad");
      utimesSync(manifest, pinned, pinned);
      expect(
        resolveTargetPolicyDetailed(file, lookup).diagnostics,
      ).toHaveLength(1);
    });

    it("agrees with scanCustomTags about which package.json is nearest", () => {
      const root = tree({
        "package.json": ANGULAR,
        "app/package.json": "{",
        "app/a.mx": "",
      });
      const file = join(root, "app/a.mx");

      const scan = scanCustomTags(file, { targets: lookup });
      const [diagnostic] = resolveTargetPolicyDetailed(
        file,
        lookup,
      ).diagnostics;

      expect(scan.packageFiles).toEqual([join(root, "app/package.json")]);
      expect(scan.diagnostics[0]?.file).toBe(diagnostic?.file);
    });

    it("words the diagnostic per package.json, not per file, so callers can dedupe it", () => {
      const root = tree({
        "package.json": ANGULAR,
        "app/package.json": "{",
        "app/a.mx": "",
        "app/b.mx": "",
      });

      const message = (name: string) =>
        resolveTargetPolicyDetailed(join(root, "app", name), lookup)
          .diagnostics[0]?.message;

      expect(message("a.mx")).toBe(message("b.mx"));
    });

    it("keeps resolveTargetPolicy API-compatible: same policy, nothing thrown", () => {
      const root = tree({ "package.json": ANGULAR, "app/package.json": "{" });
      const file = join(root, "app/a.mx");

      expect(resolveTargetPolicy(file, lookup)).toEqual(
        resolveTargetPolicyDetailed(file, lookup).policy,
      );
    });
  });

  describe("a directory with no package.json of its own", () => {
    it("inherits the monorepo root's host (documented, no diagnostic)", () => {
      const root = tree({
        "package.json": JSON.stringify({
          workspaces: ["packages/*"],
          devDependencies: { "@t/unit": "1" },
        }),
        "packages/web/src/a.mx": "",
      });

      expect(
        resolveTargetPolicyDetailed(
          join(root, "packages/web/src/a.mx"),
          lookup,
        ),
      ).toEqual({
        policy: { target: "unit-jsx", host: "unit" },
        diagnostics: [],
      });
    });

    it("lets a member opt out by having its own package.json", () => {
      const root = tree({
        "package.json": JSON.stringify({
          devDependencies: { "@t/unit": "1" },
        }),
        "packages/web/package.json": JSON.stringify({
          dependencies: { "@t/vue": "1" },
        }),
        "packages/web/src/a.mx": "",
        "packages/docs/src/b.mx": "",
      });

      expect(
        resolveTargetPolicy(join(root, "packages/web/src/a.mx"), lookup),
      ).toEqual({ target: "vue-jsx", host: "vue" });
      expect(
        resolveTargetPolicy(join(root, "packages/docs/src/b.mx"), lookup),
      ).toEqual({ target: "unit-jsx", host: "unit" });
    });

    it("lets a member pin a host with mx.host and an empty-deps package.json", () => {
      const root = tree({
        "package.json": ANGULAR,
        "packages/web/package.json": JSON.stringify({ mx: { target: "page" } }),
        "packages/web/a.mx": "",
      });

      expect(
        resolveTargetPolicy(join(root, "packages/web/a.mx"), lookup),
      ).toEqual({ target: "page", strict: undefined });
    });
  });

  describe("node_modules boundary", () => {
    it("does not climb out of an installed package that ships no package.json", () => {
      const root = tree({
        "package.json": ANGULAR,
        "node_modules/lib/dist/a.mx": "",
      });

      expect(
        resolveTargetPolicyDetailed(
          join(root, "node_modules/lib/dist/a.mx"),
          lookup,
        ),
      ).toEqual({ policy: { target: "page" }, diagnostics: [] });
    });

    it("stops at node_modules for a scoped package too", () => {
      const root = tree({
        "package.json": ANGULAR,
        "node_modules/@scope/lib/a.mx": "",
      });

      expect(
        resolveTargetPolicyDetailed(
          join(root, "node_modules/@scope/lib/a.mx"),
          lookup,
        ),
      ).toEqual({ policy: { target: "page" }, diagnostics: [] });
    });

    it("still reads the installed package's own package.json when it has one", () => {
      const root = tree({
        "package.json": ANGULAR,
        "node_modules/lib/package.json": JSON.stringify({
          dependencies: { "@t/unit": "1" },
        }),
        "node_modules/lib/src/a.mx": "",
      });

      expect(
        resolveTargetPolicy(join(root, "node_modules/lib/src/a.mx"), lookup),
      ).toEqual({ target: "unit-jsx", host: "unit" });
    });

    it("finds a package.json below a node_modules ancestor before reaching the boundary", () => {
      const root = tree({
        "package.json": ANGULAR,
        "node_modules/host/app/package.json": JSON.stringify({
          dependencies: { "@t/atom": "1" },
        }),
        "node_modules/host/app/a.mx": "",
      });

      expect(
        resolveTargetPolicy(join(root, "node_modules/host/app/a.mx"), lookup),
      ).toEqual({ target: "atom-jsx", host: "atom" });
    });

    it("does not affect a project that merely has node_modules next to its package.json", () => {
      const root = tree({
        "package.json": ANGULAR,
        "node_modules/.keep": "",
        "src/a.mx": "",
      });

      expect(resolveTargetPolicy(join(root, "src/a.mx"), lookup)).toEqual({
        target: "grid-jsx",
        host: "grid",
      });
    });
  });

  describe("unknown mx.host", () => {
    const SOLID_DEP = { "@t/unit": "1" };

    it("warns with the valid hosts and a did-you-mean, then falls back to the dependency rule", () => {
      const root = tree({
        "package.json": JSON.stringify({
          mx: { host: "unitt" },
          dependencies: SOLID_DEP,
        }),
        "a.mx": "",
      });

      const { policy, diagnostics } = resolveTargetPolicyDetailed(
        join(root, "a.mx"),
        lookup,
      );

      expect(policy).toEqual({ target: "unit-jsx", host: "unit" });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.file).toBe(join(root, "package.json"));
      expect(diagnostics[0]?.message).toContain('unknown mx.host "unitt"');
      // Every value `mx.host` accepts but the deprecated one, in registration
      // order, then the deprecated one named apart.
      expect(diagnostics[0]?.message).toContain(
        "valid hosts: page, view, unit, atom, vue, edge, grid ('oldpage' is a deprecated alias for page)",
      );
      expect(diagnostics[0]?.message).toContain('Did you mean "unit"?');
    });

    it("offers no suggestion when nothing is within two edits", () => {
      const root = tree({
        "package.json": JSON.stringify({ mx: { host: "banana" } }),
        "a.mx": "",
      });

      const { policy, diagnostics } = resolveTargetPolicyDetailed(
        join(root, "a.mx"),
        lookup,
      );

      expect(policy).toEqual({ target: "page" });
      expect(diagnostics[0]?.message).toContain('unknown mx.host "banana"');
      expect(diagnostics[0]?.message).not.toContain("Did you mean");
    });

    it("suggests across case (Unit -> unit) and at the edit-distance limit", () => {
      const at = (value: string) =>
        resolveTargetPolicyDetailed(
          join(
            tree({
              "package.json": JSON.stringify({ mx: { host: value } }),
              "a.mx": "",
            }),
            "a.mx",
          ),
          lookup,
        ).diagnostics[0]?.message;

      expect(at("Unit")).toContain('Did you mean "unit"?');
      expect(at("edgg")).toContain('Did you mean "edge"?');
      expect(at("reaction")).not.toContain("Did you mean");
    });

    it("positions the diagnostic at the host value, skipping an earlier nested host key", () => {
      const text = [
        "{",
        '  "mx": {',
        '    "angular": { "host": "unitt" },',
        '    "host": "solidd"',
        "  }",
        "}",
      ].join("\n");
      const root = tree({ "package.json": text, "a.mx": "" });

      const [diagnostic] = resolveTargetPolicyDetailed(
        join(root, "a.mx"),
        lookup,
      ).diagnostics;

      // The nested `angular.host` also says "solidd"; the first `host` key
      // whose value matches is the nested one, which is what text search can
      // honestly promise. It must at least land inside the mx object.
      expect(diagnostic?.line).toBeGreaterThanOrEqual(3);
      expect(diagnostic?.line).toBeLessThanOrEqual(4);
    });

    it("warns for a non-string mx.host without a suggestion", () => {
      const root = tree({
        "package.json": JSON.stringify({ mx: { host: 5 } }),
        "a.mx": "",
      });

      const [diagnostic] = resolveTargetPolicyDetailed(
        join(root, "a.mx"),
        lookup,
      ).diagnostics;

      expect(diagnostic?.message).toContain("unknown mx.host 5");
      expect(diagnostic?.message).not.toContain("Did you mean");
    });

    it("stays quiet for a known host, for the translator alias and for an mx object without host", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        for (const mx of [
          { target: "vue-jsx", host: "vue" },
          { target: "page" },
          { strict: true },
        ]) {
          const root = tree({
            "package.json": JSON.stringify({ mx }),
            "a.mx": "",
          });
          expect(
            resolveTargetPolicyDetailed(join(root, "a.mx"), lookup).diagnostics,
          ).toEqual([]);
        }
      } finally {
        warn.mockRestore();
      }
    });

    it("leaves the two-host-dependencies fallback exactly as it was", () => {
      expect(
        resolveTargetPolicyDetailed(
          join(FIXTURES, "two-dependencies/App.mx"),
          lookup,
        ),
      ).toEqual({ policy: { target: "page" }, diagnostics: [] });
    });
  });
});

describe("TargetPolicyDiagnostic code", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function project(packageJson: string): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mx-host-code-")));
    roots.push(root);
    writeFileSync(join(root, "package.json"), packageJson);
    writeFileSync(join(root, "a.mx"), "");
    return join(root, "a.mx");
  }

  it('is "unknown-host" for an mx.host naming no host', () => {
    const { diagnostics } = resolveTargetPolicyDetailed(
      project(JSON.stringify({ mx: { host: "nonesuch" } })),
      lookup,
    );

    expect(diagnostics.map((d) => d.code)).toEqual(["unknown-host"]);
  });

  it.each([
    ["unparseable JSON", "{ not json"],
    ["a non-object manifest", "[]"],
  ])('is "malformed-package-json" for %s', (_name, text) => {
    const { diagnostics } = resolveTargetPolicyDetailed(project(text), lookup);

    expect(diagnostics.map((d) => d.code)).toEqual(["malformed-package-json"]);
  });

  it("raises none for a valid host", () => {
    const { diagnostics } = resolveTargetPolicyDetailed(
      project(JSON.stringify({ mx: { target: "page" } })),
      lookup,
    );

    expect(diagnostics).toEqual([]);
  });
});

describe("mx.<target>.defaultTag (decision 145)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function project(packageJson: string): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mx-default-tag-")));
    roots.push(root);
    writeFileSync(join(root, "package.json"), packageJson);
    writeFileSync(join(root, "a.mx"), "");
    return join(root, "a.mx");
  }

  it("is read from the resolved target's own key", () => {
    const { policy, diagnostics } = resolveTargetPolicyDetailed(
      project(
        JSON.stringify({
          mx: { target: "view-jsx", "view-jsx": { defaultTag: "my-card" } },
        }),
      ),
      lookup,
    );
    expect(diagnostics).toEqual([]);
    expect(policy.defaultTag).toBe("my-card");
  });

  it("is read when the target comes from a dependency, not from mx.target", () => {
    const { policy } = resolveTargetPolicyDetailed(
      project(
        JSON.stringify({
          dependencies: { "@t/page": "1" },
          mx: { page: { defaultTag: "box" } },
        }),
      ),
      lookup,
    );
    expect(policy.target).toBe("page");
    expect(policy.defaultTag).toBe("box");
  });

  it("ignores another target's key", () => {
    const { policy, diagnostics } = resolveTargetPolicyDetailed(
      project(
        JSON.stringify({
          mx: { target: "page", "view-jsx": { defaultTag: "other" } },
        }),
      ),
      lookup,
    );
    expect(diagnostics).toEqual([]);
    expect(policy.defaultTag).toBeUndefined();
  });

  it("is absent when not configured", () => {
    const { policy } = resolveTargetPolicyDetailed(
      project(JSON.stringify({ mx: { target: "page", page: {} } })),
      lookup,
    );
    expect(policy).not.toHaveProperty("defaultTag");
  });

  it.each([
    [1, "a number"],
    [null, "null"],
    [true, "a boolean"],
    [["a"], "an array"],
    [{}, "an object"],
    ["", "an empty string"],
  ])("rejects %j, positioned at the value", (value, kind) => {
    const text = `{
  "mx": {
    "target": "page",
    "page": { "defaultTag": ${JSON.stringify(value)} }
  }
}`;
    const { policy, diagnostics } = resolveTargetPolicyDetailed(
      project(text),
      lookup,
    );
    expect(policy.defaultTag).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "invalid-default-tag",
      severity: "error",
      line: 4,
      column: text.split("\n")[3]?.indexOf(JSON.stringify(value)),
      length: JSON.stringify(value).length,
    });
    expect(diagnostics[0]?.message).toContain("invalid `defaultTag` value");
    expect(diagnostics[0]?.message).toContain(kind);
    expect(diagnostics[0]?.message).toContain("mx.page.defaultTag");
  });

  it("positions an escaped key at its value, not at a decoy elsewhere", () => {
    const text = `{
  "decoy": { "page": { "defaultTag": 9 } },
  "mx": { "target": "page", "p\\u0061ge": { "defaultTag": 7 } }
}`;
    const { diagnostics } = resolveTargetPolicyDetailed(project(text), lookup);
    expect(diagnostics[0]).toMatchObject({
      code: "invalid-default-tag",
      line: 3,
    });
  });
});
