import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { print } from "../index.ts";
import { solidRegionCompile } from "./test-helpers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ICON_TEMPLATE = join(HERE, "fixtures", "tags", "icon.mx");
const COUNTER_TEMPLATE = join(HERE, "fixtures", "tags", "counter.mx");
const PAGE = join(HERE, "fixtures", "page.solid.mx");

/** The discovered `<icon>` tag, as an integration's scan would supply it. */
function iconTag(): Record<string, unknown> {
  return {
    icon: {
      template: {
        filename: ICON_TEMPLATE,
        source: readFileSync(ICON_TEMPLATE, "utf8"),
        mtimeMs: statSync(ICON_TEMPLATE).mtimeMs,
      },
    },
  };
}

const compile = (source: string) =>
  print(source, PAGE, {
    customTags: iconTag(),
    mxRegionCompile: solidRegionCompile,
  }).code;

/**
 * Every `import … from "<specifier>"` statement in the printed module.
 *
 * Matched by shape rather than by line: the printer runs with `retainLines`,
 * so an injected statement shares the line of the code it was inserted before
 * and a line-oriented split would miss it.
 */
function importsOf(code: string): string[] {
  return [...code.matchAll(/import\s+[^;]*?from\s*"[^"]*"/g)].map(
    (match) => match[0],
  );
}

describe("hoisting a region's discovered-tag imports", () => {
  it("writes the synthesized import into the surrounding module", () => {
    const code = compile(`const a = <div><icon name="star"/></div>;`);

    const imports = importsOf(code);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatch(
      /^import \$mx_Icon\d+ from "\.\/tags\/icon\.mx"$/,
    );
    // The call references that binding, so the module actually resolves.
    const binding = imports[0]?.match(/import (\S+)/)?.[1];
    expect(code).toContain(`<${binding}`);
  });

  it("shares one import between two regions calling the same tag", () => {
    const code = compile(
      [
        `const a = <div><icon name="star"/></div>;`,
        `const b = <p><icon name="box"/></p>;`,
      ].join("\n"),
    );

    expect(importsOf(code)).toHaveLength(1);
  });

  it("reuses the module's own authored import of the same file", () => {
    const code = compile(
      [
        `import Icon from "./tags/icon.mx";`,
        `const a = <div><icon name="star"/></div>;`,
      ].join("\n"),
    );

    // Nothing injected: the author already imports that path.
    const imports = importsOf(code);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toContain("Icon");
    expect(code).not.toContain("$mx_Icon");
    // And the call is rewritten onto the author's own binding.
    expect(code).toContain("<Icon");
  });

  it("inserts after the module's last import", () => {
    const code = compile(
      [
        `import { createSignal } from "solid-js";`,
        `const a = <div><icon name="star"/></div>;`,
      ].join("\n"),
    );

    const solid = code.indexOf(`from "solid-js"`);
    const injected = code.indexOf(`from "./tags/icon.mx"`);
    expect(solid).toBeGreaterThanOrEqual(0);
    expect(injected).toBeGreaterThan(solid);
  });

  it("injects nothing when no region calls a discovered tag", () => {
    expect(importsOf(compile(`const a = <div>plain</div>;`))).toEqual([]);
  });

  it("reuses an import written with a different spelling of the same path", () => {
    const code = compile(
      [
        `import Icon from "./tags/../tags/icon.mx";`,
        `const a = <div><icon name="star"/></div>;`,
      ].join("\n"),
    );

    // One file, two spellings: reuse keys on the resolved path, so nothing is
    // injected and the call points at the author's binding.
    expect(importsOf(code)).toHaveLength(1);
    expect(code).not.toContain("$mx_Icon");
    expect(code).toContain("<Icon");
  });

  it("does not reuse a type-only import of the tag's file", () => {
    const code = compile(
      [
        `import type Icon from "./tags/icon.mx";`,
        `const a = <div><icon name="star"/></div>;`,
      ].join("\n"),
    );

    // A type-only import binds no runtime value, so reusing it would leave the
    // call referencing a name erased before the module runs. The real import
    // must still be injected alongside it.
    const injected = importsOf(code).filter((one) =>
      /^import \$mx_Icon\d+ /.test(one),
    );
    expect(injected).toHaveLength(1);
    expect(code).toMatch(/<\$mx_Icon\d+/);
  });

  it("leaves an unrelated binding of the generated name alone", () => {
    const code = compile(
      [
        `import Icon from "./tags/icon.mx";`,
        `const $mx_Icon1 = "user thing";`,
        `const a = <div><icon name="star"/></div>;`,
        `console.log($mx_Icon1);`,
      ].join("\n"),
    );

    // The generated name is minted against the caller's bindings, so this
    // collision is unlikely — but renaming the author's own declaration onto
    // their import is a duplicate-binding SyntaxError, so the rewrite is
    // confined to the region's own range.
    expect(code).toContain(`const $mx_Icon1 = "user thing"`);
    expect(code).toContain("console.log($mx_Icon1)");
    expect(code).not.toContain(`const Icon = "user thing"`);
    // The region's own call still defers to the author's import.
    expect(code).toContain("<Icon");
  });

  it("does not reuse an authored import shadowed at the region", () => {
    const code = compile(
      [
        `import Icon from "./tags/icon.mx";`,
        `function f(Icon) { return <div><icon name="star"/></div>; }`,
      ].join("\n"),
    );

    // Reuse would emit `<Icon/>` inside `f`, where `Icon` is the parameter —
    // the tag would render whatever the caller passed. So the import is
    // injected under its generated name instead, which nothing shadows.
    expect(code).toMatch(/import \$mx_Icon\d+ from "\.\/tags\/icon\.mx"/);
    expect(code).toMatch(/<\$mx_Icon\d+/);
    // The author's own parameter is untouched.
    expect(code).toContain("function f(Icon)");
  });

  it("still reuses an import when the shadow is in an unrelated scope", () => {
    const code = compile(
      [
        `import Icon from "./tags/icon.mx";`,
        `function other(Icon) { return Icon; }`,
        `const a = <div><icon name="star"/></div>;`,
      ].join("\n"),
    );

    // The shadow does not enclose the region, so reuse is still correct.
    expect(code).not.toContain("$mx_Icon");
    expect(code).toContain("<Icon");
  });

  it("leaves object keys and member properties alone", () => {
    const code = compile(
      [
        `import Icon from "./tags/icon.mx";`,
        `const o = { $mx_Icon1: 1 };`,
        `const a = <div><icon name="star"/></div>;`,
        `console.log(o.$mx_Icon1);`,
      ].join("\n"),
    );

    // Neither is a reference to a binding, so neither is a collision.
    expect(code).toContain("$mx_Icon1: 1");
    expect(code).toContain("o.$mx_Icon1");
  });
});

/**
 * A `/var` inside a region binds a value the region has no statement
 * position for — a region is an *expression* inside a TypeScript module.
 * The surrounding module declares the `let` and the region's callback prop
 * assigns it, the same channel the injected imports above ride (design
 * §2.4). Without this the emitted module referenced an undeclared binding,
 * silently (round 1, finding 6).
 */
describe("hoisting a region's `/var` bindings", () => {
  const withCounter = (source: string) =>
    print(source, PAGE, {
      customTags: {
        counter: {
          template: {
            filename: COUNTER_TEMPLATE,
            source: readFileSync(COUNTER_TEMPLATE, "utf8"),
            mtimeMs: statSync(COUNTER_TEMPLATE).mtimeMs,
          },
        },
      },
      mxRegionCompile: solidRegionCompile,
    }).code;

  it("declares the let in the surrounding module", () => {
    const code = withCounter(
      "const a = <div><counter/n start=1/><p>${n}</p></div>;",
    );

    expect(code).toContain("let n;");
    expect(code).toContain("$mxReturn=");
    // After the import and before the region that fills it: a `let`
    // declared below its reader would be a temporal-dead-zone error.
    expect(code.indexOf("let n;")).toBeGreaterThan(
      code.indexOf('from "./tags/counter.mx"'),
    );
    expect(code.indexOf("let n;")).toBeLessThan(code.indexOf("$mxReturn="));
  });

  it("declares nothing for a region that binds no /var", () => {
    const code = withCounter("const a = <div><counter start=1/></div>;");

    expect(code).not.toContain("let n;");
    expect(code).not.toContain("$mxReturn=");
  });
});
