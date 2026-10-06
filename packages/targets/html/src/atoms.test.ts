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

// Review round 2, finding 5: the atom hint names only an atom the parser
// lexed, never a `:` in a scriptlet or a statement tag.
describe("no atom hint where atoms are not read", () => {
  it("a scriptlet: the scriptlet error, no atom hint", () => {
    let message = "";
    try {
      compile("$ const o = { a: :b };\n<div/>", "/fixtures/atoms.mx");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("scriptlets (`$ …`) are not supported");
    expect(message).not.toContain("is an atom (decision 156)");
  });

  it("`static`: no atom is read, and the statement is a positioned syntax error", () => {
    // A statement's text is TypeScript, parsed as Marko parses it (#395 r2):
    // `:b` is no atom there, and html no longer emits it unchecked.
    expect(() =>
      compile("static const o = { a: :b };\n<div/>", "/fixtures/atoms.mx"),
    ).toThrow("Unexpected token");
  });

  it("`{ new :a }`: keyword plus atom, with a hint that says so", () => {
    expect(() => compile("<div x={ new :a }/>", "/fixtures/atoms.mx")).toThrow(
      "`new :a` reads as the keyword `new` and the atom `:a` (decision 156); for an object key write `{ new: a }`.",
    );
  });

  it("an atom where a shorthand property must stand gets it", () => {
    expect(() => compile("<div x=f({:a})/>", "/fixtures/atoms.mx")).toThrow(
      "`:a` is an atom (decision 156): a value, not a binding",
    );
  });
});
