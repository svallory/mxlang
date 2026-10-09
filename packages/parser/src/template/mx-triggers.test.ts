// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the cases are MX source, whose `${…}` is a placeholder, not a JS template
/**
 * The syntax table (decision 182, PR A) at the template parser: triggers in
 * expression, attribute and line position, their same-length stand-ins,
 * `terminatesValue`, validation, and the default row's parity.
 *
 * Events are rendered compactly, as the atom cases do (`mx-atoms.cases.ts`):
 * `<tag>`, `@name`, `="value"` (as `read()` returns it, so stand-ins show),
 * `atom(name@start-end)`, `trigger(id position "text"@start-end)` with
 * `="value"` or `method{"body"}` when it has one, and
 * `ERR(start-end message)`.
 */
import { describe, expect, it } from "vitest";
import { PROBES } from "./grammar-spec.cases.ts";
import {
  createParser,
  DEFAULT_SYNTAX,
  type SyntaxTable,
  type Trigger,
  validateSyntaxTable,
} from "./index.ts";
import { ATOM, CLASS, ID, NAME } from "./test-support/sugar-rows.ts";

/**
 * Mesh's member trigger (decision 182 addendum 2), the first table row. Its
 * matcher takes the identifier charset of names (Unicode letters, marks,
 * digits, connectors; review 439 B1), so it ends where the token does.
 */
const MEMBER: Trigger = {
  id: "member",
  chars: "&",
  match: "&[\\p{L}\\p{Nl}_$][\\p{L}\\p{Nl}\\p{Mn}\\p{Mc}\\p{Nd}\\p{Pc}_$]*",
  standIn: "identifier",
  node: { call: "member" },
};

/** The same row with an ASCII-only matcher, which stops inside `&façade`. */
const ASCII_MEMBER: Trigger = {
  ...MEMBER,
  match: "&[A-Za-z_$][A-Za-z0-9_$]*",
};

const table = (patch: Partial<SyntaxTable>): SyntaxTable => ({
  ...DEFAULT_SYNTAX,
  ...patch,
});

/** `&` in all three positions: the test table of the brief (not the default row). */
const MESH = table({
  expressionTriggers: [MEMBER],
  attributeTriggers: [MEMBER],
  lineTriggers: [MEMBER],
});

function render(
  code: string,
  syntax: SyntaxTable | undefined,
  codes = false,
): string {
  const out: string[] = [];
  const show = (r: { start: number; end: number }) =>
    JSON.stringify(parser.read(r));
  const parser = createParser(
    {
      onError: (e) =>
        out.push(
          `ERR(${e.start}-${e.end} ${e.message}${codes ? ` #${e.code}` : ""})`,
        ),
      onAtom: (a) =>
        out.push(
          `atom(${code.slice(a.value.start, a.value.end)}@${a.start}-${a.end})`,
        ),
      onTrigger: (t) =>
        out.push(
          `trigger(${t.id} ${t.position} ${JSON.stringify(code.slice(t.text.start, t.text.end))}@${t.start}-${t.end}${t.args ? ` args(${show(t.args.value)})` : ""}${t.value ? ` ${t.operator}${show(t.value)}` : ""}${t.method ? ` ${t.method.async ? "async " : ""}${t.method.typeParams ? `<${show(t.method.typeParams.value)}>` : ""}(${show(t.method.params.value)}) method{${show(t.method.body.value)}}` : ""})`,
        ),
      onOpenTagName: (t) => {
        out.push(`<${code.slice(t.start, t.end)}>`);
      },
      onAttrName: (r) => out.push(`@${code.slice(r.start, r.end)}`),
      onAttrValue: (v) => out.push(`=${show(v.value)}`),
      onText: (r) => out.push(`text(${show(r)})`),
      onScriptlet: (s) => out.push(`$${show(s.value)}`),
      onPlaceholder: (p) => out.push(`\${${show(p.value)}}`),
      onComment: (c) => out.push(`comment(${c.start}-${c.end})`),
      onOpenTagComment: (c) => out.push(`tag-comment(${c.start}-${c.end})`),
      onAttrMethod: (m) => out.push(`method{${show(m.body.value)}}`),
    },
    syntax ? { syntax } : undefined,
  );
  parser.parse(code);
  return out.join(" ");
}

describe("the & member row (decision 182 addendum 1)", () => {
  it.each([
    // Expression position; the atom beside it still lexes as an atom.
    [
      "x=() => &status === :sent",
      '<x> @ trigger(member expression "&status"@8-15) atom(sent@20-25) ="() => _status === 0.000"',
    ],
    [
      "x load=[&customer, &other]",
      '<x> @load trigger(member expression "&customer"@8-17) trigger(member expression "&other"@19-25) ="[_customer, _other]"',
    ],
    // Attribute position, after a kind.
    ["sort asc &dueOn", '<sort> @asc trigger(member attribute "&dueOn"@9-15)'],
    // Line position, under a concise block, with and without `=value`.
    [
      "entity Order\n  &title\n  &amount=qty * price",
      '<entity> @Order trigger(member line "&title"@15-21) trigger(member line "&amount"@24-43 ="qty * price")',
    ],
  ])("%j", (code, expected) => {
    expect(render(code, MESH)).toBe(expected);
  });

  it.each([
    // `&&` is the logical and; `a &b` (an operand before it) is the bitwise and.
    ["x=a &&b", '<x> @ ="a &&b"'],
    ["x=a&&b", '<x> @ ="a&&b"'],
    ["x=a &b", '<x> @ ="a &b"'],
    ["x=a&b", '<x> @ ="a&b"'],
    ["x=(a)&b", '<x> @ ="(a)&b"'],
    // `&=` and a lone `&` never match.
    ["x=a &= b", '<x> @ ="a &= b"'],
    // Statements and scriptlets do not lex atoms, so no expression trigger
    // is armed there either.
    ["$ x = &a", '$"x = &a"'],
    // HTML content is text: line triggers are concise-only.
    ["<div>&title</div>", '<div> text("&title")'],
    // In a string, a template quasi or a comment, `&a` is that text.
    ['x="&a"', '<x> @ ="\\"&a\\""'],
    ["x=`&a`", '<x> @ ="`&a`"'],
    ["x=a /* &b */", '<x> @ ="a /* &b */"'],
  ])("not a trigger: %j", (code, expected) => {
    expect(render(code, MESH)).toBe(expected);
  });

  it.each([
    // Expression triggers in every position atoms are armed in.
    ["x(&a)", '<x> trigger(member expression "&a"@2-4)'],
    ["x a(&b)", '<x> @a trigger(member expression "&b"@4-6)'],
    ["x ...&a", '<x> trigger(member expression "&a"@5-7)'],
    ["div -- ${&a}", '<div> trigger(member expression "&a"@9-11) ${"_a"}'],
    ["x=`${&a}`", '<x> @ trigger(member expression "&a"@5-7) ="`${_a}`"'],
    ["x=!&a", '<x> @ trigger(member expression "&a"@3-5) ="!_a"'],
    ["x=&a.b", '<x> @ trigger(member expression "&a"@2-4) ="_a.b"'],
    [
      "x=c ? &a : &b",
      '<x> @ trigger(member expression "&a"@6-8) trigger(member expression "&b"@11-13) ="c ? _a : _b"',
    ],
    // A trigger's own text is an operand, never a keyword: `:b` after
    // `&new` is a ternary-less `:`, not an atom.
    [
      "x=[&new, :b]",
      '<x> @ trigger(member expression "&new"@3-7) atom(b@9-11) ="[_new, 0.]"',
    ],
  ])("expression position: %j", (code, expected) => {
    expect(render(code, MESH)).toBe(expected);
  });

  it.each([
    // HTML mode, before `/>`, `>` and between attributes.
    [
      "<div &a x=1 &b/>",
      // Without `terminatesValue`, ` &b` after a value is the bitwise and.
      '<div> trigger(member attribute "&a"@5-7) @x ="1 &b"',
    ],
    [
      "<div &a x=1, &b></div>",
      '<div> trigger(member attribute "&a"@5-7) @x ="1" trigger(member attribute "&b"@13-15)',
    ],
    // An attribute trigger may take a value, lexed as a named attribute's.
    ["<div &a=x + 1/>", '<div> trigger(member attribute "&a"@5-13 ="x + 1")'],
    [
      "field &amount=qty * price",
      '<field> trigger(member attribute "&amount"@6-25 ="qty * price")',
    ],
    // Concise: `,` and `;` end it, and so does an attribute group's `]`.
    ["x &a, b", '<x> trigger(member attribute "&a"@2-4) @b'],
    ["x &a;", '<x> trigger(member attribute "&a"@2-4)'],
    ["x [&a]", '<x> trigger(member attribute "&a"@3-5)'],
    // A value with an expression trigger in it.
    [
      "x &a=&b",
      '<x> trigger(member expression "&b"@5-7) trigger(member attribute "&a"@2-7 ="_b")',
    ],
  ])("attribute position: %j", (code, expected) => {
    expect(render(code, MESH)).toBe(expected);
  });

  it.each([
    // At the root, with CRLF, with whitespace after the value.
    ["&title", 'trigger(member line "&title"@0-6)'],
    [
      "&a\r\n&b=1  \nx",
      'trigger(member line "&a"@0-2) trigger(member line "&b"@4-8 ="1") <x>',
    ],
    // A value runs on through operators and over a line break after one.
    ["e\n  &a=b +\n    c", '<e> trigger(member line "&a"@4-16 ="b +\\n    c")'],
    // Expression triggers and atoms inside a line trigger's value.
    [
      "&a=[&b, :c]",
      'trigger(member expression "&b"@4-6) atom(c@8-10) trigger(member line "&a"@0-11 ="[_b, 0.]")',
    ],
    // A tag after a trigger line at the same indent is a sibling.
    ["e\n  &a\n  div", '<e> trigger(member line "&a"@4-6) <div>'],
  ])("line position: %j", (code, expected) => {
    expect(render(code, MESH)).toBe(expected);
  });

  it.each([
    [
      "entity\n  &title foo",
      'ERR(16-16 A "member" trigger line ends after its text; only whitespace may follow it on the line.)',
    ],
    [
      "&a=1 2",
      'ERR(5-5 A "member" trigger line ends after its text and its value; only whitespace may follow it on the line.)',
    ],
    ["&a=", "ERR(3-3 Missing value for attribute)"],
    [
      "<div &a.b/>",
      '<div> ERR(5-8 Invalid attribute name. The "member" trigger "&a" must be followed by whitespace, "=", a method or the end of the tag.)',
    ],
    [
      "<div &a=",
      '<div> ERR(8-8 EOF reached while parsing the value of the "member" trigger)',
    ],
  ])("error: %j", (code, expected) => {
    expect(render(code, MESH)).toContain(expected);
  });
});

describe("review 439 round 1", () => {
  it.each([
    // Compact ternaries: a `?` before a trigger is never TypeScript's
    // optional marker (Mesh 1).
    [
      "x=c?&a:&b",
      '<x> @ trigger(member expression "&a"@4-6) trigger(member expression "&b"@7-9) ="c?_a:_b"',
    ],
    [
      "x=c? &a : &b",
      '<x> @ trigger(member expression "&a"@5-7) trigger(member expression "&b"@10-12) ="c? _a : _b"',
    ],
    [
      "x=[c]?&a:&b",
      '<x> @ trigger(member expression "&a"@6-8) trigger(member expression "&b"@9-11) ="[c]?_a:_b"',
    ],
    ["x=a?.&b", '<x> @ ="a?.&b"'],
    // A comment after a tagless trigger line, as after a concise tag line
    // (Mesh 2).
    ["&title // c", 'trigger(member line "&title"@0-6) comment(7-11)'],
    ["&title /* c */", 'trigger(member line "&title"@0-6) comment(7-14)'],
    [
      "e\n  &a // c\n  &b",
      '<e> trigger(member line "&a"@4-6) comment(7-11) trigger(member line "&b"@14-16)',
    ],
    // After a value the comment is the value's, as `div a=1 // c` (below).
    ["&a=1 // c", 'trigger(member line "&a"@0-9 ="1 // c")'],
    // Spaces around `=` follow the attribute-value rule (lead ruling).
    ["&a = 1", 'trigger(member line "&a"@0-6 ="1")'],
    ["x &a = 1", '<x> trigger(member attribute "&a"@2-8 ="1")'],
    ["<x &a = 1/>", '<x> trigger(member attribute "&a"@3-9 ="1")'],
    // Positions Mesh found untested.
    ["x() { &a }", '<x> @ trigger(member expression "&a"@6-8) method{" _a "}'],
    ["x=a && &b", '<x> @ trigger(member expression "&b"@7-9) ="a && _b"'],
    [
      "&f=() => &a",
      'trigger(member expression "&a"@9-11) trigger(member line "&f"@0-11 ="() => _a")',
    ],
    [
      "x [\n  &a\n  b=&c\n]",
      '<x> trigger(member attribute "&a"@6-8) @b trigger(member expression "&c"@13-15) ="_c"',
    ],
    // A Unicode identifier is one trigger (Opus B1).
    ["x=&façade", '<x> @ trigger(member expression "&façade"@2-9) ="_fa_ade"'],
    // `&a&&&b`: the third `&` continues the `&&` run, so it is not armed;
    // the value is `_a&&&b`, which Babel rejects. Write `&a && &b` (L4).
    ["x=&a&&&b", '<x> @ trigger(member expression "&a"@2-4) ="_a&&&b"'],
  ])("%j", (code, expected) => {
    expect(render(code, MESH)).toBe(expected);
  });

  it("the attribute-value rule the line trigger follows", () => {
    expect(render("div a=1 // c", undefined)).toBe('<div> @a ="1 // c"');
    expect(render("div a = 1", undefined)).toBe('<div> @a ="1"');
    expect(render("div // c", undefined)).toBe("<div> tag-comment(4-8)");
  });

  it("text after a block comment on a trigger line is an error", () => {
    expect(render("&title /* c */ x", MESH)).toBe(
      'trigger(member line "&title"@0-6) comment(7-14) ERR(15-15 In concise mode a javascript comment block can only be followed by whitespace characters and a newline.)',
    );
  });

  it("a stand-in never merges with what follows the match (Opus B1): the trigger declines (a1 item 4, P2)", () => {
    // It was an error; like an atom on `:aé`, the text now stays source.
    const ascii = table({ expressionTriggers: [ASCII_MEMBER] });
    expect(render("x=&façade", ascii)).toBe('<x> @ ="&façade"');
    const narrow = table({
      expressionTriggers: [{ ...MEMBER, match: "&[a-z]+" }],
    });
    expect(render("x=&fooBar + 1", narrow)).toBe('<x> @ ="&fooBar + 1"');
    const hash = table({
      expressionTriggers: [
        {
          id: "n",
          chars: "#",
          match: "#[a-z]*",
          standIn: "number",
          node: "string",
        },
      ],
    });
    expect(render("x=#.toString()", hash)).toBe('<x> @ ="#.toString()"');
    // Two characters read `0.` and then `.x`: a member of the literal.
    expect(render("x=#a.x", hash)).toBe(
      '<x> @ trigger(n expression "#a"@2-4) ="0..x"',
    );
    // A keep stand-in is the text itself: nothing to merge.
    const keep = table({
      expressionTriggers: [{ ...ASCII_MEMBER, standIn: "keep" }],
    });
    expect(render("x=&façade", keep)).toBe(
      '<x> @ trigger(member expression "&fa"@2-5) ="&façade"',
    );
  });

  it("terminatesValue keeps decision 146's ternary guard (Opus B2)", () => {
    const name = table({
      attributeTriggers: [
        {
          id: "name",
          chars: ":",
          match: ":[A-Za-z_$][\\w$]*",
          standIn: "identifier",
          node: "attribute",
          terminatesValue: true,
        },
      ],
    });
    expect(render("x y=a ? b :c", name)).toBe('<x> @y ="a ? b :c"');
    expect(render("<x y=a ? b :c/>", name)).toBe('<x> @y ="a ? b :c"');
    expect(render("x y=a :c", name)).toBe(
      '<x> @y ="a" trigger(name attribute ":c"@6-8)',
    );
  });

  it("an astral first character arms a trigger (Opus L2)", () => {
    const emoji = table({
      expressionTriggers: [
        {
          id: "e",
          chars: "😀",
          match: "😀[a-z]+",
          standIn: "identifier",
          node: "identifier",
        },
      ],
    });
    expect(validateSyntaxTable(emoji)).toEqual([]);
    expect(render("x=😀ab + 1", emoji)).toBe(
      '<x> @ trigger(e expression "😀ab"@2-6) ="__ab + 1"',
    );
  });
});

/** The atoms-and-sugars rows (slice a1), with the member row. */
const SUGARS = table({
  expressionTriggers: [MEMBER, ATOM],
  attributeTriggers: [MEMBER, NAME, ID, CLASS],
  lineTriggers: [MEMBER],
});

describe('value: "refuse" (a1 item 1; lead ruling Q5)', () => {
  it.each([
    ["<a #main=1/>", "<a> ERR(8-9 The `#main` shorthand takes no value. #3)"],
    [
      "<a #main = 1/>",
      "<a> ERR(9-10 The `#main` shorthand takes no value. #3)",
    ],
    ["<a .big:=x/>", "<a> ERR(7-9 The `.big` shorthand takes no value. #3)"],
    [
      "<a #main(p) { return p }/>",
      "<a> ERR(8-9 The `#main` shorthand takes no value. #3)",
    ],
    ["div .a.b=1", "<div> ERR(8-9 The `.a.b` shorthand takes no value. #3)"],
    [
      "div x=1 #m.c (p) { b }",
      '<div> @x ="1" ERR(13-14 The `#m.c` shorthand takes no value. #3)',
    ],
    // `async` before it is flushed as an attribute first.
    [
      "<a async #m(p) { b }/>",
      "<a> @async ERR(11-12 The `#m` shorthand takes no value. #3)",
    ],
  ])("%j", (code, expected) => {
    expect(render(code, SUGARS, true)).toBe(expected);
  });

  it("a refusing trigger without a value is a trigger", () => {
    expect(render("<a #main .big x=1/>", SUGARS)).toBe(
      '<a> trigger(id attribute "#main"@3-8) trigger(class attribute ".big"@9-13) @x ="1"',
    );
  });

  it("type parameters after a refusing trigger are the generic error (no method)", () => {
    expect(render("<a #m<T>(p) { b }/>", SUGARS)).toBe(
      '<a> ERR(3-6 Invalid attribute name. The "id" trigger "#m" must be followed by whitespace, "=" or the end of the tag.)',
    );
  });

  it("is an attribute-trigger field", () => {
    const expressionRow = table({
      expressionTriggers: [{ ...MEMBER, value: "refuse" }],
    });
    expect(validateSyntaxTable(expressionRow)).toEqual([
      {
        field: "expressionTriggers[0].value",
        triggerId: "member",
        message: "`value` applies to attribute triggers only",
      },
    ]);
    const lineRow = table({ lineTriggers: [{ ...MEMBER, value: "refuse" }] });
    expect(validateSyntaxTable(lineRow).map((d) => d.field)).toEqual([
      "lineTriggers[0].value",
    ]);
    const other = table({
      attributeTriggers: [{ ...MEMBER, value: "accept" as never }],
    });
    expect(validateSyntaxTable(other)).toEqual([
      {
        field: "attributeTriggers[0].value",
        triggerId: "member",
        message: '`value` is "refuse" or omitted',
      },
    ]);
    expect(validateSyntaxTable(SUGARS)).toEqual([]);
  });
});

describe("a method value after an attribute trigger (a1 item 2, T1)", () => {
  it.each([
    // Mesh v4's computed field; atoms and members inside the body lex.
    [
      "boolean :isOverdue({ self }) { return self.status === :sent }",
      '<boolean> trigger(atom expression ":sent"@54-59) trigger(name attribute ":isOverdue"@8-61 ("{ self }") method{" return self.status === 0.000 "})',
    ],
    // Whitespace before `(` and before `{`, as after a name.
    [
      "<a :x (p)  { p }/>",
      '<a> trigger(name attribute ":x"@3-16 ("p") method{" p "})',
    ],
    // Type parameters.
    [
      "<a :x<T>(p: T) { p }/>",
      '<a> trigger(name attribute ":x"@3-20 <"T">("p: T") method{" p "})',
    ],
    // `async` before the trigger modifies the method and starts it.
    [
      "<a async :x(p) { await p }/>",
      '<a> trigger(name attribute ":x"@3-26 async ("p") method{" await p "})',
    ],
    // The member row takes one too; the next attribute follows.
    [
      "field &total() { return 1 } y=2",
      '<field> trigger(member attribute "&total"@6-27 ("") method{" return 1 "}) @y ="2"',
    ],
  ])("%j", (code, expected) => {
    expect(render(code, SUGARS)).toBe(expected);
  });

  it.each([
    // Review 460 r1 (L1): `(args)` with no body are announced with the
    // trigger (core refuses them through the hook), as a named attribute's
    // arguments are lexed; a value may follow them.
    ["sort &a(1)", '<sort> trigger(member attribute "&a"@5-10 args("1"))'],
    ["div :b(x) y", '<div> trigger(name attribute ":b"@4-9 args("x")) @y'],
    [
      "<a :b(:c)/>",
      '<a> trigger(atom expression ":c"@6-8) trigger(name attribute ":b"@3-9 args("0."))',
    ],
    [
      "<a :b(p)=1 y/>",
      '<a> trigger(name attribute ":b"@3-10 args("p") ="1") @y',
    ],
    [
      "<a :b(p) := q/>",
      '<a> trigger(name attribute ":b"@3-13 args("p") :="q")',
    ],
    // `async` before arguments with no body is an attribute.
    [
      "<a async :b(p)/>",
      '<a> @async trigger(name attribute ":b"@9-14 args("p"))',
    ],
    // `:=` after a non-refusing trigger: a value lexed as for `=`.
    ["<a :n:=y/>", '<a> trigger(name attribute ":n"@3-8 :="y")'],
    ["div :n := a.b c", '<div> trigger(name attribute ":n"@4-13 :="a.b") @c'],
    [
      "x &a:=&b",
      '<x> trigger(member expression "&b"@6-8) trigger(member attribute "&a"@2-8 :="_b")',
    ],
    ["<a :n=y/>", '<a> trigger(name attribute ":n"@3-7 ="y")'],
  ])("arguments and `:=` (review 460 L1): %j", (code, expected) => {
    expect(render(code, SUGARS)).toBe(expected);
  });

  it("`async` with no method after the trigger stays an attribute", () => {
    expect(render("<script async :x/>", SUGARS)).toBe(
      '<script> @async trigger(name attribute ":x"@14-16)',
    );
    expect(render("<script async &x/>", SUGARS)).toBe(
      '<script> @async trigger(member attribute "&x"@14-16)',
    );
  });

  it.each([
    // `</` and `<!--` right after it are no type parameters.
    [
      "<a :x</a>",
      '<a> ERR(3-6 Invalid attribute name. The "name" trigger ":x" must be followed by whitespace, "=", a method or the end of the tag.)',
    ],
    [
      "<a :x<!-- c -->/>",
      '<a> ERR(3-6 Invalid attribute name. The "name" trigger ":x" must be followed by whitespace, "=", a method or the end of the tag.)',
    ],
    // Type parameters with no arguments.
    [
      "<a :x<T> y/>",
      "<a> ERR(6-7 Attribute cannot contain type parameters unless it is a shorthand method)",
    ],
  ])("error: %j", (code, expected) => {
    expect(render(code, SUGARS)).toBe(expected);
  });
});

describe("the atom row arms where the built-in atom does (a1 items 3, 4 and 6)", () => {
  const ATOMS = table({ expressionTriggers: [ATOM] });

  it.each([
    // P1: TypeScript's optional marker `?:` (or `? :`) is never followed
    // by an atom; a ternary's `?` is.
    ["x=(a?:T) => a", '<x> @ ="(a?:T) => a"'],
    ["x=(a? :T) => a", '<x> @ ="(a? :T) => a"'],
    ["x=[c]?:a", '<x> @ ="[c]?:a"'],
    [
      "x=c ? :a : :b",
      '<x> @ trigger(atom expression ":a"@6-8) trigger(atom expression ":b"@11-13) ="c ? 0. : 0."',
    ],
    [
      "x=n === 1? :a : :b",
      '<x> @ trigger(atom expression ":a"@11-13) trigger(atom expression ":b"@16-18) ="n === 1? 0. : 0."',
    ],
    // P2: a non-ASCII letter after the name, directly or after `-`: the
    // trigger declines and the text stays source, as `lexAtom` does.
    ["x=[:aé]", '<x> @ ="[:aé]"'],
    ["x=[:a-é]", '<x> @ ="[:a-é]"'],
    ["x=[:a-b-é]", '<x> @ ="[:a-b-é]"'],
    // `::` is the row's own (the hook reports it reserved).
    ["x=::a", '<x> @ trigger(atom expression "::a"@2-5) ="0.0"'],
    // Item 6: no `onAtom` with the row loaded; a declined `:` is the ternary's.
    ["x=a ? :b :c", '<x> @ trigger(atom expression ":b"@6-8) ="a ? 0. :c"'],
  ])("%j", (code, expected) => {
    expect(render(code, ATOMS)).toBe(expected);
  });

  it("each P1/P2 input lexes no built-in atom either", () => {
    for (const code of [
      "x=(a?:T) => a",
      "x=(a? :T) => a",
      "x=[c]?:a",
      "x=[:aé]",
      "x=[:a-é]",
    ]) {
      expect(render(code, undefined), code).not.toMatch(/atom\(/);
    }
  });

  it("P2 leaves a matcher that takes the characters, or never would, alone", () => {
    expect(render("x=&a-é", MESH)).toBe(
      '<x> @ trigger(member expression "&a"@2-4) ="_a-é"',
    );
  });

  it("drops the single-atom default exemption with the built-in atom (182 addendum 1)", () => {
    expect(render("<belongs-to=:X :y/>", undefined)).toBe(
      '<belongs-to> @ atom(X@12-14) ="0." @:y',
    );
    expect(render("<belongs-to=:X :y/>", ATOMS)).toBe(
      '<belongs-to> @ trigger(atom expression ":X"@12-14) ="0. :y"',
    );
  });
});

describe("attribute rows replace the built-in after-value cases (a1 item 6)", () => {
  // The rows without `terminatesValue`: the built-in case is off, so
  // nothing ends the value there.
  const quietName = table({
    attributeTriggers: [{ ...NAME, terminatesValue: false }],
  });
  const quietClass = table({
    attributeTriggers: [{ ...CLASS, terminatesValue: false }],
  });

  it.each([
    ["<a x=1 :b/>", undefined, '<a> @x ="1" @:b'],
    ["<a x=1 :b/>", quietName, '<a> @x ="1 :b"'],
    ["<a x=1 :b/>", SUGARS, '<a> @x ="1" trigger(name attribute ":b"@7-9)'],
    ["<a x=1 :/>", undefined, '<a> @x ="1" @:'],
    [
      "<a x=1 :/>",
      SUGARS,
      "<a> @x ERR(8-8 EOF reached while parsing regular expression)",
    ],
    ["<a x=a .b/>", undefined, '<a> @x ="a" @.b'],
    ["<a x=a .b/>", quietClass, '<a> @x ="a .b"'],
    ["<a x=a .b/>", SUGARS, '<a> @x ="a" trigger(class attribute ".b"@7-9)'],
    // `.5` matches no row, and the stock rule keeps it in the value.
    ["<a x=a .5/>", SUGARS, '<a> @x ="a .5"'],
    // `#` never continued a value.
    ["<a x=1 #b/>", SUGARS, '<a> @x ="1" trigger(id attribute "#b"@7-9)'],
  ] as [string, SyntaxTable | undefined, string][])(
    "%j",
    (code, syntax, expected) => {
      expect(render(code, syntax)).toBe(expected);
    },
  );
});

describe("other trigger shapes", () => {
  it("a letter trigger is armed only at a word start (the fast path does not skip it)", () => {
    const words = table({
      expressionTriggers: [
        {
          id: "words",
          chars: "A-Z",
          match: "[A-Z][a-z]+(?: [A-Z][a-z]+)+",
          standIn: "identifier",
          node: "identifier",
        },
      ],
    });
    expect(render("x=Order Total + 1", words)).toBe(
      '<x> @ trigger(words expression "Order Total"@2-13) ="_rder_Total + 1"',
    );
    expect(render("x=[myOrder Total]", words)).toBe('<x> @ ="[myOrder Total]"');
    expect(render("x=[a.Order Total]", words)).toBe('<x> @ ="[a.Order Total]"');
    // One word only: the matcher does not match.
    expect(render("x=Order + 1", words)).toBe('<x> @ ="Order + 1"');
  });

  it("a number stand-in is the atom rule: `0.` then zeros, `0` for one character", () => {
    const ui = table({
      expressionTriggers: [
        {
          id: "ui",
          chars: "%",
          match: "%[a-z.]*",
          standIn: "number",
          node: "string",
        },
      ],
    });
    expect(render("x=[%ui.save, %]", ui)).toBe(
      '<x> @ trigger(ui expression "%ui.save"@3-11) trigger(ui expression "%"@13-14) ="[0.000000, 0]"',
    );
  });

  it("a keep stand-in reads the source", () => {
    const keep = table({
      expressionTriggers: [
        {
          id: "k",
          chars: "@",
          match: "@[a-z]+",
          standIn: "keep",
          node: "string",
        },
      ],
    });
    expect(render("x=@ab", keep)).toBe(
      '<x> @ trigger(k expression "@ab"@2-5) ="@ab"',
    );
  });

  it("a non-ASCII first character arms through the non-ASCII list", () => {
    const section = table({
      expressionTriggers: [
        {
          id: "s",
          chars: "§",
          match: "§[a-z]+",
          standIn: "identifier",
          node: "identifier",
        },
      ],
    });
    expect(render("x=§ab", section)).toBe(
      '<x> @ trigger(s expression "§ab"@2-5) ="_ab"',
    );
  });

  it("terminatesValue: a space and then the trigger ends the preceding value", () => {
    const ending = table({
      attributeTriggers: [{ ...MEMBER, terminatesValue: true }],
    });
    expect(render("div x=a &b", ending)).toBe(
      '<div> @x ="a" trigger(member attribute "&b"@8-10)',
    );
    expect(render("<div x=a &b/>", ending)).toBe(
      '<div> @x ="a" trigger(member attribute "&b"@9-11)',
    );
    // Not after an operator, not without the space, and not where the
    // matcher does not match: `&&` stays the logical and.
    expect(render("div x=a + &b", ending)).toBe('<div> @x ="a + &b"');
    expect(render("div x=a&b", ending)).toBe('<div> @x ="a&b"');
    expect(render("div x=a &&b", ending)).toBe('<div> @x ="a &&b"');
    // Without the property the same input is a bitwise and.
    expect(render("div x=a &b", MESH)).toBe('<div> @x ="a &b"');
  });
});

describe("read() through stand-ins", () => {
  it("stands in every atom and trigger fully inside the range, same length", () => {
    const code = "<x y=[&ab, :c, &d]/>";
    const parser = createParser({}, { syntax: MESH });
    parser.parse(code);
    const whole = parser.read({ start: 0, end: code.length });
    expect(whole).toBe("<x y=[_ab, 0., _d]/>");
    expect(whole.length).toBe(code.length);
    // A range that only partly covers a trigger reads the source there.
    expect(parser.read({ start: 7, end: 13 })).toBe("ab, 0.");
    expect(parser.read({ start: 7, end: 12 })).toBe("ab, :");
    expect(parser.read({ start: 6, end: 18 })).toBe("_ab, 0., _d]");
  });

  it("a raw open tag reads the source", () => {
    const parser = createParser(
      {
        onOpenTagEnd: (e) => {
          raw = parser.read({ start: 0, end: e.start });
        },
      },
      { syntax: MESH },
    );
    let raw = "";
    parser.parse("style x=&a");
    expect(raw).toBe("style x=&a");
  });

  it("a reused parser forgets the previous parse's triggers", () => {
    const parser = createParser({}, { syntax: MESH });
    parser.parse("x=&a");
    parser.parse("x=1a");
    expect(parser.read({ start: 2, end: 4 })).toBe("1a");
  });
});

describe("the default row", () => {
  it("is deeply frozen and has no triggers", () => {
    expect(Object.isFrozen(DEFAULT_SYNTAX)).toBe(true);
    for (const value of Object.values(DEFAULT_SYNTAX)) {
      if (value && typeof value === "object") {
        expect(Object.isFrozen(value)).toBe(true);
      }
    }
    expect(DEFAULT_SYNTAX).toEqual({
      placeholder: { open: "${", close: "}" },
      inlineScript: { trigger: "$ " },
      blockTag: null,
      filter: null,
      concise: true,
      expressionTriggers: [],
      attributeTriggers: [],
      lineTriggers: [],
      textTriggers: [],
      tagTypes: {},
      expressionLanguage: "ts",
    });
    expect(validateSyntaxTable(DEFAULT_SYNTAX)).toEqual([]);
  });

  it("gives every grammar-corpus probe the event stream of no table at all", () => {
    const events = (code: string, syntax?: SyntaxTable) => {
      const out: string[] = [];
      const handlers = new Proxy(
        {},
        {
          get: (_target, name) =>
            typeof name === "string" && name.startsWith("on")
              ? (e: unknown) => {
                  out.push(`${name} ${JSON.stringify(e)}`);
                }
              : undefined,
        },
      );
      const parser = createParser(handlers, syntax ? { syntax } : undefined);
      try {
        parser.parse(code);
      } catch (error) {
        out.push(`throw ${(error as Error).message}`);
      }
      out.push(parser.read({ start: 0, end: code.length }));
      return out;
    };
    expect(PROBES.length).toBeGreaterThan(1_700);
    const differ = PROBES.filter(
      (p) =>
        JSON.stringify(events(p.input)) !==
        JSON.stringify(events(p.input, DEFAULT_SYNTAX)),
    ).map((p) => p.id);
    expect(differ).toEqual([]);
  });

  it("the & table changes nothing on a probe that has no `&`", () => {
    const plain = PROBES.filter((p) => !p.input.includes("&"));
    expect(plain.length).toBeGreaterThan(1_500);
    const differ = plain
      .filter((p) => render(p.input, undefined) !== render(p.input, MESH))
      .map((p) => p.id);
    expect(differ).toEqual([]);
  });
});

describe("validateSyntaxTable", () => {
  const trigger = (patch: Partial<Trigger>): Trigger => ({
    ...MEMBER,
    ...patch,
  });
  const cases: [string, unknown, string, RegExp][] = [
    ["not an object", 42, "", /is an object/],
    [
      "placeholder shape",
      table({ placeholder: { open: "", close: "}" } }),
      "placeholder",
      /non-empty strings/,
    ],
    [
      "an opener starting with <",
      table({ blockTag: { open: "<%", close: "%>" } }),
      "blockTag.open",
      /may not start with "<"/,
    ],
    [
      "openers not distinct",
      table({
        blockTag: { open: "{%", close: "%}" },
        filter: { open: "{%", close: "::" },
      }),
      "filter.open",
      /are both "\{%"/,
    ],
    [
      "inlineScript shape",
      table({ inlineScript: { trigger: "" } }),
      "inlineScript",
      /non-empty string/,
    ],
    [
      "concise not boolean",
      { ...DEFAULT_SYNTAX, concise: "yes" },
      "concise",
      /is a boolean/,
    ],
    [
      "expressionLanguage",
      { ...DEFAULT_SYNTAX, expressionLanguage: "js" },
      "expressionLanguage",
      /must be "ts"/,
    ],
    [
      "tagTypes not an object",
      { ...DEFAULT_SYNTAX, tagTypes: [] },
      "tagTypes",
      /is an object/,
    ],
    [
      "a list that is not an array",
      { ...DEFAULT_SYNTAX, lineTriggers: {} },
      "lineTriggers",
      /is an array/,
    ],
    [
      "a trigger that is not an object",
      table({ lineTriggers: [null as never] }),
      "lineTriggers[0]",
      /is an object/,
    ],
    [
      "an empty id",
      table({ lineTriggers: [trigger({ id: "" })] }),
      "lineTriggers[0].id",
      /non-empty string/,
    ],
    [
      "an id twice in one list",
      table({
        expressionTriggers: [MEMBER, trigger({ chars: "%", match: "%a" })],
      }),
      "expressionTriggers[1].id",
      /also used by expressionTriggers\[0\]/,
    ],
    [
      "a bad standIn",
      table({ lineTriggers: [trigger({ standIn: "text" as never })] }),
      "lineTriggers[0].standIn",
      /"number", "identifier" or "keep"/,
    ],
    [
      "a bad node",
      table({ lineTriggers: [trigger({ node: { call: "" } })] }),
      "lineTriggers[0].node",
      /or \{ call \}/,
    ],
    [
      "terminatesValue off the attribute list",
      table({ expressionTriggers: [trigger({ terminatesValue: true })] }),
      "expressionTriggers[0].terminatesValue",
      /attribute triggers only/,
    ],
    [
      "chars not a class",
      table({ lineTriggers: [trigger({ chars: "z-a" })] }),
      "lineTriggers[0].chars",
      /body of a character class/,
    ],
    [
      "chars on whitespace",
      table({ lineTriggers: [trigger({ chars: "& " })] }),
      "lineTriggers[0].chars",
      /whitespace/,
    ],
    [
      "an expression trigger on `,`",
      table({ expressionTriggers: [trigger({ chars: ",", match: ",a" })] }),
      "expressionTriggers[0].chars",
      /separates or closes/,
    ],
    [
      "an attribute trigger on `=`",
      table({ attributeTriggers: [trigger({ chars: "=", match: "=a" })] }),
      "attributeTriggers[0].chars",
      /attribute or open-tag syntax/,
    ],
    ...(["<", "-", "/", "@", "$"] as const).map(
      (char): [string, unknown, string, RegExp] => [
        `a line trigger on ${char}`,
        table({
          lineTriggers: [
            trigger({ chars: char, match: char === "$" ? "\\$a" : `${char}a` }),
          ],
        }),
        "lineTriggers[0].chars",
        new RegExp(`may not be armed on "\\${char}"`),
      ],
    ),
    [
      "a number stand-in on an expression token",
      table({
        expressionTriggers: [
          trigger({ chars: "A-Z", match: "[A-Z]+", standIn: "number" }),
        ],
      }),
      "expressionTriggers[0].standIn",
      /"identifier" or "keep"/,
    ],
    [
      "an empty matcher",
      table({ lineTriggers: [trigger({ match: "" })] }),
      "lineTriggers[0].match",
      /non-empty regex/,
    ],
    [
      "an invalid matcher",
      table({ lineTriggers: [trigger({ match: "&(" })] }),
      "lineTriggers[0].match",
      /not a valid regex/,
    ],
    [
      "a look-ahead",
      table({ lineTriggers: [trigger({ match: "&a(?!=)" })] }),
      "lineTriggers[0].match",
      /look-around/,
    ],
    [
      "a look-behind",
      table({ lineTriggers: [trigger({ match: "(?<=x)&a" })] }),
      "lineTriggers[0].match",
      /look-around/,
    ],
    [
      "a back-reference",
      table({ lineTriggers: [trigger({ match: "(&)\\1" })] }),
      "lineTriggers[0].match",
      /back-reference/,
    ],
    [
      "a nested unbounded quantifier",
      table({ lineTriggers: [trigger({ match: "&(a+)+b" })] }),
      "lineTriggers[0].match",
      /nests an unbounded quantifier/,
    ],
    [
      "a nested unbounded quantifier in a counted repeat",
      table({ lineTriggers: [trigger({ match: "&(?:aa*){2,}" })] }),
      "lineTriggers[0].match",
      /nests an unbounded quantifier/,
    ],
    [
      "a matcher matching empty",
      table({ lineTriggers: [trigger({ match: "&?" })] }),
      "lineTriggers[0].match",
      /matches the empty string/,
    ],
    [
      "two triggers on one first character",
      table({
        attributeTriggers: [
          MEMBER,
          trigger({ id: "other", chars: "%&", match: "[%&]b" }),
        ],
      }),
      "attributeTriggers[1].chars",
      /both armed on "&"/,
    ],
    [
      "a text trigger on <",
      table({ textTriggers: [trigger({ chars: "<", match: "<a" })] }),
      "textTriggers[0].chars",
      /template syntax/,
    ],
    // Allowed by the grammar, not implemented by this parser yet.
    [
      "a non-default placeholder",
      table({ placeholder: { open: "{{", close: "}}" } }),
      "placeholder",
      /not supported by this parser yet/,
    ],
    [
      "placeholders off",
      table({ placeholder: null }),
      "placeholder",
      /not supported/,
    ],
    [
      "a non-default inline script",
      table({ inlineScript: { trigger: "% " } }),
      "inlineScript",
      /not supported/,
    ],
    [
      "inline scripts off",
      table({ inlineScript: null }),
      "inlineScript",
      /not supported/,
    ],
    ["concise off", table({ concise: false }), "concise", /layer 3/],
    [
      "a text trigger",
      table({ textTriggers: [trigger({ chars: "%", match: "%a" })] }),
      "textTriggers",
      /never on the `\.mx` row/,
    ],
  ];

  it.each(cases)("%s", (_name, input, field, message) => {
    const found = validateSyntaxTable(input);
    expect(
      found.some((d) => d.field === field && message.test(d.message)),
      JSON.stringify(found),
    ).toBe(true);
  });

  it("names the trigger of a trigger problem", () => {
    expect(
      validateSyntaxTable(
        table({ lineTriggers: [{ ...MEMBER, match: "&?" }] }),
      ),
    ).toEqual([
      {
        field: "lineTriggers[0].match",
        triggerId: "member",
        message:
          "`match` matches the empty string; a trigger consumes at least its first character",
      },
    ]);
  });

  it("accepts the & table, and the same id in several lists", () => {
    expect(validateSyntaxTable(MESH)).toEqual([]);
  });

  it("accepts a delimited repeat, the atom-name shape (Opus L3)", () => {
    for (const match of [
      "&[A-Za-z_$][\\w$]*(?:-[\\w$]+)*",
      "&(?:-[a-z]+)*",
      "&(a+){2}",
    ]) {
      expect(
        validateSyntaxTable(table({ lineTriggers: [{ ...MEMBER, match }] })),
        match,
      ).toEqual([]);
    }
  });

  it("createParser refuses an invalid table with every problem listed", () => {
    expect(() =>
      createParser(
        {},
        {
          syntax: table({
            concise: false,
            lineTriggers: [{ ...MEMBER, chars: "<" }],
          }),
        },
      ),
    ).toThrow(
      /invalid syntax table:\n {2}lineTriggers\[0\]\.chars: .*\n {2}concise: /,
    );
  });
});
