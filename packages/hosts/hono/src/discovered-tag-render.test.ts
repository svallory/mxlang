// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCustomTags } from "@mxlang/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileHonoMx } from "./index.ts";
import { printHonoMx, renderPrinted, targets } from "./region-test-helpers.ts";

/**
 * A custom tag found by the normal `tags/` scan (not path-registered), called
 * with an attribute and a body and rendered through Hono's real renderer
 * (`hono-render-to-string`), whole-file (`.mx`) and in a `.hono.mx` region.
 * Asserting the rendered HTML, not the emitted text, is what catches a
 * discovered tag that ships as a literal element or throws at render time
 * (the `.astro.mx` bug of PR #375).
 */
const dir = mkdtempSync(join(tmpdir(), "mx-hono-discovered-tag-"));

const BADGE = [
  "export interface Input { label: string }",
  "<b title=input.label>${input.label}:<${input.content}/></b>",
  "",
].join("\n");

beforeAll(() => {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t" }));
  mkdirSync(join(dir, "tags"));
  writeFileSync(join(dir, "tags", "badge.mx"), BADGE);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function whole(source: string): Promise<string> {
  const file = join(dir, "page.mx");
  const { code } = compileHonoMx(source, file, {
    targets,
    customTags: getCustomTags(file, { targets }),
  });
  return renderPrinted(code, dir);
}

function region(body: string): Promise<string> {
  const file = join(dir, "page.hono.mx");
  const source = `export default function Page() {\n  return (<>${body}</>);\n}\n`;
  return renderPrinted(printHonoMx(source, file), dir);
}

describe("a discovered custom tag, rendered on Hono", () => {
  it("scans the tag rather than being handed it", () => {
    const tags = getCustomTags(join(dir, "page.mx"), { targets });
    expect(Object.keys(tags)).toEqual(["badge"]);
  });

  it("whole-file: renders the tag's markup with its attribute and body", async () => {
    expect(await whole('<div><badge label="a">hi</badge></div>')).toBe(
      '<div><b title="a">a:hi</b></div>',
    );
  });

  it("whole-file: renders every call, nested markup in the body", async () => {
    expect(
      await whole('<badge label="a"><i>x</i></badge><p><badge label="b"/></p>'),
    ).toBe('<b title="a">a:<i>x</i></b><p><b title="b">b:</b></p>');
  });

  it("region: renders the tag's markup with its attribute and body", async () => {
    expect(await region('<div><badge label="a">hi</badge></div>')).toBe(
      '<div><b title="a">a:hi</b></div>',
    );
  });

  it("region: renders a dynamic attribute and a repeated call", async () => {
    expect(
      await region(
        "<for|n| of=[1, 2] by=(n) => n><badge label=`n${n}`>${n}</badge></for>",
      ),
    ).toBe('<b title="n1">n1:1</b><b title="n2">n2:2</b>');
  });
});
