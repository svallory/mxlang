import { describe, expect, it } from "vitest";
import { nearestName } from "./index.ts";

describe("public exports", () => {
  it("exports nearestName, the did-you-mean helper targets reuse", () => {
    expect(nearestName("resorce", ["resource", "attributes"])).toBe("resource");
    expect(nearestName("widget", ["resource", "attributes"])).toBeUndefined();
  });
});
