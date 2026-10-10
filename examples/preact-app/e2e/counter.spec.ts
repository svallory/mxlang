import { type ChildProcess, spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The Preact host, end to end: `.mx` source through the Vite plugin, into a
 * production bundle, mounted in a real browser, clicked.
 *
 * The unit tests assert the emitted JSX text and the oracle asserts the
 * rendered HTML; neither can show that the result is a *live* component. A
 * count that changes when a button is clicked is the thing only this test
 * can prove — the hook reached the component body, the handler became a real
 * prop, and Preact re-rendered.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const port = 5379;
const baseUrl = `http://localhost:${port}`;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

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

/** Runs `vite build`, writing `dist/`. */
async function buildApp(): Promise<void> {
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
  await buildApp();

  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const name = url.pathname === "/" ? "/index.html" : url.pathname;
    const path = `${root}dist${name}`;
    if (!existsSync(path)) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, {
      "content-type":
        CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
    });
    createReadStream(path).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  await waitForServer(baseUrl);

  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(baseUrl);
  await page.waitForSelector('[data-testid="count"]');
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe("the MX + Preact counter", () => {
  it("renders the component's props and its initial hook state", async () => {
    expect(await page.textContent("h1")).toBe("MX counter");
    // `start=3` reached the component and `useState(input.start ?? 0)` ran in
    // the component body — which is what `<const>` lowering to a statement
    // inside the function is for.
    expect(await page.textContent('[data-testid="count"]')).toBe("3");
  });

  it("updates the count when the button is clicked", async () => {
    await page.click('[data-testid="inc"]');
    expect(await page.textContent('[data-testid="count"]')).toBe("4");

    await page.click('[data-testid="inc"]');
    expect(await page.textContent('[data-testid="count"]')).toBe("5");
  });

  it("re-renders a structured `class` as the state changes", async () => {
    // `class={even: …, odd: …}` goes through the emitted `mxClass` helper, so
    // this also proves the helper is in the bundle and runs per render.
    const parity = '[data-testid="parity"]';
    expect(await page.getAttribute(parity, "class")).toBe("odd");
    expect(await page.textContent(parity)).toBe("odd");

    await page.click('[data-testid="inc"]');
    expect(await page.getAttribute(parity, "class")).toBe("even");
    expect(await page.textContent(parity)).toBe("even");
  });

  it("resets through a second handler", async () => {
    await page.click('[data-testid="reset"]');
    expect(await page.textContent('[data-testid="count"]')).toBe("0");
  });

  it("catches a real thrown error through `<try>`'s boundary", async () => {
    // The only place an error boundary actually runs: Preact's boundaries are
    // a client-render mechanism, and `preact-render-to-string`'s sync
    // renderer rethrows instead of invoking one (pinned in
    // `@mxlang/host-preact`'s own `runtime.test.ts`). So this browser assertion is
    // the live proof that `<@catch>` wires a working boundary — the sibling
    // `<Risky fail=false/>` proves the boundary is transparent otherwise.
    expect(await page.textContent('[data-testid="boom-ok"]')).toBe(
      "child rendered fine",
    );
    expect(await page.textContent('[data-testid="boom-caught"]')).toBe(
      "caught: boom from a child",
    );
  });

  it("renders a `<for>` loop's rows in order", async () => {
    expect(await page.textContent('[data-testid="item-0"]')).toBe("0: alpha");
    expect(await page.textContent('[data-testid="item-1"]')).toBe("1: beta");
    expect(await page.textContent('[data-testid="item-2"]')).toBe("2: gamma");
  });
});
