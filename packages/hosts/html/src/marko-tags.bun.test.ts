import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scanCached } from "@mxlang/core";
import markoPlugin from "./bun.ts";
import { compileFile } from "./index.ts";

/**
 * A `.mx` page calling a tag from `tags/*.marko`, compiled and run for real.
 *
 * Marko imports every tag its taglib lookup finds
 * (`import _badge from "./tags/badge.marko"`); the emitted page must do the
 * same, or the bare call throws a `ReferenceError` at run time. These tests
 * execute the rendered module rather than matching emitted text, so they hold
 * whatever the import is spelled.
 */

// Inside the package, not `tmpdir()`: the emitted modules import `@mxlang/html`
// by bare specifier, which only resolves from within the package tree.
const root = mkdtempSync(join(import.meta.dirname, "..", ".tmp-marko-tags-"));

function write(rel: string, source: string): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  return path;
}

async function render(
  path: string,
  input: Record<string, unknown> = {},
): Promise<string> {
  const mod = (await import(path)) as {
    default: (input: unknown) => string;
  };
  return mod.default(input);
}

beforeAll(() => {
  Bun.plugin(markoPlugin);
  // The shipped plugin claims only `.mx`; the `.marko` tag files need a loader.
  // Scoped to this test's directory: plugins are process-wide, and
  // `bun.test.ts` asserts that a `.marko` path is NOT claimed.
  Bun.plugin({
    name: "mxlang-marko-tags-test",
    setup(build) {
      build.onLoad(
        { filter: /\.tmp-marko-tags-[^/]+\/.*\.marko$/ },
        ({ path }) => ({
          contents: compileFile(path, {
            customTags: scanCached(path, { host: "html" }).customTags,
          }).code,
          loader: "ts",
        }),
      );
    },
  });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a .mx page calling a tags/*.marko tag", () => {
  test("renders input attributes and body content", async () => {
    const dir = "basic";
    write(
      `${dir}/tags/badge.marko`,
      `<span class="badge">\${input.label}<\${input.content}/></span>`,
    );
    const page = write(
      `${dir}/page.mx`,
      `<div><badge label=input.text>body &amp; <b>more</b></badge></div>`,
    );
    expect(await render(page, { text: "<hi>" })).toBe(
      `<div><span class="badge">&lt;hi&gt;body &amp; <b>more</b></span></div>`,
    );
  });

  test("a hyphenated tag name and a repeated call", async () => {
    const dir = "hyphen";
    write(`${dir}/tags/fancy-btn.marko`, `<button>\${input.label}</button>`);
    const page = write(
      `${dir}/page.mx`,
      `<div><fancy-btn label="a"/><fancy-btn label="b"/></div>`,
    );
    expect(await render(page)).toBe(
      `<div><button>a</button><button>b</button></div>`,
    );
  });

  test("a directory tag (tags/card/index.marko)", async () => {
    const dir = "dirtag";
    write(
      `${dir}/tags/card/index.marko`,
      `<div class="card">\${input.title}</div>`,
    );
    const page = write(`${dir}/page.mx`, `<card title="T"/>`);
    expect(await render(page)).toBe(`<div class="card">T</div>`);
  });

  test("tags/ is found up the tree from a nested page directory", async () => {
    const dir = "nested";
    write(`${dir}/tags/badge.marko`, `<i>\${input.label}</i>`);
    const page = write(`${dir}/a/b/c/page.mx`, `<badge label="deep"/>`);
    expect(await render(page)).toBe(`<i>deep</i>`);
  });

  test("the nearest tags/ wins per name, the rest come from further up", async () => {
    const dir = "nearest";
    write(`${dir}/tags/badge.marko`, `<i>far \${input.label}</i>`);
    write(`${dir}/tags/other.marko`, `<u>\${input.label}</u>`);
    write(`${dir}/sub/tags/badge.marko`, `<b>near \${input.label}</b>`);
    const page = write(
      `${dir}/sub/page.mx`,
      `<div><badge label="x"/><other label="y"/></div>`,
    );
    expect(await render(page)).toBe(`<div><b>near x</b><u>y</u></div>`);
  });

  test("a tags/*.mx tag and a tags/*.marko tag used together", async () => {
    const dir = "mixed";
    write(`${dir}/tags/from-mx.mx`, `<em>\${input.label}</em>`);
    write(`${dir}/tags/from-marko.marko`, `<strong>\${input.label}</strong>`);
    const page = write(
      `${dir}/page.mx`,
      `<p><from-mx label="a"/><from-marko label="b"/></p>`,
    );
    expect(await render(page)).toBe(`<p><em>a</em><strong>b</strong></p>`);
  });

  test("a .marko tag calling another .marko tag", async () => {
    const dir = "chain";
    write(`${dir}/tags/inner.marko`, `<i>\${input.label}</i>`);
    write(`${dir}/tags/outer.marko`, `<div><inner label=input.label/></div>`);
    const page = write(`${dir}/page.mx`, `<outer label="z"/>`);
    expect(await render(page)).toBe(`<div><i>z</i></div>`);
  });

  test("same name as a tags/*.mx tag in the same directory: the .mx tag wins", async () => {
    // Marko has no `.mx`, so this is an mx rule, not a Marko one: registered
    // custom tags are consulted before the taglib lookup.
    const dir = "conflict";
    write(`${dir}/tags/dup.mx`, `<i>mx \${input.label}</i>`);
    write(`${dir}/tags/dup.marko`, `<i>marko \${input.label}</i>`);
    const page = write(`${dir}/page.mx`, `<dup label="q"/>`);
    expect(await render(page)).toBe(`<i>mx q</i>`);
  });

  test("a FAR tags/*.mx tag beats a NEAR tags/*.marko tag of the same name", async () => {
    // "Regardless of distance": the .mx tag is in an ancestor's tags/, the
    // .marko one in the page's own directory, and the .mx tag still wins.
    const dir = "far-mx";
    write(`${dir}/tags/dup.mx`, `<i>far mx \${input.label}</i>`);
    write(`${dir}/sub/tags/dup.marko`, `<i>near marko \${input.label}</i>`);
    const page = write(`${dir}/sub/page.mx`, `<dup label="q"/>`);
    expect(await render(page)).toBe(`<i>far mx q</i>`);
  });

  test("an explicit import of the same name is not shadowed by discovery", async () => {
    const dir = "explicit";
    write(`${dir}/tags/Badge.marko`, `<i>tags</i>`);
    write(`${dir}/other.marko`, `<b>explicit</b>`);
    const page = write(
      `${dir}/page.mx`,
      `import Badge from "./other.marko"\n<Badge/>`,
    );
    expect(await render(page)).toBe(`<b>explicit</b>`);
  });
});
