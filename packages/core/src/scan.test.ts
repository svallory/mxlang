import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
import { normalizeMxTags, readParseOptions, scanCustomTags } from "./scan.ts";
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
    expect(() => scanCustomTags(join(dir, "caller.mx"))).toThrow(
      /tag templates are `\.mx`; `\.solid\.mx` is not supported as a tag/,
    );
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
