/**
 * Hard-wrapped source lines are one paragraph, as in CommonMark. docmd's
 * markdown-it defaults to `breaks: true`, which renders every wrapped line as
 * `<br>`; `docmd.config.json` sets `markdown.breaks: false` instead. These
 * tests render through docmd's own processor with that config.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(
  readFileSync(join(here, "..", "docmd.config.json"), "utf8"),
);

// `@docmd/parser` is core's dependency, not ours: resolve it from core.
const fromCore = createRequire(
  createRequire(import.meta.url).resolve("@docmd/core/package.json"),
);
const { createMarkdownProcessor } = (await import(
  fromCore.resolve("@docmd/parser")
)) as {
  createMarkdownProcessor: (config: unknown) => {
    render: (source: string) => string;
  };
};

const render = (source: string) =>
  createMarkdownProcessor(config).render(source);

describe("line breaks", () => {
  it("renders a hard-wrapped paragraph as one paragraph, with no <br>", () => {
    const html = render("one line that\nwraps onto the\nnext two lines.\n");
    expect(html).not.toContain("<br");
    expect(html).toContain("one line that\nwraps onto the\nnext two lines.");
  });

  it("renders a trailing double space as exactly one <br>", () => {
    const html = render("first line  \nsecond line\n");
    expect(html.match(/<br\s*\/?>/g)).toHaveLength(1);
  });

  it("renders a trailing backslash as exactly one <br>", () => {
    const html = render("first line\\\nsecond line\n");
    expect(html.match(/<br\s*\/?>/g)).toHaveLength(1);
  });
});
