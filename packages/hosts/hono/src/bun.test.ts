import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import honoPlugin from "./bun.ts";

/**
 * Runs under `bun test`, not vitest: it exercises `Bun.plugin` and Bun's
 * dynamic `import()` of a `.mx` module, both Bun-runtime-only — the same
 * shape as `@mxlang/html`'s own `bun.test.ts`.
 */
describe("@mxlang/hono/bun", () => {
  test("compiles a tag discovered beside the file, with no import", async () => {
    Bun.plugin(honoPlugin);

    // Through the real plugin, so the loader's own `getCustomTags` call is
    // what is under test: deleting it from `bun.ts` must fail this. A test
    // that called `compileHonoMx()` with a tag map it fetched itself would
    // stay green with the loader gutted.
    //
    // Inside the package tree, because the emitted module imports from
    // `hono/jsx` by bare specifier, which Bun resolves from the file's own
    // directory.
    const base = join(import.meta.dirname, "..");
    const tagsDir = join(base, "tags");
    const tagFile = join(tagsDir, "honostamp.tag.ts");
    const page = join(base, "bun-discovery.mx");

    mkdirSync(tagsDir, { recursive: true });
    writeFileSync(
      tagFile,
      "export default { transform: (_c, ctx) => [ctx.build.element('b', [], [ctx.build.text('discovered')])] };\n",
    );
    writeFileSync(page, "<honostamp/>\n");
    try {
      const mod = await import(page);
      const render = mod.default as (input: unknown) => unknown;
      expect(String(render({}))).toContain("discovered");
    } finally {
      rmSync(page, { force: true });
      rmSync(tagsDir, { recursive: true, force: true });
    }
  });

  test("resolves a discovered template tag's injected import", async () => {
    Bun.plugin(honoPlugin);

    // The unit-model path, distinct from the sidecar test above: a *template*
    // tag compiles to its own module and the caller emits an import of it.
    // This asserts the loader resolves that injected import for real —
    // `tags/hicon.mx` has to be found, compiled and imported, or the page
    // module fails to load rather than merely rendering the wrong thing.
    const base = join(import.meta.dirname, "..");
    const tagsDir = join(base, "tags");
    const tagFile = join(tagsDir, "hicon.mx");
    const page = join(base, "bun-template-page.mx");

    mkdirSync(tagsDir, { recursive: true });
    writeFileSync(
      tagFile,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax, not a JS template
      '<span class="icon">${input.name}</span>\n',
    );
    writeFileSync(page, '<div><hicon name="star"/></div>\n');
    try {
      const mod = await import(page);
      const render = mod.default as (input: unknown) => unknown;
      const html = String(render({}));
      expect(html).toContain("star");
      expect(html).toContain('class="icon"');
    } finally {
      rmSync(page, { force: true });
      rmSync(tagsDir, { recursive: true, force: true });
    }
  });

  test("a tag whose mx.tags entry excludes this host is not discovered", async () => {
    Bun.plugin(honoPlugin);

    // Through the real plugin's own `getCustomTags(path, { host: "hono" })`
    // call: a `package.json#mx.tags` entry declaring `hosts: ["solid"]`
    // must be invisible from the hono loader, which is decision 110(a). A
    // nested package.json under the package root, so the upward walk stops
    // there rather than reaching the package's own.
    const base = join(import.meta.dirname, "..");
    const pkgDir = join(base, "hosts-fixture");
    const tagsDir = join(pkgDir, "widgets");
    const page = join(pkgDir, "bun-hosts.mx");

    mkdirSync(tagsDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "hono-hosts-fixture",
        mx: { tags: [{ dir: "widgets", hosts: ["solid"] }] },
      }),
    );
    writeFileSync(
      join(tagsDir, "gizmo.tag.ts"),
      "export default { transform: (_c, ctx) => [ctx.build.element('b', [], [ctx.build.text('nope')])] };\n",
    );
    writeFileSync(page, "<gizmo/>\n");
    try {
      // Unlike the html translator, an unresolved lowercase name doesn't
      // fail to parse on a JSX host — it falls through to a literal DOM-ish
      // element. So the discovery gap surfaces as the tag's own transform
      // never running, not as a compile error: the excluded tag's
      // "nope" output must not appear.
      const mod = await import(page);
      const render = mod.default as (input: unknown) => unknown;
      expect(String(render({}))).not.toContain("nope");
    } finally {
      rmSync(pkgDir, { recursive: true, force: true });
    }
  });

  test("an own-only lookup leaves an unmatched mx.tags host unresolved without warning", async () => {
    Bun.plugin(honoPlugin);

    // PR 3 round-2 ruling: only a full registry can validate host names.
    // Filtering and other scan diagnostics remain active with an own lookup.
    const base = join(import.meta.dirname, "..");
    const pkgDir = join(base, "hosts-warning-fixture");
    const tagsDir = join(pkgDir, "widgets");
    const page = join(pkgDir, "bun-hosts-warning.mx");

    mkdirSync(tagsDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "hono-hosts-warning-fixture",
        mx: { tags: [{ dir: "widgets", hosts: ["bogus"] }] },
      }),
    );
    writeFileSync(
      join(tagsDir, "gizmo.tag.ts"),
      "export default { transform: (_c, ctx) => [ctx.build.element('b', [], [ctx.build.text('nope')])] };\n",
    );
    writeFileSync(page, "<div>no call</div>\n");

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await import(page);
      expect(
        warn.mock.calls.some((call) => String(call[0]).includes("bogus")),
      ).toBe(false);
    } finally {
      warn.mockRestore();
      rmSync(pkgDir, { recursive: true, force: true });
    }
  });

  test("does not claim a .astro.mx path", async () => {
    Bun.plugin(honoPlugin);

    // Astro's template kind (decision 134): an Astro component, lowered by
    // `@mxlang/astro`. It ends in `.mx` but is not an MX page, and this
    // source would fail the string translator. Bun's default loader returns
    // the file's own path as the default export when no onLoad hook claims it.
    const dir = mkdtempSync(join(tmpdir(), "mxlang-hono-bun-astro-"));
    const path = join(dir, "Card.astro.mx");
    writeFileSync(path, "---\nconst a = 1;\n---\n<p>{a}</p>\n");

    const mod = await import(path);
    expect(mod.default).toEndWith("Card.astro.mx");
  });

  test("does not claim a .solid.mx path", async () => {
    Bun.plugin(honoPlugin);

    // A different file kind (TSX with MX regions), handled by the Vite
    // plugin. Bun's default loader for an unrecognized extension returns the
    // file's own path as the module's default export, which is what "the
    // onLoad hook declined this path" looks like from the caller's side.
    const dir = mkdtempSync(join(tmpdir(), "mxlang-hono-bun-solid-"));
    const path = join(dir, "Counter.solid.mx");
    writeFileSync(
      path,
      "export function Counter() {\n  return <button>Count</button>;\n}\n",
    );

    const mod = await import(path);
    expect(mod.default).toEndWith("Counter.solid.mx");
  });

  test("a dotted tag file name is rejected, not indexed (decision 137)", async () => {
    Bun.plugin(honoPlugin);

    // The loader is a direct entry: it resolves its targets from this
    // package's own descriptor unless a caller passes a lookup, so a file
    // kind of *another* host is not one it knows. Either way the file is
    // rejected — through the second diagnostic, which says why it cannot be
    // called and names the tag the shorthand form would resolve to.
    const base = join(import.meta.dirname, "..");
    const pkgDir = join(base, "dotted-fixture");
    const tagsDir = join(pkgDir, "tags");
    mkdirSync(tagsDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "hono-dotted-fixture" }),
    );
    // A foreign host's file kind, and a name no host declares at all.
    writeFileSync(join(tagsDir, "x.ng.mx"), "<span>x</span>\n");
    writeFileSync(join(tagsDir, "icon.small.mx"), "<span>icon</span>\n");
    const page = join(pkgDir, "dotted-page.mx");
    writeFileSync(page, "<div>no call</div>\n");

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await import(page);
      const warned = warn.mock.calls.map((call) => String(call[0]));
      // Neither file is indexed: calling `<x.ng>` is impossible, and the
      // diagnostic says so with the tag it would parse as.
      expect(
        warned.some((message) =>
          message.includes(
            "`x.ng.mx` cannot be called as a tag: `<x.ng>` parses as tag `x` with class `ng`.",
          ),
        ),
      ).toBe(true);
      expect(
        warned.some((message) =>
          message.includes(
            "`icon.small.mx` cannot be called as a tag: `<icon.small>` parses as tag `icon` with class `small`.",
          ),
        ),
      ).toBe(true);
      expect(
        warned.some((message) => /is a host module file/.test(message)),
      ).toBe(false);
    } finally {
      warn.mockRestore();
      rmSync(pkgDir, { recursive: true, force: true });
    }
  });
});
