import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import { TranslateError } from "./core.ts";
import { customTagTaglib } from "./custom-tags.ts";
import type { Policy } from "./declarations.ts";
import type { Ir, IrNode } from "./ir.ts";
import {
  clearManifestCache,
  discoverProjectTags,
  normalizeMxTags,
  readParseOptions,
  scanCustomTags,
  walkProjectDirectories,
} from "./scan.ts";
import {
  clearScanCache,
  getCustomTags,
  liveTagMapCount,
  scanCached,
} from "./scan-cache.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures", "scan");

function fixture(...parts: string[]): string {
  return join(fixtures, ...parts);
}

/** Scratch directories this file created, removed after each test. */
const scratches: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "mx-scan-"));
  scratches.push(dir);
  return dir;
}

/**
 * Moves a file's mtime forward explicitly.
 *
 * An editor's save produces a new mtime, but two writes inside one test can
 * land in the same filesystem timestamp tick; stamping the future makes the
 * change the cache must notice unambiguous rather than clock-dependent.
 */
function touchInFuture(path: string): void {
  const when = new Date(Date.now() + 10_000);
  utimesSync(path, when, when);
}

afterEach(() => {
  clearScanCache();
  clearManifestCache();
  for (const dir of scratches.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("scanCustomTags", () => {
  it("discovers a sidecar in a sibling tags/ directory with no import", () => {
    const result = scanCustomTags(fixture("parse-options", "caller.mx"));

    expect([...result.tags.keys()]).toEqual(["raw"]);
    expect(result.tags.get("raw")?.sidecar).toBe(
      fixture("parse-options", "tags", "raw.tag.ts"),
    );
    expect(Object.keys(result.customTags)).toEqual(["raw"]);
  });

  it("reads parseOptions statically, before any hook runs", () => {
    const result = scanCustomTags(fixture("parse-options", "caller.mx"));

    // The value is present on the map handed to the compiler, which is what
    // lets it reach Marko's taglib before the *caller* is parsed.
    expect(result.customTags.raw?.parseOptions).toEqual({
      text: true,
      preserveWhitespace: true,
    });
  });

  it("loads a sidecar's hooks only when one is used", () => {
    const dir = scratch();
    mkdirSync(join(dir, "tags"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"lazy"}');
    // Evaluating this module appends to a global; reading `parseOptions` must
    // not, and reading `transform` must.
    writeFileSync(
      join(dir, "tags", "counted.tag.ts"),
      [
        "(globalThis as Record<string, unknown>).mxScanLoadCount =",
        "  ((globalThis as Record<string, number>).mxScanLoadCount ?? 0) + 1;",
        "export default { parseOptions: { text: true }, transform: () => [] };",
      ].join("\n"),
    );

    const globals = globalThis as unknown as { mxScanLoadCount?: number };
    globals.mxScanLoadCount = 0;

    const tags = scanCustomTags(join(dir, "caller.mx")).customTags;
    expect(tags.counted?.parseOptions).toEqual({ text: true });
    expect(globals.mxScanLoadCount).toBe(0);

    expect(typeof tags.counted?.transform).toBe("function");
    expect(globals.mxScanLoadCount).toBe(1);

    // A second read reuses the loaded module rather than evaluating again.
    void tags.counted?.transform;
    expect(globals.mxScanLoadCount).toBe(1);
  });

  it("lets the nearest tags/ directory win a shared name", () => {
    const deep = scanCustomTags(fixture("nearest", "deep", "caller.mx"));
    const shallow = scanCustomTags(fixture("nearest", "caller.mx"));

    // Which definition won is proven by its declared attribute, not just by
    // the path: the nearer file declares `nearest`, the outer one `where`.
    expect(deep.tags.get("badge")?.sidecar).toBe(
      fixture("nearest", "deep", "tags", "badge.tag.ts"),
    );
    expect(Object.keys(deep.customTags.badge?.attributes ?? {})).toEqual([
      "nearest",
    ]);

    expect(shallow.tags.get("badge")?.sidecar).toBe(
      fixture("nearest", "tags", "badge.tag.ts"),
    );
    expect(Object.keys(shallow.customTags.badge?.attributes ?? {})).toEqual([
      "where",
    ]);
  });

  it("discovers a template-only tag with no sidecar", () => {
    const result = scanCustomTags(fixture("template-only", "caller.mx"));

    const note = result.tags.get("note");
    expect(note?.template).toBe(fixture("template-only", "tags", "note.mx"));
    expect(note?.sidecar).toBeUndefined();
    // Registered as a real template tag: no sidecar, so no `transform`, but a
    // `template` the core expands at the call site (P3). Reading it is what
    // loads the file, so a project with fifty tags touches only the ones a
    // compilation calls.
    expect(result.customTags.note).toBeDefined();
    expect(result.customTags.note?.transform).toBeUndefined();
    const template = (
      result.customTags.note as {
        template?: { filename: string; source: string };
      }
    ).template;
    expect(template?.filename).toBe(
      fixture("template-only", "tags", "note.mx"),
    );
    expect(template?.source).toContain("an L1 tag");
  });

  it("extends the walk with package.json#mx.tags, prefix included", () => {
    const result = scanCustomTags(fixture("mx-tags", "src", "caller.mx"));

    expect([...result.tags.keys()].sort()).toEqual(["ui-override", "ui-panel"]);
  });

  it("lets a sidecar override a directory-level parseOptions default", () => {
    const result = scanCustomTags(fixture("mx-tags", "src", "caller.mx"));

    // `panel` declares none and inherits the entry's default.
    expect(result.customTags["ui-panel"]?.parseOptions).toEqual({ text: true });
    // `override` declares `text: false` and that wins.
    expect(result.customTags["ui-override"]?.parseOptions).toEqual({
      text: false,
    });
  });

  it("reports a missing mx.tags directory without failing the scan", () => {
    const result = scanCustomTags(fixture("mx-tags-missing", "caller.mx"));

    // A diagnostic, not a throw: one typo in `package.json` must not break
    // compilation of every file in the package, including the files that
    // never used that entry.
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.file).toBe(
      fixture("mx-tags-missing", "package.json"),
    );
    expect(result.diagnostics[0]?.message).toContain(
      "names a directory that does not exist",
    );
  });

  it("keeps discovering local tags when an mx.tags entry is missing", () => {
    const dir = scratch();
    mkdirSync(join(dir, "tags"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      '{"name":"partial","mx":{"tags":"nope"}}',
    );
    writeFileSync(join(dir, "tags", "local.mx"), "<div/>\n");

    const result = scanCustomTags(join(dir, "caller.mx"));

    expect(Object.keys(result.customTags)).toEqual(["local"]);
    expect(result.diagnostics).toHaveLength(1);
  });

  it("reports a sidecar whose parseOptions is not a literal", () => {
    let error: unknown;
    try {
      scanCustomTags(fixture("bad-parse-options", "caller.mx"));
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(TranslateError);
    const translate = error as TranslateError;
    // Names the offending file and points into it, so the author can act.
    expect(translate.message).toContain("computed.tag.ts");
    expect(translate.message).toContain("must be an object literal");
    expect(translate.line).toBeGreaterThan(0);
  });

  it("reports a sidecar that throws while loading, rather than crashing", () => {
    // Discovery itself succeeds: the throw happens only when hooks are read.
    const result = scanCustomTags(fixture("broken-sidecar", "caller.mx"));
    expect(result.tags.has("boom")).toBe(true);

    let error: unknown;
    try {
      void result.customTags.boom?.transform;
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(TranslateError);
    expect((error as Error).message).toContain("boom.tag.ts");
    expect((error as Error).message).toContain("sidecar failed to load");
  });

  it("ignores files in a tags/ directory that are not tag files", () => {
    const dir = scratch();
    mkdirSync(join(dir, "tags"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"mixed"}');
    writeFileSync(join(dir, "tags", "README.md"), "# tags\n");
    writeFileSync(join(dir, "tags", "helper.ts"), "export const x = 1;\n");
    writeFileSync(join(dir, "tags", "card.mx"), "<div/>\n");

    const result = scanCustomTags(join(dir, "caller.mx"));
    expect([...result.tags.keys()]).toEqual(["card"]);
  });

  it("skips dotfiles rather than minting a broken tag name", () => {
    const dir = scratch();
    mkdirSync(join(dir, "tags"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"dotfiles"}');
    // `.mx` has an empty basename, and an empty tag name makes
    // `@marko/compiler` throw `"tag.name" is required` — which fails every
    // file in the package, not just a file that calls it. `.DS_Store.mx` is
    // the same class from the other side: a `tags/` directory collects the
    // junk any directory collects.
    writeFileSync(join(dir, "tags", ".mx"), "<div/>\n");
    writeFileSync(join(dir, "tags", ".DS_Store.mx"), "<div/>\n");
    writeFileSync(join(dir, "tags", ".hidden.tag.ts"), "export default {};\n");
    writeFileSync(join(dir, "tags", "real.mx"), "<div/>\n");

    expect(
      Object.keys(scanCustomTags(join(dir, "caller.mx")).customTags),
    ).toEqual(["real"]);
  });

  it("rejects a tag file whose name cannot be a tag name", () => {
    const dir = scratch();
    mkdirSync(join(dir, "tags"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"badname"}');
    writeFileSync(join(dir, "tags", "-leading.mx"), "<div/>\n");

    let error: unknown;
    try {
      scanCustomTags(join(dir, "caller.mx"));
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(TranslateError);
    expect((error as Error).message).toContain("-leading.mx");
    expect((error as Error).message).toContain("is not a usable tag name");
  });

  it("preserves a tag file's case in its call name", () => {
    const dir = scratch();
    mkdirSync(join(dir, "tags"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"cased"}');
    writeFileSync(join(dir, "tags", "Icon.tag.ts"), "export default {};\n");

    // `tags/Icon.tag.ts` is `<Icon>`: a tag name is the filename, and the
    // filename is the author's.
    expect(
      Object.keys(scanCustomTags(join(dir, "caller.mx")).customTags),
    ).toEqual(["Icon"]);
  });

  it("reports a .solid.mx in a tags/ directory instead of ignoring it", () => {
    const dir = scratch();
    mkdirSync(join(dir, "tags"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"solidtag"}');
    writeFileSync(
      join(dir, "tags", "widget.solid.mx"),
      "export const x = 1;\n",
    );

    // A different file kind, not a tag template. Silence would leave an
    // author wondering why their file is invisible.
    const result = scanCustomTags(join(dir, "caller.mx"));
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toMatch(
      /`widget\.solid\.mx` is a host module file/,
    );
  });

  it("reports a .ng.mx in a tags/ directory instead of ignoring it", () => {
    const dir = scratch();
    mkdirSync(join(dir, "tags"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"ngtag"}');
    writeFileSync(join(dir, "tags", "widget.ng.mx"), "export const x = 1;\n");

    const result = scanCustomTags(join(dir, "caller.mx"));
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toMatch(
      /`widget\.ng\.mx` is a host module file/,
    );
  });

  it("indexes <unlisted>.mx as an ordinary dotted tag name", () => {
    const dir = scratch();
    mkdirSync(join(dir, "tags"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"footag"}');
    writeFileSync(join(dir, "tags", "widget.foo.mx"), "");

    // `foo` is not a recognized host segment (only `solid`/`ng` are today):
    // the host-module list is a closed allowlist, not "any second dotted
    // segment", precisely so a future dotted tag name is never mistaken for
    // a host module file it isn't.
    expect(
      Object.keys(scanCustomTags(join(dir, "caller.mx")).customTags),
    ).toEqual(["widget.foo"]);
  });

  it("still indexes a plain .mx tag with no host-module suffix", () => {
    const dir = scratch();
    mkdirSync(join(dir, "tags"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"plaintag"}');
    writeFileSync(join(dir, "tags", "icon.mx"), "");

    expect(
      Object.keys(scanCustomTags(join(dir, "caller.mx")).customTags),
    ).toEqual(["icon"]);
  });

  it("indexes a dotted tag name that is not a host-module convention", () => {
    const dir = scratch();
    mkdirSync(join(dir, "tags"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"dottedtag"}');
    // `my.icon` is not a recognized host segment (only `solid`/`ng` are), so
    // `TAG_NAME_RE` — which allows dots in a tag name — still wins: this is
    // the valid tag `<my.icon>`, unaffected by the host-module rule.
    writeFileSync(join(dir, "tags", "my.icon.mx"), "");

    expect(
      Object.keys(scanCustomTags(join(dir, "caller.mx")).customTags),
    ).toEqual(["my.icon"]);
  });

  it("refuses to register a tag file shadowing a core-owned built-in", () => {
    const dir = scratch();
    mkdirSync(join(dir, "tags"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"shadow"}');
    // `<try>` is core-owned (spec §5 P4). `rejectShadowedRegistration`
    // refuses the *whole* map when a shadowing name is in it, so passing this
    // one onward would break every file in the package — including files that
    // never call `<try>` — over one misnamed file.
    writeFileSync(join(dir, "tags", "try.tag.ts"), "export default {};\n");
    writeFileSync(join(dir, "tags", "fine.mx"), "<div/>\n");

    const result = scanCustomTags(join(dir, "caller.mx"));

    // Excluded from the map, so the rest of the package still compiles...
    expect(Object.keys(result.customTags)).toEqual(["fine"]);
    // ...and the author is told which file to rename.
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.file).toContain("try.tag.ts");
    expect(result.diagnostics[0]?.message).toContain("core-owned custom tag");
  });

  it("stops the upward walk at the package root", () => {
    const dir = scratch();
    mkdirSync(join(dir, "outer", "tags"), { recursive: true });
    mkdirSync(join(dir, "outer", "pkg"), { recursive: true });
    writeFileSync(join(dir, "outer", "tags", "outside.mx"), "<div/>\n");
    writeFileSync(
      join(dir, "outer", "pkg", "package.json"),
      '{"name":"inner"}',
    );

    // The `tags/` directory above the nearest package.json is out of scope:
    // a tag belongs to a package, not to whatever happens to sit above it.
    const result = scanCustomTags(join(dir, "outer", "pkg", "caller.mx"));
    expect(result.tags.has("outside")).toBe(false);
  });
});

describe("host-filtered discovery", () => {
  it("carries hosts onto a DiscoveredTag from an mx.tags entry", () => {
    const result = scanCustomTags(fixture("hosts", "caller.mx"));
    expect(result.tags.get("gizmo")?.hosts).toEqual(["solid"]);
  });

  it("is visible from the host it names", () => {
    const result = scanCustomTags(fixture("hosts", "caller.mx"), {
      host: "solid",
    });
    expect(result.tags.has("gizmo")).toBe(true);
    expect(Object.keys(result.customTags)).toEqual(["gizmo"]);
  });

  it("is absent from a host it does not name", () => {
    const result = scanCustomTags(fixture("hosts", "caller.mx"), {
      host: "html",
    });
    expect(result.tags.has("gizmo")).toBe(false);
    expect(Object.keys(result.customTags)).toEqual([]);
  });

  it("is visible to every host when the scan carries no host option", () => {
    const result = scanCustomTags(fixture("hosts", "caller.mx"));
    expect(result.tags.has("gizmo")).toBe(true);
  });

  it("a local tags/ directory has no hosts restriction", () => {
    const result = scanCustomTags(fixture("nearest", "caller.mx"), {
      host: "html",
    });
    expect(result.tags.get("badge")?.hosts).toBeUndefined();
    expect(result.tags.has("badge")).toBe(true);
  });
});

describe("discoverProjectTags", () => {
  it("enumerates every tags/ directory under the project, plus mx.tags", () => {
    const result = discoverProjectTags(fixture("project-wide"));
    expect([...result.tags.keys()].sort()).toEqual([
      "alpha",
      "beta",
      "epsilon",
    ]);
  });

  it("excludes a nested package's tags/ directory", () => {
    const result = discoverProjectTags(fixture("project-wide"));
    expect(result.tags.has("gamma")).toBe(false);
  });

  it("reports a .ng.mx under tags/ without failing the project scan", () => {
    const dir = scratch();
    mkdirSync(join(dir, "tags"), { recursive: true });
    mkdirSync(join(dir, "nested", "tags"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"projectng"}');
    writeFileSync(
      join(dir, "mx.tags"),
      JSON.stringify([{ dir: "tags" }, { dir: "nested/tags" }]),
    );
    writeFileSync(join(dir, "tags", "widget.ng.mx"), "export const x = 1;\n");
    writeFileSync(join(dir, "tags", "legit.mx"), "<div/>\n");
    writeFileSync(join(dir, "nested", "tags", "another.mx"), "<div/>\n");

    const result = discoverProjectTags(dir);
    expect(result.tags.has("legit")).toBe(true);
    expect(result.tags.has("another")).toBe(true);
    expect(result.directories).toContainEqual(join(dir, "tags"));
    expect(result.directories).toContainEqual(join(dir, "nested", "tags"));
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toMatch(
      /`widget\.ng\.mx` is a host module file/,
    );
  });

  it("excludes node_modules", () => {
    // Built at runtime rather than checked in: a `node_modules/` fixture
    // directory is gitignored by the repo's own root `.gitignore`, so a file
    // placed there would never reach a clone and this test would pass
    // vacuously with nothing to exclude.
    const dir = scratch();
    mkdirSync(join(dir, "node_modules", "tags"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "tags", "delta.mx"), "<div/>\n");
    writeFileSync(join(dir, "package.json"), '{"name":"node-modules-test"}');

    const result = discoverProjectTags(dir);
    expect(result.tags.has("delta")).toBe(false);
  });

  it("records sourceDir for every discovered tag", () => {
    const result = discoverProjectTags(fixture("project-wide"));
    expect(result.tags.get("alpha")?.sourceDir).toBe(
      fixture("project-wide", "tags"),
    );
    expect(result.tags.get("beta")?.sourceDir).toBe(
      fixture("project-wide", "nested", "tags"),
    );
  });

  it("is stably ordered across repeated calls", () => {
    const first = [...discoverProjectTags(fixture("project-wide")).tags.keys()];
    const second = [
      ...discoverProjectTags(fixture("project-wide")).tags.keys(),
    ];
    expect(first).toEqual(second);
  });

  it("applies the host filter the same way scanCustomTags does", () => {
    const result = discoverProjectTags(fixture("hosts"), { host: "html" });
    expect(result.tags.has("gizmo")).toBe(false);

    const solidResult = discoverProjectTags(fixture("hosts"), {
      host: "solid",
    });
    expect(solidResult.tags.has("gizmo")).toBe(true);
  });

  it("follows a symlinked tags/ directory", () => {
    const dir = scratch();
    writeFileSync(join(dir, "package.json"), '{"name":"symlink-test"}');
    mkdirSync(join(dir, "real-tags"), { recursive: true });
    writeFileSync(join(dir, "real-tags", "linked.mx"), "<div/>\n");
    symlinkSync(join(dir, "real-tags"), join(dir, "tags"), "dir");

    const result = discoverProjectTags(dir);
    expect(result.tags.has("linked")).toBe(true);
  });

  it("does not loop forever on a symlink cycle", () => {
    const dir = scratch();
    writeFileSync(join(dir, "package.json"), '{"name":"symlink-cycle-test"}');
    mkdirSync(join(dir, "tags"), { recursive: true });
    writeFileSync(join(dir, "tags", "real.mx"), "<div/>\n");
    // `nested/` has no `package.json` of its own, so the package-boundary
    // check does not stop the walk from descending into it — the
    // self-referential symlink inside it (`nested/loop` -> `nested`) is what
    // must be caught by the realpath guard, or the walk never terminates.
    mkdirSync(join(dir, "nested"), { recursive: true });
    symlinkSync(join(dir, "nested"), join(dir, "nested", "loop"), "dir");

    expect(() => discoverProjectTags(dir)).not.toThrow();

    const result = discoverProjectTags(dir);
    expect(result.tags.has("real")).toBe(true);
  });
});

describe("walkProjectDirectories", () => {
  it("visits every real directory exactly once", () => {
    const dir = scratch();
    mkdirSync(join(dir, "a"), { recursive: true });
    mkdirSync(join(dir, "b"), { recursive: true });

    const visited: string[] = [];
    walkProjectDirectories(dir, (visitedDir) => visited.push(visitedDir));

    expect(visited.sort()).toEqual(
      [dir, join(dir, "a"), join(dir, "b")].sort(),
    );
  });

  it("is the guard that stops a two-node symlink cycle from recursing forever", () => {
    const dir = scratch();
    mkdirSync(join(dir, "a"), { recursive: true });
    mkdirSync(join(dir, "b"), { recursive: true });
    // `a/link` -> `b`, `b/link` -> `a`: no directory in this cycle has a
    // `package.json` of its own, so nothing but the realpath guard can stop
    // the walk from bouncing `a` -> `a/link` (== `b`) -> `a/link/link`
    // (== `a`) -> ... forever. Each hop is a *distinct path string*, so only
    // comparing realpaths (not raw path strings) can detect the repeat and
    // stop *descending further* — `visit` itself still fires for every path
    // reached, one hop past where the guard catches the repeat.
    symlinkSync(join(dir, "b"), join(dir, "a", "link"), "dir");
    symlinkSync(join(dir, "a"), join(dir, "b", "link"), "dir");

    const visited: string[] = [];
    walkProjectDirectories(dir, (visitedDir) => visited.push(visitedDir));

    // `root`, `a`, `a/link` (realpath `b`), `a/link/link` (realpath `a`,
    // already visited — recursion stops here) and `b` (reached directly as
    // root's own second child, realpath already visited — recursion stops
    // there too). Five visits total, all distinct *path strings*, covering
    // only three distinct *realpaths*. A missing guard would make this list
    // unbounded instead of exactly these five.
    expect(visited.sort()).toEqual(
      [
        dir,
        join(dir, "a"),
        join(dir, "a", "link"),
        join(dir, "a", "link", "link"),
        join(dir, "b"),
      ].sort(),
    );

    // Proof the guard is load-bearing, not merely lucky: a `visited` set
    // pre-seeded with `a`'s realpath already present stops the walk from
    // descending into `a` at all — `visit(a)` still fires (every reached path
    // is visited), but nothing under it does, since the guard gates
    // recursion, not the visit call itself. `b` is not preseeded, so it is
    // both visited and descended into, reaching `b/link` (realpath `a`,
    // already preseeded, so recursion stops there).
    const preseeded = new Set([realpathSync(join(dir, "a"))]);
    const secondVisit: string[] = [];
    walkProjectDirectories(
      dir,
      (visitedDir) => secondVisit.push(visitedDir),
      preseeded,
    );
    expect(secondVisit.sort()).toEqual(
      [dir, join(dir, "a"), join(dir, "b"), join(dir, "b", "link")].sort(),
    );
  });

  it("excludes node_modules and dotdirectories from the walk", () => {
    const dir = scratch();
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(dir, ".git"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });

    const visited: string[] = [];
    walkProjectDirectories(dir, (visitedDir) => visited.push(visitedDir));

    expect(visited.sort()).toEqual([dir, join(dir, "src")].sort());
  });

  it("stops at a nested package boundary, excluding the boundary directory itself", () => {
    const dir = scratch();
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "nested", "package.json"), '{"name":"nested"}');
    mkdirSync(join(dir, "nested", "tags"), { recursive: true });

    const visited: string[] = [];
    walkProjectDirectories(dir, (visitedDir) => visited.push(visitedDir));

    // `nested/` itself carries the package.json that makes it a boundary, so
    // it is excluded along with everything inside it — only the project root
    // is visited.
    expect(visited).toEqual([dir]);
  });
});

describe("tolerant, cached manifest reads", () => {
  it("recovers from a broken package.json, keeping the previous mx.tags", () => {
    const dir = scratch();
    mkdirSync(join(dir, "shared"), { recursive: true });
    writeFileSync(join(dir, "shared", "widget.tag.ts"), "export default {};\n");
    const packageJson = join(dir, "package.json");
    writeFileSync(
      packageJson,
      JSON.stringify({ name: "manifest-test", mx: { tags: ["shared"] } }),
    );

    const good = scanCustomTags(join(dir, "caller.mx"));
    expect(good.tags.has("widget")).toBe(true);
    expect(good.diagnostics).toHaveLength(0);

    // Break the manifest: an editor mid-save, or a typo.
    touchInFuture(packageJson);
    writeFileSync(packageJson, "{ this is not json");

    const broken = scanCustomTags(join(dir, "caller.mx"));
    // The previous good `mx.tags` stays in force — the file does not go dark
    // because `package.json` is momentarily invalid.
    expect(broken.tags.has("widget")).toBe(true);
    expect(broken.diagnostics).toHaveLength(1);
    expect(broken.diagnostics[0]?.file).toBe(packageJson);
    expect(broken.diagnostics[0]?.message).toContain("could not be parsed");

    // A second *fresh* scan of the same broken revision still carries the
    // diagnostic — `readManifest`'s cache skips re-parsing (the mtime is
    // unchanged), not re-diagnosing: the parse error is a fact about this
    // revision, owed to every `ScanResult` built against it, not just the
    // first one that happened to trigger the parse. (Dedup belongs to
    // `scanCached`'s own outer cache, which short-circuits before
    // `readManifest` runs again at all — see the two-host test below.)
    const brokenAgain = scanCustomTags(join(dir, "caller.mx"));
    expect(brokenAgain.diagnostics).toHaveLength(1);
    expect(brokenAgain.diagnostics[0]?.message).toContain(
      "could not be parsed",
    );

    // Fixing it clears the diagnostic and re-establishes discovery from the
    // new content.
    touchInFuture(packageJson);
    writeFileSync(
      packageJson,
      JSON.stringify({ name: "manifest-test", mx: { tags: ["shared"] } }),
    );
    const fixed = scanCustomTags(join(dir, "caller.mx"));
    expect(fixed.tags.has("widget")).toBe(true);
    expect(fixed.diagnostics).toHaveLength(0);
  });

  it("never throws on a broken manifest", () => {
    const dir = scratch();
    writeFileSync(join(dir, "package.json"), "not json at all");
    expect(() => scanCustomTags(join(dir, "caller.mx"))).not.toThrow();
  });

  it("reports the diagnostic to every host scanning the same broken manifest, not just the first", () => {
    const dir = scratch();
    mkdirSync(join(dir, "shared"), { recursive: true });
    writeFileSync(join(dir, "shared", "widget.tag.ts"), "export default {};\n");
    const packageJson = join(dir, "package.json");
    writeFileSync(
      packageJson,
      JSON.stringify({ name: "two-host-test", mx: { tags: ["shared"] } }),
    );
    writeFileSync(join(dir, "caller.mx"), "<div/>\n");

    // Establish a good cached scan for one host first, so the failure below
    // exercises `readManifest`'s cache-hit path, not its first-parse path.
    scanCached(join(dir, "caller.mx"), { host: "html" });

    touchInFuture(packageJson);
    writeFileSync(packageJson, "{ still not json");

    // Two hosts, two independent `scanCached` entries (the cache key
    // includes `host`) — each is a *fresh* `ScanResult` built against the
    // same broken `package.json` revision, so each must carry its own copy
    // of the diagnostic. Before this fix, `readManifest`'s cache hit
    // returned the cached manifest without re-pushing the diagnostic, so
    // only the first caller to hit the parse error ever saw it.
    const htmlResult = scanCached(join(dir, "caller.mx"), { host: "html" });
    const solidResult = scanCached(join(dir, "caller.mx"), { host: "solid" });

    expect(htmlResult.diagnostics).toHaveLength(1);
    expect(htmlResult.diagnostics[0]?.message).toContain("could not be parsed");
    expect(solidResult.diagnostics).toHaveLength(1);
    expect(solidResult.diagnostics[0]?.message).toContain(
      "could not be parsed",
    );

    // A repeat call for the *same* host is a `scanCached` cache hit (nothing
    // about the directory or the manifest changed), so it returns the exact
    // same `ScanResult` object rather than re-running `readManifest` at all —
    // the diagnostic is still there because it is the same array, not
    // because anything re-pushed into it.
    const htmlAgain = scanCached(join(dir, "caller.mx"), { host: "html" });
    expect(htmlAgain).toBe(htmlResult);
    expect(htmlAgain.diagnostics).toHaveLength(1);

    // Force `scanCached`'s own outer cache to miss (a third host it has
    // never scanned this directory for) while the manifest's mtime stays
    // exactly as broken as before: this exercises `readManifest`'s *own*
    // cache-hit path (mtime unchanged since the last parse) on a genuinely
    // fresh `ScanResult`, and it must still carry the diagnostic — this is
    // the exact case the fix targets.
    const reactResult = scanCached(join(dir, "caller.mx"), { host: "react" });
    expect(reactResult).not.toBe(htmlResult);
    expect(reactResult.diagnostics).toHaveLength(1);
    expect(reactResult.diagnostics[0]?.message).toContain(
      "could not be parsed",
    );
  });
});

describe("normalizeMxTags", () => {
  it("accepts a bare string as one directory", () => {
    expect(normalizeMxTags("shared", "/pkg", "/pkg/package.json")).toEqual([
      { dir: join("/pkg", "shared") },
    ]);
  });

  it("rejects a shape it cannot honor", () => {
    expect(() => normalizeMxTags(42, "/pkg", "/pkg/package.json")).toThrow(
      /`mx\.tags` must be a string or an array/,
    );
    expect(() =>
      normalizeMxTags([{ prefix: "ui-" }], "/pkg", "/pkg/package.json"),
    ).toThrow(/must be a string or an object with a `dir` string/);
  });

  it("rejects a parse option that is not one of the three", () => {
    expect(() =>
      normalizeMxTags(
        [{ dir: "shared", parseOptions: { html: true } }],
        "/pkg",
        "/pkg/package.json",
      ),
    ).toThrow(/is not a parse option/);
  });
});

describe("readParseOptions", () => {
  it("reads an inline default export", () => {
    expect(
      readParseOptions(
        "export default { parseOptions: { text: true } };",
        "a.tag.ts",
      ),
    ).toEqual({ text: true });
  });

  it("follows a module-scope binding to its literal", () => {
    const source = [
      "import type { CustomTag } from '@mxlang/core';",
      "const tag: CustomTag = { parseOptions: { openTagOnly: true } };",
      "export default tag;",
    ].join("\n");

    expect(readParseOptions(source, "a.tag.ts")).toEqual({ openTagOnly: true });
  });

  it("returns undefined for a sidecar that declares none", () => {
    expect(
      readParseOptions("export default { transform: () => [] };", "a.tag.ts"),
    ).toBeUndefined();
  });

  it("rejects a non-boolean option value", () => {
    expect(() =>
      readParseOptions(
        'export default { parseOptions: { text: "yes" } };',
        "a.tag.ts",
      ),
    ).toThrow(/`parseOptions\.text` must be a boolean/);
  });

  it("rejects a spread it cannot read without executing the module", () => {
    expect(() =>
      readParseOptions(
        "const base = { text: true };\nexport default { parseOptions: { ...base } };",
        "a.tag.ts",
      ),
    ).toThrow(/spread or computed key/);
  });

  it("reports a file it cannot parse at that file's own position", () => {
    let error: unknown;
    try {
      readParseOptions("export default { parseOptions: {", "a.tag.ts");
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(TranslateError);
    expect((error as Error).message).toContain("could not be parsed");
  });
});

describe("the scan cache", () => {
  it("returns one map object while the tag set is unchanged", () => {
    const first = getCustomTags(fixture("parse-options", "caller.mx"));
    const second = getCustomTags(fixture("parse-options", "caller.mx"));

    // Identity, not just equality: Marko keys its taglib cache on the id this
    // map's contents derive, so a new object per compile is the leak.
    expect(second).toBe(first);
  });

  it("does not grow the live map count across repeated compiles", () => {
    clearScanCache();
    for (let index = 0; index < 50; index++) {
      getCustomTags(fixture("parse-options", `caller${index}.mx`));
    }

    // One tag set was scanned, so exactly one map is live regardless of how
    // many files were compiled against it.
    expect(liveTagMapCount()).toBe(1);
  });

  it("invalidates when a tag file's contents change", () => {
    const dir = scratch();
    mkdirSync(join(dir, "tags"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"edited"}');
    const tagFile = join(dir, "tags", "thing.tag.ts");
    writeFileSync(
      tagFile,
      "export default { parseOptions: { text: true } };\n",
    );

    const before = getCustomTags(join(dir, "caller.mx"));
    expect(before.thing?.parseOptions).toEqual({ text: true });

    // A different mtime is what an editor's save produces; write one
    // explicitly so the test does not depend on the clock's resolution.
    writeFileSync(
      tagFile,
      "export default { parseOptions: { text: false } };\n",
    );
    touchInFuture(tagFile);

    const after = getCustomTags(join(dir, "caller.mx"));
    expect(after.thing?.parseOptions).toEqual({ text: false });
  });

  it("invalidates when a tag file is added to a scanned directory", () => {
    const dir = scratch();
    mkdirSync(join(dir, "tags"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"added"}');
    writeFileSync(join(dir, "tags", "one.mx"), "<div/>\n");

    expect(Object.keys(getCustomTags(join(dir, "caller.mx")))).toEqual(["one"]);

    writeFileSync(join(dir, "tags", "two.mx"), "<p/>\n");
    expect(Object.keys(getCustomTags(join(dir, "caller.mx"))).sort()).toEqual([
      "one",
      "two",
    ]);
  });

  it("invalidates when a tag file is removed", () => {
    const dir = scratch();
    mkdirSync(join(dir, "tags"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"removed"}');
    writeFileSync(join(dir, "tags", "one.mx"), "<div/>\n");
    writeFileSync(join(dir, "tags", "two.mx"), "<p/>\n");

    expect(Object.keys(getCustomTags(join(dir, "caller.mx"))).sort()).toEqual([
      "one",
      "two",
    ]);

    rmSync(join(dir, "tags", "two.mx"));
    expect(Object.keys(getCustomTags(join(dir, "caller.mx")))).toEqual(["one"]);
  });

  it("invalidates when package.json#mx.tags changes", () => {
    const dir = scratch();
    mkdirSync(join(dir, "shared"), { recursive: true });
    writeFileSync(join(dir, "shared", "extra.mx"), "<div/>\n");
    const manifest = join(dir, "package.json");
    writeFileSync(manifest, '{"name":"config"}');

    expect(Object.keys(getCustomTags(join(dir, "caller.mx")))).toEqual([]);

    writeFileSync(manifest, '{"name":"config","mx":{"tags":"shared"}}');
    touchInFuture(manifest);

    expect(Object.keys(getCustomTags(join(dir, "caller.mx")))).toEqual([
      "extra",
    ]);
  });

  it("records the evidence an integration needs for its own watcher", () => {
    const result = scanCached(fixture("parse-options", "caller.mx"));

    expect(result.directories).toContain(fixture("parse-options", "tags"));
    expect(result.packageFiles).toContain(
      fixture("parse-options", "package.json"),
    );
    expect(result.files.map((file) => file.path)).toContain(
      fixture("parse-options", "tags", "raw.tag.ts"),
    );
  });

  it("mints one Marko taglib id across many compiles of one tag set", () => {
    // The P1 review's deferred item. `@marko/compiler` keys
    // `loadedTranslatorsTaglibs` on the translator object and `lookupCache` on
    // the sorted taglib ids, and evicts neither, so a long-lived process that
    // minted a fresh id per compile would grow without bound. Those caches are
    // module-closure state with no public accessor, so the invariant is
    // asserted where MX actually controls it: the id MX hands the compiler.
    clearScanCache();
    const ids = new Set<string>();
    for (let index = 0; index < 50; index++) {
      const entry = customTagTaglib(
        getCustomTags(fixture("parse-options", `caller${index}.mx`)),
      );
      if (entry) ids.add(entry[0]);
    }

    expect(ids.size).toBe(1);
    expect(liveTagMapCount()).toBe(1);
  });

  it("mints a different taglib id once the tag set changes", () => {
    // The other half: an id that never changed would be a correctness bug,
    // reusing one lookup for two different tag sets.
    const dir = scratch();
    mkdirSync(join(dir, "tags"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"changing"}');
    writeFileSync(join(dir, "tags", "one.mx"), "<div/>\n");

    const before = customTagTaglib(getCustomTags(join(dir, "caller.mx")))?.[0];

    writeFileSync(join(dir, "tags", "two.mx"), "<p/>\n");
    const after = customTagTaglib(getCustomTags(join(dir, "caller.mx")))?.[0];

    expect(before).toBeDefined();
    expect(after).not.toBe(before);
  });
});

describe("a discovered template tag routes as a unit", () => {
  afterEach(() => {
    clearScanCache();
  });

  /**
   * The P2/P3 seam: a `tags/icon.mx` beside a caller, with **no import, no
   * sidecar and no `customTags` argument**, has to reach the caller as a real
   * template tag and be imported. This asserts discovery and lowering
   * together rather than either half.
   */
  it("resolves `tags/icon.mx` with no authored import and injects one", () => {
    const file = fixture("template-render", "page.mx");
    const customTags = getCustomTags(file);

    // Discovered by filename alone.
    expect(Object.keys(customTags)).toContain("icon");

    let ir: Ir | null = null;
    compileSource(readFileSync(file, "utf8"), file, declarations(), {
      customTags,
      tagDiscoveryDirs: [],
      emitIr(lowered) {
        ir = lowered;
        return "";
      },
    });
    if (!ir) throw new Error("lowerer produced no IR");

    expect((ir as Ir).imports).toHaveLength(1);
    expect((ir as Ir).imports[0]?.code).toContain("./tags/icon.mx");

    const names = flattenElements((ir as Ir).body);
    expect(names).toEqual(["p"]);
    expect((ir as Ir).body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "Element", name: "p" }),
      ]),
    );
  });
});

/** A permissive host: this file is testing discovery, not any host's policy. */
function declarations(): Policy {
  return {
    tags: {},
    isElement: () => true,
    isComponent: (name, ctx) => ctx.defines.has(name),
  };
}

function walk(nodes: IrNode[], visit: (node: IrNode) => void): void {
  for (const node of nodes) {
    visit(node);
    if ("children" in node && Array.isArray(node.children)) {
      walk(node.children as IrNode[], visit);
    }
    if (node.kind === "IfChain") {
      for (const branch of node.branches) walk(branch.children, visit);
    }
  }
}

function flattenElements(nodes: IrNode[]): string[] {
  const names: string[] = [];
  walk(nodes, (node) => {
    if (node.kind === "Element") names.push(node.name);
  });
  return names;
}
