import { expect, it } from "vitest";
import { compile } from "../src/index.ts";

it.each(["let", "var"])(
  "does not offer an immutable replacement for $ %s",
  (keyword) => {
    expect(() =>
      compile(`$ ${keyword} x = 1;\n<p>1</p>`, "/fixtures/Test.mx"),
    ).toThrow(
      /^scriptlets \(`\$ statement`\) are not supported in MX \(decision 54\)$/,
    );
    expect(() =>
      compile(`$ ${keyword} x = ;\n<p>1</p>`, "/fixtures/Test.mx"),
    ).toThrow("Unexpected token; scriptlets (`$ …`) are not supported\n");
    expect(() => compile("<let/x=1/>", "/fixtures/Test.mx")).toThrow(
      "`<let>` is Marko reactive state",
    );
  },
);
