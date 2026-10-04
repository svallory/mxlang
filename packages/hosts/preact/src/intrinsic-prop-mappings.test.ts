import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

const compile = (source: string, typeCheck?: boolean) =>
  compilePreactMx(source, "/fixtures/test.mx", { typeCheck });

function nameMappings(source: string, typeCheck?: boolean) {
  const { code, mappings } = compile(source, typeCheck);
  // Value expressions now have their own mappings through the guard. This
  // helper asserts names only, including string-keyed merged JSX props.
  return mappings
    .map((mapping) => ({
      generated: code
        .slice(mapping.generatedStart, mapping.generatedEnd)
        .replace(/^"|"$/g, ""),
      authored: source.slice(mapping.sourceStart, mapping.sourceEnd),
    }))
    .filter(({ authored }) => /^[A-Za-z_$][\w:-]*$/.test(authored));
}

describe("native non-event name mappings (decision 140 (b))", () => {
  it.each([undefined, true])(
    "maps every named prop kind (typeCheck=%s)",
    (typeCheck) => {
      const source =
        '<input maxLength="x" disabled tabIndex=1 key="k" ref=((el) => el)/>';
      expect(nameMappings(source, typeCheck)).toEqual([
        { generated: "maxLength", authored: "maxLength" },
        { generated: "disabled", authored: "disabled" },
        { generated: "tabIndex", authored: "tabIndex" },
        { generated: "key", authored: "key" },
        { generated: "ref", authored: "ref" },
      ]);
    },
  );

  it("maps structured class and style without mapping spread keys", () => {
    const source =
      '<div.card class={active: true} style={color: "red"} ...{title: "ok"}/>';
    expect(nameMappings(source)).toEqual([
      { generated: "class", authored: "class" },
      { generated: "style", authored: "style" },
    ]);
  });

  it("maps SVG names, including props on camelCase native tags", () => {
    expect(
      nameMappings('<svg viewBox="0 0 1 1"><clipPath id="c"/></svg>'),
    ).toEqual([
      { generated: "viewBox", authored: "viewBox" },
      { generated: "id", authored: "id" },
    ]);
  });

  it("leaves custom elements and event-prop names unmapped", () => {
    for (const source of [
      '<my-el foo=1 class="a"/>',
      "<button onClick=((e) => e.type) onKeyDown=((e) => e.key)/>",
      '<button onClick="alert(1)" onKeyDown/>',
    ]) {
      expect(nameMappings(source)).toEqual([]);
      expect(
        nameMappings(source, true).some((mapping) =>
          mapping.generated.startsWith("on"),
        ),
      ).toBe(false);
    }
  });

  it("leaves the default attribute's zero-width name unmapped", () => {
    expect(nameMappings('<input="a"/>')).toEqual([]);
  });
});
