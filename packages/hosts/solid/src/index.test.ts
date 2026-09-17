import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileSolidMx, compileSolidUnit } from "./index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TAGS = join(HERE, "fixtures", "tags");
const ICON_TEMPLATE = join(TAGS, "icon.mx");
const PANEL_TEMPLATE = join(TAGS, "panel.mx");

/** The discovered `<panel>` tag, whose template reads `input.content`. */
function panelTag(): Record<string, never> {
  return {
    panel: {
      template: {
        filename: PANEL_TEMPLATE,
        source: readFileSync(PANEL_TEMPLATE, "utf8"),
        mtimeMs: statSync(PANEL_TEMPLATE).mtimeMs,
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: a CustomTag map, shaped by the scan
  } as any;
}

/** The discovered `<icon>` tag, as an integration's scan would supply it. */
function iconTag(): Record<string, never> {
  return {
    icon: {
      template: {
        filename: ICON_TEMPLATE,
        source: readFileSync(ICON_TEMPLATE, "utf8"),
        mtimeMs: statSync(ICON_TEMPLATE).mtimeMs,
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: a CustomTag map, shaped by the scan
  } as any;
}

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

describe("discovered tag imports inside a region", () => {
  const compileRegion = (source: string) =>
    compileSolidMx(source, {
      filename: join(HERE, "fixtures", "page.solid.mx"),
      customTags: iconTag(),
    });

  it("hands the synthesized import back instead of rejecting it", () => {
    const result = compileRegion(`<div><icon name="star"/></div>`);

    expect(result.hoistedImports).toHaveLength(1);
    const [hoisted] = result.hoistedImports;
    expect(hoisted?.specifier).toBe("./tags/icon.mx");
    expect(hoisted?.code).toBe(
      `import ${hoisted?.binding} from "./tags/icon.mx"`,
    );
    // The region references the generated binding, never the author's `icon`:
    // a lowercase name is not a component call on any host.
    expect(result.code).toContain(`<${hoisted?.binding}`);
  });

  it("emits no hoisted import for a region that calls no discovered tag", () => {
    expect(compileRegion(`<div>plain</div>`).hoistedImports).toEqual([]);
  });

  it("still rejects a module-level MX statement the author wrote", () => {
    let error: unknown;
    try {
      compileRegion(`<import x from "./x.ts"/>`);
    } catch (caught) {
      error = caught;
    }
    expect((error as Error | undefined)?.message).toContain(
      "module-level MX statements cannot appear inside a `.solid.mx` expression",
    );
  });

  it("rejects a region calling its own file's tag", () => {
    // A region is an expression spliced into someone else's module, so it
    // declares nothing a self-call could resolve to. Before this was gated on
    // `Ctx.emitsModule`, the self-recursion branch fired on path equality
    // alone and emitted `<PageSolid />` — a reference to a binding nothing
    // declares, with no import and no diagnostic anywhere.
    const page = join(HERE, "fixtures", "page.solid.mx");
    let error: unknown;
    try {
      compileSolidMx(`<div><page/></div>`, {
        filename: page,
        customTags: {
          page: {
            template: { filename: page, source: "<b>x</b>\n", mtimeMs: 0 },
          },
          // biome-ignore lint/suspicious/noExplicitAny: a CustomTag map, shaped by the scan
        } as any,
      });
    } catch (caught) {
      error = caught;
    }

    expect((error as Error | undefined)?.message).toContain(
      "is this file's own tag",
    );
    expect(error).toMatchObject({ line: expect.any(Number) });
  });

  it("passes a region's body to a unit that reads input.content", () => {
    const result = compileSolidMx(`<panel title="T"><b>slot</b></panel>`, {
      filename: join(HERE, "fixtures", "page.solid.mx"),
      customTags: panelTag(),
    });

    const [hoisted] = result.hoistedImports;
    expect(hoisted?.specifier).toBe("./tags/panel.mx");
    // Solid's calling convention for a body is JSX children, so the body
    // reaches the unit as `props.children` and the unit's `input.content`
    // bridges to it. What this pins is the call site: the body is passed
    // through rather than dropped, which is the silent-drop class.
    expect(result.code).toContain(`<${hoisted?.binding}`);
    expect(result.code).toContain("<b>slot</b>");
  });
});

describe("compileSolidUnit", () => {
  const unitOf = (name: string) =>
    compileSolidUnit(readFileSync(join(TAGS, name), "utf8"), {
      filename: join(TAGS, name),
    }).code;

  it("emits a default export and keeps the markup", () => {
    const code = unitOf("icon.mx");

    // Named after the file (`icon.mx` -> `Icon`), never anonymous.
    expect(code).toContain("export default function Icon(input)");
    expect(code).toContain("icon");
  });

  it("drops `export interface Input` rather than emitting it", () => {
    // Pinned, not incidental: Solid's compiler takes source text and has no
    // TypeScript frontend, so a type declaration in the emitted unit is a
    // syntax error downstream. Typing a unit's props is phase 3's job. If
    // this ever starts emitting, that decision has changed and the CHANGELOG
    // note about it is stale.
    const code = unitOf("panel.mx");

    expect(code).not.toContain("interface Input");
    expect(code).toContain("export default function Panel(input)");
    // The body that reads `input.title` is still emitted.
    expect(code).toContain("input.title");
  });
});
