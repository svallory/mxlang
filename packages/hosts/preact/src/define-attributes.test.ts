// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * A `<define>` tag's attributes are properties of its value, as in Marko
 * 6.4.4 (`<define/D a=1 b="s"/>` is `const D = { a: 1, b: "s" }`, and `${D.a}`
 * reads `1`). This host's value is the local function a call runs, so the
 * attributes ride on it as own properties. The rendered shapes are locked by
 * the oracle fixture `html/fixtures-marko/define-attributes` (the Preact, React
 * and Hono oracles render it).
 */
import { createTargetLookup } from "@mxlang/core";
import { print } from "@mxlang/tsx-bridge";
import { describe, expect, it } from "vitest";
import descriptor from "./descriptor.ts";
import { compilePreactMx, compilePreactRegion } from "./index.ts";

const targets = createTargetLookup([descriptor]);
const whole = (source: string) =>
  compilePreactMx(source, "/f/page.mx", { targets }).code;

/** A define inside a `.preact.mx` region (one root element), printed. */
function region(markup: string): string {
  return print(
    `export default function Page() {\n  return (\n    <div>${markup}</div>\n  );\n}\n`,
    "/f/Page.preact.mx",
    {
      mx: true,
      mxRegionCompile: (input) =>
        compilePreactRegion(input.source, { ...input, targets }) as ReturnType<
          NonNullable<
            NonNullable<Parameters<typeof print>[2]>["mxRegionCompile"]
          >
        >,
    },
  ).code;
}

describe("preact: a <define> carries its attributes as properties", () => {
  it("a define with no body: attributes of every kind, in source order", () => {
    expect(
      whole(
        '<define/D a=1 b="s" c d=input.x/>\n<p>${D.a} ${D.b}${D.c}${D.d}</p>',
      ),
    ).toContain(
      'const D = Object.assign(() => (<></>), { "a": 1, "b": "s", "c": true, "d": input.x });',
    );
  });

  it("a define with a body keeps the body as the function", () => {
    expect(whole("<define/D|x| a=1><p>${x}</p></define>\n<D(2)/>")).toContain(
      'const D = Object.assign((x) => (<><p>{x}</p></>), { "a": 1 });',
    );
  });

  it("keeps a spread where it was written and a later attribute after it", () => {
    expect(whole("<define/D a=1 ...input.rest b=2/>\n<p>${D.b}</p>")).toContain(
      '{ "a": 1, ...input.rest, "b": 2 });',
    );
  });

  it("an attribute named name or a spread makes name/length writable first", () => {
    expect(whole('<define/F name="email"/>\n<p>${F.name}</p>')).toContain(
      'const F = Object.assign(Object.defineProperties(() => (<></>), { name: { writable: true }, length: { writable: true } }), { "name": "email" });',
    );
    expect(whole("<define/F ...input.rest/>\n<p>${F.a}</p>")).toContain(
      "Object.defineProperties(",
    );
  });

  it("a define with no attributes is unchanged", () => {
    const code = whole("<define/D><p>x</p></define>\n<D/>");
    expect(code).toContain("const D = () => (<><p>x</p></>);");
    expect(code).not.toContain("Object.assign");
  });

  it("an attribute named content next to a body is refused", () => {
    expect(() => whole('<define/D content="x">body</define>')).toThrow(
      "`content` is the body of a `<define>` that has one; rename the attribute, or remove the body",
    );
  });

  it("a define lifted out of a region carries them too", () => {
    expect(region('<define/D a=1 b="s"/><p>${D.a}</p>')).toContain(
      'const D = Object.assign(() => <></>, { "a": 1, "b": "s" });',
    );
  });
});
