import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

// The descriptors' lazy require must be bundled, not left for Node ESM to
// execute from a source module. A Bun-only server test cannot catch that.
it("dispatches every wired page target and the region pipeline from dist under plain Node ESM", () => {
  const entry = pathToFileURL(
    join(import.meta.dirname, "../dist/index.js"),
  ).href;
  const script = `
    import { diagnoseDocument } from ${JSON.stringify(entry)};
    const unexpected = (error) => { throw error; };
    for (const target of ["html", "astro-html", "solid-jsx", "preact-jsx", "react-jsx", "hono-jsx"]) {
      const diagnostics = diagnoseDocument(
        "<let/count=0/>\\n", "/app/page.mx", { target, strict: true }, unexpected,
      );
      if (diagnostics.length !== 1) throw new Error(target + ": " + JSON.stringify(diagnostics));
    }
    const region = diagnoseDocument(
      "export const view = () => <p>hello</p>;\\n", "untitled:region",
      { target: "html" }, unexpected, "solidmx",
    );
    if (region.length !== 0) throw new Error(JSON.stringify(region));
    console.log("Node ESM target dispatch passed");
  `;
  const result = spawnSync(
    process.env.MX_LS_NODE ?? "node",
    ["--input-type=module", "-e", script],
    {
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("Node ESM target dispatch passed");
});
