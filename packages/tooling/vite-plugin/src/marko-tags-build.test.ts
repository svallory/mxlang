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

describe("a .mx page calling a tags/*.mx tag, built with vite (audit case h18)", () => {
  it("renders input attributes and body content", async () => {
    html("basic");
    write(
      "basic",
      "src/tags/badge.mx",
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
    write("nested", "src/tags/badge.mx", `<i>\${input.label}</i>`);
    write("nested", "src/pages/a/b/page.mx", `<badge label="deep"/>`);
    expect(await render("nested", "src/pages/a/b/page.mx")).toBe("<i>deep</i>");
  });

  it("builds the h18 shape: a typed Input and a tag fed from it", async () => {
    html("h18");
    write("h18", "src/pages/tags/greet.mx", `<span>hi \${input.who}</span>`);
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

  it("two tags/*.mx tags side by side", async () => {
    html("mixed");
    write("mixed", "src/tags/from-first.mx", `<b>\${input.label}</b>`);
    write("mixed", "src/tags/from-mx.mx", `<i>\${input.label}</i>`);
    write(
      "mixed",
      "src/page.mx",
      `<p><from-first label="m"/><from-mx label="x"/></p>`,
    );
    expect(await render("mixed", "src/page.mx")).toBe(
      "<p><b>m</b><i>x</i></p>",
    );
  });

  it("a .mx tag that calls another tag", async () => {
    html("chain");
    write("chain", "src/tags/inner.mx", `<u>\${input.label}</u>`);
    write(
      "chain",
      "src/tags/outer.mx",
      `<div><inner label=input.label/></div>`,
    );
    write("chain", "src/page.mx", `<outer label="x"/>`);
    expect(await render("chain", "src/page.mx")).toBe("<div><u>x</u></div>");
  });

  it("a .marko tag is a build error naming the file (decision 172)", async () => {
    html("marko-tag");
    write("marko-tag", "src/tags/card.marko", `<div>\${input.title}</div>`);
    write("marko-tag", "src/page.mx", `<card title="T"/>`);
    const error = await render("marko-tag", "src/page.mx").then(
      () => undefined,
      (err: Error) => err,
    );
    expect(error?.message).toContain(
      "`<card>` resolves to `tags/card.marko`, a `.marko` file",
    );
  });

  it("a directory tag (tags/card/index.mx) is a build error naming the file", async () => {
    html("dirtag");
    write("dirtag", "src/tags/card/index.mx", `<div>\${input.title}</div>`);
    write("dirtag", "src/page.mx", `<card title="T"/>`);
    const error = await render("dirtag", "src/page.mx").then(
      () => undefined,
      (err: Error) => err,
    );
    expect(error?.message).toContain("matches `tags/card/index.mx`");
  });

  it("a broken tag file fails the build naming the tag, not a rolldown parse error", async () => {
    html("broken");
    write("broken", "src/tags/bad.mx", "<div><span>oops</div>");
    write("broken", "src/page.mx", `<bad/>`);
    const error = await render("broken", "src/page.mx").then(
      () => undefined,
      (err: Error) => err,
    );
    expect(error?.message).toContain("bad.mx");
    expect(error?.message).not.toContain("Unexpected JSX expression");
    // Located at the tag's own line:column (the 1-based column of the closer),
    // with Marko's reason, and not a stack's worth of frames (audit item 19).
    // The header names the authored tag, not the `.mx.tsx` module id this
    // plugin mints for it (`vite-virtual-tsx-id`).
    expect(error?.message).toContain("bad.mx:1:16");
    expect(error?.message).not.toContain("bad.mx.tsx");
    expect(error?.message).toContain('closing "div" tag does not match');
  });
});

describe("the same page through the dev server's transform path", () => {
  it("ssrLoadModule renders a page with a tags/*.mx tag", async () => {
    html("dev");
    write(
      "dev",
      "src/tags/badge.mx",
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
 * The JSX hosts import a discovered `tags/x.mx` the same way. A Solid
 * whole-file page does not run Marko's lookup (a `.marko` tag there is an
 * error, decision 172).
 */
describe("a tags/*.mx tag on the JSX hosts, built with vite", () => {
  const page = `<p><badge label="L"/></p>`;
  const tag = `<b>\${input.label}</b>`;

  function jsx(project: string, host: string): void {
    write(project, "package.json", JSON.stringify({ name: "p", mx: { host } }));
    write(project, "src/tags/badge.mx", tag);
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
