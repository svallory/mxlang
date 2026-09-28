import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CustomTag, readCalleeInput } from "@mxlang/core";
import { parse as parseMxFile } from "@mxlang/parser";
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
  const rows: Array<[string, string, string[], string[]?]> = [
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
      "dynamic tag (tagged)",
      `<\${which} n=1>x</>`,
      [
        "= which; if (",
        '=== "string" || typeof',
        '=== "function" ?',
        "<Dynamic component={",
        " n={1}>",
        "x",
        "</Dynamic>",
        " : ",
        "; })()}",
      ],
    ],
    [
      "dynamic tag (bare concise-position line)",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
      "${which}\n",
      ["= which; if (", "<Dynamic component={", " /> : ", "; })()}"],
    ],
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
        `<Layout id="x" head={() => <h1>H</h1>} foot={(year) => () => <>{() => {`,
        "$mxEscape",
        `}</>}>`,
        `{(input) => <p>{input}</p>}`,
      ],
      ["Layout"],
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
        "each={Object.entries(record ?? {})}",
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
      ["Risky"],
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
    // attribute-tag-silent-drops B1: a repeated `<@item>` used to emit the
    // `item=` prop twice (JSX last-wins), losing every occurrence but the
    // last. It becomes an array; decision 108 gives each body-only occurrence
    // the renderable accessor shape for this untyped callee.
    [
      "repeated attribute tag becomes an array",
      `<Layout><@item>1</@item><@item>2</@item></Layout>`,
      ["item={[() => <>1</>, () => <>2</>]}"],
      ["Layout"],
    ],
    [
      "single attribute tag stays a plain value",
      `<Layout><@item>1</@item></Layout>`,
      ["item={() => <>1</>}"],
      ["Layout"],
    ],
    // attribute-tag-silent-drops B2 (Solid's dynamic-tag path shares the same
    // call site as the named-component path): an attribute tag on a dynamic
    // tag must reach the resolved component's props, not be dropped.
    [
      "attribute tag on a dynamic tag is forwarded",
      `<\${which}><@header>hi</@header></>`,
      ["header={", "hi"],
    ],
  ];

  for (const [name, source, expected, imports] of rows) {
    it(name, () => {
      const result = imports
        ? compileSolidMx(source, {
            filename: "fixture.solid.mx",
            importSpecifiers: new Map(imports.map((n) => [n, `./${n}.mx`])),
          })
        : compile(source);
      for (const text of expected) expect(result.code).toContain(text);
      expect(result.map.sources).toEqual(["fixture.solid.mx"]);
      expect(result.map.sourcesContent).toEqual([source]);
    });
  }
});

describe("Solid callee Input reader", () => {
  it("returns none for a SolidMX callee with MX syntax and no Input", () => {
    const path = join(HERE, "fixtures", "no-input-control.solid.mx");
    expect(
      readCalleeInput(
        { kind: "name", name: "NoInputControl", resolvedPath: path },
        { importer: join(HERE, "fixture.mx") },
      ),
    ).toEqual({
      input: { kind: "none", path },
      dependencies: [path],
    });
  });

  it("reads an exported typed Input with the Solid parser", () => {
    const path = join(HERE, "fixtures", "typed-input.solid.mx");
    const source = readFileSync(path, "utf8");
    const typeText = 'AttrTag<{ as: "renderable" }>';
    const start = source.indexOf(typeText);
    expect(
      readCalleeInput(
        { kind: "name", name: "TypedInput", resolvedPath: path },
        { importer: join(HERE, "fixture.mx") },
      ),
    ).toEqual({
      input: {
        kind: "declared",
        path,
        attrTags: new Map([
          [
            "item",
            {
              cardinality: "optional",
              as: "renderable",
              hasAttrs: false,
              hasParams: false,
              nested: new Map(),
              nestedOpen: false,
              span: {
                file: path,
                sourceStart: start,
                sourceEnd: start + typeText.length,
              },
            },
          ],
        ]),
        otherProps: new Set(),
        open: false,
      },
      dependencies: [path],
    });
  });

  it.each(["untyped-default-arrow", "untyped-named-arrow"])(
    "returns none instead of throwing for %s SolidMX",
    (name) => {
      const path = join(HERE, "fixtures", `${name}.solid.mx`);
      expect(
        readCalleeInput(
          { kind: "name", name: "Card", resolvedPath: path },
          { importer: join(HERE, "fixture.mx") },
        ),
      ).toEqual({
        input: { kind: "none", path },
        dependencies: [path],
      });
    },
  );

  it("reads Input after a component whose earlier region contains MX syntax", () => {
    const path = join(HERE, "fixtures", "input-after-control.solid.mx");
    const source = readFileSync(path, "utf8");
    const typeText = 'AttrTag<{ as: "renderable" }>';
    const start = source.indexOf(typeText);
    expect(
      readCalleeInput(
        { kind: "name", name: "Card", resolvedPath: path },
        { importer: join(HERE, "fixture.mx") },
      ),
    ).toEqual({
      input: {
        kind: "declared",
        path,
        attrTags: new Map([
          [
            "item",
            {
              cardinality: "optional",
              as: "renderable",
              hasAttrs: false,
              hasParams: false,
              nested: new Map(),
              nestedOpen: false,
              span: {
                file: path,
                sourceStart: start,
                sourceEnd: start + typeText.length,
              },
            },
          ],
        ]),
        otherProps: new Set(),
        open: false,
      },
      dependencies: [path],
    });
  });

  it.each([
    ["B1", "real", "data", [], "AttrTag"],
    ["B2", "real", "data", [], "AttrTag"],
    [
      "B3",
      "real",
      "renderable",
      ["label", "tpl"],
      'AttrTag<{ as: "renderable" }>',
    ],
    ["B4", "real", "data", [], "AttrTag"],
    ["B5", "real", "renderable", [], 'AttrTag<{\n  as: "renderable" }>'],
    ["B6", "x", "renderable", [], "AttrTag<Cfg>"],
  ] as const)(
    "reads only the real top-level Input in reviewer probe %s",
    (name, attrName, as, otherProps, typeText) => {
      const path = join(HERE, "fixtures", `${name}.solid.mx`);
      const source = readFileSync(path, "utf8");
      const start = source.lastIndexOf(typeText);
      const dependency = join(HERE, "fixtures", "c-dep");
      expect(
        readCalleeInput(
          { kind: "name", name: "Card", resolvedPath: path },
          { importer: join(HERE, "fixture.mx") },
        ),
      ).toEqual({
        input: {
          kind: "declared",
          path,
          attrTags: new Map([
            [
              attrName,
              {
                cardinality: "optional",
                as,
                hasAttrs: false,
                hasParams: false,
                nested: new Map(),
                nestedOpen: false,
                span: {
                  file: path,
                  sourceStart: start,
                  sourceEnd: start + typeText.length,
                },
              },
            ],
          ]),
          otherProps: new Set(otherProps),
          open: false,
        },
        dependencies:
          name === "B6"
            ? [
                path,
                dependency,
                `${dependency}.mx`,
                `${dependency}.solid.mx`,
                `${dependency}.tsx`,
                `${dependency}.ts`,
              ]
            : [path],
      });
    },
  );
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
    [
      "unresolved capitalized tag (decision 114)",
      `<TotallyUndefined/>`,
      "Unable to find entry point for custom tag `<TotallyUndefined>`",
    ],
    [
      "unresolved capitalized tag with body (decision 114)",
      `<TotallyUndefined>body</TotallyUndefined>`,
      "Unable to find entry point for custom tag `<TotallyUndefined>`",
    ],
    [
      "unresolved capitalized tag with attribute (decision 114)",
      `<TotallyUndefined attr=1/>`,
      "Unable to find entry point for custom tag `<TotallyUndefined>`",
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

  it("does not reject a <for>-param capitalized local as unresolved (decision 113)", () => {
    // A local binding resolves before core ever asks the host's
    // `isComponent`, so tightening it to reject unresolved tags must not
    // regress this case. (`<const>` cannot be used for the same check here:
    // it is unconditionally rejected inside a `.solid.mx` region, unrelated
    // to this fix — see `packages/hosts/solid/AGENTS.md`.)
    expect(() =>
      compile(`<for|Item| of=components><Item/></for>`),
    ).not.toThrow();
  });

  it("resolves a Solid JSX built-in with no import (decision 114)", () => {
    // `<Show>` is a real MX tag reference here, not a claimed host tag
    // (`claimsTag` only claims `try`) — `isComponent` must recognize it by
    // name.
    expect(() => compile(`<Show when=cond>x</Show>`)).not.toThrow();
  });

  it("resolves a capitalized tag bound by the surrounding module (decision 114)", () => {
    // A `.solid.mx` region has no module scope of its own; a real caller's
    // surrounding TypeScript module supplies this through
    // `moduleBindings`, computed by `@mxlang/parser`'s `programBindings`
    // from the whole file (imports plus top-level const/function/class).
    expect(() =>
      compileSolidMx("<Widget/>", {
        filename: "fixture.solid.mx",
        moduleBindings: new Set(["Widget"]),
      }),
    ).not.toThrow();
  });

  it("still rejects a capitalized tag bound only by a type-only import (decision 114)", () => {
    // `import type Widget from "./widget.mx"` binds no runtime value, so it
    // must not resolve `<Widget/>` — matching `@mxlang/parser`'s
    // `programBindings`, which excludes type-only bindings by design (see
    // `source-bindings.ts`). Passed explicitly here as `moduleBindings`
    // would already exclude it were it computed live; this asserts the
    // *effect* (still unresolved) rather than re-testing `programBindings`
    // itself, which has its own coverage in `@mxlang/parser`.
    let error: unknown;
    try {
      compileSolidMx("<Widget/>", {
        filename: "fixture.solid.mx",
        moduleBindings: new Set(),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "Unable to find entry point for custom tag `<Widget>`",
    );
  });
});

describe("event attributes (decision 101, phase B of dom-events)", () => {
  it("recomposes the prop from the DOM event name", () => {
    expect(compile(`<button onClick=handler>x</button>`).code).toContain(
      "onClick={handler}",
    );
  });

  it("collapses onDblClick and on-dblclick byte-identically", () => {
    const a = compile(`<button onDblClick=f>x</button>`).code;
    const b = compile(`<button on-dblclick=f>x</button>`).code;
    // `@solidjs/web`'s own `jsx.d.ts` declares `onDblClick`, not
    // `onDblclick` — Solid's runtime lowercases either spelling identically
    // (`prop.slice(2).toLowerCase()`), but only the declared spelling
    // satisfies the JSX types (see `event-names.ts`).
    expect(a).toContain("onDblClick={f}");
    expect(a).toBe(b);
  });

  it("emits onDoubleClick as onDoubleclick without rewriting (no aliases)", () => {
    // Core warns (`onDoubleClick` is not a DOM event) but never rewrites;
    // the prop is recomposed from the DOM name exactly as written. The
    // warning itself is pinned in the core's lower tests.
    expect(compile(`<button onDoubleClick=handler>x</button>`).code).toContain(
      "onDoubleclick={handler}",
    );
  });

  it("rejects a custom DOM event name with the ref route", () => {
    expectError(
      `<div on-my-event=fn>x</div>`,
      '`on-my-event` names a custom DOM event (`my-event`) Solid cannot bind as a prop; use a `ref` callback calling `addEventListener("my-event", fn)`',
    );
  });

  it("passes a static inline handler string through verbatim", () => {
    // Spec §4: a string-valued `onClick` stays an ordinary static attribute;
    // MX does not invent a policy against inline handler strings.
    expect(compile(`<button onClick="alert(1)">x</button>`).code).toContain(
      'onClick="alert(1)"',
    );
  });

  it("points the on: fix-it at on-<exact>", () => {
    let error: unknown;
    try {
      compile(`<div on:click=fn/>`);
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toContain("`on-x=fn` for a custom event");
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

describe("<define> hoisted to module scope (decision 110b)", () => {
  it("used to be a compile error inside a region", () => {
    // The bug this whole feature fixes, pinned so a regression is obvious:
    // before decision 110b, any `<define>` inside a `.solid.mx` region
    // failed with this message, unconditionally.
    expect(() => compile(`<define/Row>x</define><Row/>`)).not.toThrow();
  });

  it("hoists a no-args <define> to a module-scope function", () => {
    const result = compile(`<define/Row>x</define><Row/>`);
    expect(result.hoistedDefines).toHaveLength(1);
    const [hoisted] = result.hoistedDefines;
    expect(hoisted?.code).toMatch(
      /^function \$mx_DefineRow1\(\) \{ return .*x.*; \}$/,
    );
    // JSX has no positional-call syntax, so a <define> call is a plain
    // function-call expression, not a JSX tag — the same call shape
    // `@mxlang/html` already uses (decision 109's named-param binding).
    expect(result.code).toContain(`{${hoisted?.binding}()}`);
    expect(result.code).not.toContain("<Row");
  });

  it("passes params through the hoisted function's own signature", () => {
    const result = compile(
      `<define/Row|item, i|><li>\${item}-\${i}</li></define><Row(input.name, 0)/>`,
    );
    const [hoisted] = result.hoistedDefines;
    expect(hoisted?.code).toContain("function $mx_DefineRow1(item, i)");
    expect(result.code).toContain(`{${hoisted?.binding}(input.name, 0)}`);
  });

  it("supports an attribute-tag call to a hoisted <define>", () => {
    const result = compile(
      `<define/Row|head|>\${head}</define><Row><@head>H</@head></Row>`,
    );
    expect(result.hoistedDefines).toHaveLength(1);
    // `head` is not a positional arg, so it is filled by name from the
    // attribute tag, matching decision 109's html/preact named-lookup.
    expect(result.code).toContain("H");
  });

  it("supports args, content and attribute tags together (decision 109)", () => {
    // `item` is consumed positionally by the arg; `head`/`content` are
    // params beyond it, filled by name from the attribute tag/body — the
    // same named-lookup scheme `@mxlang/html`'s `<define>` call already
    // uses for this exact shape.
    const result = compile(
      `<define/Row|item, head, content|>\${item}\${head}\${content}</define><Row(input.name)><@head>H</@head>body</Row>`,
    );
    const [hoisted] = result.hoistedDefines;
    expect(result.code).toContain(`{${hoisted?.binding}(input.name`);
    expect(result.code).toContain("H");
    expect(result.code).toContain("body");
  });

  it("gensyms a fresh binding per <define>, never the author's own name", () => {
    const result = compile(
      `<define/Row>a</define><define/Card>b</define><Row/><Card/>`,
    );
    expect(result.hoistedDefines).toHaveLength(2);
    const bindings = result.hoistedDefines.map((d) => d.binding);
    expect(new Set(bindings).size).toBe(2);
    for (const binding of bindings) expect(binding).toMatch(/^\$mx_Define/);
  });

  it("rejects a <define> nested inside <for>/<if> with a positioned error", () => {
    // Not hoisted to module scope: acceptance criterion from the brief is
    // "decide and document" what happens when a `<define>` can't be safely
    // hoisted. Nesting inside a per-row/per-branch callback is the case this
    // host cannot support (§7.5-8's escape-rejection precedent).
    expectError(
      `<for|x| of=[1]><define/Row>\${x}</define><Row/></for>`,
      "top level",
    );
  });

  it("rejects a <define> that closes over a region-local value", () => {
    // A hoisted <define> becomes a real module-scope function; it can no
    // longer read a binding from the surrounding TypeScript function the
    // region itself lives in (e.g. a signal from `createSignal`). Rejected
    // rather than silently emitting a reference to an undeclared name.
    expectError(`<define/Row>\${someRegionLocal}</define><Row/>`, "close over");
  });

  it("supports a <define> calling another top-level <define> declared earlier in source", () => {
    // `ctx.defines` (core, `lowerDefine`) registers a define's name only
    // *after* lowering its own body, so a reference to a sibling define is
    // only ever resolvable when that sibling was declared **earlier** in
    // source — confirmed against `@mxlang/html`: a forward reference is a
    // pre-existing, core-wide "has no matching import or `<define>` in
    // scope" error on every host, unrelated to this fix, so this test
    // covers the reachable case only. What it pins for Solid specifically
    // is that the reference resolves to the gensym'd binding at the
    // hoisted call site, not the raw author name.
    const result = compile(`<define/B>b</define><define/A><B/></define><A/>`);
    expect(result.hoistedDefines).toHaveLength(2);
    const [b, a] = result.hoistedDefines;
    expect(a?.code).toContain(`{${b?.binding}()}`);
  });

  it("a self-recursive <define> now errors with Marko's own wording (decision 114, was a silent gap)", () => {
    // `ctx.defines.set(name, params)` (core, `lowerDefine`) runs only
    // *after* lowering a define's own body, so `A` isn't registered as a
    // define while `A`'s own body is being lowered — on `@mxlang/html` this
    // already reached the generic capitalized-tag guard and errored ("no
    // matching import or `<define>` in scope"). On Solid it used to be a
    // silent pass-through: `isComponent` was a bare `/^[A-Z]/` test with no
    // resolvability check, so the inner self-reference lowered as a
    // `Component` with a plain `"name"` target and printed a JSX tag
    // referencing a binding nothing declares (`<A />`, args dropped) — the
    // identical bug decision 114's `TotallyUndefined` case fixes elsewhere
    // in this file. Tightening `isComponent` closes this gap too, as a
    // side effect rather than a separate fix.
    expect(() =>
      compileSolidMx(
        `<define/A|n|><if=(n > 0)><A(n - 1)/></if></define><A(3)/>`,
        { filename: "/fixtures/page.solid.mx" },
      ),
    ).toThrow("Unable to find entry point for custom tag `<A>`.");
  });

  it("gensyms distinct bindings for two regions in one file that each declare the same <define> name", () => {
    // Regression: `generatedDefineBinding`'s uniqueness check is scoped to
    // one region's own `defineBindings`, freshly created per
    // `compileSolidMx` call — two independent regions each declaring
    // `<define/Row>` used to mint the identical `$mx_DefineRow1`, spliced
    // as two functions of the same name into one module (a SyntaxError).
    // Exercised through the real `parse()` pipeline, since the collision
    // is only visible once both regions' hoisted defines reach the same
    // module (the parser bridge, not `compileSolidMx` in isolation).
    const source = [
      "export function A() {",
      "  return (<div><define/Row>a</define><Row/></div>);",
      "}",
      "export function B() {",
      "  return (<div><define/Row>b</define><Row/></div>);",
      "}",
    ].join("\n");
    const solidRegionCompile = (
      input: Parameters<typeof compileSolidMx>[1] & { source: string },
    ) => compileSolidMx(input.source, input);
    const file = parseMxFile(source, "two-regions.solid.mx", {
      // biome-ignore lint/suspicious/noExplicitAny: MxRegionCompile shape, avoiding a parser<->solid type cycle in a test
      mxRegionCompile: solidRegionCompile as any,
    });
    const program = file.program as unknown as {
      body: Array<{ type?: string }>;
    };
    const declared = program.body.filter(
      (node) => node.type === "FunctionDeclaration",
    ) as Array<{ id?: { name?: string } }>;
    const names = declared.map((node) => node.id?.name).filter(Boolean);
    // Two `$mx_DefineRowN` module-scope functions, under two distinct names.
    const defineNames = names.filter((name) => name?.startsWith("$mx_Define"));
    expect(defineNames).toHaveLength(2);
    expect(new Set(defineNames).size).toBe(2);
  });

  it("renames a colliding define's declaration through the AST, not a text pattern, so a body containing the binding name in a string or comment is untouched", () => {
    // Regression guard for the fix that replaced a `function <name>(`
    // text/regex rename with an AST `id.name` assignment: a naive text
    // rename keyed on the binding's spelling could mismatch inside a
    // string literal or comment that happens to contain it. Region B's
    // define body echoes its own about-to-collide binding name in a
    // string and a comment; only the real `FunctionDeclaration.id` for
    // the *renamed* copy may change — the string/comment text must not.
    const source = [
      "export function A() {",
      "  return (<div><define/Row>a</define><Row/></div>);",
      "}",
      "export function B() {",
      "  return (<div><define/Row>",
      '    ${"function $mx_DefineRow1(" /* not a real function $mx_DefineRow1( */}',
      "  </define><Row/></div>);",
      "}",
    ].join("\n");
    const solidRegionCompile = (
      input: Parameters<typeof compileSolidMx>[1] & { source: string },
    ) => compileSolidMx(input.source, input);
    const file = parseMxFile(source, "define-decoy-text.solid.mx", {
      // biome-ignore lint/suspicious/noExplicitAny: MxRegionCompile shape, avoiding a parser<->solid type cycle in a test
      mxRegionCompile: solidRegionCompile as any,
    });
    const program = file.program as unknown as {
      body: Array<{ type?: string; id?: { name?: string } }>;
    };
    const declared = program.body.filter(
      (node) => node.type === "FunctionDeclaration",
    );
    const defineNames = declared
      .map((node) => node.id?.name)
      .filter((name): name is string =>
        Boolean(name?.startsWith("$mx_Define")),
      );
    // Both hoisted module-scope functions, under two distinct names — the
    // second region's declaration was renamed, its decoy string/comment left
    // exactly as authored.
    expect(defineNames).toHaveLength(2);
    expect(new Set(defineNames).size).toBe(2);
    // The renamed declaration is `$mx_DefineRow1_2`; the decoy string
    // literal inside its own body is still spelled `$mx_DefineRow1`,
    // untouched by the rename that renamed only the declaration's `id`.
    expect(defineNames).toContain("$mx_DefineRow1_2");
    const printed = JSON.stringify(program.body);
    expect(printed).toContain('"function $mx_DefineRow1("');
  });

  it("does not corrupt $mx_DefineRow1 when a fresh binding needs $mx_DefineRow10", () => {
    // `freshDefineBinding` mints `<binding>_2`, `<binding>_3`, ... so this
    // guards a different prefix hazard: a module already using a name whose
    // *own* text contains another binding's name as a strict prefix
    // (`$mx_DefineRow1` is a prefix of `$mx_DefineRow10`). Renaming via the
    // AST's `id.name` assignment is exact regardless of prefix relationships
    // between bindings — nothing here is spelled as a pattern match.
    const source = [
      "const $mx_DefineRow10 = 1;",
      "export function A() {",
      "  return (<div>{$mx_DefineRow10}<define/Row>a</define><Row/></div>);",
      "}",
      "export function B() {",
      "  return (<div><define/Row>b</define><Row/></div>);",
      "}",
    ].join("\n");
    const solidRegionCompile = (
      input: Parameters<typeof compileSolidMx>[1] & { source: string },
    ) => compileSolidMx(input.source, input);
    const file = parseMxFile(source, "define-prefix-collision.solid.mx", {
      // biome-ignore lint/suspicious/noExplicitAny: MxRegionCompile shape, avoiding a parser<->solid type cycle in a test
      mxRegionCompile: solidRegionCompile as any,
    });
    const program = file.program as unknown as {
      body: Array<{ type?: string; id?: { name?: string } }>;
    };
    const declared = program.body.filter(
      (node) => node.type === "FunctionDeclaration",
    );
    const defineNames = declared
      .map((node) => node.id?.name)
      .filter((name): name is string =>
        Boolean(name?.startsWith("$mx_Define")),
      );
    expect(defineNames).toHaveLength(2);
    expect(new Set(defineNames).size).toBe(2);
    // The pre-existing module-scope `const` is untouched.
    const constDecl = program.body.find(
      (node) => node.type === "VariableDeclaration",
    ) as unknown as {
      declarations: Array<{ id?: { name?: string } }>;
    };
    expect(constDecl?.declarations[0]?.id?.name).toBe("$mx_DefineRow10");
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

  it("does not emit the erased Input declaration's AttrTag type import", () => {
    const code = compileSolidUnit(
      "export interface Input { item: AttrTag }\n<div/>",
      { filename: "/fixtures/typed.mx" },
    ).code;
    expect(code).not.toContain('import type { AttrTag } from "@mxlang/solid";');
  });

  it("errors on a whole `import type` used as a tag (decision 114 parity)", () => {
    // Mirrors `@mxlang/html`'s equivalent coverage: a whole `import type`
    // binds no runtime value, so `<Widget/>` must still be Marko's own
    // unresolved-tag error on Solid's whole-file entry too, not a silently
    // routed component call. Before the core fix, `lowerStatement`'s
    // `importBindings` never checked `importKind`, so this compiled clean.
    let error: unknown;
    try {
      compileSolidUnit(`import type Widget from "./widget.mx"\n<Widget/>`, {
        filename: "/fixtures/type-only.mx",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "Unable to find entry point for custom tag `<Widget>`",
    );
  });

  it("errors on an inline `{ type X }` specifier used as a tag (decision 114 parity)", () => {
    let error: unknown;
    try {
      compileSolidUnit(`import { type Widget } from "./widget.mx"\n<Widget/>`, {
        filename: "/fixtures/type-only-specifier.mx",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "Unable to find entry point for custom tag `<Widget>`",
    );
  });

  it("still resolves an ordinary value import as a tag", () => {
    const code = compileSolidUnit(
      `import Widget from "./widget.mx"\n<Widget/>`,
      { filename: "/fixtures/value-import.mx" },
    ).code;
    expect(code).toContain("<Widget />");
  });

  it("still rejects <define> with a positioned error, not a silent hoist to nowhere", () => {
    // A tag unit is a whole file, not a region spliced into someone else's
    // module — `hoistedDefines` has no caller here to place it, and
    // `compileSolidUnit` never reads it. Regression: hoisting used to be
    // gated on the shared `hoistedDefines`/`defineBindings` module state
    // alone, which `collectReturnVars` set for every caller including this
    // one — so a `<define>` here compiled clean but emitted a call to a
    // function nothing declares (a runtime ReferenceError, decision 110b's
    // own "positioned error, not wrong code" violated silently).
    let error: unknown;
    try {
      compileSolidUnit(`<define/Row>x</define><Row/>`, {
        filename: "/fixtures/unit.mx",
      });
    } catch (caught) {
      error = caught;
    }
    expect((error as Error | undefined)?.message).toContain(
      "cannot declare a function inside a JSX expression",
    );
  });

  it("strictly types params in an attribute-tag <for>", () => {
    const scratch = mkdtempSync(join(tmpdir(), "mx-solid-attr-tsc-"));
    try {
      symlinkSync(
        join(HERE, "../../../..", "node_modules"),
        join(scratch, "node_modules"),
        "dir",
      );
      const callee = join(scratch, "Row.tsx");
      writeFileSync(
        callee,
        [
          'import type { AttrTag } from "@mxlang/solid";',
          "export interface Input { item: AttrTag<{ attrs: { id: number }; params: [label: string] }>[] }",
          "export default function Row(_input: Input) { return null; }",
        ].join("\n"),
      );
      const caller = join(scratch, "caller.tsx");
      const compiled = compileSolidMx(
        `<Row><for|value| of=values><@item|label| id=value>\${label.toUpperCase()}:\${value.toFixed()}</@item></for></Row>`,
        {
          filename: join(scratch, "caller.solid.mx"),
          importSpecifiers: new Map([["Row", "./Row.tsx"]]),
        },
      );
      const regionImports = compiled.hoistedImports
        .map((entry) => entry.code)
        .join("\n");
      writeFileSync(
        caller,
        `${regionImports}\nimport Row from "./Row.tsx";\ndeclare const values: number[];\nexport const view = ${compiled.code};\n`,
      );
      writeFileSync(
        join(scratch, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            jsx: "preserve",
            module: "ESNext",
            moduleResolution: "Bundler",
            allowImportingTsExtensions: true,
            skipLibCheck: true,
            ignoreDeprecations: "6.0",
            baseUrl: scratch,
            paths: {
              "@mxlang/solid": [join(HERE, "index.ts")],
              "@mxlang/core": [join(HERE, "../../../core/dist/index.d.ts")],
              "@mxlang/parser": [join(HERE, "../../../parser/src/public.d.ts")],
            },
          },
          include: ["*.tsx"],
        }),
      );
      try {
        execFileSync(
          join(HERE, "../../../../node_modules/.bin/tsc"),
          ["-p", scratch],
          { cwd: scratch, stdio: "pipe" },
        );
      } catch (error) {
        const failure = error as { stdout?: Buffer; stderr?: Buffer };
        throw new Error(
          `${failure.stdout?.toString() ?? ""}${failure.stderr?.toString() ?? ""}`,
        );
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

/**
 * `<return>` and `/var` on Solid (acceptance C4).
 *
 * This is the one host where the `{ value, output }` shape does not fit: a
 * Solid component's return value is its view, and the caller writes JSX
 * rather than a call — so the value travels back on a callback prop
 * (design §2.4), verified there against solid-js 2.0.0-rc.7.
 */
describe("a unit that returns a value", () => {
  const counterSource = [
    "<span>${input.start}</span>",
    "<return value=input.start + 1/>",
  ].join("\n");

  const counter = {
    template: { filename: "/fixtures/tags/counter.mx", source: counterSource },
  } as unknown as CustomTag;

  it("calls the callback prop with the value during setup", () => {
    const code = compileSolidUnit(counterSource, {
      filename: "/fixtures/tags/counter.mx",
    }).code;

    // Before the return, so it has run by the time the caller's next
    // statement executes — the property the whole channel depends on.
    expect(code).toContain('input["$mxReturn"]?.(input.start + 1);');
    const call = code.indexOf('input["$mxReturn"]');
    expect(code.indexOf("return <>")).toBeGreaterThan(call);
  });

  it("declares the /var above the JSX and fills it from the prop", () => {
    const code = compileSolidUnit("<counter/n start=1/>\n<p>${n}</p>", {
      filename: "/fixtures/page.mx",
      customTags: { counter },
    }).code;

    // `let`, not `const`: the callback assigns it during the child's
    // synchronous setup, which happens as the JSX is evaluated.
    expect(code).toContain("let n;");
    expect(code).toContain("$mxReturn={($mxV) => { n = $mxV; }}");
    // One-shot, not reactive (risk 4): a plain binding read, with no
    // accessor call wrapped around it. A tag wanting reactivity returns an
    // accessor and the author calls it.
    expect(code).toContain("<p>{n}</p>");
  });

  // Round 1, finding 3. The `let` this host declares sits at the component's
  // head, so one binding was shared by every `<For>` row, and a read beside
  // the call ran while the fragment was being built — before that row's
  // callback had fired. Invariant §7.5-8 rejects the escape.
  it("rejects /var inside <for>, naming the tag as written", () => {
    expect(() =>
      compileSolidUnit(
        "<for|i| of=[1,2]><counter/n start=i/><p>${n}</p></for>",
        { filename: "/fixtures/page.mx", customTags: { counter } },
      ),
    ).toThrow(/`\/var` on `<counter>` inside `<for>`\/`<if>` is not supported/);
  });

  it("rejects /var inside <if>", () => {
    expect(() =>
      compileSolidUnit("<if=true><counter/n start=1/><p>${n}</p></if>", {
        filename: "/fixtures/page.mx",
        customTags: { counter },
      }),
    ).toThrow(/is not supported on Solid yet/);
  });

  it("still allows a call with no /var inside <for>", () => {
    const code = compileSolidUnit("<for|i| of=[1,2]><counter start=i/></for>", {
      filename: "/fixtures/page.mx",
      customTags: { counter },
    }).code;

    expect(code).toContain("<For each={");
    expect(code).not.toContain("$mxReturn");
  });

  it("emits no callback prop for a call that binds no /var", () => {
    const code = compileSolidUnit("<counter start=1/>", {
      filename: "/fixtures/page.mx",
      customTags: { counter },
    }).code;

    expect(code).not.toContain("$mxReturn");
    expect(code).not.toContain("let ");
  });
});

describe("event error positions", () => {
  it("positions the custom-event error at the attribute name", () => {
    let error: unknown;
    try {
      compileSolidMx("<div   on-my-event=fn>x</div>", {
        filename: "pos.solid.mx",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ line: 1, column: 7 });
  });
});
