import { describe, expect, it } from "vitest";
import { emit } from "./helpers.ts";

describe("task 1.3 kinds (not yet implemented)", () => {
  it("errors on <for>", () => {
    expect(() => emit("<for|p| of=people>${p}</for>")).toThrow(
      /angular: <For> not implemented yet/,
    );
  });

  it("errors on <define>", () => {
    expect(() => emit("<define/Row|x|>${x}</define>")).toThrow(
      /angular: <Define> not implemented yet/,
    );
  });

  it("errors on a component call", () => {
    expect(() => emit("<UserCard name=n/>")).toThrow(
      /angular: <Component> not implemented yet/,
    );
  });

  it("errors on <try>", () => {
    expect(() => emit("<try>x</try>")).toThrow(
      /no template-level error boundary/,
    );
  });
});
