import { describe, expect, it } from "vitest";
import type { AttrTag } from "./index.ts";

const data: AttrTag<{ attrs: { id: number } }> = {
  id: 1,
  content: () => "one",
};
const parameterized: AttrTag<{ params: [label: string] }> = {
  content: (label) => () => label,
};
const renderable: AttrTag<{ as: "renderable" }> = () => "rendered";

describe("Solid AttrTag type", () => {
  it("specialises data, params and renderable values to accessors", () => {
    expect(data.content?.()).toBe("one");
    expect(parameterized.content?.("two")()).toBe("two");
    expect(renderable()).toBe("rendered");
  });
});
