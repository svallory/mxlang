import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import { TranslateError } from "./core.ts";
import type { HostDeclarations } from "./declarations.ts";
import { testTargetLookup } from "./test-targets.ts";

/**
 * The `productName` compile option (decision 183): a language packaged on top
 * of MX passes its name, and every diagnostic where core's own wording says
 * "MX" says that name instead. Unset, the default, every message is
 * byte-identical to before the option existed.
 */

const targets = testTargetLookup();
const declarations: HostDeclarations = {
  tags: {},
  isElement: () => true,
  isComponent: () => false,
};

function fails(source: string, productName?: string): TranslateError {
  try {
    compileSource(source, "/tmp/mx-product-name/page.mx", declarations, {
      targets,
      tagDiscoveryDirs: [],
      warnings: [],
      emitIr: () => "",
      ...(productName === undefined ? {} : { productName }),
    });
  } catch (cause) {
    expect(cause).toBeInstanceOf(TranslateError);
    return cause as TranslateError;
  }
  throw new Error("expected a TranslateError");
}

describe("productName (decision 183)", () => {
  it("defaults to MX, byte-identical to before the option", () => {
    expect(fails("<div *foo/>").message).toContain("no meaning in MX");
  });

  it("names the product in the foreign-attribute hints", () => {
    expect(fails("<div *foo/>", "Acme").message).toContain(
      "no meaning in Acme",
    );
  });
});
