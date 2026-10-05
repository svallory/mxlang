/**
 * The paths that discover tags for themselves (`loadMx`, `mx` with a
 * `filename`, nested tags, the Bun loader) read the package's
 * `mx.html.defaultTag`, validate it with core's shared check, and put it in
 * their cache keys (decision 145, review rounds 2 and 3).
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getCustomTags } from "@mxlang/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configuredDefaultTag,
  resetReportedDefaultTags,
} from "./default-tag.ts";
import { loadMx, mx } from "./helpers.ts";
import { htmlTargets } from "./index.ts";

const packageRoot = new URL("..", import.meta.url).pathname;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  resetReportedDefaultTags();
  vi.restoreAllMocks();
});

function project(defaultTag?: unknown): {
  dir: string;
  page: string;
  config: (v: unknown) => void;
} {
  const dir = mkdtempSync(join(packageRoot, ".mx-default-tag-tmp-"));
  dirs.push(dir);
  mkdirSync(join(dir, "tags"));
  const config = (value: unknown) => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ mx: { target: "html", html: { defaultTag: value } } }),
    );
    // Same size and often the same second: make the stat stamp differ.
    const t = new Date(Date.now() + Math.floor(Math.random() * 1e6));
    utimesSync(join(dir, "package.json"), t, t);
  };
  if (defaultTag === undefined)
    writeFileSync(join(dir, "package.json"), '{"mx":{"target":"html"}}');
  else config(defaultTag);
  writeFileSync(join(dir, "page.mx"), "<.x>hi</>\n<my-card/>\n");
  writeFileSync(join(dir, "tags", "my-card.mx"), "<#inner>c</>\n");
  return { dir, page: join(dir, "page.mx"), config };
}

describe("loadMx reads the package's validated defaultTag", () => {
  it("applies it to the page and to a nested tag, and a changed config changes the output", () => {
    const { page, config } = project("section");
    expect(loadMx(page)({})).toBe(
      '<section class="x">hi</section><section id="inner">c</section>',
    );
    config("article");
    expect(loadMx(page)({})).toBe(
      '<article class="x">hi</article><article id="inner">c</article>',
    );
    config("section");
    expect(loadMx(page)({})).toBe(
      '<section class="x">hi</section><section id="inner">c</section>',
    );
  });

  it("without config the output is the built-in", () => {
    const { page } = project();
    expect(loadMx(page)({})).toBe(
      '<div class="x">hi</div><div id="inner">c</div>',
    );
  });

  it("an explicit option beats the package", () => {
    const { page } = project("section");
    expect(loadMx(page, { defaultTag: "main" })({})).toContain("<main");
  });

  it("an invalid value is dropped, the built-in answers, and one warning names the package.json position", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { page } = project("input");
    expect(loadMx(page)({})).toBe(
      '<div class="x">hi</div><div id="inner">c</div>',
    );
    loadMx(page)({});
    const messages = warn.mock.calls.map((c) => String(c[0]));
    const mine = messages.filter((m) =>
      m.includes("invalid `defaultTag` value"),
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatch(
      /package\.json:1:\d+: invalid `defaultTag` value: `<input>` is a void tag/,
    );
  });
});

describe("mx(source, { filename }) reads it too", () => {
  it("applies the package's value", () => {
    const { page } = project("section");
    expect(mx("<.x/>", { filename: page })({})).toBe(
      '<section class="x"></section>',
    );
  });

  it("a source with no filename has no package: the built-in", () => {
    expect(mx("<.x/>")({})).toBe('<div class="x"></div>');
  });
});

describe("configuredDefaultTag (the helper the Bun loader shares)", () => {
  it("returns a valid value, a custom tag from tags/ included", () => {
    const { page } = project("my-card");
    const customTags = getCustomTags(page, {
      host: "html",
      targets: htmlTargets,
    });
    expect(configuredDefaultTag(page, customTags, htmlTargets)).toBe("my-card");
  });

  it("drops core tags the lookup also holds", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { page } = project("await");
    const customTags = getCustomTags(page, {
      host: "html",
      targets: htmlTargets,
    });
    expect(configuredDefaultTag(page, customTags, htmlTargets)).toBeUndefined();
  });

  it("is undefined when nothing is configured", () => {
    const { page } = project();
    expect(configuredDefaultTag(page, {}, htmlTargets)).toBeUndefined();
  });
});
