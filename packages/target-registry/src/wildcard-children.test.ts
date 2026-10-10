import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CustomTag } from "@mxlang/core";
import * as core from "@mxlang/core";
import { afterAll, describe, expect, it } from "vitest";
import { builtinLookup, builtinTargets } from "./index.ts";

/**
 * `children["*"]` per target family (decision 147): inside a contract parent
 * the contract decides, so a lowercase child matches on every target exactly
 * as on html and under lowerSource, native-element name or not; outside a contract parent
 * the target's own behaviour is unchanged. A target's built-ins are never
 * matched.
 *
 * Measured, outside a contract parent (`<zork>` is no tag anywhere):
 *   html, astro-html           : error, Marko's "Unable to find entry point"
 *   solid, preact, react, hono : a native element
 *   angular-template           : a native element
 *   lowerSource (the IR entry) : a tree node (`unknownTags` defaults to allow)
 */

const work = mkdtempSync(join(tmpdir(), "mx-wildcard-children-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
writeFileSync(join(work, "package.json"), "{}");

const customTags: Record<string, CustomTag> = {
  attribute: { attributes: { value: {} } },
  resource: {
    children: { "*": [{ pattern: "[a-z]+", contract: "attribute" }] },
  },
};

/** The names a wildcard parent claims in these tests: an element name and a name nothing resolves. */
const NAMES = ["title", "zork"] as const;

const inside = (name: string) => `<resource><${name} nope="a"/></resource>\n`;
const outside = (name: string) => `<${name} nope="a"/>\n`;

type Compile = (source: string, file: string) => unknown;

const byDescriptor =
  (name: string, extra: object = {}): Compile =>
  (source, file) =>
    builtinTargets
      .find((target) => target.name === name)
      ?.load?.(core)
      .compileModule(source, file, {
        customTags,
        targets: builtinLookup(),
        ...extra,
      });

const compilers: [string, Compile][] = [
  ["html", byDescriptor("html")],
  ["astro-html", byDescriptor("astro-html", { strict: true })],
  ["solid-jsx", byDescriptor("solid-jsx")],
  ["preact-jsx", byDescriptor("preact-jsx")],
  ["react-jsx", byDescriptor("react-jsx")],
  ["hono-jsx", byDescriptor("hono-jsx")],
  [
    "angular-template",
    (source, file) =>
      import("@mxlang/host-angular").then((m) =>
        m.compile(source, file, { customTags, targets: builtinLookup() }),
      ),
  ],
];

const page = (name: string) => join(work, `${name}.mx`);

/** What a compile did: its error message, or `ok`. */
async function run(compile: Compile, source: string, file: string) {
  try {
    await compile(source, file);
    return "ok";
  } catch (error) {
    return (error as Error).message;
  }
}

describe("a wildcard parent claims a lowercase child on every target", () => {
  it.each(compilers.flatMap(([t, c]) => NAMES.map((n) => [t, n, c] as const)))(
    "%s: <%s> inside the contract parent is checked as the contract",
    async (target, name, compile) => {
      const message = await run(compile, inside(name), page(target));
      // The referenced contract is a bare declaration (no template to expand),
      // which core reports against the matched child: that error is the proof
      // the contract claimed it, by its authored and its canonical name.
      expect(message).toContain(`\`<${name}>\` (as \`attribute\`)`);
    },
  );

  it.each(NAMES)(
    "lowerSource: <%s> inside the contract parent is the contract's",
    (name) => {
      const { diagnostics } = core.lowerSource(inside(name), "/d.mx", {
        customTags,
      });
      expect(diagnostics[0]?.message).toContain("nope");
      expect(diagnostics[0]?.message).toContain(
        `\`<${name}>\` (as \`attribute\`)`,
      );
    },
  );
});

describe("outside a contract parent each target keeps its behaviour", () => {
  it.each(compilers)(
    "%s: an element name compiles as before",
    async (target, compile) => {
      expect(await run(compile, outside("title"), page(`${target}-t`))).toBe(
        "ok",
      );
    },
  );

  it.each(["html", "astro-html"])(
    "%s: a name nothing resolves is Marko's unknown-tag error",
    async (target) => {
      const compile = compilers.find(
        ([name]) => name === target,
      )?.[1] as Compile;
      expect(
        await run(compile, outside("zork"), page(`${target}-z`)),
      ).toContain("Unable to find entry point for custom tag");
    },
  );

  it.each(compilers.filter(([t]) => t !== "html" && t !== "astro-html"))(
    "%s: a name nothing resolves is a native element",
    async (target, compile) => {
      expect(await run(compile, outside("zork"), page(`${target}-z`))).toBe(
        "ok",
      );
    },
  );

  it("lowerSource: it is a tree node by default and an error under reject", () => {
    expect(
      core.lowerSource(outside("zork"), "/d.mx", { customTags }).diagnostics,
    ).toEqual([]);
    expect(
      core.lowerSource(outside("zork"), "/d.mx", {
        customTags,
        unknownTags: "reject",
      }).diagnostics[0]?.message,
    ).toContain("is not a known tag");
  });
});

const catchAll: Record<string, CustomTag> = {
  attribute: { attributes: { value: {} } },
  resource: { children: { "*": [{ pattern: ".+", contract: "attribute" }] } },
};

/** A compile of each family against `tags`: the descriptors, and Angular (no registry `load()`). */
const compilersWith = (
  tags: Record<string, CustomTag>,
): [string, Compile][] => [
  ...[
    "html",
    "astro-html",
    "solid-jsx",
    "preact-jsx",
    "react-jsx",
    "hono-jsx",
  ].map((name): [string, Compile] => [
    name,
    byDescriptor(name, {
      customTags: tags,
      ...(name === "astro-html" ? { strict: true } : {}),
    }),
  ]),
  [
    "angular-template",
    (source, file) =>
      import("@mxlang/host-angular").then((m) =>
        m.compile(source, file, { customTags: tags, targets: builtinLookup() }),
      ),
  ],
];

describe("a target's built-ins are never wildcard-matched", () => {
  // Core's own taglib names are built-ins on every target (and under lowerSource), so
  // one `.mx` file validates identically everywhere.
  const expected = (name: string) =>
    `\`<resource>\`: \`<${name}>\` is not allowed here; names must match \`.+\` (\`<${name}>\` is a built-in tag, so the wildcard does not apply to it)`;

  it.each(
    ["let", "style", "effect", "script"].flatMap((name) =>
      compilersWith(catchAll).map(
        ([target, compile]) => [target, name, compile] as const,
      ),
    ),
  )(
    "%s: <%s> inside a catch-all parent is the built-in",
    async (target, name, compile) => {
      expect(
        await run(
          compile,
          `<resource><${name} nope="a"/></resource>\n`,
          page(`b-${target}-${name}`),
        ),
      ).toBe(expected(name));
    },
  );

  it.each(["let", "style", "effect", "script"])(
    "lowerSource: <%s> inside a catch-all parent is the built-in",
    (name) => {
      const { diagnostics } = core.lowerSource(
        `<resource><${name} nope="a"/></resource>\n`,
        "/d.mx",
        { customTags: catchAll },
      );
      expect(diagnostics[0]?.message).toBe(expected(name));
    },
  );

  it.each(
    compilersWith(catchAll).filter(
      ([t]) => t !== "angular-template" && t !== "astro-html",
    ),
  )(
    "%s: a host disposition keeps the name its own (not claimed)",
    async (target, compile) => {
      // `<try>` is core's; the point is that the message never names the contract.
      const message = await run(
        compile,
        "<resource><try/></resource>\n",
        page(`d-${target}`),
      );
      expect(message).not.toContain("(as `attribute`)");
    },
  );
});

describe("a by-reference contract with a transform lowers the matched child", () => {
  const withTransform: Record<string, CustomTag> = {
    attribute: {
      attributes: { value: {} },
      transform: (call) => [
        {
          kind: "Text",
          value: `${call.name} from ${call.alias?.authored}`,
          loc: call.loc,
        },
      ],
    },
    resource: {
      children: { "*": [{ pattern: "[a-z]+", contract: "attribute" }] },
      transform: (call) => call.content?.children ?? [],
    },
  };

  it.each(compilersWith(withTransform))(
    "%s: <title> becomes the transform's output under its canonical name",
    async (target, compile) => {
      const out = await compile(
        '<resource><title value="a"/></resource>\n',
        page(`t-${target}`),
      );
      expect((out as { code: string }).code).toContain("attribute from title");
    },
  );
});
