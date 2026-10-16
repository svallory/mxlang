import { describe, expect, it } from "vitest";
import { flattenErrors, TranslateError } from "./index.ts";

/** A parse error as core's parser builds it: a start offset, no `TranslateError` brand. */
function parseError(index: number, message = `at ${index}`): Error {
  return Object.assign(new Error(message), { loc: { start: { index } } });
}

function aggregate(errors: unknown[]): Error {
  return Object.assign(new Error(""), { name: "CompileErrors", errors });
}

describe("flattenErrors", () => {
  it("returns a plain error as itself", () => {
    const error = new Error("boom");
    expect(flattenErrors(error)).toEqual([error]);
  });

  it("returns a value that is not an error as itself", () => {
    expect(flattenErrors(null)).toEqual([null]);
    expect(flattenErrors("text")).toEqual(["text"]);
  });

  it("returns a TranslateError with no list as itself", () => {
    const error = new TranslateError("one", 1, 0);
    expect(flattenErrors(error)).toEqual([error]);
  });

  it("returns a TranslateError's list, the thrown error first", () => {
    const first = new TranslateError("first", 1, 0);
    const second = new TranslateError("second", 3, 0);
    first.errors = [first, second];
    expect(flattenErrors(first)).toEqual([first, second]);
  });

  it("returns a TranslateError with an empty list as itself, never as nothing", () => {
    const error = new TranslateError("one", 1, 0);
    error.errors = [];
    expect(flattenErrors(error)).toEqual([error]);
  });

  it("unrolls an aggregate into its errors", () => {
    const a = parseError(0);
    const b = parseError(10);
    expect(flattenErrors(aggregate([a, b]))).toEqual([a, b]);
  });

  it("keeps the order core detected an aggregate's errors in, a cause before its cascade", () => {
    // `<for of=[1]|x|>`: the expression error at offset 13 is the cause of the
    // missing end tag at offset 0, which core detects at the end of input.
    const cause = parseError(13);
    const cascade = parseError(0);
    expect(flattenErrors(aggregate([cause, cascade]))).toEqual([
      cause,
      cascade,
    ]);
  });

  it("unrolls an aggregate inside an aggregate", () => {
    const a = parseError(0);
    const b = parseError(5);
    const c = parseError(9);
    expect(flattenErrors(aggregate([aggregate([a, b]), c]))).toEqual([a, b, c]);
  });

  it("returns an aggregate with no errors as itself, never as nothing", () => {
    const empty = aggregate([]);
    expect(flattenErrors(empty)).toEqual([empty]);
  });

  it("does not reorder the list it was given", () => {
    const errors = [parseError(9), parseError(1)];
    const copy = [...errors];
    flattenErrors(aggregate(errors));
    expect(errors).toEqual(copy);
  });
});
