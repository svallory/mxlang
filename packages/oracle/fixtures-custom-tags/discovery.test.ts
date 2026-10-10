/**
 * The acceptance gate for P2: one shared fixture project, reached from every
 * integration that must run the scan (spec §4's list).
 *
 * The fixture (`discovered/`) is deliberately import-free. `src/page.mx`
 * calls `<icon>` and `<snippet>` with no `import` statement anywhere, so a
 * row here passes only if that integration actually discovered
 * `discovered/tags/`. `<snippet>` additionally declares
 * `parseOptions: { text: true }` and its body contains `<` and `#`, which
 * Marko would otherwise read as a tag and a shorthand id — so the row also
 * proves the declaration reached the parser *before* the caller was parsed,
 * which is only possible if the scan read it without executing the sidecar.
 *
 * This file covers the hosts the oracle already depends on. The three tooling
 * integrations — the Vite plugin, the TypeScript plugin and the language
 * server — assert the same fixture from inside their own packages, where the
 * dependency already exists; adding them here would make the oracle depend on
 * the whole toolchain in order to test discovery.
 *
 * Counted (decision 55): the suite asserts how many integrations it covered,
 * so an integration silently not running is a failure rather than a smaller
 * green run.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clearScanCache } from "@mxlang/core";
import { compileHonoMx } from "@mxlang/host-hono";
import { compilePreactMx } from "@mxlang/host-preact";
import { compileReactMx } from "@mxlang/host-react";
import { compile as compileHtml } from "@mxlang/target-html";
import { getCustomTags } from "@mxlang/targets";
import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const project = join(here, "discovered");
const page = join(project, "src", "page.mx");
const source = readFileSync(page, "utf8");
const expected = readFileSync(join(project, "expected.html"), "utf8").trim();

/**
 * What this file proves, and nothing more.
 *
 * The Bun loaders are deliberately absent: a row here can only call a host's
 * `compile*` with a map it fetched itself, which stays green even with
 * `getCustomTags` deleted from `bun.ts`. They are covered where they can
 * actually be driven — `packages/{targets/html,hosts/hono}/src/bun.test.ts`, which
 * import a page *through* `Bun.plugin` under `bun test` (verified to fail
 * when the loader's own call is removed). The count gate must reflect real
 * integrations, so it counts only the rows below.
 */
const COVERED_INTEGRATIONS = ["core scan", "html host", "hono host"] as const;

const covered = new Set<string>();

function cover(name: (typeof COVERED_INTEGRATIONS)[number]): void {
  covered.add(name);
}

afterEach(() => {
  clearScanCache();
});

describe("custom tag discovery, per integration", () => {
  it("the scan itself finds both tags with no import", () => {
    const tags = getCustomTags(page);

    expect(Object.keys(tags).sort()).toEqual(["icon", "note", "snippet"]);
    // Read statically, before any hook ran and before the caller is parsed.
    expect(tags.snippet?.parseOptions).toEqual({ text: true });
    cover("core scan");
  });

  it("renders the fixture through the HTML host with a discovered tag", () => {
    const { code } = compileHtml(source, page, {
      customTags: getCustomTags(page),
    });

    // `<` and `#` survive verbatim inside `<pre>`, which only happens when
    // `parseOptions.text` reached Marko before this file was parsed.
    expect(code).toContain('<pre>if (a < b) { id = \\"#main\\"; }</pre>');
    expect(code).toContain("<title>check</title>");
    cover("html host");
  });

  it("compiles the fixture through the Hono host with a discovered tag", () => {
    const { code } = compileHonoMx(source, page, {
      customTags: getCustomTags(page),
    });

    expect(code).toContain("check");
    expect(code).toContain("#main");
    cover("hono host");
  });

  it("compiles the fixture through the Preact and React hosts", () => {
    const tags = getCustomTags(page);

    expect(compilePreactMx(source, page, { customTags: tags }).code).toContain(
      "check",
    );
    expect(compileReactMx(source, page, { customTags: tags }).code).toContain(
      "check",
    );
  });

  it("covered every integration the spec lists", () => {
    expect([...covered].sort()).toEqual([...COVERED_INTEGRATIONS].sort());
    expect(covered.size).toBe(COVERED_INTEGRATIONS.length);
  });

  it("keeps the shared fixture project intact", () => {
    expect(existsSync(join(project, "tags", "icon.tag.ts"))).toBe(true);
    expect(existsSync(join(project, "tags", "snippet.tag.ts"))).toBe(true);
    expect(source).not.toContain("import");
    expect(expected).toContain("#main");
  });
});
