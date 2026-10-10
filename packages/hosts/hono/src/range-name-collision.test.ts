// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal mx source
/**
 * A `<for from/to>` mapper's own parameters are in scope for the authored
 * `from`/`to`/`step` expressions, which are written inside the same callback
 * (the row value has to be derived from the index). Before `__mxUnused` /
 * `__mxIndex`, those two generated names were `_` and `mxIndex` — both
 * plausible author names — so a `<const>` of the same name was *shadowed*
 * inside the callback and the loop rendered wrong values with no error.
 *
 * The emitter is shared with `@mxlang/host-preact` and `@mxlang/host-react` (this file's
 * cases are asserted there too); this suite runs the same cases through
 * Hono's own JSX runtime, per the host-parity rule the brief states.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { compileHonoMx } from "./index.ts";

const packageRoot = join(import.meta.dirname, "..");

async function render(source: string): Promise<string> {
  const { jsx } = (await import("hono/jsx")) as {
    jsx: (
      type: unknown,
      props: Record<string, unknown>,
    ) => { toString(): string | Promise<string> };
  };
  // Inside the package, not the OS tmpdir: `hono`'s `exports` map does not
  // expose `./package.json`, so a symlinked `node_modules` cannot be located
  // the way the preact/react suites locate theirs — bare resolution walking up
  // from here finds the workspace's real copy.
  const scratch = mkdtempSync(join(packageRoot, ".range-names-tmp-"));
  try {
    writeFileSync(
      join(scratch, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    writeFileSync(
      join(scratch, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "hono/jsx" },
      }),
    );
    const entry = join(scratch, "entry.mx");
    writeFileSync(entry, source);
    const out = join(scratch, "entry.tsx");
    const code = compileHonoMx(source, entry).code.replace(
      '"@mxlang/host-hono/runtime"',
      JSON.stringify(require.resolve("@mxlang/host-hono/runtime")),
    );
    writeFileSync(out, code);
    const mod = (await import(pathToFileURL(out).href)) as {
      default: (props: Record<string, unknown>) => unknown;
    };
    const html = jsx(mod.default, {}).toString();
    return typeof html === "string" ? html : await html;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("<for> range bounds are not shadowed by the mapper's own params", () => {
  it("renders `_` bounds, where the mapper's unused `_` used to shadow them", async () => {
    expect(
      await render("<const/_=5/>\n<for|i| from=_ to=_+2><b>${i}</b></for>"),
    ).toBe("<b>5</b><b>6</b><b>7</b>");
  });

  it("renders `_` bounds with a `step=`", async () => {
    expect(
      await render(
        "<const/_=5/>\n<for|i| from=_ to=_+4 step=2><b>${i}</b></for>",
      ),
    ).toBe("<b>5</b><b>7</b><b>9</b>");
  });

  it("renders `mxIndex` bounds, where the mapper's counter used to shadow them", async () => {
    expect(
      await render(
        "<const/mxIndex=10/>\n<for|i| from=mxIndex to=mxIndex+1><b>${i}</b></for>",
      ),
    ).toBe("<b>10</b><b>11</b>");
  });

  it("renders `mxIndex` bounds with a `step=`", async () => {
    expect(
      await render(
        "<const/mxIndex=10/>\n<for|i| from=mxIndex to=mxIndex+4 step=2><b>${i}</b></for>",
      ),
    ).toBe("<b>10</b><b>12</b><b>14</b>");
  });
});
