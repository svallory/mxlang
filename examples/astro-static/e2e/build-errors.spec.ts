import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const pagesDir = join(root, "src", "pages");
const fixtures = join(root, "error-fixtures");

/** Runs `astro build` and resolves with its exit code and combined output. */
async function build(): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", "build"], { cwd: root });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, output }));
  });
}

/**
 * Copies one expected-to-fail page into `src/pages/` for a single build.
 *
 * The fixtures live outside `src/pages/` so the ordinary `astro build` never
 * sees them: a page that is supposed to break the build cannot also be part of
 * the build everything else depends on.
 */
function stagePage(name: string): string {
  mkdirSync(pagesDir, { recursive: true });
  const target = join(pagesDir, name);
  copyFileSync(join(fixtures, "pages", name), target);
  return target;
}

let staged: string | null = null;

afterEach(() => {
  if (staged) rmSync(staged, { force: true });
  staged = null;
});

describe("builds that are supposed to fail", () => {
  it("rejects client:load on an MX component, naming the component", async () => {
    // The renderer raises this, not Astro. Astro's own `NoClientEntrypoint`
    // message is defined in `dist/core/errors/errors-data.js` and thrown from
    // nowhere in 7.3.2 — its render path is a bare
    // `if (renderer.clientEntrypoint)` (`dist/runtime/server/hydration.js:98`)
    // with no else branch, so left alone the build succeeds and ships an
    // `<astro-island client="load">` whose loader falls back to a no-op
    // hydrator. An island that silently does nothing is the wrong outcome on a
    // host whose whole claim is shipping no client JS (decision 70), so
    // `renderToStaticMarkup` throws on `metadata.hydrate` instead.
    staged = stagePage("client-error.astro");
    const { code, output } = await build();

    expect(code).not.toBe(0);
    expect(output).toContain("is an MX component and renders statically");
    expect(output).toContain("remove the `client:load` directive");
    // The component is named, so the author knows which one to fix.
    expect(output).toContain("Card");
  });

  it("rejects <let> in an MX component under the strict policy", async () => {
    // Decision 71: stateful tags mean whatever the host says, and this host
    // has no reactive target at all — so `<let>` is a compile error naming the
    // construct, not markup that silently renders once and never updates.
    staged = stagePage("strict-error.astro");
    const { code, output } = await build();

    expect(code).not.toBe(0);
    expect(output).toContain("`<let>` is reactive state");
    // The error carries the offending file, so the author is pointed at the
    // component rather than at the page that imported it.
    expect(output).toContain("stateful.mx");
  });

  it("rejects <let> in a page-mode .mx file under src/pages, not only in an imported component", async () => {
    // Round-2 gap: the test above only exercises the component path (a
    // `.astro` page importing a stateful `.mx` component). This one is a
    // `.mx` file placed directly under `src/pages` — page mode, going
    // through `@mxlang/host-astro`'s `mxPages` Vite plugin. The strict policy is
    // enforced at `@mxlang/vite-plugin`'s compile step, before `mxPages`'s
    // `enforce: "post"` transform ever runs, so this fails the same way for
    // the same reason — but that was previously unverified for the page case.
    staged = stagePage("strict-error-page.mx");
    const { code, output } = await build();

    expect(code).not.toBe(0);
    expect(output).toContain("`<let>` is reactive state");
    expect(output).toContain("strict-error-page.mx");
  });
});
