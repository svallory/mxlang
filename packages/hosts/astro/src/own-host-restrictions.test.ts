import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { mxTemplates } from "./vite-templates.ts";

it("the own-only Astro template loader does not warn about a peer host restriction", () => {
  const dir = mkdtempSync(join(tmpdir(), "mx-astro-own-hosts-"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    mkdirSync(join(dir, "extra"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ mx: { tags: [{ dir: "extra", hosts: ["solid"] }] } }),
    );
    writeFileSync(join(dir, "extra/thing.mx"), "<div/>");
    const file = join(dir, "Card.astro.mx");
    writeFileSync(file, "---\nconst title = 'hi';\n---\n<div>{title}</div>\n");
    const load = mxTemplates().load;
    if (typeof load !== "function") throw new Error("missing load hook");
    // SAFETY: this plugin's load hook does not consult its Vite context.
    const invoke = load as (this: unknown, id: string) => string | null;
    expect(invoke.call({}, `${file}.astro`)).toContain("const title");
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
