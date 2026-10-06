/**
 * The fragment-link gate's own tests.
 *
 * Two halves: a synthetic site tree, so the walk's rules (same-page,
 * root-relative, relative, trailing slash, percent-encoded, external hrefs,
 * a missing page) are pinned without a build, and the real built site when
 * one exists, which is the end-to-end answer to "does any `#fragment` in the
 * docs resolve" — skipped when `site/` is absent, as it is on a fresh
 * worktree.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  findBrokenAnchors,
  formatBrokenAnchors,
  resolveTarget,
  siteHtmlFiles,
  siteRoot,
} from "./anchors.ts";

/** A synthetic `site/` with one good link, one broken id and one missing page. */
function fixtureSite(): string {
  const root = mkdtempSync(join(tmpdir(), "mx-anchors-"));
  const page = (rel: string, html: string) => {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, html);
  };
  page(
    "language/atoms/index.html",
    '<h1 id="atoms">Atoms</h1><h2 id="atoms-known-limits">Known limits</h2>' +
      '<a href="#atoms-known-limits">same page</a>' +
      '<a href="#nope">same page, broken</a>',
  );
  page(
    "custom-tags/sidecars/index.html",
    '<h1 id="sidecars">Sidecars</h1><h2 id="sidecars-declare-the-call-contract">x</h2>' +
      '<a href="/language/atoms/#atoms-known-limits">absolute, good</a>' +
      '<a href="/language/atoms/#known-limits">absolute, broken</a>' +
      '<a href="../../language/atoms/#atoms-known-limits">relative, good</a>' +
      '<a href="/language/atoms/#atoms%2Dknown%2Dlimits">percent-encoded, good</a>' +
      '<a href="/language/atoms/">no fragment, ignored</a>' +
      '<a href="/nowhere/#x">missing page</a>' +
      '<a href="https://example.com/#x">external, ignored</a>' +
      '<a href="#sidecars-declare-the-call-contract">fragment only</a>',
  );
  return root;
}

describe("findBrokenAnchors", () => {
  const root = fixtureSite();
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("reports only the hrefs that resolve to no id", () => {
    expect(formatBrokenAnchors(findBrokenAnchors(root))).toEqual([
      "custom-tags/sidecars/index.html: /language/atoms/#known-limits -> missing id",
      "custom-tags/sidecars/index.html: /nowhere/#x -> missing id",
      "language/atoms/index.html: #nope -> missing id",
    ]);
  });

  it("walks every built page", () => {
    expect(siteHtmlFiles(root).map((f) => f.slice(root.length + 1))).toEqual([
      "custom-tags/sidecars/index.html",
      "language/atoms/index.html",
    ]);
  });

  it("resolves a bare fragment to the page carrying it", () => {
    const from = join(root, "language/atoms/index.html");
    expect(resolveTarget("#x", from, root)).toBe(from);
  });
});

describe("the built site", () => {
  // A fresh worktree has no `site/`; the docs build runs before this in CI.
  it.skipIf(!existsSync(siteRoot))(
    "resolves every fragment link",
    () => {
      expect(formatBrokenAnchors(findBrokenAnchors(siteRoot))).toEqual([]);
    },
    120_000,
  );
});
