import { describe, expect, it } from "vitest";
import {
  DOM_EVENT_SUPPLEMENT,
  extractDomEventNames,
  installedLibDom,
} from "./dom-event-names.extract.ts";
import { DOM_EVENT_NAMES } from "./dom-event-names.ts";

describe("DOM_EVENT_NAMES", () => {
  it("equals the installed lib.dom.d.ts extraction plus the supplement", () => {
    // Fails after a TypeScript bump until the data file is regenerated.
    const extracted = extractDomEventNames(installedLibDom().path);
    expect([...DOM_EVENT_NAMES]).toEqual(
      [...new Set([...extracted, ...DOM_EVENT_SUPPLEMENT])].sort(),
    );
  });

  it.each([
    "dblclick",
    "keydown",
    "focusin",
    "pointerdown",
    "timeupdate",
    "encrypted",
    "beforecopy",
  ])("contains %s", (name) => {
    expect(DOM_EVENT_NAMES.has(name)).toBe(true);
  });

  it.each(["doubleclick", "dragexit", "begin", "repeat"])(
    "does not contain %s",
    (name) => {
      expect(DOM_EVENT_NAMES.has(name)).toBe(false);
    },
  );
});
