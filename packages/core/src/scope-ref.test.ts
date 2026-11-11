import { describe, expect, it } from "vitest";
import { type ScopeRef, sameScopeRef, scopeRefOf } from "./scope-ref.ts";

const collected = { deref: () => undefined } as unknown as WeakRef<object>;

describe("sameScopeRef", () => {
  const one = {};
  const other = {};
  it.each([
    ["absent / absent", scopeRefOf(undefined), undefined, true],
    ["present / same", scopeRefOf(one), one, true],
    ["present / other", scopeRefOf(one), other, false],
    ["present / absent", scopeRefOf(one), undefined, false],
    ["absent / present", scopeRefOf(undefined), one, false],
    ["collected / absent", collected, undefined, false],
    ["collected / present", collected, one, false],
  ] as [string, ScopeRef, object | undefined, boolean][])(
    "%s",
    (_name, stored, current, expected) => {
      expect(sameScopeRef(stored, current)).toBe(expected);
    },
  );
});
