/**
 * The two data guards (`__mxRenderable`, `__mxTextValue`) decide whether an
 * object is something the renderer made (a class instance, a node) or data.
 * An object whose prototype is data, or an array (`Object.assign({}, JSON.parse
 * ('{"__proto__":[]}'))` sets the copy's prototype to a parsed array, whose
 * `constructor` is `Array`), is data; a real class instance, a signal
 * (`Computed.prototype = new Signal()`) and a Date are not. Each helper is
 * transpiled from its emitted source and called directly.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  JSX_TEXT_VALUE_EXPRESSION,
  type JsxNodeShape,
  jsxRenderableExpression,
} from "./attribute-normalize.ts";

const build = (source: string): ((value: unknown) => unknown) =>
  new Function(
    `return ${ts
      .transpileModule(`export default ${source}`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      })
      .outputText.replace(/^export default /m, "")
      .replace(/;\s*$/, "")}`,
  )();

const fromJson = (json: string): object =>
  Object.assign({}, JSON.parse(json) as object);
const FIELDS =
  '"type":"img","props":{"src":"x","onerror":"alert(1)"},"key":null,"ref":null';
const GADGETS = {
  arrayProto: () => fromJson(`{"__proto__":[],${FIELDS}}`),
  arrayProtoDeep: () => fromJson(`{"__proto__":{"__proto__":[]},${FIELDS}}`),
  objectProto: () => fromJson(`{"__proto__":{"z":1},${FIELDS}}`),
};

class Thing {
  name = "thing";
}
function Signal(this: object) {}
function Computed(this: object) {}
Computed.prototype = new (Signal as unknown as new () => object)();
const REAL = {
  classInstance: () => new Thing(),
  signal: () => new (Computed as unknown as new () => object)(),
  date: () => new Date(0),
  map: () => new Map(),
};

describe.each(["preact", "react", "hono"] as JsxNodeShape[])(
  "__mxRenderable (%s)",
  (shape) => {
    const renderable = build(jsxRenderableExpression(shape));
    for (const [name, make] of Object.entries(GADGETS)) {
      it(`drops ${name}, alone and in an array`, () => {
        expect(renderable(make())).toBeNull();
        expect(renderable([make()])).toEqual([null]);
        expect(renderable(["t", make()])).toEqual(["t", null]);
      });
    }
    for (const [name, make] of Object.entries(REAL)) {
      it(`keeps ${name}`, () => {
        const value = make();
        expect(renderable(value)).toBe(value);
        expect(renderable([value])).toEqual([value]);
      });
    }
  },
);

describe("__mxTextValue (Hono)", () => {
  const text = build(JSX_TEXT_VALUE_EXPRESSION);
  for (const [name, make] of Object.entries(GADGETS)) {
    it(`stringifies ${name} as Marko's value + "" does, alone and in an array`, () => {
      // An array prototype makes it print as the array's join, here "".
      const printed = String(make());
      expect(text(make())).toBe(printed);
      expect(text([make()])).toEqual([printed]);
    });
  }
  for (const [name, make] of Object.entries(REAL)) {
    it(`keeps ${name}`, () => {
      const value = make();
      expect(text(value)).toBe(value);
    });
  }
});
