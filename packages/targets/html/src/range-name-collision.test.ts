// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal mx source
/**
 * The html host never had the range-mapper shadowing bug the JSX, Solid and
 * Astro hosts had: it binds its own `__mxForN` temporaries for `from`/`to`
 * *before* the `for` opens, so no generated binding is ever in scope where an
 * authored expression is evaluated. Pinned here so a refactor to a
 * `Array.from`/`.map` shape cannot reintroduce it silently.
 *
 * `<for step=...>` is rejected by this host outright, so the `step=` half of
 * the matrix has no case here by construction.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadMx } from "./helpers.ts";

const packageRoot = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(packageRoot, ".mx-range-names-tmp-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
mkdirSync(join(dir, "tags"));

let serial = 0;
function render(page: string): string {
  const path = join(dir, `page${serial++}.mx`);
  writeFileSync(path, page);
  return loadMx<Record<string, unknown>>(path)({});
}

describe("<for> range bounds are not shadowed (html)", () => {
  it("renders `_` bounds", () => {
    expect(
      render("<const/_=5/>\n<for|i| from=_ to=_+2><b>${i}</b></for>"),
    ).toBe("<b>5</b><b>6</b><b>7</b>");
  });

  it("renders `mxIndex` bounds", () => {
    expect(
      render(
        "<const/mxIndex=10/>\n<for|i| from=mxIndex to=mxIndex+1><b>${i}</b></for>",
      ),
    ).toBe("<b>10</b><b>11</b>");
  });

  it("honours an exclusive `until=` bound", () => {
    expect(render("<const/_=5/>\n<for|i| until=_+2><b>${i}</b></for>")).toBe(
      "<b>0</b><b>1</b><b>2</b><b>3</b><b>4</b><b>5</b><b>6</b>",
    );
  });

  it("reads an outer row's binding as a range bound", () => {
    expect(
      render("<for|n| of=[1, 2]><for|i| from=n to=n><b>${i}</b></for></for>"),
    ).toBe("<b>1</b><b>2</b>");
  });
});
