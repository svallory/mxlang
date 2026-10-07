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
    // The Angular host is wired like every other: page compile through the
    // descriptor's load(), .ng.mx through the file kind's compileFile().
    const ngMx = (region) => [
      'import { Component } from "@angular/core";',
      "@Component({",
      '  selector: "app-x",',
      "  standalone: true,",
      "  template: " + region + ",",
      "})",
      "export class XComponent {}",
    ].join("\\n");
    const page = diagnoseDocument(
      "<div>\\n  <return value=x/>\\n</div>\\n", "/app/b.mx",
      { target: "angular-template" }, unexpected,
    );
    if (page.length !== 1 || !page[0].message.includes("<return>"))
      throw new Error("angular page: " + JSON.stringify(page));
    const clean = diagnoseDocument(
      ngMx("<p>\${user.name}</p>"), "/app/c.component.ng.mx",
      { target: "angular-template" }, unexpected,
    );
    if (clean.length !== 0) throw new Error("angular clean: " + JSON.stringify(clean));
    const broken = diagnoseDocument(
      ngMx("<p>\${user.name +)}</p>"), "/app/d.component.ng.mx",
      { target: "angular-template" }, unexpected,
    );
    if (broken.length !== 1) throw new Error("angular region: " + JSON.stringify(broken));
    // Ruling 3: @angular/compiler-cli must never load, directly or
    // transitively — not a dependency, and absent from every module cache.
    const { createRequire } = await import("node:module");
    const req = createRequire(${JSON.stringify(join(import.meta.dirname, "../dist/index.js"))});
    try {
      req.resolve("@angular/compiler-cli");
      throw new Error("@angular/compiler-cli is resolvable from the server");
    } catch (error) {
      if (!/Cannot find module|MODULE_NOT_FOUND/.test(String(error?.message ?? error)))
        throw error;
    }
    const loaded = Object.keys(req.cache);
    if (loaded.some((file) => file.includes("@angular/compiler-cli")))
      throw new Error("@angular/compiler-cli was loaded: " + loaded.join(", "));
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
