// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX, not JS templates
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

/**
 * Decision 156 on the html target: an atom lowers to its name as a string
 * literal; nothing atom-specific reaches the emitted module.
 */
describe("atoms on html", () => {
  it.each([
    ["<div x=:a/>", ' x=\\"a\\"'],
    ["<div x=[:a, :b]/>", '["a", "b"]'],
    ["<div x=a ? :b : :c/>", 'a ? "b" : "c"'],
    ["<div x=:a :b/>", ' x=\\"a\\" name=\\"b\\"'],
    ["<p>${:hello}</p>", '"hello"'],
    ["<if=x === :on><p/></if>", 'x === "on"'],
  ])("%j", (source, expected) => {
    const { code } = compile(source, "/fixtures/atoms.mx");
    expect(code).toContain(expected);
    expect(code).not.toMatch(/[=[(,{\s]:(?:a|b|c|hello|on)\b/);
  });
});
