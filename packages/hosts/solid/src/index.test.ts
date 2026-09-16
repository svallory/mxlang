import { describe, expect, it } from "vitest";
import { compileSolidMx } from "./index.ts";

const compile = (source: string) =>
  compileSolidMx(source, { filename: "fixture.solid.mx" });

function expectError(source: string, expected: string): void {
  let error: unknown;
  try {
    compile(source);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(expected);
}

describe("Solid IR lowering", () => {
  const rows: Array<[string, string, string[]]> = [
    [
      "text and interpolation",
      `<p>Hello \${name}</p>`,
      ["<p>Hello ", "{name}</p>"],
    ],
    [
      "element attributes",
      `<input disabled title="x" value=v ...rest>`,
      [
        "<input",
        " disabled={true}",
        ` title="x"`,
        " value={v}",
        " {...rest}",
        " />",
      ],
    ],
    [
      "attribute method",
      `<button onClick(e) { run(e) }>go</button>`,
      ["onClick={(e) => {", "run(e);", "}}"],
    ],
    ["prop namespace", `<input prop:value=v>`, ["prop:value={v}"]],
    [
      "class and id shorthand",
      `<div#main.card.big>x</div>`,
      [`id="main"`, `class="card big"`],
    ],
    [
      "object class merge",
      `<div.card class={active: on()}>x</div>`,
      [`class={["card", { active: on() }]}`],
    ],
    // Sliced verbatim from source (no space after `{`): `expr()` keeps the
    // author's own spacing once it can slice, the same seam that keeps
    // TypeScript type arguments (see packages/core's core.ts).
    ["object style", `<div style={color: c()}/>`, ["style={{color: c()}}"]],
    ["raw HTML", `<div>$!{html}</div>`, ["<div innerHTML={html}></div>"]],
    [
      "component render props",
      `<Layout|input| id="x"><@head><h1>H</h1></@head><@foot|year|>\${year}</@foot><p>\${input}</p></Layout>`,
      [
        `<Layout id="x" head={<h1>H</h1>} foot={(year) => year}>`,
        `{(input) => <p>{input}</p>}`,
      ],
    ],
    ["if", `<if=ready>yes</if>`, ["<Show when={ready}><>yes</></Show>"]],
    [
      "if / else",
      `<if=a>A</if><else>B</else>`,
      ["<Show when={a} fallback={<>B</>}><>A</></Show>"],
    ],
    [
      "one else-if",
      `<if=a>A</if><else if=b>B</else><else>C</else>`,
      ["fallback={<Show when={b} fallback={<>C</>}><>B</></Show>}"],
    ],
    [
      "multiple else-if branches",
      `<if=a>A</if><else if=b>B</else><else if=c>C</else><else if=d>D</else><else>E</else>`,
      ["<Switch fallback={<>E</>}>", "<Match when={a}>", "<Match when={d}>"],
    ],
    [
      "list loop",
      `<for|item, i| of=items><p>\${item}</p></for>`,
      ["<For each={items}>", "{(item, i) => <p>{item}</p>}"],
    ],
    [
      "keyed list loop",
      `<for|item| of=items by="id"><p>\${item}</p></for>`,
      ["keyed={x => x.id}"],
    ],
    [
      "identity-keyed list loop",
      `<for|item| of=items by=identity><p>\${item}</p></for>`,
      ["<For each={items}>{(item) => <p>{item}</p>}</For>"],
    ],
    [
      "function-keyed list loop",
      `<for|item| of=items by=myKeyFn><p>\${item}</p></for>`,
      ["keyed={myKeyFn}"],
    ],
    [
      "object loop",
      `<for|key, value| in=record><p>\${key}</p></for>`,
      [
        "each={Object.entries(record)}",
        "keyed={e => e[0]}",
        // `keyed={fn}` means Solid hands the whole entry as one accessor, so
        // the pair cannot be destructured in the parameter list; each name
        // reads through the accessor instead.
        "{(mxEntry) =>",
        "mxEntry()[0]",
      ],
    ],
    [
      "inclusive range",
      `<for|i| from=2 to=4><p>\${i}</p></for>`,
      ["<Repeat count={3} from={2}>", "{(i) => <p>{i}</p>}"],
    ],
    [
      "exclusive range",
      `<for|i| from=2 until=4><p>\${i}</p></for>`,
      ["<Repeat count={2} from={2}>"],
    ],
    [
      "stepped range",
      `<for|n| from=2 to=8 step=2><p>\${n}</p></for>`,
      ["<Repeat count={4}>", "const n = (2) + mxIndex * (2);"],
    ],
    [
      "try boundary",
      `<try><@placeholder>wait</@placeholder><Risky/><@catch|error, reset|><p>\${error.message}</p></@catch></try>`,
      [
        "<Errored fallback={(error, reset) => <p>{error.message}</p>}>",
        "<Loading fallback={<>wait</>}><Risky /></Loading>",
      ],
    ],
    // Round 1 item 1 regression: `<try>`'s body must reach the host
    // unchanged, matching `lowerHostTag`'s old unconditional lowering,
    // rather than being gated on `hasContent` the way an ordinary
    // (template-authored) custom tag's body is.
    ["try whitespace-only body", `<try>  </try>`, ["<Loading> </Loading>"]],
    [
      "try mixed text and markup body",
      `<try>a <b>c</b></try>`,
      ["<Loading>a <b>c</b></Loading>"],
    ],
  ];

  for (const [name, source, expected] of rows) {
    it(name, () => {
      const result = compile(source);
      for (const text of expected) expect(result.code).toContain(text);
      expect(result.map.sources).toEqual(["fixture.solid.mx"]);
      expect(result.map.sourcesContent).toEqual([source]);
    });
  }
});

describe("Solid host errors", () => {
  const errors: Array<[string, string, string]> = [
    ["let", `<let/x=1/>`, "createSignal"],
    ["effect", `<effect() { run() }/>`, "createEffect"],
    ["lifecycle", `<lifecycle onMount() { run() }/>`, "lifecycle primitives"],
    ["script", `<script>run()</script>`, "surrounding TypeScript module"],
    ["bound attribute", `<input value:=name>`, "bound attribute"],
    ["on modifier", `<div on:click=fn/>`, "removed in Solid 2"],
    ["capture modifier", `<div oncapture:click=fn/>`, "capture: true"],
    ["attr modifier", `<div attr:title=value/>`, "plain attribute"],
    ["bool modifier", `<div bool:hidden=value/>`, "plain attribute"],
    ["use modifier", `<div use:tip=opts/>`, "ref=foo(opts)"],
    ["dynamic style", `<div style=value/>`, "non-object"],
    ["dynamic tag", `<\${which}>x</>`, "dynamic tag name"],
    ["try params", `<try|value|><p>x</p></try>`, "tag params"],
    ["try variable", `<try/value><p>x</p></try>`, "tag variable"],
    ["try arguments", `<try(value)><p>x</p></try>`, "tag arguments"],
    ["try attrs", `<try foo=1><p>x</p></try>`, "accepts no attributes"],
    [
      "try unknown attribute tag",
      `<try><@head>x</@head></try>`,
      "unknown attribute tag `<@head>`",
    ],
    [
      "try duplicate catch",
      `<try><@catch|e|>a</@catch><@catch|e|>b</@catch></try>`,
      "may not be repeated",
    ],
    [
      "try placeholder params",
      `<try><@placeholder|value|>wait</@placeholder></try>`,
      "on `<@placeholder>`",
    ],
  ];

  for (const [name, source, expected] of errors) {
    it(name, () => expectError(source, expected));
  }

  it("reports a host error past the enclosing region base", () => {
    let error: unknown;
    try {
      compileSolidMx(`<div>\n  <let/x=1/>\n</div>`, {
        filename: "based.solid.mx",
        baseOffset: 120,
        baseLine: 7,
        baseColumn: 13,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ line: 9, column: 2 });
  });

  it("reports an expression parse error past the enclosing region base", () => {
    let error: unknown;
    try {
      compileSolidMx(`<p>\${a b}</p>`, {
        filename: "based.solid.mx",
        baseOffset: 120,
        baseLine: 7,
        baseColumn: 13,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ line: 8, column: 20 });
  });
});
