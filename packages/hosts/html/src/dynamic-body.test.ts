// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag/placeholder syntax in template source
/**
 * A body forwarded through `<${input.content}/>`, rendered for real: the html
 * host is the reference shape (its `content` is a renderer, never a string),
 * so a text-only body already renders as text. Regression guard for the same
 * matrix the JSX hosts' `dynamic-body.test.ts` pin, with the expected HTML
 * stock Marko 6.3.51 renders (scratch/squad-liuna/jsx-dynamic-body-text.md).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadMx } from "./helpers.ts";

const packageRoot = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(packageRoot, ".mx-helpers-dynbody-tmp-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
mkdirSync(join(dir, "tags"));
writeFileSync(
  join(dir, "tags", "wrap.mx"),
  "<section><${input.content}/></section>",
);

let serial = 0;
function render(page: string, input: Record<string, unknown> = {}): string {
  const path = join(dir, `page${serial++}.mx`);
  writeFileSync(path, page);
  return loadMx<Record<string, unknown>>(path)(input);
}

describe("a body forwarded through <${input.content}/> (html, Marko parity)", () => {
  it.each([
    ["(a) text-only", "<wrap>hello</wrap>", {}, "<section>hello</section>"],
    ["(b) element", "<wrap><b>x</b></wrap>", {}, "<section><b>x</b></section>"],
    [
      "(c) mixed",
      "<wrap>a <i>b</i> c</wrap>",
      {},
      "<section>a <i>b</i> c</section>",
    ],
    ["(d) no body", "<wrap/>", {}, "<section></section>"],
    [
      "(e) placeholder",
      "<wrap>hi ${input.x}</wrap>",
      { x: "div" },
      "<section>hi div</section>",
    ],
    [
      "(e2) sole placeholder holding a tag name",
      "<wrap>${input.x}</wrap>",
      { x: "em" },
      "<section>em</section>",
    ],
    [
      "escaped markup",
      "<wrap>${input.x}</wrap>",
      { x: "<b>" },
      "<section>&lt;b&gt;</section>",
    ],
  ])("%s", (_label, page, input, expected) => {
    expect(render(page, input as Record<string, unknown>)).toBe(expected);
  });
});
