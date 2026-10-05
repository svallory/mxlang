import { type ChildProcess, spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = 6381;
const baseUrl = `http://localhost:${port}`;
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

async function buildApp(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const build: ChildProcess = spawn("bun", ["run", "build"], {
      cwd: root,
      stdio: "inherit",
    });
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
const pageErrors: string[] = [];

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

  browser = await chromium.launch();
  page = await browser.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl);
  await page.waitForSelector('[data-testid="count"]');
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe("a Vite-built .react.mx component", () => {
  it("renders the region with the initial useState values", async () => {
    expect(await page.textContent("h1")).toBe("MX React regions");
    expect(await page.textContent('[data-testid="count"]')).toBe("0");
    expect(await page.getAttribute('[data-testid="count"]', "class")).toBe(
      "even",
    );
    expect(await page.textContent('[data-testid="badge"]')).toBe("clicks: 0");
    expect(await page.$('[data-testid="list"]')).toBeNull();
  });

  it("a click updates useState and the region, the <define> included", async () => {
    await page.click('[data-testid="inc"]');
    expect(await page.textContent('[data-testid="count"]')).toBe("1");
    expect(await page.getAttribute('[data-testid="count"]', "class")).toBe(
      "odd",
    );
    expect(await page.textContent('[data-testid="badge"]')).toBe("clicks: 1");
  });

  it("an <if>/<else> switches on state and renders the <for>", async () => {
    await page.click('[data-testid="show"]');
    expect(
      await page.$$eval('[data-testid="list"] li', (items) =>
        items.map((item) => item.textContent),
      ),
    ).toEqual(["Ann", "Bo"]);
    expect(await page.$('[data-testid="show"]')).toBeNull();
    expect(pageErrors).toEqual([]);
  });
});
