import { describe, expect, spyOn, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTargetLookup, type TargetDescriptor } from "@mxlang/core";
import markoPlugin, { mxFilter } from "./bun.ts";
import { htmlTargets } from "./index.ts";

/**
 * Makes `@mxlang/html` resolvable from a fixture that declares its own
 * `package.json`, which otherwise ends the self-reference lookup that lets a
 * file inside this package import the package by name. Every compiled module
 * imports the runtime (`createOut`, decision 155), so a real consumer has the
 * package installed; this stands in for that install.
 */
function linkRuntime(pkgDir: string): void {
  mkdirSync(join(pkgDir, "node_modules", "@mxlang"), { recursive: true });
  symlinkSync(
    join(import.meta.dirname, ".."),
    join(pkgDir, "node_modules", "@mxlang", "html"),
  );
}

/**
 * Runs under `bun test`, not vitest: it exercises `Bun.plugin` and Bun's
 * dynamic `import()` of a `.mx` module, both Bun-runtime-only.
 */
describe("@mxlang/html/bun", () => {
  test("does not claim a .marko path", async () => {
    Bun.plugin(markoPlugin);

    // MX only supports the MX 1.0 subset of Marko syntax, so a real .marko
    // file is not treated as MX by this loader — even one of this host's
    // own oracle fixtures, which stays a real .marko file on disk. Bun's
    // default loader for an unrecognized extension returns the file's own
    // path as the module's default export, not a compiled function -
    // exactly what "the onLoad hook declined this path" looks like from the
    // caller's side.
    const fixtureDir = join(
      import.meta.dirname,
      "..",
      "fixtures-marko",
      "attributes",
    );
    const path = join(fixtureDir, "input.marko");

    const mod = await import(path);
    expect(mod.default).toEndWith("input.marko");
  });

  test("Bun.plugin claims .mx, the only extension this loader accepts", async () => {
    Bun.plugin(markoPlugin);

    const fixtureDir = join(
      import.meta.dirname,
      "..",
      "fixtures-marko",
      "attributes",
    );
    const input = JSON.parse(
      readFileSync(join(fixtureDir, "input.json"), "utf8"),
    ) as { value: string };
    const source = readFileSync(join(fixtureDir, "input.marko"), "utf8");

    // Written alongside input.marko, not a bare tmpdir: the emitted module
    // imports `escape` from "@mxlang/html" by bare specifier, which
    // Bun resolves via node_modules lookup from the file's own directory —
    // a tmpdir outside the package tree can't resolve it.
    const path = join(fixtureDir, "input.mx");
    writeFileSync(path, source);
    try {
      const mod = await import(path);
      const render = mod.default as (input: unknown) => string;
      expect(render(input)).toContain(input.value);
    } finally {
      rmSync(path);
    }
  });

  // Decision 155: the default export keeps `(input) => string`, and the sink
  // entry is reachable both as `X.render` and as the named `render` export.
  test("a loaded .mx module exposes render(input, out) beside its default export", async () => {
    Bun.plugin(markoPlugin);

    // Inside the package tree, for the same bare-specifier reason as above.
    const dir = mkdtempSync(join(import.meta.dirname, ".render-sink-"));
    const path = join(dir, "counter.mx");
    writeFileSync(
      path,
      [
        "export interface Input { start: number }",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
        "<span>${input.start}</span>",
        "<return=input.start + 1/>",
        "",
      ].join("\n"),
    );
    try {
      const mod = await import(path);
      const { createOut } = await import("./runtime.ts");
      expect(mod.default({ start: 1 })).toBe("<span>1</span>");
      expect(mod.default.render).toBe(mod.render);
      const out = createOut();
      expect(mod.default.render({ start: 2 }, out)).toBe(3);
      expect(out.toString()).toBe("<span>2</span>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not claim a .astro.mx path", async () => {
    Bun.plugin(markoPlugin);

    // Astro's template kind (decision 134): an Astro component, lowered by
    // `@mxlang/astro`. It ends in `.mx` but is not an MX page, and this
    // source would fail the string translator. Bun's default loader returns
    // the file's own path as the default export when no onLoad hook claims it.
    const dir = mkdtempSync(join(tmpdir(), "mxlang-translator-bun-astro-"));
    const path = join(dir, "Card.astro.mx");
    writeFileSync(path, "---\nconst a = 1;\n---\n<p>{a}</p>\n");

    const mod = await import(path);
    expect(mod.default).toEndWith("Card.astro.mx");
  });

  test("does not claim a .react.mx path", async () => {
    Bun.plugin(markoPlugin);

    // A `.react.mx` is TSX with MX regions (`@mxlang/react`'s file kind),
    // compiled by the Vite plugin; claimed here it would be translated as a
    // whole-file `.mx`. Declined, Bun's default loader returns the path.
    const dir = mkdtempSync(join(tmpdir(), "mxlang-translator-bun-react-"));
    const path = join(dir, "Panel.react.mx");
    writeFileSync(
      path,
      "export function Panel() {\n  return <p class={ on: true }>x</p>;\n}\n",
    );

    const mod = await import(path);
    expect(mod.default).toEndWith("Panel.react.mx");
  });

  test("does not claim a .preact.mx path", async () => {
    Bun.plugin(markoPlugin);

    // A `.preact.mx` is TSX with MX regions (`@mxlang/preact`'s file kind),
    // compiled by the Vite plugin; claimed here it would be translated as a
    // whole-file `.mx`. Declined, Bun's default loader returns the path.
    const dir = mkdtempSync(join(tmpdir(), "mxlang-translator-bun-preact-"));
    const path = join(dir, "Panel.preact.mx");
    writeFileSync(
      path,
      "export function Panel() {\n  return <p class={ on: true }>x</p>;\n}\n",
    );

    const mod = await import(path);
    expect(mod.default).toEndWith("Panel.preact.mx");
  });

  test("does not claim a .solid.mx path", async () => {
    Bun.plugin(markoPlugin);

    // Real Solid source: it would fail the string translator outright
    // (JSX like <button onClick={...}> isn't valid `.marko` syntax), so the
    // regression this guards against is real, not just theoretical.
    const dir = mkdtempSync(join(tmpdir(), "mxlang-translator-bun-solid-"));
    const path = join(dir, "Counter.solid.mx");
    writeFileSync(
      path,
      `export function Counter() {
  return <button onClick={() => {}}>Count</button>;
}
`,
    );

    // Bun's default loader for an unrecognized extension returns the file's
    // own path as the module's default export, not a compiled function -
    // exactly what "the onLoad hook declined this path" looks like from the
    // caller's side.
    const mod = await import(path);
    expect(mod.default).toEndWith("Counter.solid.mx");
  });

  test("compiles a tag discovered beside the file, with no import", async () => {
    Bun.plugin(markoPlugin);

    // Through the real plugin, so the loader's own `getCustomTags` call is
    // what is under test: deleting it from `bun.ts` must fail this. A test
    // that called `compile()` with a tag map it fetched itself would stay
    // green with the loader gutted.
    //
    // Inside the package tree, like the test above and for the same reason:
    // the emitted module imports `escape` from "@mxlang/html" by bare
    // specifier, which Bun resolves from the file's own directory.
    const base = join(import.meta.dirname, "..", "fixtures-marko");
    const tagsDir = join(base, "tags");
    const tagFile = join(tagsDir, "bunstamp.tag.ts");
    const page = join(base, "bun-discovery.mx");

    mkdirSync(tagsDir, { recursive: true });
    writeFileSync(
      tagFile,
      "export default { transform: (_c, ctx) => [ctx.build.element('b', [], [ctx.build.text('discovered')])] };\n",
    );
    writeFileSync(page, "<bunstamp/>\n");
    try {
      const mod = await import(page);
      const render = mod.default as (input: unknown) => string;
      expect(render({})).toContain("discovered");
    } finally {
      rmSync(page, { force: true });
      rmSync(tagsDir, { recursive: true, force: true });
    }
  });

  test("resolves a discovered template tag's injected import", async () => {
    Bun.plugin(markoPlugin);

    // The unit-model path, distinct from the sidecar test above: a *template*
    // tag compiles to its own module and the caller emits an import of it.
    // This asserts the loader resolves that injected import for real — the
    // tag file has to be found, compiled and imported, or the page module
    // fails to load rather than merely rendering the wrong thing.
    const base = join(import.meta.dirname, "..", "fixtures-marko");
    const tagsDir = join(base, "tags");
    const tagFile = join(tagsDir, "bunicon.mx");
    const page = join(base, "bun-template-page.mx");

    mkdirSync(tagsDir, { recursive: true });
    writeFileSync(
      tagFile,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax, not a JS template
      '<span class="icon">${input.name}</span>\n',
    );
    writeFileSync(page, '<div><bunicon name="star"/></div>\n');
    try {
      const mod = await import(page);
      const render = mod.default as (input: unknown) => string;
      const html = render({});
      expect(html).toContain("star");
      expect(html).toContain('class="icon"');
    } finally {
      rmSync(page, { force: true });
      rmSync(tagsDir, { recursive: true, force: true });
    }
  });

  test("a tag whose mx.tags entry excludes this host is not discovered", async () => {
    Bun.plugin(markoPlugin);

    // Through the real plugin's own `getCustomTags(path, { host: "html" })`
    // call: a `package.json#mx.tags` entry declaring `hosts: ["solid"]`
    // must be invisible from the html loader, which is decision 110(a).
    const base = join(import.meta.dirname, "..", "fixtures-marko");
    const pkgDir = join(base, "hosts-fixture");
    const tagsDir = join(pkgDir, "widgets");
    const page = join(pkgDir, "bun-hosts.mx");

    mkdirSync(tagsDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "bun-hosts-fixture",
        mx: { tags: [{ dir: "widgets", hosts: ["solid"] }] },
      }),
    );
    writeFileSync(
      join(tagsDir, "gizmo.tag.ts"),
      "export default { transform: (_c, ctx) => [ctx.build.element('b', [], [ctx.build.text('nope')])] };\n",
    );
    writeFileSync(page, "<gizmo/>\n");
    try {
      // Marko rejects an unresolvable lowercase custom tag as a syntax
      // error, so the discovery gap surfaces as a compile failure rather
      // than a silently rendered tag — exactly the observable symptom the
      // field's absence produces at the call site.
      await expect(import(page)).rejects.toThrow();
    } finally {
      rmSync(pkgDir, { recursive: true, force: true });
    }
  });

  test("an own-only lookup leaves an unmatched mx.tags host unresolved without warning", async () => {
    Bun.plugin(markoPlugin);

    // PR 3 round-2 ruling: only a full registry can validate host names.
    // Filtering and other scan diagnostics remain active with an own lookup.
    const base = join(import.meta.dirname, "..", "fixtures-marko");
    const pkgDir = join(base, "hosts-warning-fixture");
    const tagsDir = join(pkgDir, "widgets");
    const page = join(pkgDir, "bun-hosts-warning.mx");

    mkdirSync(tagsDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "bun-hosts-warning-fixture",
        mx: { tags: [{ dir: "widgets", hosts: ["bogus"] }] },
      }),
    );
    linkRuntime(pkgDir);
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

  // A8, and the half a compile-only test cannot reach: a tag whose template
  // calls its own discovered name becomes a module that imports itself. That
  // is legal ESM (hoisted `function render` + live bindings), but "it compiles"
  // says nothing about whether it terminates and nests correctly, so this
  // renders a real tree three levels deep, each level passing a body.
  test("a self-recursive discovered tag renders to full depth", async () => {
    Bun.plugin(markoPlugin);

    const base = join(import.meta.dirname, "..", "fixtures-marko");
    const tagsDir = join(base, "tags");
    const tagFile = join(tagsDir, "buntree.mx");
    const page = join(base, "bun-recursive.mx");

    mkdirSync(tagsDir, { recursive: true });
    // `\${` keeps the MX placeholder literal: this string is template source,
    // not a JS template to interpolate.
    writeFileSync(
      tagFile,
      `<li>\${input.node.label}` +
        "<if=input.node.kids>" +
        "<ul><for|k| of=input.node.kids><buntree node=k/></for></ul>" +
        "</if>" +
        "</li>\n",
    );
    writeFileSync(page, "<ul><buntree node=input.root/></ul>\n");
    try {
      const mod = await import(page);
      const render = mod.default as (input: unknown) => string;
      const html = render({
        root: { label: "a", kids: [{ label: "b", kids: [{ label: "c" }] }] },
      });
      expect(html).toBe(
        "<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>",
      );
    } finally {
      rmSync(page, { force: true });
      rmSync(tagsDir, { recursive: true, force: true });
    }
  });

  test("a dotted tag file name is rejected, not indexed (decision 137)", async () => {
    Bun.plugin(markoPlugin);

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
      JSON.stringify({ name: "html-dotted-fixture" }),
    );
    linkRuntime(pkgDir);
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

describe("the onLoad filter (decision 154: hosts claim .<segment>.mx)", () => {
  const fake: TargetDescriptor = {
    descriptorVersion: 0,
    name: "fake-jsx",
    packageName: "@test/mx-fake",
    defaultTag: "div",
    host: {
      name: "fake",
      fileKinds: [
        {
          segment: "fake",
          diagnosticSource: "fakemx",
          compileRegion: () => ({ code: "null" }),
        },
      ],
    },
  };

  test("with the package's own lookup it is today's filter", () => {
    const filter = mxFilter(htmlTargets);
    expect(filter.source).toBe(
      String.raw`(?<!\.(?:solid|astro|react|preact))\.mx$`,
    );
    for (const file of ["/a/page.mx", "/a/my.icon.mx", "/a/page.nope.mx"])
      expect(filter.test(file)).toBe(true);
    for (const file of [
      "/a/x.solid.mx",
      "/a/x.astro.mx",
      "/a/x.react.mx",
      "/a/x.preact.mx",
      "/a/x.fake.mx",
    ])
      expect(filter.test(file)).toBe(file.endsWith(".fake.mx"));
  });

  test("declines every host module file kind of the lookup it is given", () => {
    const filter = mxFilter(
      createTargetLookup([
        ...[htmlTargets.target(htmlTargets.defaultTarget())!],
        fake,
      ]),
    );
    expect(filter.test("/a/x.fake.mx")).toBe(false);
    expect(filter.test("/a/x.solid.mx")).toBe(false);
    expect(filter.test("/a/page.mx")).toBe(true);
    expect(filter.test("/a/page.nope.mx")).toBe(true);
  });
});
