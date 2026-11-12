import { describe, expect, it } from "vitest";
import {
  attachRelatedErrors,
  byPosition,
  relatedErrorsOf,
  TranslateError,
} from "./core.ts";

const at = (message: string, line: number, column = 0) =>
  new TranslateError(message, line, column);

describe("attachRelatedErrors", () => {
  it("adds to what the error already carries instead of replacing it", () => {
    const primary = at("primary", 1);
    const first = at("first", 2);
    const later = at("later", 3);
    attachRelatedErrors(primary, [first]);
    attachRelatedErrors(primary, [later]);
    expect(relatedErrorsOf(primary)).toEqual([first, later]);
    expect(primary.errors).toEqual([primary, first, later]);
  });

  it("appends to an `errors` list the error already has, once each", () => {
    const primary = at("primary", 1);
    const own = at("own", 2);
    const added = at("added", 3);
    primary.errors = [primary, own];
    attachRelatedErrors(primary, [added]);
    attachRelatedErrors(primary, [added]);
    expect(primary.errors).toEqual([primary, own, added]);
    expect(relatedErrorsOf(primary)).toEqual([added]);
  });

  it("leaves an error alone when there is nothing to attach", () => {
    const primary = at("primary", 1);
    attachRelatedErrors(primary, []);
    expect(primary.errors).toBeUndefined();
  });
});

describe("byPosition", () => {
  it("orders by line, then column", () => {
    const errors = [at("c", 2, 1), at("b", 2, 0), at("a", 1, 9)];
    expect(errors.sort(byPosition()).map((e) => e.message)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});
