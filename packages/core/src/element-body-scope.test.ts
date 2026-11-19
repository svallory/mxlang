/**
 * A native element's body is its own scope for a tag variable (Marko 6.4.4
 * probed on the stock parser: `<let/count=1/><div><const/count=2/>${count}</div>${count}`
 * compiles, the read inside the `<div>` is the inner `count` and the read
 * after it is the outer one; a `<for>`, `<if>`, `<try>` or `<define>` body
 * scopes the same way). The lowering state that tracks a declaration (write
 * guards, `<let>` names, derived `<const>`s, shadowed host bindings) has to
 * follow that scope: an inner `<const/x>` must not make a write to the outer
 * `<let/x>` after the element a "const write" error, and an inner `<let/x>`
 * must not make a write to the outer `<const/x>` legal.
 */
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import { DYNAMIC_TAG, type TranslateError } from "./core.ts";
import type { CustomTag } from "./custom-tags.ts";
import type { HostDeclarations } from "./declarations.ts";
import type { Ir, IrNode } from "./ir.ts";
import { lowerSource } from "./ir-entry/index.ts";
import { lookup } from "./test-targets.ts";

const READONLY = "MX_READONLY_BINDING_WRITE";

/** A host that has `<let>` and an element for every other name. */
const withLet: HostDeclarations = {
  name: "element-body-scope-test",
  tags: {},
  isElement: () => true,
  isComponent: () => false,
  isBuiltinTag: (name) => name === "let",
  isDelegatedTag: (name) => name === "let",
  resolveDelegatedTag: () => ({}),
  resolveAttributeMethod: () => true,
};

function attempt(
  source: string,
  host: HostDeclarations = withLet,
): TranslateError | undefined {
  try {
    compileSource(source, "/page.mx", host, {
      targets: lookup,
      emitIr: () => "",
    } as never);
  } catch (error) {
    return error as TranslateError;
  }
  return undefined;
}

/** The diagnostics `lowerSource` reports, which carry the code under test. */
function lowered(source: string) {
  return lowerSource(source, "/page.mx", { tagRules: "html" }).diagnostics;
}

const constWrite = (name: string) =>
  `\`${name}\` is a \`<const>\` and cannot be written. Keep a value that changes in a \`<let>\` and write that in an event handler or a \`<script>\` body, or derive a new value with another \`<const>\`.`;

const ACCEPTED: Array<[string, string]> = [
  [
    "an inner <const> does not guard the outer <let> written after the element",
    "<let/x=0/>\n<div><const/x=1/></div>\n<button onClick() { x = 2 }/>\n",
  ],
  [
    "two levels deep",
    "<let/x=0/>\n<div><section><const/x=1/></section><button onClick() { x = 2 }/></div>\n",
  ],
  [
    "an inner <let> is written inside the element",
    "<const/x=1/>\n<div><let/x=2/><button onClick() { x = 3 }/></div>\n",
  ],
  [
    "sibling elements each declare the name",
    "<div><const/x=1/></div><div><let/x=2/><button onClick() { x = 3 }/></div>\n",
  ],
  ["concise syntax", "let/x=0\ndiv\n  const/x=1\nbutton onClick() { x = 2 }\n"],
];

const REFUSED: Array<[string, string, string]> = [
  [
    "an inner <let> does not make the outer <const> writable after the element",
    "<const/x=1/>\n<div><let/x=2/></div>\n<button onClick() { x = 3 }/>\n",
    "x = 3",
  ],
  [
    "the inner <const> still guards a write inside the element",
    "<let/x=0/>\n<div><const/x=1/><button onClick() { x = 2 }/></div>\n",
    "x = 2",
  ],
  [
    "the outer <const> still guards a write inside an element that declares another name",
    "<const/x=1/>\n<div><const/y=1/><button onClick() { x = 2 }/></div>\n",
    "x = 2",
  ],
];

describe("an element body scopes its tag variables for write checks", () => {
  for (const [name, source] of ACCEPTED) {
    it(`compiles: ${name}`, () => {
      expect(attempt(source)).toBeUndefined();
      expect(lowered(source).filter((d) => d.code === READONLY)).toEqual([]);
    });
  }

  for (const [name, source, write] of REFUSED) {
    it(`refuses: ${name}`, () => {
      const variable = write.slice(0, write.indexOf(" "));
      expect(attempt(source)?.message).toBe(constWrite(variable));
      const found = lowered(source).filter((d) => d.code === READONLY);
      expect(found).toHaveLength(1);
      expect(found[0]?.message).toBe(constWrite(variable));
    });
  }
});

/** The first error `lowerSource` reports, from the diagnostic list. */
function duplicates(source: string) {
  return lowered(source).filter((d) => d.code === "MX_DUPLICATE_DECLARATION");
}

describe("a <define> in a native element body is declared in the body around it", () => {
  const FOO = "<define/Foo>a</define>";
  const REFUSED_DEFINES: Array<[string, string]> = [
    ["two sibling elements", `<div>${FOO}</div><div>${FOO}</div>`],
    ["an element and a define of the body", `${FOO}<div>${FOO}</div>`],
    ["a define of the body after an element", `<div>${FOO}</div>${FOO}`],
    [
      "through nested elements",
      `<div><span>${FOO}</span></div><section>${FOO}</section>`,
    ],
  ];
  for (const [name, source] of REFUSED_DEFINES) {
    it(`refuses: ${name}`, () => {
      const found = duplicates(source);
      expect(found).toHaveLength(1);
      expect(found[0]?.message).toMatch(
        /^Duplicate declaration of `Foo`: it is already declared in this body at 1:\d+/,
      );
    });
  }

  it("refuses inside a <define> body too", () => {
    const error = attempt(`<define/Box><div>${FOO}</div>${FOO}</define>`);
    expect(error?.diagnosticCode).toBe("MX_DUPLICATE_DECLARATION");
  });

  it("blames the second define's name", () => {
    const source = `<div>${FOO}</div><div>${FOO}</div>`;
    const found = duplicates(source)[0];
    expect(found?.column).toBe(source.lastIndexOf("Foo"));
  });

  const ACCEPTED_DEFINES: Array<[string, string]> = [
    [
      "an <if> branch beside an element",
      `<div>${FOO}</div><if=input.a>${FOO}</if>`,
    ],
    ["an <if> inside an element", `<div><if=input.a>${FOO}</if></div>${FOO}`],
    ["<if> and <else> branches", `<if=input.a>${FOO}</if><else>${FOO}</else>`],
    [
      "a <define> body beside an element",
      `<div>${FOO}</div><define/Box>${FOO}</define>`,
    ],
    [
      "a <const> of the same name beside the element",
      `<div>${FOO}</div><const/Foo=1/>`,
    ],
    ["different names", `<div>${FOO}</div><div><define/Bar>b</define></div>`],
  ];
  for (const [name, source] of ACCEPTED_DEFINES) {
    it(`compiles: ${name}`, () => {
      expect(duplicates(source)).toEqual([]);
    });
  }
});

/**
 * The IR `compileSource` hands the emitter, with every position (`span`,
 * `*Span`, `loc`) left out: a literal name is longer than the static one.
 */
function irOf(
  source: string,
  host: HostDeclarations = withLet,
  customTags?: Record<string, CustomTag>,
): IrNode[] {
  let captured: Ir | undefined;
  compileSource(source, "/page.mx", host, {
    targets: lookup,
    ...(customTags ? { customTags } : {}),
    emitIr: (ir: Ir) => {
      captured = ir;
      return "";
    },
  } as never);
  return JSON.parse(
    JSON.stringify(captured?.body ?? [], (key, value) =>
      key === "loc" || key === "span" || key.endsWith("Span")
        ? undefined
        : value,
    ),
  );
}

/** {@link withLet}, claiming every dynamic tag as a delegated tag too. */
const claimsDynamic: HostDeclarations = {
  ...withLet,
  isDelegatedTag: (name) => name === "let" || name === DYNAMIC_TAG,
};

describe("a literal dynamic tag name that names a native element is that element", () => {
  const DIV = '<div class="a">x</div>';
  const LITERALS = [
    '<${"div"} class="a">x</>',
    "<${'div'} class=\"a\">x</>",
    '<${`div`} class="a">x</>',
  ];
  for (const [label, host] of [
    ["an element host", withLet],
    ["a host claiming dynamic tags", claimsDynamic],
  ] as const) {
    it.each(LITERALS)(`lowers %s as <div> under ${label}`, (source) => {
      const element = irOf(source, host);
      expect(element[0]?.kind).toBe("Element");
      expect(element).toEqual(irOf(DIV, host));
    });
  }

  /** The kind each source lowers to, and a dynamic `Component`'s target kind. */
  const kindOf = (nodes: IrNode[]) => {
    const node = nodes[0];
    if (node?.kind !== "Component") return node?.kind;
    const target = node.target;
    return target.kind === "dynamic"
      ? `Component dynamic ${target.expr.code}`
      : `Component ${JSON.stringify(target)}`;
  };
  /** Each compile setup a literal that stays dynamic is lowered under. */
  type Setup = {
    host: HostDeclarations;
    customTags?: Record<string, CustomTag>;
  };
  const plain: Setup = { host: withLet };
  const noSection: Setup = {
    host: { ...withLet, isElement: (name) => name !== "section" },
  };
  const registersSection: Setup = {
    host: withLet,
    customTags: { section: {} },
  };
  const delegatesSection: Setup = {
    host: {
      ...withLet,
      isDelegatedTag: (name) => name === "let" || name === "section",
    },
  };
  it.each<[string, string, Setup, string]>([
    ["a capitalized name", '<${"Foo"} a=1/>', plain, "`Foo`"],
    ["a custom element name", '<${"my-el"} a=1/>', plain, "`my-el`"],
    ["the core <style>", '<${"style"}>a{}</>', plain, "`style`"],
    ["the core <script>", '<${"script"}>x</>', plain, "`script`"],
    ["the core <for>", '<${"for"} of=[1]>x</>', plain, "`for`"],
    ["an empty name", '<${""}>x</>', plain, "``"],
    ["a concatenation", '<${"di" + "v"}>x</>', plain, '"di" + "v"'],
    ["a name isElement rejects", '<${"section"}>x</>', noSection, "`section`"],
    [
      "a registered custom tag",
      '<${"section"}>x</>',
      registersSection,
      "`section`",
    ],
    ["a delegated name", '<${"section"}>x</>', delegatesSection, "`section`"],
  ])("keeps %s a dynamic tag: %s", (_label, source, setup, target) => {
    expect(kindOf(irOf(source, setup.host, setup.customTags))).toBe(
      `Component dynamic ${target}`,
    );
  });
});

describe("a literal dynamic tag that stays dynamic keeps Marko's native-tag field rules", () => {
  const ARGS = [
    "Tag does not support arguments.",
    "MX_UNSUPPORTED_TAG_ARGUMENTS",
  ] as const;
  const PARAMS = [
    "Tag does not support parameters.",
    "MX_UNSUPPORTED_CONSTRUCT",
  ] as const;
  const ATTR_TAGS = [
    "Tag does not support nested attribute tags.",
    "MX_UNSUPPORTED_CONSTRUCT",
  ] as const;
  const DESTRUCTURED = [
    "Tag variables on native tags cannot be destructured.",
    "MX_INVALID_TAG_VAR",
  ] as const;
  // Columns are Marko 6.4.4's own (stock parser): the arguments, the first
  // param, the first attribute tag, the variable. Rows with two fields pin
  // the rule Marko reports first.
  const REFUSED: Array<[string, readonly [string, string], number]> = [
    ['<${"Foo"}(1)/>', ARGS, 10],
    ['<${"my-el"}(1)/>', ARGS, 12],
    ['<${"style"}(1)/>', ARGS, 12],
    ['<${"Foo"}|x|>x</>', PARAMS, 10],
    ['<${"my-el"}|x|/>', PARAMS, 12],
    ['<${"for"}|x| of=[1]>x</>', PARAMS, 10],
    ['<${"Foo"}><@a/></>', ATTR_TAGS, 10],
    ['<${"my-el"}>x<@a/></>', ATTR_TAGS, 13],
    ['<${"Foo"}/{a}/>', DESTRUCTURED, 10],
    ['<${"my-el"}/[a]/>', DESTRUCTURED, 12],
    ['<${"Foo"}(1) a=2/>', ARGS, 10],
    ['<${"Foo"}(1) ref=x/>', ARGS, 10],
    ['<${"Foo"}(1)|x|>x</>', ARGS, 10],
    ['<${"Foo"}(1)><@a/></>', ARGS, 10],
    ['<${"Foo"}|x|><@a/></>', PARAMS, 10],
    ['<${"Foo"}/{a}|x|>x</>', PARAMS, 14],
    ['<${"Foo"}/{a}(1)/>', ARGS, 14],
    ['<${"Foo"}/{a}><@a/></>', ATTR_TAGS, 14],
  ];
  for (const [label, host] of [
    ["an element host", withLet],
    ["a host claiming dynamic tags", claimsDynamic],
  ] as const) {
    it.each(REFUSED)(
      `refuses %s under ${label}`,
      (source, [message, code], column) => {
        const error = attempt(source, host);
        expect(error?.message).toBe(message);
        expect(error?.diagnosticCode).toBe(code);
        expect([error?.line, error?.column]).toEqual([1, column]);
      },
    );
  }

  const bindsVar: HostDeclarations = { ...withLet, bindsDynamicTagVar: true };
  it.each<[string, HostDeclarations]>([
    ['<${"my-el"}>x</>', withLet],
    ['<${"Foo"}()/>', withLet],
    ['<${"Foo"}||>x</>', withLet],
    ['<${"my-el"}||>x</>', withLet],
    ['<${"Foo"}||>x</>', claimsDynamic],
    ['<${"my-el"}||>x</>', claimsDynamic],
    ['<${"Foo"}/el/>', bindsVar],
    ["<${input.t}(1)/>", withLet],
    ["<${input.t}|x|>x</>", withLet],
    ["<${input.t}><@a/></>", withLet],
    ['<${"di" + "v"}><@a/></>', withLet],
    ['<const/x="Foo"/><${x}(1)/>', withLet],
  ])("still compiles %s", (source, host) => {
    expect(attempt(source, host)).toBeUndefined();
  });
});

describe("a literal naming a void element", () => {
  const BODY =
    "The `<br>` tag cannot have content, so it does not support a body.";
  it.each([
    ['<${"br"}>x</>', 9],
    ['<${"br"}> </>', 9],
  ])("refuses a body at its first child: %j", (source, column) => {
    const error = attempt(source);
    expect(error?.message).toBe(BODY);
    expect(error?.diagnosticCode).toBe("MX_UNSUPPORTED_CONSTRUCT");
    expect([error?.line, error?.column]).toEqual([1, column]);
  });

  it.each(['<${"br"}/>', '<${"br"}></>', '<${"br"}>\n</>'])(
    "lowers %j to a void <br>",
    (source) => {
      expect(irOf(source)).toEqual([
        {
          kind: "Element",
          name: "br",
          attrs: [],
          children: [],
          void: true,
        },
      ]);
    },
  );
});

describe("a literal naming an element is that element to every pre-scan", () => {
  it("declares a <define> in its body in the body around it", () => {
    const FOO = "<define/Foo>a</define>";
    const error = attempt(`${FOO}<\${"div"}>${FOO}</>`);
    expect(error?.diagnosticCode).toBe("MX_DUPLICATE_DECLARATION");
  });
});

describe("a tag variable on a native element (an element reference)", () => {
  const bindsElement: HostDeclarations = { ...withLet, bindsElementVar: true };

  it.each(["<div/el/>", '<${"div"}/el/>'])(
    "lowers %s to an Element with `var` on a host that binds one",
    (source) => {
      expect(irOf(source, bindsElement)).toEqual([
        {
          kind: "Element",
          name: "div",
          attrs: [],
          children: [],
          void: false,
          var: "el",
        },
      ]);
    },
  );

  it.each([
    ["<div/el/>", 5],
    ['<${"div"}/el/>', 10],
  ])(
    "keeps refusing %s at the `/var` on a host that does not",
    (source, column) => {
      const error = attempt(source);
      expect(error?.message).toBe(
        "tag variable `/el` on `<div>` is not supported in a standalone template",
      );
      expect(error?.diagnosticCode).toBe("MX_UNSUPPORTED_CONSTRUCT");
      expect([error?.line, error?.column]).toEqual([1, column]);
    },
  );

  for (const [label, host] of [
    ["a host that binds element references", bindsElement],
    ["a host that does not", withLet],
  ] as const) {
    it.each(["<div/{a}/>", "<div/[a]/>"])(
      `refuses the pattern in %s on ${label}`,
      (source) => {
        const error = attempt(source, host);
        expect(error?.message).toBe(
          "Tag variables on native tags cannot be destructured.",
        );
        expect(error?.diagnosticCode).toBe("MX_INVALID_TAG_VAR");
        expect([error?.line, error?.column]).toEqual([1, 5]);
      },
    );
  }
});
