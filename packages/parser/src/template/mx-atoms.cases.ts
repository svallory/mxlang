// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the cases are MX source, whose `${…}` is a placeholder, not a JS template
/**
 * Atom lexing (decision 156) at the parser level: one case table, run against
 * this source copy (`mx-atoms.test.ts`) and against both builds of the patched
 * npm `htmljs-parser` (`patches/htmljs-parser.test.ts`), so the two stay in
 * lockstep.
 *
 * Events are rendered compactly: `<tag>`, `@name`, `="value"` (as `read()`
 * returns it, so atoms show as their same-length numeric stand-in),
 * `..."spread"`, `args:"…"`, `aargs:"…"`, `${"…"}`, `var:"…"`,
 * `params:"…"`, `$"scriptlet"`, `atom(name@start-end)` (`onAtom`) and
 * `ERR(start-end message)`.
 */

/** The structural subset of a parser module these cases drive. */
export interface AtomParserModule {
  createParser(handlers: Record<string, unknown>): {
    parse(code: string): void;
    read(range: { start: number; end: number }): string;
  };
  TagType: { statement: number };
}

interface ValueRange {
  start: number;
  end: number;
  value: { start: number; end: number };
}

// What Marko and `close-tag-opener.ts` return from `onOpenTagName`.
const STATEMENT_TAGS = new Set([
  "static",
  "import",
  "export",
  "server",
  "client",
]);

export function renderAtoms(
  mod: AtomParserModule,
  code: string,
  statements = false,
): string {
  const out: string[] = [];
  const show = (r: { start: number; end: number }) =>
    JSON.stringify(parser.read(r));
  const parser = mod.createParser({
    onError: (e: { start: number; end: number; message: string }) =>
      out.push(`ERR(${e.start}-${e.end} ${e.message})`),
    onAtom: (a: ValueRange) =>
      out.push(
        `atom(${code.slice(a.value.start, a.value.end)}@${a.start}-${a.end})`,
      ),
    onOpenTagName: (t: { start: number; end: number }) => {
      const name = code.slice(t.start, t.end);
      out.push(`<${name}>`);
      if (statements && STATEMENT_TAGS.has(name)) return mod.TagType.statement;
    },
    onTagArgs: (t: ValueRange) => out.push(`args:${show(t.value)}`),
    onTagParams: (t: ValueRange) => out.push(`params:${show(t.value)}`),
    onTagVar: (t: ValueRange) => out.push(`var:${show(t.value)}`),
    onAttrName: (t: { start: number; end: number }) =>
      out.push(`@${code.slice(t.start, t.end)}`),
    onAttrArgs: (t: ValueRange) => out.push(`aargs:${show(t.value)}`),
    onAttrValue: (t: ValueRange) => out.push(`=${show(t.value)}`),
    onAttrMethod: (t: { body: ValueRange }) =>
      out.push(`method:${show(t.body.value)}`),
    onAttrSpread: (t: ValueRange) => out.push(`...${show(t.value)}`),
    onPlaceholder: (t: ValueRange) => out.push(`\${${show(t.value)}}`),
    onScriptlet: (t: ValueRange) => out.push(`$${show(t.value)}`),
  });
  parser.parse(code);
  return out.join(" ");
}

const reserved = (name: string, at: string) =>
  `ERR(${at} \`::${name}\` is reserved (decision 156): \`::\` will be the Symbol.for sugar; write \`:${name}\` for an atom)`;

/** [input, rendered events] — atoms are lexed and stood in for. */
export const ATOMS: [string, string][] = [
  // Research §5 row 1, 2, 3: attribute values.
  ["<div x=:a/>", '<div> @x atom(a@7-9) ="0."'],
  ["<div x=[:a, :b]/>", '<div> @x atom(a@8-10) atom(b@12-14) ="[0., 0.]"'],
  ["<div x=f(:a)/>", '<div> @x atom(a@9-11) ="f(0.)"'],
  ["<div x={k: :a}/>", '<div> @x atom(a@11-13) ="{k: 0.}"'],
  [
    "<div x=a ? :b : :c/>",
    '<div> @x atom(b@11-13) atom(c@16-18) ="a ? 0. : 0."',
  ],
  ["<div x=:rename-all/>", '<div> @x atom(rename-all@7-18) ="0.000000000"'],
  ["<div x=:a-1/>", '<div> @x atom(a-1@7-11) ="0.00"'],
  ["<div x=:$a_b/>", '<div> @x atom($a_b@7-12) ="0.000"'],
  // A trailing or doubled `-` is not part of the name.
  ["<div x=:a - b/>", '<div> @x atom(a@7-9) ="0. - b"'],
  ["<div x=:a--/>", '<div> @x atom(a@7-9) ="0.--"'],
  // After operators, punctuators and operator keywords.
  ["<div x=a || :b/>", '<div> @x atom(b@12-14) ="a || 0."'],
  ["<div x=a ?? :b/>", '<div> @x atom(b@12-14) ="a ?? 0."'],
  ["<div x=a === :b/>", '<div> @x atom(b@13-15) ="a === 0."'],
  ["<div x=(a) => :b/>", '<div> @x atom(b@14-16) ="(a) => 0."'],
  ["<div x=!:a/>", '<div> @x atom(a@8-10) ="!0."'],
  ["<div x=[...:a]/>", '<div> @x atom(a@11-13) ="[...0.]"'],
  [
    "<div x=() => { return :a }/>",
    '<div> @x atom(a@22-24) ="() => { return 0. }"',
  ],
  ["<div x=typeof :a/>", '<div> @x atom(a@14-16) ="typeof 0."'],
  ["<div x=(a in :b)/>", '<div> @x atom(b@13-15) ="(a in 0.)"'],
  [
    "<div x=[\n :a,\n :b\n]/>",
    '<div> @x atom(a@10-12) atom(b@15-17) ="[\\n 0.,\\n 0.\\n]"',
  ],
  // A comment between the operator and the atom is skipped.
  ["<div x=[ /* c */ :a]/>", '<div> @x atom(a@17-19) ="[ /* c */ 0.]"'],
  ["<div x=[ // c\n :a]/>", '<div> @x atom(a@15-17) ="[ // c\\n 0.]"'],
  // Row 4: placeholders, tag arguments, concise mode, attribute tags,
  // spreads, attribute arguments, default attributes, template `${}`.
  ["<div>${:a}</div>", '<div> atom(a@7-9) ${"0."}'],
  ["<div>${[:a, :b]}</div>", '<div> atom(a@8-10) atom(b@12-14) ${"[0., 0.]"}'],
  ["<div>$!{:a}</div>", '<div> atom(a@8-10) ${"0."}'],
  ["<if(:a)>y</if>", '<if> atom(a@4-6) args:"0."'],
  [
    "<if(a ? :b : :c)>y</if>",
    '<if> atom(b@8-10) atom(c@13-15) args:"a ? 0. : 0."',
  ],
  ["div x=[:a, :b]\n", '<div> @x atom(a@7-9) atom(b@11-13) ="[0., 0.]"'],
  ["<t><@b x=[:a]/></t>", '<t> <@b> @x atom(a@10-12) ="[0.]"'],
  ["<div ...{ k: :a }/>", '<div> atom(a@13-15) ..."{ k: 0. }"'],
  ["<t x(:a)/>", '<t> @x atom(a@5-7) aargs:"0."'],
  ["<if=:a>y</if>", '<if> @ atom(a@4-6) ="0."'],
  ["<const/x=:a/>", '<const> var:"x" @ atom(a@9-11) ="0."'],
  ["<div x=`t :a ${:b}`/>", '<div> @x atom(b@15-17) ="`t :a ${0.}`"'],
  ["<div>${`${:a}`}</div>", '<div> atom(a@10-12) ${"`${0.}`"}'],
  // Row 5: whitespace after `=` is consumed before the value starts.
  ["<div x= :b/>", '<div> @x atom(b@8-10) ="0."'],
  ["<div x = :b/>", '<div> @x atom(b@9-11) ="0."'],
  ["t x= :b", '<t> @x atom(b@5-7) ="0."'],
  // Row 6: the ternary counter skips an atom's `:`, so this is ONE value
  // (decision 146's after-value split used to cut it at ` :c`).
  ["<div x=a ? :b :c/>", '<div> @x atom(b@11-13) ="a ? 0. :c"'],
  ["<div x=a ?:b :c/>", '<div> @x atom(b@10-12) ="a ?0. :c"'],
  ["<div x=a ? :b :c :d/>", '<div> @x atom(b@11-13) ="a ? 0. :c" @:d'],
  [
    "<div x=:a ? :b : :c/>",
    '<div> @x atom(a@7-9) atom(b@12-14) atom(c@17-19) ="0. ? 0. : 0."',
  ],
  // A method-shorthand body is an attribute value: it lowers to a function
  // (lead ruling 2026-10-05). TypeScript inside it keeps its colons.
  [
    "<div onClick() { return :a; }/>",
    '<div> @onClick atom(a@24-26) method:" return 0.; "',
  ],
  [
    "boolean :isOverdue({ self }) { return self.status === :sent }\n",
    '<boolean> @:isOverdue atom(sent@54-59) method:" return self.status === 0.000 "',
  ],
  [
    "<div x() { switch (k) { case :a: return 1; default: return 2 } }/>",
    '<div> @x atom(a@29-31) method:" switch (k) { case 0.: return 1; default: return 2 } "',
  ],
  [
    "<div x(a: T) { const y: string = :b; return { k: :c, y } }/>",
    '<div> @x atom(b@33-35) atom(c@49-51) method:" const y: string = 0.; return { k: 0., y } "',
  ],
  [
    "<div x() { return a ? :b : c }/>",
    '<div> @x atom(b@22-24) method:" return a ? 0. : c "',
  ],
  [
    "<div x() { return `t :a ${:b}` /* :c */ }/>",
    '<div> @x atom(b@26-28) method:" return `t :a ${0.}` /* :c */ "',
  ],
  [
    "<div async x() { return await f(:a) }/>",
    '<div> @x atom(a@32-34) method:" return await f(0.) "',
  ],
  // A keyword key with whitespace before `:` reads as keyword + atom (lead
  // ruling, review round 3): ambiguous with `return :a` and `case :a`, and
  // `new :a` is atom misuse anyway. Write `{ new: a }`. See divergences.md.
  ["<div x={ new :a }/>", '<div> @x atom(a@13-15) ="{ new 0. }"'],
  [
    "<div x={ delete :a, in :b }/>",
    '<div> @x atom(a@16-18) atom(b@23-25) ="{ delete 0., in 0. }"',
  ],
  // An atom named like an operator keyword is still an expression end
  // (review round 2): the next ` :b` is name sugar or the ternary's `:`.
  ["<div x=:delete :b/>", '<div> @x atom(delete@7-14) ="0.00000" @:b'],
  ["<div x=:new :b/>", '<div> @x atom(new@7-11) ="0.00" @:b'],
  ["<div x=:foo-new :b/>", '<div> @x atom(foo-new@7-15) ="0.000000" @:b'],
  ["<div x=a ? :new :b/>", '<div> @x atom(new@11-15) ="a ? 0.00 :b"'],
  [
    "<div x=c ? :delete :keep/>",
    '<div> @x atom(delete@11-18) ="c ? 0.00000 :keep"',
  ],
  ["<div x=:in :b/>", '<div> @x atom(in@7-10) ="0.0" @:b'],
  ["<div x=:typeof :b/>", '<div> @x atom(typeof@7-14) ="0.00000" @:b'],
  // Review round 4 (PR #342): contextual keywords as identifiers, unary `!`,
  // and every `${}` (in raw-text bodies and tag names too, addendum 2).
  ["<div x=f(of, :b)/>", '<div> @x atom(b@13-15) ="f(of, 0.)"'],
  ["<div x=typeof!:a/>", '<div> @x atom(a@14-16) ="typeof!0."'],
  ["<div x=!:a/>", '<div> @x atom(a@8-10) ="!0."'],
  ["<div x=a => :b/>", '<div> @x atom(b@12-14) ="a => 0."'],
  [
    "<div x() { for (const v of :a) {} }/>",
    '<div> @x atom(a@27-29) method:" for (const v of 0.) {} "',
  ],
  [
    "<div x() { return await :a }/>",
    '<div> @x atom(a@24-26) method:" return await 0. "',
  ],
  ["<style>${:a}</style>", '<style> atom(a@9-11) ${"0."}'],
  ["<script>${:a}</script>", '<script> atom(a@10-12) ${"0."}'],
  ["<textarea>${:a}</textarea>", '<textarea> atom(a@12-14) ${"0."}'],
  ["<${:a}/>", "atom(a@3-5) <${:a}>"],
  ["<div.${:a}/>", "<div> atom(a@7-9)"],
  ["<div#${:a}/>", "<div> atom(a@7-9)"],
  [
    "<div x=:a",
    '<div> @x atom(a@7-9) ERR(7-7 EOF reached while parsing attribute value for the "x" attribute)',
  ],
  [
    "<div>${:a",
    "<div> atom(a@7-9) ERR(7-7 EOF reached while parsing placeholder)",
  ],
  ["<div x=:a:b/>", '<div> @x atom(a@7-9) ="0.:b"'],
  ["<div x=a / :b/>", '<div> @x atom(b@11-13) ="a / 0."'],
  [
    "<div x=a ? :b : c ? :d :e/>",
    '<div> @x atom(b@11-13) atom(d@20-22) ="a ? 0. : c ? 0. :e"',
  ],
  // Row 12: an atom value followed by decision 146 name sugar.
  ["<div x=:a :b/>", '<div> @x atom(a@7-9) ="0." @:b'],
  ["<div :b x=:a/>", '<div> @:b @x atom(a@10-12) ="0."'],
  ["<div:b x=[:c]/>", '<div:b> @x atom(c@10-12) ="[0.]"'],
  ["<div x=:a .b/>", '<div> @x atom(a@7-9) ="0." @.b'],
  ["div x=:a :b", '<div> @x atom(a@6-8) ="0." @:b'],
];

/** [input, rendered events] — `::name` is reserved: a positioned error. */
export const RESERVED: [string, string][] = [
  ["<div x=::a/>", `<div> @x ${reserved("a", "7-10")}`],
  ["<div x={k::a}/>", `<div> @x ${reserved("a", "9-12")}`],
  ["<div x=a?b::c/>", `<div> @x ${reserved("c", "10-13")}`],
  ["<div>${::rename-all}</div>", `<div> ${reserved("rename-all", "7-19")}`],
  ["<if(::a)>y</if>", `<if> ${reserved("a", "4-7")}`],
  ["<div x=[:a, ::b]/>", `<div> @x atom(a@8-10) ${reserved("b", "12-15")}`],
  [
    "<div x=::/>",
    "<div> @x ERR(7-9 `::` is reserved (decision 156): `::` will be the Symbol.for sugar; write `:name` for an atom)",
  ],
  // `::` in attribute-name and tag-name position (decision 156 addendum 2).
  [
    "<a ::b/>",
    "<a> ERR(3-6 `::b` is reserved (decision 156): `::` will be the Symbol.for sugar; write `:b` for an atom)",
  ],
  [
    "<a::b/>",
    "ERR(2-5 `::b` is reserved (decision 156): `::` will be the Symbol.for sugar; write `:b` for an atom)",
  ],
  [
    "<div :: />",
    "<div> ERR(5-7 `::` is reserved (decision 156): `::` will be the Symbol.for sugar; write `:name` for an atom)",
  ],
];

/** [input, rendered events] — never atoms (research §5 rows 8, 9). */
export const NOT_ATOMS: [string, string][] = [
  // Strings, template text, regex literals and comments.
  ['<div x="s :a"/>', '<div> @x ="\\"s :a\\""'],
  ["<div x='s :a'/>", "<div> @x =\"'s :a'\""],
  ["<div x=`t :a`/>", '<div> @x ="`t :a`"'],
  ["<div x=/ :a/g/>", '<div> @x ="/ :a/g"'],
  ["<div x=a /* :b */ + c/>", '<div> @x ="a /* :b */ + c"'],
  ["<div x=[a // :b\n]/>", '<div> @x ="[a // :b\\n]"'],
  // After an expression end: identifiers, literals, `)`, `]`, `}`, strings.
  ["<div x=a ? b :c/>", '<div> @x ="a ? b :c"'],
  ["<div x=(a ? b :c)/>", '<div> @x ="(a ? b :c)"'],
  ["<div x={ a:b }/>", '<div> @x ="{ a:b }"'],
  ["<div x=(x :number) => x/>", '<div> @x ="(x :number) => x"'],
  ["<div x=(x):number => x/>", '<div> @x ="(x):number => x"'],
  ["<div x=f([k]:a)/>", '<div> @x ="f([k]:a)"'],
  ["<div x={ 'k':a }/>", "<div> @x =\"{ 'k':a }\""],
  ["<div x=(a ? 1 :b)/>", '<div> @x ="(a ? 1 :b)"'],
  // After `.`, `?.`, `as`, `satisfies` and other (non-operator) words.
  ["<div x=o.:a/>", '<div> @x ="o.:a"'],
  ["<div x=o?.:a/>", '<div> @x ="o?.:a"'],
  ["<div x=(a as :b)/>", '<div> @x ="(a as :b)"'],
  ["<div x=(a satisfies :b)/>", '<div> @x ="(a satisfies :b)"'],
  ["<div x=(o.return :a)/>", '<div> @x ="(o.return :a)"'],
  // TypeScript's optional marker `x?:` and definite assignment `x!:`.
  ["<div x=(a?: number) => a/>", '<div> @x ="(a?: number) => a"'],
  ["<div x=(a?:number) => a/>", '<div> @x ="(a?:number) => a"'],
  ["<div x=() => { let a!:T; }/>", '<div> @x ="() => { let a!:T; }"'],
  // Stock htmljs-parser ends an unparenthesized value at a binary keyword
  // followed by `:`, so this is name sugar, as before atoms.
  ["<div x=a in :b/>", '<div> @x ="a" @in @:b'],
  // A word written right against `:` is a key or label, keyword or not
  // (review round 2): `{ new:a }` parsed before atoms and still does.
  ["<div x={ new:a }/>", '<div> @x ="{ new:a }"'],
  [
    "<div x={ delete:x, in:y, of:z, do:w }/>",
    '<div> @x ="{ delete:x, in:y, of:z, do:w }"',
  ],
  [
    "<div x() { return { return:1 } }/>",
    '<div> @x method:" return { return:1 } "',
  ],
  // A `:` not followed by a name start.
  ["<div x=(a ? b : 1)/>", '<div> @x ="(a ? b : 1)"'],
  ["<div x=[a ?: 1]/>", '<div> @x ="[a ?: 1]"'],
  ["<div x=[:1]/>", '<div> @x ="[:1]"'],
  // Review round 4 (PR #342, D1): TypeScript markers and type ends win
  // even with whitespace before `:`; `of`/`yield` as identifiers. Each
  // expected value is the pre-atoms parse.
  ["<div x=c ? a! :b/>", '<div> @x ="c ? a! :b"'],
  ["<div x=c ? (a)! :b/>", '<div> @x ="c ? (a)! :b"'],
  ["<div x=(a? :T) => a/>", '<div> @x ="(a? :T) => a"'],
  [
    "<div onClick(e? :Event) { return e }/>",
    '<div> @onClick method:" return e "',
  ],
  ["<div x={ a? :T }/>", '<div> @x ="{ a? :T }"'],
  ["<div x() { let t: { b? :U } }/>", '<div> @x method:" let t: { b? :U } "'],
  ["<div x() { class C { b! :U } }/>", '<div> @x method:" class C { b! :U } "'],
  ["<div x=c ? y as Array<T> :z/>", '<div> @x ="c ? y as Array<T> :z"'],
  [
    "<div x=c ? x satisfies Foo<T> :d/>",
    '<div> @x ="c ? x satisfies Foo<T> :d"',
  ],
  ["<div x=c ? of :b/>", '<div> @x ="c ? of :b"'],
  ["<div x=c ? yield :b/>", '<div> @x ="c ? yield :b"'],
  ["<div x=c ? a! :b :name/>", '<div> @x ="c ? a! :b" @:name'],
  // A non-ASCII letter right after a name: no atom, so no stand-in can
  // reach Babel's message (N5). A touching keyword is never an operator
  // (Q4). A regex end is an operand. A statement after a block (N8).
  ["<div x=:a\u00e9/>", '<div> @x =":a\u00e9"'],
  ["<div x=typeof:a/>", '<div> @x ="typeof:a"'],
  ["<div x=/r/ :b/>", '<div> @x ="/r/" @:b'],
  ["<div x() { if (a) {} :b }/>", '<div> @x method:" if (a) {} :b "'],
  // Statement tags, scriptlets, tag variables, tag params.
  ["static const s = :a;\n<div/>", "<static> <div>"],
  ["$ const y = :a;\n<div/>", '$"const y = :a;" <div>'],
  ["$ { const y = :a; }\n<div/>", '$" const y = :a; " <div>'],
  ["<for|:a| of=x>y</for>", '<for> params:":a" @of ="x"'],
  // The attribute name position is never a value (decision 146 sugar).
  ["<div :a/>", "<div> @:a"],
  ["<div:a/>", "<div:a>"],
];

/**
 * Decision 146's forms (research §4, the 31 `p8-invariants` sources): every
 * piece of sugar lives in tag and attribute names, never in a value, so none
 * of these lexes an atom or reports `::`.
 */
export const SUGAR_FORMS: string[] = [
  "<:email/>",
  "<input:email/>",
  "<input :email/>",
  "<input#main:email.big/>",
  "<input:email#main.big/>",
  "<input:email.big#main/>",
  "<input.big:email#main/>",
  "<input.big#main:email/>",
  "<input#main.big:email/>",
  "<:email.big/>",
  "<input #main/>",
  "<input .big/>",
  '<input :email type="email"/>',
  '<input type="email" :email/>',
  "<input x=1 #main .big :email/>",
  "<input x=a.b .c/>",
  "<input:email=1/>",
  "<input :email=1/>",
  "<input:email(a) { return a; }/>",
  "<input #main(a) { return a; }/>",
  "<input x=1 :/>",
  "<input :/>",
  "<a:b:c/>",
  "<if=a\n  .b>x</if>",
  "<const/x=items\n  .filter(Boolean)/>\n${x}",
  "<div class:x=1/>",
  "<div style:x=1/>",
  "<input value:fn:=x/>",
  "<div><@svg:rect/></div>",
  "<input x=a ? b :c/>",
  "<input x=(a) :T => a/>",
];

/**
 * Review round 4 (N4): a read from a tag name start (the raw open tag that
 * `@marko/compiler` uses for `rawValue`, as `<style>` does) is the source,
 * while the attribute value still reads its stand-in. Returns both reads.
 */
export function rawOpenTagReads(mod: AtomParserModule): {
  raw: string;
  value: string;
} {
  const code = "<style x=:a>b{}</style>";
  let nameStart = -1;
  let value = "";
  let raw = "";
  const parser = mod.createParser({
    onOpenTagName: (t: { start: number }) => {
      nameStart = t.start;
    },
    onAttrValue: (t: ValueRange) => {
      value = parser.read(t.value);
    },
    onOpenTagEnd: (t: { end: number }) => {
      raw = parser.read({ start: nameStart, end: t.end - 1 });
    },
  });
  parser.parse(code);
  return { raw, value };
}

/**
 * Review round 4 (N1): read() finds atoms by binary search. Checks every
 * sub-range of a value holding many atoms against a linear stand-in, and
 * returns the mismatches (none expected).
 */
export function readMismatches(mod: AtomParserModule): string[] {
  const items = Array.from({ length: 40 }, (_, k) => `:a${k}`);
  const code = `<div x=[${items.join(", ")}]/>`;
  const parser = mod.createParser({});
  parser.parse(code);
  const atoms: [number, number][] = [];
  for (const m of code.matchAll(/:a\d+/g)) {
    atoms.push([m.index, m.index + m[0].length]);
  }
  const naive = (start: number, end: number) => {
    let out = "";
    let last = start;
    for (const [a, b] of atoms) {
      if (a < start || b > end) continue;
      out += code.slice(last, a) + "0." + "0".repeat(b - a - 2);
      last = b;
    }
    return out + code.slice(last, end);
  };
  const bad: string[] = [];
  for (let start = 6; start < code.length; start += 3) {
    for (let end = start; end <= code.length; end += 5) {
      const got = parser.read({ start, end });
      if (got !== naive(start, end)) bad.push(`${start}-${end}: ${got}`);
    }
  }
  return bad;
}
