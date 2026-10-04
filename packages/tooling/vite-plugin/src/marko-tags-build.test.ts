import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, createServer } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import mx from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
// Inside the package, not `tmpdir()`: the compiled pages import `@mxlang/html`
// by bare specifier, which only resolves from within the package tree.
const root = mkdtempSync(join(here, "..", ".tmp-marko-tags-build-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(project: string, rel: string, source: string): string {
  const path = join(root, project, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  return path;
}

/** A project with the html host selected, as `h18` and every html example are. */
function html(project: string): void {
  write(project, "package.json", '{"name":"p","mx":{"host":"html"}}');
}

/**
 * `vite build` of one page as an SSR bundle, then the bundle is executed and
 * its default export called. A string match on the emitted text would pass
 * with the import left unresolved; only running the output proves the tag was
 * compiled and linked.
 */
async function renderRaw(
  project: string,
  entry: string,
  input: Record<string, unknown> = {},
): Promise<unknown> {
  const projectRoot = join(root, project);
  const outDir = join(projectRoot, "dist");
  await build({
    root: projectRoot,
    configFile: false,
    logLevel: "silent",
    plugins: [mx()],
    build: {
      ssr: join(projectRoot, entry),
      outDir,
      emptyOutDir: true,
      minify: false,
      rollupOptions: { output: { entryFileNames: "page.mjs" } },
    },
  });
  const mod = (await import(
    /* @vite-ignore */ pathToFileURL(join(outDir, "page.mjs")).href
  )) as { default: (input: unknown) => unknown };
  return mod.default(input);
}

async function render(
  project: string,
  entry: string,
  input: Record<string, unknown> = {},
): Promise<string> {
  return (await renderRaw(project, entry, input)) as string;
}

describe("a .mx page calling a tags/*.marko tag, built with vite (audit case h18)", () => {
  it("renders input attributes and body content", async () => {
    html("basic");
    write(
      "basic",
      "src/tags/badge.marko",
      `<span class="badge">\${input.label}<\${input.content}/></span>`,
    );
    write(
      "basic",
      "src/page.mx",
      "<div><badge label=input.text>body &amp; <b>more</b></badge></div>",
    );
    expect(await render("basic", "src/page.mx", { text: "<hi>" })).toBe(
      `<div><span class="badge">&lt;hi&gt;body &amp; <b>more</b></span></div>`,
    );
  });

  it("finds tags/ up the tree from a nested page directory", async () => {
    html("nested");
    write("nested", "src/tags/badge.marko", `<i>\${input.label}</i>`);
    write("nested", "src/pages/a/b/page.mx", `<badge label="deep"/>`);
    expect(await render("nested", "src/pages/a/b/page.mx")).toBe("<i>deep</i>");
  });

  it("builds the h18 shape: a typed Input and a tag fed from it", async () => {
    html("h18");
    write("h18", "src/pages/tags/greet.marko", `<span>hi \${input.who}</span>`);
    write(
      "h18",
      "src/pages/page.mx",
      `export interface Input { name: string; count: number }
<greet who=input.name/>
<span>n=\${input.count}</span>`,
    );
    expect(
      await render("h18", "src/pages/page.mx", { name: "world", count: 1 }),
    ).toBe("<span>hi world</span><span>n=1</span>");
  });

  it("a tags/*.mx and a tags/*.marko tag side by side", async () => {
    html("mixed");
    write("mixed", "src/tags/from-marko.marko", `<b>\${input.label}</b>`);
    write("mixed", "src/tags/from-mx.mx", `<i>\${input.label}</i>`);
    write(
      "mixed",
      "src/page.mx",
      `<p><from-marko label="m"/><from-mx label="x"/></p>`,
    );
    expect(await render("mixed", "src/page.mx")).toBe(
      "<p><b>m</b><i>x</i></p>",
    );
  });

  it("a .marko tag that calls another tag", async () => {
    html("chain");
    write("chain", "src/tags/inner.marko", `<u>\${input.label}</u>`);
    write(
      "chain",
      "src/tags/outer.marko",
      `<div><inner label=input.label/></div>`,
    );
    write("chain", "src/page.mx", `<outer label="x"/>`);
    expect(await render("chain", "src/page.mx")).toBe("<div><u>x</u></div>");
  });

  it("a directory tag (tags/card/index.marko)", async () => {
    html("dirtag");
    write("dirtag", "src/tags/card/index.marko", `<div>\${input.title}</div>`);
    write("dirtag", "src/page.mx", `<card title="T"/>`);
    expect(await render("dirtag", "src/page.mx")).toBe("<div>T</div>");
  });

  it("a broken tag file fails the build naming the tag, not a rolldown parse error", async () => {
    html("broken");
    write("broken", "src/tags/bad.marko", "<div><span>oops</div>");
    write("broken", "src/page.mx", `<bad/>`);
    const error = await render("broken", "src/page.mx").then(
      () => undefined,
      (err: Error) => err,
    );
    expect(error?.message).toContain("bad.marko");
    expect(error?.message).not.toContain("Unexpected JSX expression");
    // Located at the tag's own line:column (the 0-based column of the closer),
    // with Marko's reason, and not a stack's worth of frames (audit item 19).
    // The header names the authored tag, not the `.marko.tsx` module id this
    // plugin mints for it (`vite-virtual-tsx-id`).
    expect(error?.message).toContain("bad.marko:1:15");
    expect(error?.message).not.toContain("bad.marko.tsx");
    expect(error?.message).toContain('closing "div" tag does not match');
  });
});

describe("the same page through the dev server's transform path", () => {
  it("ssrLoadModule renders a page with a tags/*.marko tag", async () => {
    html("dev");
    write(
      "dev",
      "src/tags/badge.marko",
      `<b>\${input.label}<\${input.content}/></b>`,
    );
    write("dev", "src/page.mx", `<badge label="L">body</badge>`);
    const server = await createServer({
      root: join(root, "dev"),
      configFile: false,
      logLevel: "silent",
      plugins: [mx()],
      server: { middlewareMode: true, hmr: false, watch: null },
      appType: "custom",
    });
    try {
      const mod = (await server.ssrLoadModule(
        join(root, "dev", "src/page.mx"),
      )) as { default: (input: unknown) => string };
      expect(mod.default({})).toBe("<b>Lbody</b>");
    } finally {
      await server.close();
    }
  });
});

/**
 * The JSX hosts emit the same `import … from "./tags/x.marko"` (#187), so the
 * same fix carries them. A Solid whole-file page does not discover
 * `tags/*.marko` at all (the tag stays a literal `<badge>` element), which is
 * outside this plugin.
 */
describe("a tags/*.marko tag on the JSX hosts, built with vite", () => {
  const page = `<p><badge label="L"/></p>`;
  const tag = `<b>\${input.label}</b>`;

  function jsx(project: string, host: string): void {
    write(project, "package.json", JSON.stringify({ name: "p", mx: { host } }));
    write(project, "src/tags/badge.marko", tag);
    write(project, "src/page.mx", page);
  }

  it("preact", async () => {
    jsx("preact", "preact");
    const { renderToString } = await import("preact-render-to-string");
    expect(
      renderToString((await renderRaw("preact", "src/page.mx")) as never),
    ).toBe("<p><b>L</b></p>");
  });

  it("react", async () => {
    jsx("react", "react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    expect(
      renderToStaticMarkup((await renderRaw("react", "src/page.mx")) as never),
    ).toBe("<p><b>L</b></p>");
  });

  it("hono", async () => {
    jsx("hono", "hono");
    expect(String(await renderRaw("hono", "src/page.mx"))).toBe(
      "<p><b>L</b></p>",
    );
  });
});
