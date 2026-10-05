import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "@mxlang/html";
import { describe, expect, it } from "vitest";
import { check, renderToStaticMarkup } from "./server.ts";

const dir = mkdtempSync(join(tmpdir(), "mx-astro-"));

/**
 * Compiles an MX template and imports the resulting module.
 *
 * Against components compiled by the real translator rather than hand-written
 * stand-ins: the brand `check` looks for is written by `@mxlang/html`'s
 * `postEmit`, so a fake would prove nothing about whether the two packages
 * actually agree on it.
 *
 * The module is written to a temp file and imported so Vite's own pipeline
 * transpiles it — the emitted code is TypeScript, and `@mxlang/html`'s
 * `escape` import has to resolve like it does in a real build.
 */
async function compileComponent(
  name: string,
  body: string,
): Promise<(input: Record<string, unknown>) => string> {
  const { code } = compile(
    body.endsWith("\n") ? body : `${body}\n`,
    "probe.mx",
  );
  const path = join(dir, `${name}.ts`);
  writeFileSync(path, code);

  const module = (await import(/* @vite-ignore */ path)) as {
    default: (input: Record<string, unknown>) => string;
  };
  return module.default;
}

describe("check", () => {
  it("claims a component compiled by the translator", async () => {
    const component = await compileComponent("brand", "<p>hi</p>");
    expect(await check(component)).toBe(true);
  });

  it("declines a plain function of the same call shape", async () => {
    // Every `(props) => string` in the project has this shape, so duck-typing
    // the signature would claim another renderer's components and render them
    // wrong rather than fail.
    expect(await check((_props: unknown) => "<p>hi</p>")).toBe(false);
  });

  it("declines non-functions", async () => {
    expect(await check(undefined)).toBe(false);
    expect(await check({})).toBe(false);
    expect(await check("<p>hi</p>")).toBe(false);
  });
});

describe("renderToStaticMarkup", () => {
  it("passes props straight through as the template's input", async () => {
    const component = await compileComponent(
      "props",
      "<h1>Hi ${input.name}</h1>",
    );
    const { html } = await renderToStaticMarkup(
      component,
      { name: "world" },
      {},
    );
    expect(html).toBe("<h1>Hi world</h1>");
  });

  it("maps Astro's default slot to MX's `content` prop", async () => {
    // MX names ordinary children `content` and hands them to the component as
    // a `() => string` thunk; Astro hands slots in as already-rendered HTML.
    const component = await compileComponent(
      "default-slot",
      "<section>$!{input.content()}</section>",
    );
    const { html } = await renderToStaticMarkup(
      component,
      {},
      {
        default: "<p>body</p>",
      },
    );
    expect(html).toBe("<section><p>body</p></section>");
  });

  it("maps a named slot to the attribute tag of the same name", async () => {
    const component = await compileComponent(
      "named-slot",
      "<article>$!{input.content()}<footer>$!{input.note()}</footer></article>",
    );
    const { html } = await renderToStaticMarkup(
      component,
      {},
      {
        default: "<p>body</p>",
        note: "<small>fine print</small>",
      },
    );
    expect(html).toBe(
      "<article><p>body</p><footer><small>fine print</small></footer></article>",
    );
  });

  it("exposes a named slot through the default data AttrTag shape", async () => {
    const component = await compileComponent(
      "named-slot-data",
      "export interface Input { note?: AttrTag }\n<aside>$!{input.note?.content?.()}</aside>",
    );
    const { html } = await renderToStaticMarkup(
      component,
      {},
      {
        note: "<strong>data view</strong>",
      },
    );

    expect(html).toBe("<aside><strong>data view</strong></aside>");
  });

  it("renders the data AttrTag body with the <${x.content}/> idiom", async () => {
    const component = await compileComponent(
      "named-slot-data-dynamic",
      "export interface Input { note?: AttrTag }\n<aside><${input.note?.content}/></aside>",
    );
    const { html } = await renderToStaticMarkup(
      component,
      {},
      {
        note: "<strong>dynamic data view</strong>",
      },
    );

    expect(html).toBe("<aside><strong>dynamic data view</strong></aside>");
  });

  it("exposes the same named slot through the renderable AttrTag shape", async () => {
    const component = await compileComponent(
      "named-slot-renderable",
      'export interface Input { note?: AttrTag<{ as: "renderable" }> }\n<aside>$!{input.note?.()}</aside>',
    );
    const { html } = await renderToStaticMarkup(
      component,
      {},
      {
        note: "<strong>renderable view</strong>",
      },
    );

    expect(html).toBe("<aside><strong>renderable view</strong></aside>");
  });

  it("inserts slot HTML verbatim, since Astro already rendered it", async () => {
    // The slot is markup, not text: escaping it here would double-escape what
    // Astro produced.
    const component = await compileComponent(
      "verbatim",
      "<div>$!{input.content()}</div>",
    );
    const { html } = await renderToStaticMarkup(
      component,
      {},
      {
        default: '<a href="/x">link &amp; more</a>',
      },
    );
    expect(html).toBe('<div><a href="/x">link &amp; more</a></div>');
  });

  it("renders with no slots at all", async () => {
    const component = await compileComponent("static", "<p>static</p>");
    const { html } = await renderToStaticMarkup(component, {}, {});
    expect(html).toBe("<p>static</p>");
  });
});

describe("client:* directives are an error", () => {
  // Astro does not raise one itself (`NoClientEntrypoint` is defined and never
  // thrown in 7.3.2), so this host does: an island that silently no-ops is
  // worse than a build failure on a host that ships no client JS.
  it.each([["load"], ["idle"], ["visible"], ["media"], ["only"]] as const)(
    "rejects client:%s, naming the component",
    async (hydrate) => {
      const component = await compileComponent(
        `hydrate-${hydrate}`,
        "<p>static</p>",
      );

      await expect(
        renderToStaticMarkup(
          component,
          {},
          {},
          { displayName: "Card", hydrate },
        ),
      ).rejects.toThrow(
        `\`Card\` is an MX component and renders statically: remove the \`client:${hydrate}\` directive.`,
      );
    },
  );

  it("renders normally when metadata carries no directive", async () => {
    // The ordinary path: Astro always passes metadata, and `hydrate` is absent
    // unless the author wrote a directive.
    const component = await compileComponent("no-directive", "<p>static</p>");
    const { html } = await renderToStaticMarkup(
      component,
      {},
      {},
      {
        displayName: "Card",
      },
    );
    expect(html).toBe("<p>static</p>");
  });

  // An imported `.mx` tag that declares `<return>` reaches Astro as an
  // ordinary component call, and Astro, not the call site, invokes it: the
  // renderer is the one place that can drop the value and keep the markup.
  it("renders the markup of a unit that declares <return>, dropping the value", async () => {
    const component = await compileComponent(
      "returns",
      "<span>${input.start}</span>\n<return value=input.start + 1/>",
    );
    const { html } = await renderToStaticMarkup(component, { start: 1 }, {});
    expect(html).toBe("<span>1</span>");
  });
});
