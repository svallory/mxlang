// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal mx source
/**
 * A `<for from/to>` mapper's own parameters are in scope for the authored
 * `from`/`to`/`step` expressions, which are written inside the same callback
 * (the row value has to be derived from the index). Before `__mxUnused` /
 * `__mxIndex`, those two generated names were `_` and `mxIndex` — both
 * plausible author names — so a `<const>` of the same name was *shadowed*
 * inside the callback and the loop rendered wrong values with no error:
 *
 * - `<const/_=5/>` + `<for|i| from=_ to=_+2>` rendered `NaN` three times
 *   (expected `5, 6, 7`); with `step=`, `NaN` again.
 * - `<const/mxIndex=10/>` + `<for|i| from=mxIndex to=mxIndex+1>` rendered
 *   `0, 2` (expected `10, 11`); with `step=2`, `0, 3, 6`.
 *
 * `until=` alone was never affected: its bound goes into the row *count*,
 * which is computed outside the callback.
 *
 * Rendered through `preact-render-to-string`, not asserted as emitted text:
 * the bug was invisible in the emitted source and only showed in the DOM.
 * Marko 6.3.51 renders the expected values for all of these.
 */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { type FunctionComponent, h } from "preact";
import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

async function render(source: string): Promise<string> {
  const { render } = (await import("preact-render-to-string")) as {
    render: (vnode: unknown) => string;
  };
  const scratch = mkdtempSync(join(tmpdir(), "mx-preact-range-names-"));
  try {
    symlinkSync(
      dirname(dirname(require.resolve("preact/package.json"))),
      join(scratch, "node_modules"),
      "dir",
    );
    writeFileSync(
      join(scratch, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    writeFileSync(
      join(scratch, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "preact" },
      }),
    );
    const entry = join(scratch, "entry.mx");
    writeFileSync(entry, source);
    const out = join(scratch, "entry.tsx");
    writeFileSync(out, compilePreactMx(source, entry).code);
    const mod = (await import(pathToFileURL(out).href)) as {
      default: FunctionComponent<Record<string, never>>;
    };
    return render(h(mod.default, {}));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("<for> range bounds are not shadowed by the mapper's own params", () => {
  it("renders `_` bounds, where the mapper's unused `_` used to shadow them", async () => {
    const html = await render(
      "<const/_=5/>\n<for|i| from=_ to=_+2><b>${i}</b></for>",
    );
    expect(html).toBe("<b>5</b><b>6</b><b>7</b>");
  });

  it("renders `_` bounds with a `step=`", async () => {
    const html = await render(
      "<const/_=5/>\n<for|i| from=_ to=_+4 step=2><b>${i}</b></for>",
    );
    expect(html).toBe("<b>5</b><b>7</b><b>9</b>");
  });

  it("renders `mxIndex` bounds, where the mapper's counter used to shadow them", async () => {
    const html = await render(
      "<const/mxIndex=10/>\n<for|i| from=mxIndex to=mxIndex+1><b>${i}</b></for>",
    );
    expect(html).toBe("<b>10</b><b>11</b>");
  });

  it("renders `mxIndex` bounds with a `step=`", async () => {
    const html = await render(
      "<const/mxIndex=10/>\n<for|i| from=mxIndex to=mxIndex+4 step=2><b>${i}</b></for>",
    );
    expect(html).toBe("<b>10</b><b>12</b><b>14</b>");
  });

  it("still honours an exclusive `until=` bound", async () => {
    const html = await render(
      "<const/_=5/>\n<for|i| until=_+2><b>${i}</b></for>",
    );
    expect(html).toBe(
      "<b>0</b><b>1</b><b>2</b><b>3</b><b>4</b><b>5</b><b>6</b>",
    );
  });

  it("reads an outer row's binding as a range bound", async () => {
    const html = await render(
      "<for|n| of=[1, 2]><for|i| from=n to=n><b>${i}</b></for></for>",
    );
    expect(html).toBe("<b>1</b><b>2</b>");
  });
});
