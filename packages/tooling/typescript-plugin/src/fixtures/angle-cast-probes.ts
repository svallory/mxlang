// biome-ignore-all lint/suspicious/noTemplateCurlyInString: authored MX template fixtures
// Shared by the real editor-service and mx-tsc regression tests.
export const ANGLE_INPUT =
  "export interface Input { num: number; text: string; obj: { a?: string }; xs: string[] }\n";

export const ATTRIBUTE_CAST_RANGES = [
  "<define/L|{item}: {item?: any}|/><L><for|i| from=(<number>input.zz) to=3><@item n=(<number>input.zz)/></for></L>",
  "<define/L|{item}: {item?: any}|/><L><for|i| from=0 to=(<number>input.zz)><@item n=(<number>input.zz)/></for></L>",
] as const;

export const ANGLE_PROBES = [
  ["placeholder", "<p>${<string>input.zz}</p>"],
  ["raw placeholder", "<p>$!{<string>input.zz}</p>"],
  ["attribute", "<p title=(<string>input.zz)/>"],
  ["spread", "<p ...(<any>input.zz)/>"],
  ["class", "<p class=(<string>input.zz)/>"],
  ["style", "<p style={color:(<string>input.zz)}/>"],
  ["const value", "<const/y=(<string>input.zz)/>${y}"],
  ["let value", "<let/y=(<string>input.zz)/>${y}"],
  ["const object pattern", "<const/{a=(<string>input.zz)}=input.obj/>${a}"],
  ["let object pattern", "<let/{a=(<string>input.zz)}=input.obj/>${a}"],
  ["array pattern", "<const/[a=(<string>input.zz)]=input.xs/>${a}"],
  ["if", "<if=(<boolean>input.zz)>yes</if>"],
  ["else-if", "<if=false>no</if><else-if=(<boolean>input.zz)>yes</else-if>"],
  ["for of", "<for|item| of=(<string[]>input.zz)>${item}</for>"],
  ["for in", "<for|key| in=(<Record<string,string>>input.zz)>${key}</for>"],
  ["for from", "<for|i| from=(<number>input.zz) to=2 by=String>${i}</for>"],
  ["for to", "<for|i| to=(<number>input.zz) by=String>${i}</for>"],
  ["for until", "<for|i| until=(<number>input.zz) by=String>${i}</for>"],
  [
    "tag argument",
    "<define/Foo|value: string|>${value}</define><Foo(<string>input.zz)/>",
  ],
  [
    "tag parameter",
    "<define/Foo|value=(<string>input.zz)|>${value}</define><Foo(undefined)/>",
  ],
  [
    "attribute tag",
    "<define/Foo|{head}: {head: {title: string; content?: () => unknown}}|>${head.title}</define><Foo><@head title=(<string>input.zz)/></Foo>",
  ],
  ["return", "<return=(<string>input.zz)/>"],
  ["html-comment", "<html-comment>${<string>input.zz}</html-comment>"],
  ["dynamic name", "<${<any>input.zz}/>"],
  ["mixed dynamic name", "<p${<string>input.zz}/>"],
  [
    "method parameter",
    "<define/Foo|{f}: {f: (v?: string) => string}|>${f()}</define><Foo f(value=(<string>input.zz)) { return value; }/>",
  ],
  [
    "method body",
    "<define/Foo|{f}: {f: () => string}|>${f()}</define><Foo f() { return <string>input.zz; }/>",
  ],
  ["generator body", "<const/f=(function*(){ yield <string>input.zz; })/>${f}"],
  ["call argument", "<p>${String(<string>input.zz)}</p>"],
  ["ternary", "<p>${true ? <string>input.zz : ''}</p>"],
  ["arrow body", "<p>${(() => <string>input.zz)()}</p>"],
  ["async arrow", "<const/f=(async () => <string>input.zz)/>${f}"],
  ["template literal", "<p>${`a${<string>input.zz}`}</p>"],
  ["member receiver", "<p>${(<string>input.zz).length}</p>"],
  ["as wrapper", "<p>${(<string>input.zz) as string}</p>"],
  ["non-null wrapper", "<p>${(<string>input.zz)!}</p>"],
  ["satisfies wrapper", "<p>${(<string>input.zz) satisfies string}</p>"],
  ["nested assertions", "<p>${<string><unknown>input.zz}</p>"],
  [
    "static statement",
    'static const o = {text: ""}; const s = <string>o.zz;\n${s}',
  ],
  [
    "static block",
    'static const o = {text: ""};\nstatic { const s = <string>o.zz; }\n${s}',
  ],
  [
    "export statement",
    'static const o = {text: ""};\nexport const s = <string>o.zz;\n${s}',
  ],
  [
    "server statement",
    'static const o = {text: ""};\nserver const s = <string>o.zz;\n${s}',
  ],
  [
    "client statement",
    'static const o = {text: ""};\nclient const s = <string>o.zz;\n${s}',
  ],
] as const;

/** Exercise the moved type token in the same containers as the operand. */
export function withMissingType(probe: string): string {
  return probe
    .replace(/<(?:string|boolean|number|any)(?:\[\])?>/, "<Missing>")
    .replace("<Record<string,string>>", "<Record<string,Missing>>")
    .replace(/\b(input|o)\.zz/, "$1.text");
}

/** Follow existing host policy: let/comments are html-only; methods need JSX. */
export function angleProbesFor(host: string) {
  return ANGLE_PROBES.filter(([name]) =>
    host === "html"
      ? !name.startsWith("method ")
      : !name.startsWith("let ") &&
        name !== "html-comment" &&
        !name.startsWith("server ") &&
        !name.startsWith("client "),
  );
}

/** Operator diagnostics include the synthetic parentheses of a bare cast. */
export const OPERATOR_PROBES = [
  ["<p>${<string>input.text * 2}</p>", 2362, "<string>input.text"],
  ["<p>${<string> input.text * 2}</p>", 2362, "<string> input.text"],
  ["<p>${<string>input.text - 2}</p>", 2362, "<string>input.text"],
  // TS2365 blames the complete comparison, rather than just its operand.
  ["<p>${<string>input.text < 2}</p>", 2365, "<string>input.text < 2"],
  ["<p>${-<symbol>Symbol()}</p>", 2469, "<symbol>Symbol()"],
] as const;

// The existing html-comment helper is untyped even without an assertion.
// Do not confuse its unrelated noImplicitAny diagnostics with cast mappings.
export const HTML_COMMENT_HELPER_ERROR =
  /Parameter '__mx(?:Value|Escaped)' implicitly has an 'any' type/;

/** Preserved literals must still print and check their authored wrappers. */
export const CHECKED_LITERAL_PROBES = [
  [
    '<define/Foo|{n}: {n: number}|>${n}</define><Foo n=("3" as any)/>',
    '"3" as any',
    "",
  ],
  [
    '<define/Foo|{n}: {n: number}|>${n}</define><Foo n=(<any>"3")/>',
    '"3" as any',
    "",
  ],
  ['<p id=("x" as number)/>', '"x" as number', '"x" as number'],
  ['<p id=(<number>"x")/>', '"x" as number', '<number>"x"'],
  ['<p id=("x" as const)/>', '"x" as const', ""],
  ['<p id=(<const>"x")/>', '"x" as const', ""],
  ["${(`t` as unknown)}", "`t` as unknown", ""],
  ["${(<unknown>`t`)}", "`t` as unknown", ""],
  ["<p>${(`t` as unknown)}</p>", "`t` as unknown", ""],
  ["<p>${(<unknown>`t`)}</p>", "`t` as unknown", ""],
] as const;

/** Nested unknown children exercise Preact's own renderability policy. */
export function checkedLiteralProbesFor(host: string) {
  return CHECKED_LITERAL_PROBES.filter(
    ([probe]) => host === "preact" || !probe.startsWith("<p>${"),
  );
}

export const VALID_ANGLE_PROBES = [
  "<p>${<string>input.text}</p>",
  "<p>${<const>[1, 2]}</p>",
  "<const/value=(<const>{a: 1})/>${value.a}",
  "<p>${(<string>input.text).length}</p>",
  "<p>${(<string>input.text) as string}</p>",
  "<p>${(<string>input.text)!}</p>",
  "<p>${<number>input.num + 1}</p>",
  "<p>${<string /* > */>input.text}</p>",
  "<p>${<string> /* operand */ (input.text)}</p>",
  "<p>${<Array<string>>input.xs}</p>",
] as const;
