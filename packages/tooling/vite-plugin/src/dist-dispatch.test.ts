import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("emits only public declarations with no private registry or descriptor imports", () => {
  const dist = join(import.meta.dirname, "../dist");
  const declarations = readdirSync(dist).filter((file) =>
    file.endsWith(".d.ts"),
  );
  expect(declarations).toEqual(["index.d.ts"]);
  for (const file of declarations) {
    expect(readFileSync(join(dist, file), "utf8")).not.toMatch(
      /@mxlang\/target-registry|@mxlang\/[^"']+\/descriptor/,
    );
  }
});

// MX_VITE_ENTRY allows replaying the pre-bundle source failure without
// changing the production entry or this regression's default dist coverage.
it("transforms every wired target and a region from dist under plain Node ESM", () => {
  const entry = pathToFileURL(
    process.env.MX_VITE_ENTRY ?? join(import.meta.dirname, "../dist/index.js"),
  ).href;
  const script = `
    import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import mx from ${JSON.stringify(entry)};
    for (const target of ["astro-html", "solid-jsx", "react-jsx", "preact-jsx", "hono-jsx", "html"]) {
      const dir = mkdtempSync(join(tmpdir(), "mx-vite-node-dispatch-"));
      try {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ mx: { target } }));
        const result = await mx().transform.call({}, "<p>hello</p>\\n", join(dir, "page.mx.tsx"));
        if (!result?.code.includes("export default") || result.map !== null) throw new Error(target + ": " + JSON.stringify(result));
        if (target === "astro-html" && !result.code.includes("__mxOut.write(")) throw new Error("not HTML output");
        if (target === "solid-jsx" && !result.code.includes("<p>hello</p>")) throw new Error("not Solid JSX");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    const region = await mx().transform.call({}, "export const view = () => <p>hello</p>;\\n", "/app/page.solid.mx.tsx");
    if (!region?.code.includes("<p>hello</p>")) throw new Error("region failed");
    console.log("Node ESM Vite target dispatch passed");
  `;
  const result = spawnSync("node", ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("Node ESM Vite target dispatch passed");
});
