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

  it("refuses a second element reference of the same name in one body", () => {
    const error = attempt("<div/el/><div/el/>", bindsElement);
    expect(error?.message).toBe(
      "Duplicate declaration of `el`: it is already declared in this body at 1:6. A body declares each tag variable once; rename one of them.",
    );
    expect(error?.diagnosticCode).toBe("MX_DUPLICATE_DECLARATION");
    expect([error?.line, error?.column]).toEqual([1, 14]);
  });

  // Marko reads a one-quasi literal as a native tag whatever it names, so
  // its identifier `/var` is an element reference too.
  const LITERALS = ['<${"my-el"}/el/>', '<${"Foo"}/el/>'];
  const bindsBoth: HostDeclarations = {
    ...bindsElement,
    bindsDynamicTagVar: true,
  };
  const claimsAndBinds: HostDeclarations = {
    ...claimsDynamic,
    bindsElementVar: true,
  };
  const bindsVar: HostDeclarations = { ...withLet, bindsDynamicTagVar: true };

  for (const [label, host] of [
    ["a host that binds element references", bindsElement],
    ["a host that binds both", bindsBoth],
  ] as const) {
    it.each(LITERALS)(
      `lowers %s to a dynamic Component with an element reference on ${label}`,
      (source) => {
        const [node] = irOf(source, host);
        expect(node).toMatchObject({
          kind: "Component",
          target: { kind: "dynamic" },
          var: "el",
          elementRef: true,
        });
      },
    );
  }

  it.each(LITERALS)(
    "lowers %s to a DelegatedTag with an element reference on a host claiming dynamic tags",
    (source) => {
      const [node] = irOf(source, claimsAndBinds);
      expect(node).toMatchObject({
        kind: "DelegatedTag",
        tag: { var: "el", elementRef: true },
      });
    },
  );

  it.each(LITERALS)(
    "keeps the dynamic tag's value binding for %s on a host that binds only dynamic tag variables",
    (source) => {
      const [node] = irOf(source, bindsVar);
      expect(node).toMatchObject({ kind: "Component", var: "el" });
      expect(node).not.toHaveProperty("elementRef");
    },
  );

  it.each([
    ['<${"my-el"}/el/>', 12],
    ['<${"Foo"}/el/>', 10],
  ])(
    "keeps refusing %s at the `/var` on a host that binds neither",
    (source, column) => {
      const error = attempt(source);
      expect(error?.message).toBe(
        "tag variable `/el` on `<dynamic tag>` is not supported in a standalone template",
      );
      expect(error?.diagnosticCode).toBe("MX_UNSUPPORTED_CONSTRUCT");
      expect([error?.line, error?.column]).toEqual([1, column]);
    },
  );

  it("refuses an element of the same name after a literal's element reference", () => {
    const error = attempt('<${"my-el"}/el/><div/el/>', bindsElement);
    expect(error?.message).toBe(
      "Duplicate declaration of `el`: it is already declared in this body at 1:13. A body declares each tag variable once; rename one of them.",
    );
    expect(error?.diagnosticCode).toBe("MX_DUPLICATE_DECLARATION");
    expect([error?.line, error?.column]).toEqual([1, 21]);
  });

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

// Stock Marko 6.4.4 (probed on the stock parser) refuses a read of a name two
// or more tags declare in nested bodies when nothing around the read binds it,
// at the read; the columns are stock's indexes.
describe("a read of a tag variable two nested bodies declare", () => {
  const AMBIGUOUS =
    "Ambiguous reference, variable was defined in multiple places and was not shadowed.";
  const host: HostDeclarations = {
    ...withLet,
    bindsElementVar: true,
    isBuiltinTag: (name) => name === "let" || name === "id",
    isDelegatedTag: (name) => name === "let" || name === "id",
  };
  const refused = (source: string, column: number) => {
    const error = attempt(source, host);
    expect(error?.message).toBe(AMBIGUOUS);
    expect(error?.diagnosticCode).toBe("MX_INVALID_TAG_VAR");
    expect([error?.line, error?.column]).toEqual([1, column]);
  };

  it.each([
    [
      "<div><div/el/></div><div><div/el/></div><button onClick() { el() }>c</button>",
      60,
    ],
    [
      "<div><div/el/></div><div><div/el/></div><div><button onClick() { el() }>c</button></div>",
      65,
    ],
    [
      "<div><div/el/></div><div><div/el/></div><button onClick() { el(); el() }>c</button><button onClick() { el() }>d</button>",
      60,
    ],
    [
      "<div><span><div/el/></span><button onClick() { el() }>c</button></div><div><div/el/></div>",
      47,
    ],
    [
      "<if=true><div/el/></if><else><div/el/></else><button onClick() { el() }>c</button>",
      65,
    ],
    [
      "<if=true><div/el/></if><if=false><div/el/></if><button onClick() { el() }>c</button>",
      67,
    ],
    [
      "<for|i| of=[1]><div/el/></for><div><div/el/></div><button onClick() { el() }>c</button>",
      70,
    ],
    [
      "<div><div><div/el/></div><div><div/el/></div><button onClick() { el() }>c</button></div>",
      65,
    ],
    [
      '<div><${"my-el"}/el/></div><div><div/el/></div><button onClick() { el() }>c</button>',
      67,
    ],
    [
      "<div><div/el/></div><div><const/el=1/></div><button onClick() { el() }>c</button>",
      64,
    ],
    ["<div><div/el/></div><div><div/el/></div><p>${typeof el}</p>", 52],
    ["<div><div/el/></div><div><div/el/></div><const/f=() => el()/>", 55],
    [
      "<div><span><div/el/></span><div/el/></div><button onClick() { el() }>c</button>",
      62,
    ],
    [
      "<div><div/el/></div><div><span><div/el/></span></div><button onClick() { el() }>c</button>",
      73,
    ],
  ])("refuses the element-reference read in %s at column %i", refused);

  it.each([
    ["<div><const/x=1/></div><div><const/x=2/></div><p>${x}</p>", 51],
    [
      "<div><const/x=1/></div><div><const/x=2/></div><button onClick() { x }>c</button>",
      66,
    ],
    ["<div><let/x=1/></div><div><let/x=2/></div><p>${x}</p>", 47],
    ["<div><id/x/></div><div><id/x/></div><p>${x}</p>", 41],
    [
      "<define/C><return=1/></define><div><C/x/></div><div><C/x/></div><p>${x}</p>",
      69,
    ],
  ])("refuses the read in %s at column %i", refused);

  // A default in a tag variable's pattern is a read in the body around the
  // tag; the names the pattern binds are not.
  it.each([
    [
      "<div><const/x=1/></div><div><const/x=2/></div><const/{a = x}=input/>",
      58,
    ],
    [
      "<div><const/x=1/></div><div><const/x=2/></div><const/[a = x]=input.list/>",
      58,
    ],
    [
      "<div><const/x=1/></div><div><const/x=2/></div><const/{a: { b = x }}=input/>",
      63,
    ],
    ["<div><const/x=1/></div><div><const/x=2/></div><let/{a = x}=input/>", 56],
    [
      "<div><const/x=1/></div><div><const/x=2/></div><define/C><return=input/></define><C/{a = x}/>",
      88,
    ],
    [
      "<div><const/x=1/></div><div><const/x=2/></div><div><const/{a = x}=input/></div>",
      63,
    ],
  ])("refuses the pattern-default read in %s at column %i", refused);

  it("refuses a read in a <script> body", () => {
    refused(
      "<div><div/el/></div><div><div/el/></div><script>el()</script>",
      48,
    );
  });

  it.each([
    "<div><div/el/><button onClick() { el() }>a</button></div><div><div/el/></div>",
    "<div><div/el/></div><button onClick() { el() }>c</button>",
    "<div/el/><div><div/el/></div><div><div/el/></div><button onClick() { el() }>c</button>",
    "<div><div/el/></div><div><div/el/></div><button onClick(el) { el }>c</button>",
    "<div><div/el/></div><div><div/el/></div><button onClick() { const el = 1; el }>c</button>",
    "<div><div/el/></div><div><div/el/></div>",
    "<div><div/el/></div><div><div/el/></div><button onClick() { el }>c</button><div/el/>",
    // A build strips the annotation before lowering, so this row pins the
    // build's outcome; the types-kept test below pins the annotation rule.
    "<div><div/el/></div><div><div/el/></div><const/f=(x: el) => x/>",
    "<div><const/Map=1/></div><div><const/Map=2/></div><p>${Map}</p>",
    // A body's tag variable binds the whole body, reads above it included.
    "<div><button onClick() { el() }>a</button><div/el/></div><div><div/el/></div>",
    // A pattern default is bound by its body's declaration (a later sibling,
    // so only the open body binds it), shadowed by the expression's own
    // param, or not a read at all (an object key).
    "<div><const/{a = x}=input/><const/x=1/></div><div><const/x=2/></div>",
    "<div><const/x=1/></div><div><const/x=2/></div><const/{a = ((x) => x)(1)}=input/>",
    "<div><const/x=1/></div><div><const/x=2/></div><const/{x: a = 1}=input/>",
  ])("compiles %s", (source) => {
    expect(attempt(source, host)).toBeUndefined();
  });

  // Type-checking tooling keeps the annotation in the payload; stock's crawl
  // skips a type annotation, so the name in it is no read.
  it("compiles a name in a type annotation with the types kept", () => {
    expect(() =>
      compileSource(
        "<div><div/el/></div><div><div/el/></div><const/f=(x: el) => x/>",
        "/page.mx",
        host,
        { targets: lookup, emitIr: () => "", stripTypes: false } as never,
      ),
    ).not.toThrow();
  });

  // A name in any other type position is a read to stock's crawl: `x as T`,
  // `x satisfies T`, `<T>x`, a type argument, a type parameter's constraint,
  // a type alias. A build strips the TypeScript before lowering, and a tag's
  // type arguments and parameters leave the tree in every compile, so each row
  // runs with the types stripped (the default) and kept.
  const typesKept = (source: string) => {
    try {
      compileSource(source, "/page.mx", host, {
        targets: lookup,
        emitIr: () => "",
        stripTypes: false,
      } as never);
    } catch (error) {
      return error as TranslateError;
    }
    return undefined;
  };
  describe.each([
    ["stripped", (source: string) => attempt(source, host)],
    ["kept", typesKept],
  ])("with the types %s", (_mode, compile) => {
    it.each([
      [
        "<div><div/el/></div><div><div/el/></div><const/f=() => (1 as el)/>",
        61,
      ],
      [
        "<div><const/x=1/></div><div><const/x=2/></div><const/f=(1 as any as x)/>",
        68,
      ],
      [
        "<div><const/x=1/></div><div><const/x=2/></div><const/f=(1 satisfies x)/>",
        68,
      ],
      ["<div><div/el/></div><div><div/el/></div><p>${(1 as el)}</p>", 51],
      ["<div><div/el/></div><div><div/el/></div><p>${g<el>()}</p>", 47],
      [
        "<div><div/el/></div><div><div/el/></div><p>${(<T extends el>() => 1)}</p>",
        57,
      ],
      [
        "<div><div/el/></div><div><div/el/></div><button onClick() { 1 as el }>c</button>",
        65,
      ],
      [
        "<div><div/el/></div><div><div/el/></div><button onClick() { g<el>() }>c</button>",
        62,
      ],
      [
        "<div><div/el/></div><div><div/el/></div><button onClick() { type A = el }>c</button>",
        69,
      ],
      [
        "<div><div/el/></div><div><div/el/></div><button onClick<T extends el>() {}>c</button>",
        66,
      ],
      [
        "<div><div/el/></div><div><div/el/></div><for|i = (1 as el)| of=[1]></for>",
        55,
      ],
      ["<div><div/el/></div><div><div/el/></div><for<el>|i| of=[1]></for>", 45],
      ["<div><div/el/></div><div><div/el/></div><let<el>/y=1/>", 45],
      [
        "<div><div/el/></div><div><div/el/></div><define/F<T extends el>|i|></define>",
        60,
      ],
      // An attribute tag's type arguments are read in the body around the
      // call: neither its own body nor the call's binds them.
      [
        "<div><const/x=1/></div><div><const/x=2/></div><define/C|input|>${input.item}</define><C><@item<x>>hi</@item></C>",
        95,
      ],
      [
        "<div><const/x=1/></div><div><const/x=2/></div><define/C|input|>${input.item}</define><C><@item<x>><const/x=3/>hi</@item></C>",
        95,
      ],
      [
        "<div><const/x=1/></div><div><const/x=2/></div><define/C|input|>${input.item}</define><C><const/x=3/><@item<x>>hi</@item></C>",
        107,
      ],
      // Type parameters after whitespace sit on the attribute tag's body.
      [
        "<div><const/x=1/></div><div><const/x=2/></div><define/C|input|>${input.item}</define><C><@item <T extends x>|v: T|>hi</@item></C>",
        106,
      ],
    ])(
      "refuses the type-position read in %s at column %i",
      (source, column) => {
        const error = compile(source);
        expect(error?.message).toBe(AMBIGUOUS);
        expect(error?.diagnosticCode).toBe("MX_INVALID_TAG_VAR");
        expect([error?.line, error?.column]).toEqual([1, column]);
      },
    );

    // The expression's own param binds the name; a tag's type parameters
    // sit on its body, where the body's params and tag variables bind.
    it.each([
      "<div><div/el/></div><div><div/el/></div><const/f=(el: number) => (1 as el)/>",
      "<div><div/el/></div><div><div/el/></div><define/F<T extends el>|el|></define>",
      "<div><div/el/></div><div><div/el/></div><define/F<T extends el>|i|><div/el/></define>",
    ])("compiles %s", (source) => {
      expect(compile(source)).toBeUndefined();
    });
  });
});
