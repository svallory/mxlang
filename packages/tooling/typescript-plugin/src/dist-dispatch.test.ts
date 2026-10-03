import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";

// Lazy descriptor requires must stay inside the artifact, not escape to a
// private host's TS source. Bun-only tests cannot prove this Node contract.
it("dispatches every wired page target and region from dist under plain Node", () => {
  const entry = join(import.meta.dirname, "../dist/index.cjs");
  const script = `
    const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const ts = require("typescript");
    const plugin = require(${JSON.stringify(entry)});
    if (typeof plugin !== "function") throw new Error("not a plugin factory");
    for (const target of ["html", "astro-html", "solid-jsx", "preact-jsx", "react-jsx", "hono-jsx"]) {
      const dir = mkdtempSync(join(tmpdir(), "mx-plugin-node-dispatch-"));
      try {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ mx: { target } }));
        const file = join(dir, "page.mx");
        const language = plugin.createMxLanguagePlugin(ts);
        const virtual = language.createVirtualCode(file, "mx", ts.ScriptSnapshot.fromString("<p>hello</p>\\n"), { getAssociatedScript: () => undefined });
        const diagnostics = language.getCompileDiagnostics(file);
        if (!virtual || diagnostics.length) throw new Error(target + ": " + JSON.stringify(diagnostics));
        if (!virtual.snapshot.getText(0, virtual.snapshot.getLength()).includes("export default")) throw new Error(target + " missing default export");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    const region = plugin.createSolidMxLanguagePlugin(ts);
    const virtual = region.createVirtualCode("/app/page.solid.mx", "solidmx", ts.ScriptSnapshot.fromString("export const view = () => <p>hello</p>;\\n"), { getAssociatedScript: () => undefined });
    if (!virtual || region.getCompileDiagnostics().length) throw new Error("region failed");
    console.log("Node target dispatch passed");
  `;
  const result = spawnSync("node", ["-e", script], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("Node target dispatch passed");
});
