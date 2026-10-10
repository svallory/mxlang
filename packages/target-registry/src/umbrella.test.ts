import { readFileSync } from "node:fs";
import * as htmlEntry from "@mxlang/target-html";
import { describe, expect, it } from "vitest";
import * as htmlSubpath from "./html.ts";
import * as registry from "./index.ts";

// Decision 201: `@mxlang/targets` is the umbrella, the registry plus every
// target. The main entry names the html target's descriptor; the `./html`
// subpath is the target's full entry. `@mxlang/data` is not part of it
// (decision 204 deletes that package).

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { name: string; exports: Record<string, string> };

describe("@mxlang/targets umbrella", () => {
  it("is the package @mxlang/targets with the ./html and ./dialect-check subpaths and no ./tree", () => {
    expect(manifest.name).toBe("@mxlang/targets");
    expect(manifest.exports).toEqual({
      ".": "./src/index.ts",
      "./html": "./src/html.ts",
      "./dialect-check": "./src/dialect-check.ts",
    });
  });

  it("exports the html descriptor the registry registers, and no tree descriptor", () => {
    expect(registry.htmlTarget.name).toBe("html");
    expect(registry.htmlTarget.packageName).toBe("@mxlang/target-html");
    // The same object, not a copy: a consumer comparing against the lookup
    // gets identity.
    expect(registry.builtinTargets).toContain(registry.htmlTarget);
    expect(Object.keys(registry)).not.toContain("treeTarget");
  });

  it("./html re-exports @mxlang/target-html's entry, compile included", () => {
    expect(Object.keys(htmlSubpath).sort()).toEqual(
      Object.keys(htmlEntry).sort(),
    );
    expect(htmlSubpath.compile).toBe(htmlEntry.compile);
    expect(htmlSubpath.compile("<p>hi</p>", "hi.mx").code).toContain(
      "<p>hi</p>",
    );
  });
});
