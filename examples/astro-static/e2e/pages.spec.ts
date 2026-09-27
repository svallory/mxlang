import { type ChildProcess, spawn } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = 5374;
const baseUrl = `http://localhost:${port}`;

/** Waits until `url` responds or `timeoutMs` elapses. */
async function waitForServer(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status < 500) return;
    } catch {
      // Server not up yet; retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server at ${url} did not respond within ${timeoutMs}ms`);
}

/** Runs `astro build`, writing `dist/`. */
async function buildSite(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const build: ChildProcess = spawn("bun", ["run", "build"], { cwd: root });
    build.on("error", reject);
    build.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`build failed with exit code ${code}`));
    });
  });
}

let browser: Browser;
let server: Server;
let page: Page;

beforeAll(async () => {
  await buildSite();

  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const name = url.pathname === "/" ? "/index.html" : url.pathname;
    // Astro writes `about/index.html` for the route `/about`.
    const candidates = [
      `${root}dist${name}`,
      `${root}dist${name}/index.html`,
      `${root}dist${name}.html`,
    ];
    // `isFile()`, not `existsSync`: Astro writes the route `/named-slot` as
    // the directory `dist/named-slot/` containing `index.html`, so the first
    // candidate exists but is a directory — streaming it raises EISDIR.
    const path = candidates.find((candidate) => {
      try {
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
    if (!path) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    createReadStream(path).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  await waitForServer(baseUrl);

  browser = await chromium.launch();
  page = await browser.newPage();
});

afterAll(async () => {
  await page?.close();
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe("astro-static", () => {
  it("/ renders an MX component with props and Astro's default slot", async () => {
    const response = await page.goto(baseUrl, { waitUntil: "networkidle" });
    expect(response?.status()).toBe(200);
    const html = await response?.text();

    // The prop reached `input.title`...
    expect(html).toContain("<h2>Props and a default slot</h2>");
    // ...and Astro's default slot reached MX's `content` thunk, as markup
    // rather than escaped text.
    expect(html).toContain(
      "<p>This paragraph is Astro's default slot, rendered to HTML before MX sees it.</p>",
    );
    expect(html).not.toContain("&lt;p&gt;");
  });

  it("/named-slot maps a named slot to the matching attribute tag", async () => {
    const response = await page.goto(`${baseUrl}/named-slot`, {
      waitUntil: "networkidle",
    });
    expect(response?.status()).toBe(200);
    const html = await response?.text();

    expect(html).toContain('<footer class="card-footer">');
    expect(html).toContain('<span class="badge">footer slot</span>');
  });

  it("/composed renders one MX component through another", async () => {
    const response = await page.goto(`${baseUrl}/composed`, {
      waitUntil: "networkidle",
    });
    expect(response?.status()).toBe(200);
    const html = await response?.text();

    expect(html).toContain('<section class="panel">');
    expect(html).toContain("<h2>Panel wraps Card</h2>");
    expect(html).toContain('<span class="badge">composed</span>');
  });

  it("/mx-page is an MX file directly under src/pages, rendered through a layout", async () => {
    // Decision 76b: `.mx` files under `src/pages` are pages, not components.
    // `mx-page.mx` declares `export const layout`, a `static` block for its
    // props, and uses `<if>`/`<for>` — this asserts the whole page-mode
    // pipeline: layout wrapping, static-block props, and control flow.
    const response = await page.goto(`${baseUrl}/mx-page`, {
      waitUntil: "networkidle",
    });
    expect(response?.status()).toBe(200);
    const html = (await response?.text()) ?? "";

    // The layout ran and wrapped the page's HTML.
    expect(html).toContain("Rendered through Base.astro");
    expect(html).toContain("<title>MX page — astro-static</title>");
    // `<if=showNote>` rendered its branch.
    expect(html).toContain(
      "Rendered through a layout, from a page-level static block.",
    );
    // `<for|item, i| of=items>` rendered every entry.
    expect(html).toContain("<li>0: one</li>");
    expect(html).toContain("<li>1: two</li>");
    expect(html).toContain("<li>2: three</li>");
  });

  it("/no-layout renders a full document with no layout export", async () => {
    const response = await page.goto(`${baseUrl}/no-layout`, {
      waitUntil: "networkidle",
    });
    expect(response?.status()).toBe(200);
    const html = (await response?.text()) ?? "";

    expect(html).toContain("<title>No layout — astro-static</title>");
    expect(html).toContain("<h1>No layout</h1>");
    // No layout wrapper ran: the page's own `<html>` is the only one.
    expect(html).not.toContain("Rendered through Base.astro");
  });

  it("/posts/[slug] is a dynamic MX page with getStaticPaths, both entries built", async () => {
    for (const [slug, title] of [
      ["first", "First post"],
      ["second", "Second post"],
    ] as const) {
      const response = await page.goto(`${baseUrl}/posts/${slug}`, {
        waitUntil: "networkidle",
      });
      expect(response?.status()).toBe(200);
      const html = (await response?.text()) ?? "";

      expect(html).toContain(`<h1>${title}</h1>`);
      // `input.params.slug` reached the page: the merged `params` from
      // `Astro.params`, not only the page's own `props`.
      expect(html).toContain(`Route param <code>slug</code>: ${slug}`);
    }
  });

  it("/templates renders .amx components: MX template, Astro semantics", async () => {
    // Decisions 76c/78. The page itself is `.amx`, as are its layout and both
    // components: an Astro component whose template is MX, lowered to Astro
    // template syntax and compiled by Astro itself. `.amx` is registered with
    // `addPageExtension`, which is what makes this route exist at all. This
    // asserts each construct the lowering table claims, on real rendered
    // output rather than on emitted code.
    const response = await page.goto(`${baseUrl}/templates`, {
      waitUntil: "networkidle",
    });
    expect(response?.status()).toBe(200);
    const html = (await response?.text()) ?? "";

    // The `.amx` layout ran, and `${title}` reached its `<title>`: the
    // `---` fence kept Astro's own semantics (`Astro.props`).
    expect(html).toContain("Rendered through BaseMx.amx");
    expect(html).toContain("<title>AstroMX templates — astro-static</title>");

    // A structured `class` lowered to Astro's `class:list`, so the toggled
    // entry appears only when its value is true.
    expect(html).toContain('class="panel panel-on"');
    // ...and the plain panel keeps only the always-on entry.
    expect(html).toContain('class="panel"');

    // An attribute tag lowered to an Astro named slot, and the page's
    // `<Fragment slot="header">` landed in the component's `<slot name=...>`.
    expect(html).toContain(
      '<span class="panel-badge">badge in the named slot</span>',
    );
    // The default slot still works alongside the named one.
    expect(html).toContain("<p>This paragraph is the default slot.</p>");

    // `<for|member, i| of=members>` lowered to `.map()`, index included.
    expect(html).toContain('<li class="roster-item">0: ada</li>');
    expect(html).toContain('<li class="roster-item">1: grace</li>');
    expect(html).toContain('<li class="roster-item">2: alan</li>');

    // `<if>`/`<else if>`/`<else>` lowered to a ternary chain: each of the
    // three rosters takes a different arm.
    expect(html).toContain('<p class="roster-empty">Nobody here yet.</p>');
    expect(html).toContain('<p class="roster-hidden">(hidden)</p>');
  });

  it("ships no renderer script: the pages are static markup", async () => {
    // The whole claim of this host. An MX component has no runtime, the
    // renderer registers no client entrypoint, and `output: "static"`
    // prerenders everything — so no `<script>` should appear in the output.
    for (const route of [
      "/",
      "/named-slot",
      "/composed",
      "/mx-page",
      "/no-layout",
      "/posts/first",
      "/posts/second",
      // `.amx` components lower to Astro template syntax and are
      // compiled by Astro itself, so they ship no client JS either.
      "/templates",
    ]) {
      const response = await page.goto(`${baseUrl}${route}`, {
        waitUntil: "networkidle",
      });
      const html = (await response?.text()) ?? "";
      expect(html).not.toContain("<script");
    }
  });
});
