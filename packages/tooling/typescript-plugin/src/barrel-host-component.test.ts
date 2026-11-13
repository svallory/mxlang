// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createPluginService } from "./fixtures/plugin-service.ts";

/**
 * An MX tag re-exported from a `.ts` barrel (`import { Card as C } from
 * "./barrel"`) is a value import core routes through the dynamic dispatch, as
 * Marko does. The JSX hosts' type-check projection writes such a call as the
 * element the dispatch renders (`<C title={1} />`), so a wrong prop reports as
 * it does through `import Card from "./card.mx"`. A hand-written host
 * component and a string-valued import stay silent, as in hand-written TSX.
 *
 * Each host's directory carries only its `package.json` (`mx.host`); the
 * files below are in-memory.
 */

const fixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "expression-values",
);

const JSX_SOURCE: Record<string, string> = {
  preact: "preact",
  react: "react",
  hono: "hono/jsx",
};

const codes = (
  diagnostics: readonly { code: number; start?: number; length?: number }[],
) => diagnostics.map((d) => [d.code, d.start, d.length]);

describe.each(["preact", "react", "hono"])(
  "a host-component call through a .ts barrel on %s",
  // A cold plugin-service program is built per host and paid inside the
  // first test, as in the sibling plugin-service files.
  { timeout: 60_000 },
  (host) => {
    const at = (name: string) => join(fixtures, host, name);
    const service = createPluginService(
      {
        [at("card.mx")]:
          "export interface Input { title: string }\n<p>${input.title}</p>\n",
        [at("barrel.ts")]:
          'export { default as Card } from "./card.mx";\nexport const Tag = "div";\n',
        // `title` at 40.
        [at("page.mx")]: 'import { Card as C } from "./barrel"\n<C title=1/>\n',
        // `title` at 35.
        [at("direct.mx")]: 'import Card from "./card.mx"\n<Card title=1/>\n',
        [at("host.mx")]:
          `import { Fragment } from "${JSX_SOURCE[host]}"\n<Fragment><p/>x</Fragment>\n`,
        [at("tag.mx")]: 'import { Tag } from "./barrel"\n<Tag/>\n',
        // The callback's `x: string` at 53.
        [at("generic.mx")]:
          "static function G<T>(v: T, f: (x: T) => void) {}\n${G(1, (x: string) => {})}\n",
        [at("consumer.ts")]: ["page", "direct", "host", "tag", "generic"]
          .map((name) => `import "./${name}.mx";\n`)
          .join(""),
      },
      [at("consumer.ts")],
    );
    const reported = (name: string) =>
      codes(service.getSemanticDiagnostics(at(name)));

    it("reports a wrong prop at the attribute, as the direct .mx import does", () => {
      expect(reported("direct.mx")).toEqual([[2322, 35, 5]]);
      expect(reported("page.mx")).toEqual([[2322, 40, 5]]);
    });

    it("accepts a hand-written host component with a body and a string-valued import", () => {
      expect(reported("host.mx")).toEqual([]);
      expect(reported("tag.mx")).toEqual([]);
    });

    it("reports a generic static called with a mismatched callback", () => {
      expect(reported("generic.mx")).toEqual([[2345, 53, 1]]);
    });
  },
);

describe("a host-component call through a .ts barrel in a .preact.mx region", {
  timeout: 60_000,
}, () => {
  const at = (name: string) => join(fixtures, "preact", name);
  const service = createPluginService(
    {
      [at("card.mx")]:
        "export interface Input { title: string }\n<p>${input.title}</p>\n",
      [at("barrel.ts")]: 'export { default as Card } from "./card.mx";\n',
      // `title` at 63.
      [at("view.preact.mx")]:
        'import { Card as C } from "./barrel";\nexport const v = <div><C title=1/></div>;\n',
      [at("consumer.ts")]: 'import "./view.preact.mx";\n',
    },
    [at("consumer.ts")],
  );

  it("reports a wrong prop at the attribute", () => {
    // The region fixture declares no JSX namespace, so only the prop's own
    // diagnostic is read.
    expect(
      codes(service.getSemanticDiagnostics(at("view.preact.mx"))).filter(
        ([code]) => code === 2322,
      ),
    ).toEqual([[2322, 63, 5]]);
  });
});
