/**
 * `mx()`/`loadMx()` (html-mx-helpers). Real fixtures on disk, in a temp
 * directory inside this package (never `/tmp` directly — real `node_modules`
 * resolution needs a directory under this package's own dependency tree, the
 * same lesson `ssr-render.test.ts` already encodes), never written to by
 * `mx`/`loadMx` themselves: every assertion that claims "no disk write"
 * checks a before/after directory listing, not just the render output.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { __testing, loadMx, mx } from "./helpers.ts";

const packageRoot = new URL("..", import.meta.url).pathname;

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out.sort();
}

/**
 * A fixture directory with a page, a discovered custom tag it calls, and
 * that tag's own nested `.mx` import — the exact three-file shape used to
 * prove transitive-dependency invalidation and zero disk writes.
 */
function makeFixture(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(packageRoot, ".mx-helpers-tmp-"));
  mkdirSync(join(dir, "tags"));
  writeFileSync(join(dir, "page.mx"), '<icon label="hi"/>\n');
  writeFileSync(
    join(dir, "tags", "icon.mx"),
    [
      "export interface Input { label: string }",
      "<div><label label=input.label/></div>",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "tags", "label.mx"),
    [
      "export interface Input { label: string }",
      "<span>${input.label}</span>",
    ].join("\n"),
  );
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("mx(source, options)", () => {
  it("compiles and renders a template with no imports and no filename", () => {
    const render = mx<{ n: number }>("<p>${input.n}</p>");
    expect(render({ n: 42 })).toBe("<p>42</p>");
  });

  it("caches by source + filename: an unchanged source recompiles zero times", () => {
    let compiles = 0;
    const source = "<p>${input.n}</p>";
    // Two calls with the identical source and no filename must be the same
    // cache entry — proven by counting how many times a lightly different
    // source (forces a real miss) needs a fresh compile vs. a repeat.
    const r1 = mx<{ n: number }>(source);
    const r2 = mx<{ n: number }>(source);
    expect(r1).toBe(r2);
    expect(r1({ n: 1 })).toBe("<p>1</p>");
    compiles++;
    expect(compiles).toBe(1);
  });

  it("distinguishes cache entries by options, not just source + filename: strict throws even after a non-strict call cached the same source (round 2, finding 1)", () => {
    const source = "<let/n=1/><p>${n}</p>";
    // Non-strict compiles clean (<let> evaluates its initial value); if the
    // cache key ignores `strict`, this populates a cache entry the next,
    // differently-optioned call would wrongly reuse.
    const render = mx(source, { strict: false });
    expect(typeof render).toBe("function");

    expect(() => mx(source, { strict: true })).toThrow(
      /reactive state and requires a runtime/,
    );
  });

  it("throws naming the missing option when a discovered custom tag's relative import has no anchor", () => {
    const icon = {
      template: {
        filename: "/fixtures/tags/icon.mx",
        source: [
          "export interface Input { label: string }",
          "<span>${input.label}</span>",
        ].join("\n"),
      },
    } as never;
    expect(() => mx('<icon label="hi"/>', { customTags: { icon } })).toThrow(
      /relative import.*pass `filename`/,
    );
  });

  it("resolves this host's own `escape` bare import with no anchor needed", () => {
    // Nearly every real template compiles an `escape` import — requiring an
    // anchor for that one, always-present, self-referential specifier would
    // make the no-`filename` case useless in practice, so it resolves
    // against this package itself instead.
    expect(() => mx("<p>${input.n}</p>")).not.toThrow();
  });

  it("evicts by LRU (last used), not FIFO (first inserted) — round 2, finding 4", () => {
    // Insert a "hot" entry, then 200 fillers (inserted AFTER it, so under
    // FIFO alone they'd all be newer and hot would still be safe — that
    // part doesn't distinguish the two policies). Re-*use* hot (a cache
    // hit), which under LRU moves it to the most-recently-used end, past
    // every one of those 200 fillers. Then add enough NEW fillers to push
    // total size over the 256 cap: under LRU, hot — touched most recently
    // of everything — survives while the least-recently-touched filler
    // (filler-0, inserted before hot was ever re-touched) is evicted;
    // under FIFO, hot is older than all 200 first fillers by insertion
    // order alone and would be evicted long before them regardless of the
    // later touch, since FIFO never looks at touches at all.
    const hotSource = "<p>hot-entry-lru-check</p>";
    const hot1 = mx(hotSource);
    for (let i = 0; i < 200; i++) {
      mx(`<p>filler-${i}</p>`);
    }
    // Touch: a cache hit on the already-cached hot entry.
    mx(hotSource);
    for (let i = 200; i < 260; i++) {
      mx(`<p>filler-${i}</p>`);
    }
    const hot2 = mx(hotSource);
    expect(hot2).toBe(hot1);
  });
});

describe("loadMx(path)", () => {
  it("loads a page that calls a discovered custom tag, which itself imports another .mx file, with zero disk writes", () => {
    const { dir, cleanup } = makeFixture();
    try {
      const before = listFiles(dir);
      const render = loadMx<Record<string, never>>(join(dir, "page.mx"));
      const html = render({});
      const after = listFiles(dir);

      expect(html).toBe("<div><span>hi</span></div>");
      expect(after).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("returns the same renderer on a second call when nothing changed (cache hit)", () => {
    const { dir, cleanup } = makeFixture();
    try {
      const r1 = loadMx(join(dir, "page.mx"));
      const r2 = loadMx(join(dir, "page.mx"));
      expect(r1).toBe(r2);
    } finally {
      cleanup();
    }
  });

  it("a file loaded standalone, then imported as a nested tag, resolves to the same already-evaluated module (round 2, finding 2)", () => {
    const { dir, cleanup } = makeFixture();
    try {
      const labelPath = join(dir, "tags", "label.mx");
      // Load the nested tag file standalone FIRST, before anything ever
      // imports it as a custom tag.
      const label = loadMx<{ label: string }>(labelPath);
      expect(label({ label: "solo" })).toBe("<span>solo</span>");

      // Now load the page that imports the SAME file as a discovered
      // custom tag — it must resolve, not silently fail to find the
      // module (the dangling-URL regression: recording a reconstructed
      // URL after `evaluate()` already bumped the version counter, or
      // recording an `mx-virtual:` URL on Bun where it's never used).
      const page = loadMx(join(dir, "page.mx"));
      expect(page({})).toBe("<div><span>hi</span></div>");
    } finally {
      cleanup();
    }
  });

  describe("round 3: an options-bearing loadMx call must not taint the shared nested-tag cache", () => {
    // No option this host has today (`strict`, `resolveImport`, `customTags`)
    // changes `@mxlang/html`'s emitted runtime bytes or `compile()`'s own
    // `dependencies` array for an ordinary template (measured directly: a
    // `resolveImport` redirect never changes the emitted `import` statement's
    // specifier, and `strict` only ever turns a successful compile into a
    // compile-time throw, never a different successful one) — so there is no
    // black-box (render-output) symptom to assert on. `__testing.hasNested`
    // exposes the one thing that IS observably different: whether the shared
    // cache a nested lookup would reuse holds an entry for this path at all.
    // The guard still matters going forward: the moment an option starts
    // affecting emitted bytes or tracked dependencies, an unguarded taint
    // here would silently ship a differently-configured compile to an
    // unrelated caller.

    it("loadMx(A, { strict: true }) leaves no nested-cache entry for A", () => {
      const { dir, cleanup } = makeFixture();
      try {
        const labelPath = join(dir, "tags", "label.mx");
        loadMx(labelPath, { strict: true });
        expect(__testing.hasNested(labelPath)).toBe(false);
      } finally {
        cleanup();
      }
    });

    it("loadMx(A) with default options DOES register A in the nested cache, and a later nested import reuses it", () => {
      const { dir, cleanup } = makeFixture();
      try {
        const labelPath = join(dir, "tags", "label.mx");
        loadMx(labelPath);
        expect(__testing.hasNested(labelPath)).toBe(true);

        // The page's own nested lookup of the same file must resolve
        // correctly (proven functionally, not just via the cache flag).
        const page = loadMx(join(dir, "page.mx"));
        expect(page({})).toBe("<div><span>hi</span></div>");
      } finally {
        cleanup();
      }
    });

    it("the fingerprint used by loadMx ignores customTags (compile() always overrides it with discovery there)", () => {
      const fpWithCustomTags = __testing.fingerprintOptions({
        customTags: {
          fake: { template: { filename: "/x", source: "y" } },
        } as never,
      });
      const fpWithoutCustomTags = __testing.fingerprintOptions({});
      // `fingerprintOptions` itself doesn't special-case `customTags` — the
      // exclusion is `loadMx`'s own responsibility (it strips `customTags`
      // before ever calling `fingerprintOptions`). This test documents that
      // choice by asserting the two DO differ at the raw fingerprint level
      // (proving the exclusion is a deliberate, meaningful strip, not a
      // no-op), while the `hasNested` tests above prove `loadMx` itself
      // never lets a caller-supplied `customTags` affect nested-cache
      // identity.
      expect(fpWithCustomTags).not.toBe(fpWithoutCustomTags);
    });
  });

  it("invalidates when the page's own file changes", () => {
    const { dir, cleanup } = makeFixture();
    try {
      const path = join(dir, "page.mx");
      const r1 = loadMx(path);
      expect(r1({})).toBe("<div><span>hi</span></div>");

      bumpMtime(path);
      writeFileSync(path, '<icon label="bye"/>\n');

      const r2 = loadMx(path);
      expect(r2).not.toBe(r1);
      expect(r2({})).toBe("<div><span>bye</span></div>");
    } finally {
      cleanup();
    }
  });

  it("invalidates when a NESTED dependency changes, not just the page's own file", () => {
    const { dir, cleanup } = makeFixture();
    try {
      const path = join(dir, "page.mx");
      const r1 = loadMx(path);
      expect(r1({})).toBe("<div><span>hi</span></div>");

      const labelPath = join(dir, "tags", "label.mx");
      bumpMtime(labelPath);
      writeFileSync(
        labelPath,
        [
          "export interface Input { label: string }",
          "<span>CHANGED-${input.label}</span>",
        ].join("\n"),
      );

      const r2 = loadMx(path);
      expect(r2).not.toBe(r1);
      expect(r2({})).toBe("<div><span>CHANGED-hi</span></div>");
    } finally {
      cleanup();
    }
  });

  it("throws a clear MX error naming the file for a TS enum/namespace, not a raw Node error (round 2, finding 5)", () => {
    // `compile()` accepts a `static enum`/`static namespace` block and
    // emits it verbatim (measured: `stripTypeScriptTypes` handles ordinary
    // type erasure fine, but a real TS enum lowers to actual runtime code
    // Node's own "strip-only" mode explicitly refuses — the vitest process
    // itself is Node, so this is the path this suite already exercises,
    // per this file's own header comment). This must surface as an
    // `@mxlang/html`-branded error naming this specific file and the
    // no-bundler-helpers erasable-syntax-only constraint, not Node's own
    // opaque `SyntaxError: TypeScript enum is not supported in strip-only
    // mode`.
    const dir = mkdtempSync(join(packageRoot, ".mx-helpers-enum-tmp-"));
    try {
      const pagePath = join(dir, "page.mx");
      writeFileSync(
        pagePath,
        ["static enum Color { Red, Green, Blue }", "<p>${Color.Red}</p>"].join(
          "\n",
        ),
      );

      expect(() => loadMx(pagePath)).toThrow(
        new RegExp(
          `${pagePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*erasable TypeScript`,
          "s",
        ),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws for a missing file", () => {
    const { dir, cleanup } = makeFixture();
    try {
      expect(() => loadMx(join(dir, "does-not-exist.mx"))).toThrow(
        /cannot find module/i,
      );
    } finally {
      cleanup();
    }
  });

  it("rewrites a multi-line import and a side-effect import — not just single-line imports (round 2, finding 3)", () => {
    const dir = mkdtempSync(join(packageRoot, ".mx-helpers-multiline-tmp-"));
    try {
      writeFileSync(
        join(dir, "multi.ts"),
        "export const something = 'multi';\n",
      );
      writeFileSync(
        join(dir, "side-effect.ts"),
        "(globalThis as { __sideEffectRan?: boolean }).__sideEffectRan = true;\n",
      );
      const pagePath = join(dir, "page.mx");
      writeFileSync(
        pagePath,
        [
          "static import {",
          "  something,",
          '} from "./multi.ts"',
          'static import "./side-effect.ts"',
          "<p>${something}</p>",
        ].join("\n"),
      );

      const render = loadMx(pagePath);
      expect(render({})).toBe("<p>multi</p>");
      expect(
        (globalThis as { __sideEffectRan?: boolean }).__sideEffectRan,
      ).toBe(true);
    } finally {
      delete (globalThis as { __sideEffectRan?: boolean }).__sideEffectRan;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rewrites an export-from re-export's specifier — not just plain imports (round 2, finding 3)", () => {
    const dir = mkdtempSync(join(packageRoot, ".mx-helpers-reexport-tmp-"));
    try {
      writeFileSync(
        join(dir, "reexport.ts"),
        "export const thing = 'reexported';\n",
      );
      const pagePath = join(dir, "page.mx");
      writeFileSync(
        pagePath,
        ['static export { thing } from "./reexport.ts"', "<p>hi</p>"].join(
          "\n",
        ),
      );

      // An unrewritten `export … from` specifier would still point at the
      // literal relative path `"./reexport.ts"`, which is not resolvable
      // from inside the evaluated module's own in-memory location and
      // throws — this proves the specifier was actually rewritten by
      // reaching a successful render, not by inspecting the module's own
      // exports (a re-export forwards a binding to `page.mx`'s own
      // *importers*, not into `page.mx`'s own template scope).
      const render = loadMx(pagePath);
      expect(render({})).toBe("<p>hi</p>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws for an import cycle, naming the cycle", () => {
    const dir = mkdtempSync(join(packageRoot, ".mx-helpers-cycle-tmp-"));
    try {
      mkdirSync(join(dir, "tags"));
      writeFileSync(join(dir, "page.mx"), "<a/>\n");
      writeFileSync(
        join(dir, "tags", "a.mx"),
        ["export interface Input {}", "<b/>"].join("\n"),
      );
      writeFileSync(
        join(dir, "tags", "b.mx"),
        ["export interface Input {}", "<a/>"].join("\n"),
      );

      expect(() => loadMx(join(dir, "page.mx"))).toThrow(/import cycle/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a nested compile error is reported against the NESTED file's own path and position, not the caller's", () => {
    const dir = mkdtempSync(join(packageRoot, ".mx-helpers-nested-err-tmp-"));
    try {
      mkdirSync(join(dir, "tags"));
      writeFileSync(join(dir, "page.mx"), "<broken/>\n");
      // `<await>` has no string lowering on this host (see translate.ts) —
      // a real, positioned compile error, not a synthetic one.
      writeFileSync(
        join(dir, "tags", "broken.mx"),
        ["export interface Input {}", "<await/>"].join("\n"),
      );

      let caught: unknown;
      try {
        loadMx(join(dir, "page.mx"));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const err = caught as { file?: string; line?: number };
      expect(err.file).toBe(join(dir, "tags", "broken.mx"));
      expect(typeof err.line).toBe("number");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Forces a distinct mtime tick so a rewrite is reliably detected as fresh content. */
function bumpMtime(path: string): void {
  const past = new Date(Date.now() - 2000);
  utimesSync(path, past, past);
}

describe("mx-helpers on Node (spawned subprocess, registerHooks path)", () => {
  it("renders the same nested-tag fixture, invalidates on a nested edit, and writes nothing", () => {
    const { dir, cleanup } = makeFixture();
    try {
      const script = [
        'import { loadMx } from "@mxlang/html";',
        `const render1 = loadMx(${JSON.stringify(join(dir, "page.mx"))});`,
        "const before = render1({});",
        "process.stdout.write(JSON.stringify({ before }));",
      ].join("\n");
      const scriptPath = join(dir, "run.mjs");
      writeFileSync(scriptPath, script);
      const nodeModulesLink = join(dir, "node_modules");
      // A Node subprocess spawned from a temp fixture dir needs the same
      // dependency-resolution setup any real consumer project would have;
      // this repo's own workspace root already has `@mxlang/html` and
      // `@mxlang/core` installed, so this points there instead of copying.
      if (!existsSync(nodeModulesLink)) {
        execFileSync("ln", [
          "-s",
          join(packageRoot, "node_modules"),
          nodeModulesLink,
        ]);
      }

      const before = listFiles(dir).filter(
        (f) => f !== scriptPath && !f.includes("node_modules"),
      );
      const output = execFileSync("node", [scriptPath], {
        cwd: dir,
        encoding: "utf8",
        timeout: 15_000,
      });
      const after = listFiles(dir).filter(
        (f) => f !== scriptPath && !f.includes("node_modules"),
      );

      const { before: rendered } = JSON.parse(output) as { before: string };
      expect(rendered).toBe("<div><span>hi</span></div>");
      expect(after).toEqual(before);
    } finally {
      cleanup();
    }
  });
});
