import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import markoPlugin from "./bun.ts";

/**
 * A `.mx` page calling a tag from `tags/`, compiled and run for real through
 * the Bun loader. A `.marko` file is no MX input (decision 172): it is never
 * loaded here, and a call that finds one is a compile error.
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
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a .mx page calling a tags/*.mx tag", () => {
  test("renders input attributes and body content", async () => {
    const dir = "basic";
    write(
      `${dir}/tags/badge.mx`,
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
    write(`${dir}/tags/fancy-btn.mx`, `<button>\${input.label}</button>`);
    const page = write(
      `${dir}/page.mx`,
      `<div><fancy-btn label="a"/><fancy-btn label="b"/></div>`,
    );
    expect(await render(page)).toBe(
      `<div><button>a</button><button>b</button></div>`,
    );
  });

  test("a .marko tag is a compile error naming the file", async () => {
    const dir = "marko-tag";
    write(`${dir}/tags/card.marko`, `<div>\${input.title}</div>`);
    const page = write(`${dir}/page.mx`, `<card title="T"/>`);
    await expect(render(page)).rejects.toThrow(
      "`<card>` resolves to `tags/card.marko`, a `.marko` file",
    );
  });

  test("a directory tag (tags/card/index.mx) is a compile error naming the file", async () => {
    const dir = "dirtag";
    write(`${dir}/tags/card/index.mx`, `<div>\${input.title}</div>`);
    const page = write(`${dir}/page.mx`, `<card title="T"/>`);
    await expect(render(page)).rejects.toThrow("matches `tags/card/index.mx`");
  });

  test("tags/ is found up the tree from a nested page directory", async () => {
    const dir = "nested";
    write(`${dir}/tags/badge.mx`, `<i>\${input.label}</i>`);
    const page = write(`${dir}/a/b/c/page.mx`, `<badge label="deep"/>`);
    expect(await render(page)).toBe(`<i>deep</i>`);
  });

  test("the nearest tags/ wins per name, the rest come from further up", async () => {
    const dir = "nearest";
    write(`${dir}/tags/badge.mx`, `<i>far \${input.label}</i>`);
    write(`${dir}/tags/other.mx`, `<u>\${input.label}</u>`);
    write(`${dir}/sub/tags/badge.mx`, `<b>near \${input.label}</b>`);
    const page = write(
      `${dir}/sub/page.mx`,
      `<div><badge label="x"/><other label="y"/></div>`,
    );
    expect(await render(page)).toBe(`<div><b>near x</b><u>y</u></div>`);
  });

  test("a .mx tag calling another .mx tag", async () => {
    const dir = "chain";
    write(`${dir}/tags/inner.mx`, `<i>\${input.label}</i>`);
    write(`${dir}/tags/outer.mx`, `<div><inner label=input.label/></div>`);
    const page = write(`${dir}/page.mx`, `<outer label="z"/>`);
    expect(await render(page)).toBe(`<div><i>z</i></div>`);
  });

  test("a same-name tags/*.marko file is never consulted: the .mx tag wins", async () => {
    // Marko has no `.mx`, so this is an mx rule, not a Marko one: registered
    // custom tags are consulted before the taglib lookup.
    const dir = "conflict";
    write(`${dir}/tags/dup.mx`, `<i>mx \${input.label}</i>`);
    write(`${dir}/tags/dup.marko`, `<i>marko \${input.label}</i>`);
    const page = write(`${dir}/page.mx`, `<dup label="q"/>`);
    expect(await render(page)).toBe(`<i>mx q</i>`);
  });

  test("a FAR tags/*.mx tag beats a NEAR tags/*.marko file of the same name", async () => {
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
    write(`${dir}/tags/Badge.mx`, `<i>tags</i>`);
    write(`${dir}/other.mx`, `<b>explicit</b>`);
    const page = write(
      `${dir}/page.mx`,
      `import Badge from "./other.mx"\n<Badge/>`,
    );
    expect(await render(page)).toBe(`<b>explicit</b>`);
  });
  test("a lowercase registered tag beats a same-named import or define (decision 164 addendum 1)", async () => {
    // A lowercase tag never calls a binding, so the registered `tags/row.mx`
    // is called, not the authored `./row.mx` import or `<define/row>`.
    const dir = "lowercase-binding";
    write(`${dir}/tags/row.mx`, `<p>\${input.label}</p>`);
    // The authored module declares `<return>` and an `Input`, so a call that
    // read the import's metadata would render nothing or reject the props.
    write(
      `${dir}/row.mx`,
      `export interface Input { label: number; item?: { x: number } }\n<i>import</i>\n<return value=42/>`,
    );
    const imported = write(
      `${dir}/imported.mx`,
      `import row from "./row.mx"\n<row label="x"/>`,
    );
    expect(await render(imported)).toBe(`<p>x</p>`);
    const defined = write(
      `${dir}/defined.mx`,
      `<define/row|y|><i>define</i></define>\n<row label="y"/>`,
    );
    expect(await render(defined)).toBe(`<p>y</p>`);
  });
});
