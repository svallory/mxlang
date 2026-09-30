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
import { resolveHostPolicy, resolveHostPolicyDetailed } from "./host-policy.ts";
import { scanCustomTags } from "./scan.ts";

const FIXTURES = join(import.meta.dirname, "fixtures/host-policy");

/**
 * One set of branch tests for the resolver, living with the resolver itself.
 * Both `@mxlang/language-server` and `@mxlang/typescript-plugin` call this
 * function, and an editor and a `tsc` run disagreeing about which host owns a
 * file is the drift a second copy of these cases would invite.
 */
describe("resolveHostPolicy", () => {
  it("uses the package.json#mx field when present, walking up past a subdirectory with no package.json of its own", () => {
    const filePath = join(FIXTURES, "explicit-field/nested/App.mx");

    expect(resolveHostPolicy(filePath)).toEqual({
      host: "astro",
      strict: true,
    });
  });

  it("falls back to the sole @mxlang/* host dependency when no #mx field is present", () => {
    const filePath = join(FIXTURES, "single-dependency/App.mx");

    expect(resolveHostPolicy(filePath)).toEqual({ host: "html" });
  });

  it("resolves @mxlang/solid as the Solid host dependency", () => {
    const filePath = join(FIXTURES, "solid-dependency/App.mx");

    expect(resolveHostPolicy(filePath)).toEqual({ host: "solid" });
  });

  it("falls back to the html default policy when neither signal is present", () => {
    const filePath = join(FIXTURES, "no-signal/App.mx");

    expect(resolveHostPolicy(filePath)).toEqual({ host: "html" });
  });

  it("accepts 'translator' as a deprecated alias for 'html' and warns", () => {
    const filePath = join(FIXTURES, "deprecated-alias/App.mx");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(resolveHostPolicy(filePath)).toEqual({ host: "html" });
    expect(warnSpy).toHaveBeenCalledWith(
      "Warning: The 'translator' mx.host alias is deprecated and will be removed in a future release. Use 'html' instead.",
    );

    warnSpy.mockRestore();
  });

  it("resolves the Preact host from an explicit mx.host field", () => {
    // Branch 1 of the resolver, with this host's own name. The code path is
    // generic, but "preact is a host the field accepts" is the fact worth
    // pinning — `isKnownHost` is an explicit list, and a name missing from it
    // falls through to the default host rather than failing loudly.
    const filePath = join(FIXTURES, "preact-explicit/App.mx");

    expect(resolveHostPolicy(filePath)).toEqual({
      host: "preact",
      strict: undefined,
    });
  });

  it("resolves the Preact host from a lone @mxlang/preact dependency", () => {
    const filePath = join(FIXTURES, "preact-dependency/App.mx");

    expect(resolveHostPolicy(filePath)).toEqual({ host: "preact" });
  });

  it("resolves the React host from an explicit mx.host field", () => {
    const filePath = join(FIXTURES, "react-explicit/App.mx");

    expect(resolveHostPolicy(filePath)).toEqual({
      host: "react",
      strict: undefined,
    });
  });

  it("resolves the React host from a lone @mxlang/react dependency", () => {
    const filePath = join(FIXTURES, "react-dependency/App.mx");

    expect(resolveHostPolicy(filePath)).toEqual({ host: "react" });
  });

  it("resolves the Hono host from an explicit mx.host field", () => {
    const filePath = join(FIXTURES, "hono-explicit/App.mx");

    expect(resolveHostPolicy(filePath)).toEqual({
      host: "hono",
      strict: undefined,
    });
  });

  it("resolves the Hono host from a lone @mxlang/hono dependency", () => {
    const filePath = join(FIXTURES, "hono-dependency/App.mx");

    expect(resolveHostPolicy(filePath)).toEqual({ host: "hono" });
  });

  it("falls back to the default policy when two host dependencies are present", () => {
    // Ambiguous on purpose: a project depending on both hosts has not said
    // which one owns this file, so the dependency signal cannot answer and the
    // default applies. An explicit `mx.host` is the way to disambiguate.
    const filePath = join(FIXTURES, "two-dependencies/App.mx");

    expect(resolveHostPolicy(filePath)).toEqual({ host: "html" });
  });

  it("falls back to the default policy when the walk reaches the filesystem root with no package.json", () => {
    // The walk must terminate at the root rather than looping forever on
    // `dirname("/") === "/"`. A path with no `package.json` anywhere above it
    // is the case that proves the stop condition fires.
    expect(resolveHostPolicy("/nonexistent-mx-root/App.mx")).toEqual({
      host: "html",
    });
  });
});

/**
 * Edge cases of the upward walk (TODO `host-policy-walk-edge-cases`). Each
 * builds its tree in a temp dir: a committed malformed `package.json` would
 * trip every tool that globs the repo, and `node_modules` is not committable.
 */
describe("resolveHostPolicyDetailed walk edge cases", () => {
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

  const ANGULAR = JSON.stringify({ dependencies: { "@mxlang/angular": "1" } });

  describe("malformed package.json", () => {
    it("stops at it with the html default instead of climbing into an unrelated ancestor", () => {
      const root = tree({
        "package.json": ANGULAR,
        "app/package.json": '{ "dependencies": { "@mxlang/solid": "1", }}',
        "app/src/a.mx": "",
      });

      const { policy, diagnostics } = resolveHostPolicyDetailed(
        join(root, "app/src/a.mx"),
      );

      expect(policy).toEqual({ host: "html" });
      expect(diagnostics).toHaveLength(1);
    });

    it("names the broken package.json and the ancestor whose host it used to take", () => {
      const root = tree({
        "package.json": ANGULAR,
        "app/package.json": "{ not json",
        "app/src/a.mx": "",
      });
      const file = join(root, "app/src/a.mx");

      const [diagnostic] = resolveHostPolicyDetailed(file).diagnostics;

      expect(diagnostic?.file).toBe(join(root, "app/package.json"));
      expect(diagnostic?.message).toContain("could not be parsed as JSON");
      // The broken file is named in the text too, not only in `file`.
      expect(
        diagnostic?.message.startsWith(join(root, "app/package.json")),
      ).toBe(true);
      expect(diagnostic?.message).toContain(
        `before, its host was taken from ${join(root, "package.json")} ("angular")`,
      );
      expect(diagnostic?.message).toContain('default "html" host');
    });

    it("omits the ancestor clause when there is no ancestor package.json", () => {
      const root = tree({ "package.json": "{", "a.mx": "" });

      const [diagnostic] = resolveHostPolicyDetailed(
        join(root, "a.mx"),
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

      const [diagnostic] = resolveHostPolicyDetailed(
        join(root, "mid/app/a.mx"),
      ).diagnostics;

      expect(diagnostic?.file).toBe(join(root, "mid/app/package.json"));
      expect(diagnostic?.message).toContain(join(root, "package.json"));
      expect(diagnostic?.message).not.toContain(join(root, "mid/package.json"));
    });

    it.each([
      ["empty", ""],
      ["null", "null"],
      ["an array", "[]"],
      ["a string", '"solid"'],
    ])("treats %s contents as broken", (_name, text) => {
      const root = tree({
        "package.json": ANGULAR,
        "app/package.json": text,
        "app/a.mx": "",
      });

      const { policy, diagnostics } = resolveHostPolicyDetailed(
        join(root, "app/a.mx"),
      );

      expect(policy).toEqual({ host: "html" });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.file).toBe(join(root, "app/package.json"));
    });

    it("says a non-object must be a JSON object, not that it failed to parse", () => {
      const root = tree({ "package.json": "[]", "a.mx": "" });

      const [diagnostic] = resolveHostPolicyDetailed(
        join(root, "a.mx"),
      ).diagnostics;

      expect(diagnostic?.message).toContain("must contain a JSON object");
    });

    it("positions the diagnostic at the parse error when the runtime reports one, else at 1:0", () => {
      const text = '{\n  "a": 1,\n}\n';
      const root = tree({ "package.json": text, "a.mx": "" });

      const [diagnostic] = resolveHostPolicyDetailed(
        join(root, "a.mx"),
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
      expect(resolveHostPolicyDetailed(file).diagnostics).toHaveLength(1);

      writeFileSync(join(root, "package.json"), ANGULAR);
      const later = new Date(Date.now() + 5000);
      utimesSync(join(root, "package.json"), later, later);

      expect(resolveHostPolicyDetailed(file)).toEqual({
        policy: { host: "angular" },
        diagnostics: [],
      });
    });

    it("sees an edit that pins the mtime: a pinned-mtime rewrite to another host, and to broken JSON", () => {
      const pinned = new Date("2020-01-01T00:00:00Z");
      const pkg = (host: string) => JSON.stringify({ mx: { host } });
      const root = tree({ "package.json": pkg("solid"), "a.mx": "" });
      const manifest = join(root, "package.json");
      const file = join(root, "a.mx");
      utimesSync(manifest, pinned, pinned);
      expect(resolveHostPolicy(file).host).toBe("solid");

      writeFileSync(manifest, pkg("react"));
      utimesSync(manifest, pinned, pinned);
      expect(resolveHostPolicy(file).host).toBe("react");

      writeFileSync(manifest, "{ bad");
      utimesSync(manifest, pinned, pinned);
      expect(resolveHostPolicyDetailed(file).diagnostics).toHaveLength(1);
    });

    it("agrees with scanCustomTags about which package.json is nearest", () => {
      const root = tree({
        "package.json": ANGULAR,
        "app/package.json": "{",
        "app/a.mx": "",
      });
      const file = join(root, "app/a.mx");

      const scan = scanCustomTags(file);
      const [diagnostic] = resolveHostPolicyDetailed(file).diagnostics;

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
        resolveHostPolicyDetailed(join(root, "app", name)).diagnostics[0]
          ?.message;

      expect(message("a.mx")).toBe(message("b.mx"));
    });

    it("keeps resolveHostPolicy API-compatible: same policy, nothing thrown", () => {
      const root = tree({ "package.json": ANGULAR, "app/package.json": "{" });
      const file = join(root, "app/a.mx");

      expect(resolveHostPolicy(file)).toEqual(
        resolveHostPolicyDetailed(file).policy,
      );
    });
  });

  describe("a directory with no package.json of its own", () => {
    it("inherits the monorepo root's host (documented, no diagnostic)", () => {
      const root = tree({
        "package.json": JSON.stringify({
          workspaces: ["packages/*"],
          devDependencies: { "@mxlang/solid": "1" },
        }),
        "packages/web/src/a.mx": "",
      });

      expect(
        resolveHostPolicyDetailed(join(root, "packages/web/src/a.mx")),
      ).toEqual({ policy: { host: "solid" }, diagnostics: [] });
    });

    it("lets a member opt out by having its own package.json", () => {
      const root = tree({
        "package.json": JSON.stringify({
          devDependencies: { "@mxlang/solid": "1" },
        }),
        "packages/web/package.json": JSON.stringify({
          dependencies: { "@mxlang/react": "1" },
        }),
        "packages/web/src/a.mx": "",
        "packages/docs/src/b.mx": "",
      });

      expect(resolveHostPolicy(join(root, "packages/web/src/a.mx"))).toEqual({
        host: "react",
      });
      expect(resolveHostPolicy(join(root, "packages/docs/src/b.mx"))).toEqual({
        host: "solid",
      });
    });

    it("lets a member pin a host with mx.host and an empty-deps package.json", () => {
      const root = tree({
        "package.json": ANGULAR,
        "packages/web/package.json": JSON.stringify({ mx: { host: "html" } }),
        "packages/web/a.mx": "",
      });

      expect(resolveHostPolicy(join(root, "packages/web/a.mx"))).toEqual({
        host: "html",
        strict: undefined,
      });
    });
  });

  describe("node_modules boundary", () => {
    it("does not climb out of an installed package that ships no package.json", () => {
      const root = tree({
        "package.json": ANGULAR,
        "node_modules/lib/dist/a.mx": "",
      });

      expect(
        resolveHostPolicyDetailed(join(root, "node_modules/lib/dist/a.mx")),
      ).toEqual({ policy: { host: "html" }, diagnostics: [] });
    });

    it("stops at node_modules for a scoped package too", () => {
      const root = tree({
        "package.json": ANGULAR,
        "node_modules/@scope/lib/a.mx": "",
      });

      expect(
        resolveHostPolicyDetailed(join(root, "node_modules/@scope/lib/a.mx")),
      ).toEqual({ policy: { host: "html" }, diagnostics: [] });
    });

    it("still reads the installed package's own package.json when it has one", () => {
      const root = tree({
        "package.json": ANGULAR,
        "node_modules/lib/package.json": JSON.stringify({
          dependencies: { "@mxlang/solid": "1" },
        }),
        "node_modules/lib/src/a.mx": "",
      });

      expect(
        resolveHostPolicy(join(root, "node_modules/lib/src/a.mx")),
      ).toEqual({ host: "solid" });
    });

    it("finds a package.json below a node_modules ancestor before reaching the boundary", () => {
      const root = tree({
        "package.json": ANGULAR,
        "node_modules/host/app/package.json": JSON.stringify({
          dependencies: { "@mxlang/preact": "1" },
        }),
        "node_modules/host/app/a.mx": "",
      });

      expect(
        resolveHostPolicy(join(root, "node_modules/host/app/a.mx")),
      ).toEqual({ host: "preact" });
    });

    it("does not affect a project that merely has node_modules next to its package.json", () => {
      const root = tree({
        "package.json": ANGULAR,
        "node_modules/.keep": "",
        "src/a.mx": "",
      });

      expect(resolveHostPolicy(join(root, "src/a.mx"))).toEqual({
        host: "angular",
      });
    });
  });

  describe("unknown mx.host", () => {
    const SOLID_DEP = { "@mxlang/solid": "1" };

    it("warns with the valid hosts and a did-you-mean, then falls back to the dependency rule", () => {
      const root = tree({
        "package.json": JSON.stringify({
          mx: { host: "solidd" },
          dependencies: SOLID_DEP,
        }),
        "a.mx": "",
      });

      const { policy, diagnostics } = resolveHostPolicyDetailed(
        join(root, "a.mx"),
      );

      expect(policy).toEqual({ host: "solid" });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.file).toBe(join(root, "package.json"));
      expect(diagnostics[0]?.message).toContain('unknown mx.host "solidd"');
      expect(diagnostics[0]?.message).toContain(
        "html, astro, solid, preact, react, hono, angular",
      );
      expect(diagnostics[0]?.message).toContain('Did you mean "solid"?');
    });

    it("offers no suggestion when nothing is within two edits", () => {
      const root = tree({
        "package.json": JSON.stringify({ mx: { host: "banana" } }),
        "a.mx": "",
      });

      const { policy, diagnostics } = resolveHostPolicyDetailed(
        join(root, "a.mx"),
      );

      expect(policy).toEqual({ host: "html" });
      expect(diagnostics[0]?.message).toContain('unknown mx.host "banana"');
      expect(diagnostics[0]?.message).not.toContain("Did you mean");
    });

    it("suggests across case (Solid -> solid) and at the edit-distance limit", () => {
      const at = (value: string) =>
        resolveHostPolicyDetailed(
          join(
            tree({
              "package.json": JSON.stringify({ mx: { host: value } }),
              "a.mx": "",
            }),
            "a.mx",
          ),
        ).diagnostics[0]?.message;

      expect(at("Solid")).toContain('Did you mean "solid"?');
      expect(at("reakt")).toContain('Did you mean "react"?');
      expect(at("reaktion")).not.toContain("Did you mean");
    });

    it("positions the diagnostic at the host value, skipping an earlier nested host key", () => {
      const text = [
        "{",
        '  "mx": {',
        '    "angular": { "host": "solidd" },',
        '    "host": "solidd"',
        "  }",
        "}",
      ].join("\n");
      const root = tree({ "package.json": text, "a.mx": "" });

      const [diagnostic] = resolveHostPolicyDetailed(
        join(root, "a.mx"),
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

      const [diagnostic] = resolveHostPolicyDetailed(
        join(root, "a.mx"),
      ).diagnostics;

      expect(diagnostic?.message).toContain("unknown mx.host 5");
      expect(diagnostic?.message).not.toContain("Did you mean");
    });

    it("stays quiet for a known host, for the translator alias and for an mx object without host", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        for (const mx of [
          { host: "react" },
          { host: "translator" },
          { strict: true },
        ]) {
          const root = tree({
            "package.json": JSON.stringify({ mx }),
            "a.mx": "",
          });
          expect(
            resolveHostPolicyDetailed(join(root, "a.mx")).diagnostics,
          ).toEqual([]);
        }
      } finally {
        warn.mockRestore();
      }
    });

    it("leaves the two-host-dependencies fallback exactly as it was", () => {
      expect(
        resolveHostPolicyDetailed(join(FIXTURES, "two-dependencies/App.mx")),
      ).toEqual({ policy: { host: "html" }, diagnostics: [] });
    });
  });
});
