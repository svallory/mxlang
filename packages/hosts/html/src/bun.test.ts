import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import markoPlugin from "./bun.ts";

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

  test("does not claim a .solid.mx path", async () => {
    Bun.plugin(markoPlugin);

    // Real SolidMX source: it would fail the string translator outright
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
});
