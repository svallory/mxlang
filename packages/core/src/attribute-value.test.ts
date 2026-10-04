import { describe, expect, it } from "vitest";
import { ATTRIBUTE_VALUE_BODY } from "./attribute-value.ts";

describe("native attribute coercion rule", () => {
  const validate = new Function("name", "value", "tag", ATTRIBUTE_VALUE_BODY);
  it("rejects failed coercion and object-tag strings, not just plain prototypes", () => {
    for (const value of [
      { a: 1 },
      Object.create(null),
      { toString: () => "[object Object]" },
      [Object.create(null)],
    ]) {
      expect(() => validate("data-x", value, "div")).toThrow(
        "The `data-x` attribute cannot be a plain object (it would render as `[object Object]`).",
      );
    }
  });
  it("preserves renderable objects and primitives by identity", () => {
    for (const value of [
      [1, 2],
      { toString: () => "custom" },
      new Date(),
      0,
      null,
      undefined,
      "text",
      true,
    ])
      expect(validate("data-x", value, "div")).toBe(value);
  });
  it("exempts structured writers and only the relevant controlled-tag contexts", () => {
    const value = { a: 1 };
    for (const [name, tag] of [
      ["class", "div"],
      ["style", "div"],
      ["checked", "input"],
      ["checkedValue", "input"],
      ["open", "details"],
      ["open", "dialog"],
      ["value", "select"],
      ["value", "textarea"],
    ])
      expect(validate(name, value, tag)).toBe(value);
    for (const [name, tag] of [
      ["checked", "div"],
      ["open", "div"],
      ["value", "input"],
    ])
      expect(() => validate(name, value, tag)).toThrow(
        "cannot be a plain object",
      );
  });
});
