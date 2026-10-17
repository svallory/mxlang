/**
 * A native element's body is its own scope for a tag variable (Marko 6.4.4
 * probed on the stock parser: `<let/count=1/><div><const/count=2/>${count}</div>${count}`
 * compiles, the read inside the `<div>` is the inner `count` and the read
 * after it is the outer one; a `<for>`, `<if>`, `<try>` or `<define>` body
 * scopes the same way). The lowering state that tracks a declaration (write
 * guards, `<let>` names, derived `<const>`s, shadowed host bindings) has to
 * follow that scope: an inner `<const/x>` must not make a write to the outer
 * `<let/x>` after the element a "const write" error, and an inner `<let/x>`
 * must not make a write to the outer `<const/x>` legal.
 */
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import type { TranslateError } from "./core.ts";
import type { HostDeclarations } from "./declarations.ts";
import { lowerSource } from "./ir-entry/index.ts";
import { lookup } from "./test-targets.ts";

const READONLY = "MX_READONLY_BINDING_WRITE";

/** A host that has `<let>` and an element for every other name. */
const withLet: HostDeclarations = {
  name: "element-body-scope-test",
  attrTags: 2,
  tags: {},
  isElement: () => true,
  isComponent: () => false,
  isBuiltinTag: (name) => name === "let",
  isDelegatedTag: (name) => name === "let",
  resolveDelegatedTag: () => ({}),
  resolveAttributeMethod: () => true,
};

function attempt(source: string): TranslateError | undefined {
  try {
    compileSource(source, "/page.mx", withLet, {
      targets: lookup,
      emitIr: () => "",
    } as never);
  } catch (error) {
    return error as TranslateError;
  }
  return undefined;
}

/** The diagnostics `lowerSource` reports, which carry the code under test. */
function lowered(source: string) {
  return lowerSource(source, "/page.mx", { tagRules: "html" }).diagnostics;
}

const constWrite = (name: string) =>
  `\`${name}\` is a \`<const>\` and cannot be written. Keep a value that changes in a \`<let>\` and write that in an event handler or a \`<script>\` body, or derive a new value with another \`<const>\`.`;

const ACCEPTED: Array<[string, string]> = [
  [
    "an inner <const> does not guard the outer <let> written after the element",
    "<let/x=0/>\n<div><const/x=1/></div>\n<button onClick() { x = 2 }/>\n",
  ],
  [
    "two levels deep",
    "<let/x=0/>\n<div><section><const/x=1/></section><button onClick() { x = 2 }/></div>\n",
  ],
  [
    "an inner <let> is written inside the element",
    "<const/x=1/>\n<div><let/x=2/><button onClick() { x = 3 }/></div>\n",
  ],
  [
    "sibling elements each declare the name",
    "<div><const/x=1/></div><div><let/x=2/><button onClick() { x = 3 }/></div>\n",
  ],
  ["concise syntax", "let/x=0\ndiv\n  const/x=1\nbutton onClick() { x = 2 }\n"],
];

const REFUSED: Array<[string, string, string]> = [
  [
    "an inner <let> does not make the outer <const> writable after the element",
    "<const/x=1/>\n<div><let/x=2/></div>\n<button onClick() { x = 3 }/>\n",
    "x = 3",
  ],
  [
    "the inner <const> still guards a write inside the element",
    "<let/x=0/>\n<div><const/x=1/><button onClick() { x = 2 }/></div>\n",
    "x = 2",
  ],
  [
    "the outer <const> still guards a write inside an element that declares another name",
    "<const/x=1/>\n<div><const/y=1/><button onClick() { x = 2 }/></div>\n",
    "x = 2",
  ],
];

describe("an element body scopes its tag variables for write checks", () => {
  for (const [name, source] of ACCEPTED) {
    it(`compiles: ${name}`, () => {
      expect(attempt(source)).toBeUndefined();
      expect(lowered(source).filter((d) => d.code === READONLY)).toEqual([]);
    });
  }

  for (const [name, source, write] of REFUSED) {
    it(`refuses: ${name}`, () => {
      const variable = write.slice(0, write.indexOf(" "));
      expect(attempt(source)?.message).toBe(constWrite(variable));
      const found = lowered(source).filter((d) => d.code === READONLY);
      expect(found).toHaveLength(1);
      expect(found[0]?.message).toBe(constWrite(variable));
    });
  }
});
