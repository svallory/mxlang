/**
 * A `<let>` cannot be written while the template renders. Core raises one
 * error, positioned at the assignment or update with its end, on `lowerSource`
 * and on the html default policy. The code inside a function is not
 * render position: that is where a `<let>` is written.
 */
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import type { TranslateError } from "./core.ts";
import type { HostDeclarations } from "./declarations.ts";
import { lowerSource } from "./ir-entry/index.ts";
import { dialectProject } from "./test-dialect-project.ts";
import { lookup } from "./test-targets.ts";

const CODE = "MX_LET_WRITE_IN_RENDER";

const message = (name: string) =>
  `\`${name}\` is a \`<let>\` and cannot be written while the template renders. Write it in an event handler or a \`<script>\` body, or derive a value with \`<const>\`.`;

/** A host that has `<let>` (and a delegated `<widget>` that takes arguments). */
const withLet: HostDeclarations = {
  name: "let-test",
  attrTags: 2,
  tags: {},
  isElement: () => true,
  isComponent: () => false,
  isBuiltinTag: (name) => name === "let",
  isDelegatedTag: (name) => name === "let" || name === "widget",
  resolveDelegatedTag: () => ({}),
  resolveAttributeMethod: () => true,
};

function attempt(
  source: string,
  declarations: HostDeclarations = withLet,
  filename = "/page.mx",
  customTags?: Record<string, unknown>,
): TranslateError | undefined {
  try {
    compileSource(source, filename, declarations, {
      targets: lookup,
      emitIr: () => "",
      customTags,
    } as never);
  } catch (error) {
    return error as TranslateError;
  }
  return undefined;
}

/** 0-based line column of `needle` in `source`, and where it ends. */
function span(source: string, needle: string) {
  const at = source.indexOf(needle);
  if (at < 0) throw new Error(`no ${needle} in ${source}`);
  const where = (offset: number) => {
    const before = source.slice(0, offset).split("\n");
    return { line: before.length, column: before.at(-1)?.length ?? 0 };
  };
  return { start: where(at), end: where(at + needle.length) };
}

/** `<let/count=0/>` above `body`; the write is the text `write` in `body`. */
const LET = "<let/count=0/>\n";

type Form = [name: string, body: string, write: string];

/** Every write operator, in a placeholder. */
const OPERATORS: Form[] = [
  ["assignment", "<p>${count = 1}</p>", "count = 1"],
  ["addition", "<p>${count += 1}</p>", "count += 1"],
  ["subtraction", "<p>${count -= 1}</p>", "count -= 1"],
  ["multiplication", "<p>${count *= 2}</p>", "count *= 2"],
  ["division", "<p>${count /= 2}</p>", "count /= 2"],
  ["remainder", "<p>${count %= 2}</p>", "count %= 2"],
  ["exponent", "<p>${count **= 2}</p>", "count **= 2"],
  ["left shift", "<p>${count <<= 1}</p>", "count <<= 1"],
  ["right shift", "<p>${count >>= 1}</p>", "count >>= 1"],
  ["unsigned right shift", "<p>${count >>>= 1}</p>", "count >>>= 1"],
  ["bitwise and", "<p>${count &= 1}</p>", "count &= 1"],
  ["bitwise or", "<p>${count |= 1}</p>", "count |= 1"],
  ["bitwise xor", "<p>${count ^= 1}</p>", "count ^= 1"],
  ["logical and", "<p>${count &&= 1}</p>", "count &&= 1"],
  ["logical or", "<p>${count ||= 1}</p>", "count ||= 1"],
  ["nullish", "<p>${count ??= 1}</p>", "count ??= 1"],
  ["postfix increment", "<p>${count++}</p>", "count++"],
  ["prefix increment", "<p>${++count}</p>", "++count"],
  ["postfix decrement", "<p>${count--}</p>", "count--"],
  ["prefix decrement", "<p>${--count}</p>", "--count"],
  ["array destructuring", "<p>${[count] = [1]}</p>", "[count] = [1]"],
  [
    "array destructuring with a hole and a rest",
    "<p>${[, count, ...rest] = xs}</p>",
    "[, count, ...rest] = xs",
  ],
  [
    "object destructuring",
    "<p>${({ count } = { count: 1 })}</p>",
    "{ count } = { count: 1 }",
  ],
  [
    "object destructuring that renames",
    "<p>${({ value: count } = o)}</p>",
    "{ value: count } = o",
  ],
  [
    "nested destructuring with a default",
    "<p>${({ a: [count = 3] } = o)}</p>",
    "{ a: [count = 3] } = o",
  ],
  ["object rest", "<p>${({ a, ...count } = o)}</p>", "{ a, ...count } = o"],
  [
    "a write inside a larger expression",
    "<p>${total + (count += 1)}</p>",
    "count += 1",
  ],
  ["a write inside a template literal", "<p>${`n=${count++}`}</p>", "count++"],
  ["a write in a call argument", "<p>${show(count = 2)}</p>", "count = 2"],
  [
    "a write behind a conditional",
    "<p>${ok ? (count = 1) : 0}</p>",
    "count = 1",
  ],
  [
    "the first of two writes",
    "<p>${(count = 1) + (count = 2)}</p>",
    "count = 1",
  ],
];

/** Every render position the template has. */
const POSITIONS: Form[] = [
  ["a placeholder", "<p>${count++}</p>", "count++"],
  ["an unescaped placeholder", "<p>$!{count++}</p>", "count++"],
  ["a placeholder in an attribute-less tag body", "${count++}", "count++"],
  ["an attribute value", "<p class=(count++)/>", "count++"],
  [
    "a string-valued parenthesized attribute",
    "<p title=(count = 2)/>",
    "count = 2",
  ],
  ["a boolean-expression attribute", "<p hidden=(count++ > 1)/>", "count++"],
  ["a spread", "<p ...(count++, {})/>", "count++"],
  ["a default attribute value", "<p=(count += 1)/>", "count += 1"],
  ["a tag argument", "<widget(count++)/>", "count++"],
  ["a `<const>` value", "<const/x=(count += 1)/>\n<p>${x}</p>", "count += 1"],
  [
    "a `<const>` destructuring value",
    "<const/{ a }=(count++, o)/>\n<p>${a}</p>",
    "count++",
  ],
  ["an `<if>` condition", "<if=(count++ > 1)>\n  <p/>\n</if>", "count++"],
  [
    "an `<else-if>` condition",
    "<if=ok>\n  <p/>\n</if>\n<else-if=(count++ > 1)>\n  <p/>\n</else-if>",
    "count++",
  ],
  ["a `<for of>` list", "<for|x| of=(count++, xs)>\n  <p/>\n</for>", "count++"],
  [
    "a `<for in>` object",
    "<for|k| in=(count++, o)>\n  <p/>\n</for>",
    "count++",
  ],
  [
    "a `<for to>` bound",
    "<for|i| from=0 to=(count++)>\n  <p/>\n</for>",
    "count++",
  ],
  [
    "a `<for>` step",
    "<for|i| from=0 to=9 step=(count++)>\n  <p/>\n</for>",
    "count++",
  ],
  [
    "a `<for by>` key",
    "<for|x| of=xs by=(count++)>\n  <p/>\n</for>",
    "count++",
  ],
  [
    "an attribute tag value",
    "<widget>\n  <@item value=(count++)/>\n</widget>",
    "count++",
  ],
  ["inside an `<if>` body", "<if=ok>\n  <p>${count++}</p>\n</if>", "count++"],
  [
    "inside a `<for>` body",
    "<for|x| of=xs>\n  <p>${count++}</p>\n</for>",
    "count++",
  ],
  [
    "inside a `<define>` body",
    "<define/Card|a|>\n  <p>${count++}</p>\n</define>",
    "count++",
  ],
  [
    "in a nested element",
    "<div>\n  <ul>\n    <li class=(count++)/>\n  </ul>\n</div>",
    "count++",
  ],
  // A class member is not a function to Marko, which refuses these writes.
  ["a class method", "<p>${class { bump() { count++ } }}</p>", "count++"],
  [
    "a private class method",
    "<p>${class { #bump() { count++ } }}</p>",
    "count++",
  ],
  [
    "a class getter",
    "<p>${class { get x() { return count++ } }}</p>",
    "count++",
  ],
  ["a computed class key", "<p>${class { [count++]() {} }}</p>", "count++"],
  ["a class field initializer", "<p>${class { x = count++ }}</p>", "count++"],
  ["a class static block", "<p>${class { static { count++ } }}</p>", "count++"],
  // The defaults of a tag's params run while the template renders.
  [
    "a `<for>` param default",
    "<for|x = (count++)| of=xs>\n  <p/>\n</for>",
    "count++",
  ],
  [
    "a `<define>` param default",
    "<define/D|a = count++|>\n  <p/>\n</define>",
    "count++",
  ],
];

describe("a `<let>` write while the template renders is one error", () => {
  describe.each([
    ["every write operator", OPERATORS],
    ["every render position", POSITIONS],
  ] as const)("%s", (_title, forms) => {
    it.each(forms)("compileSource: %s", (_name, body, write) => {
      const source = `${LET}${body}\n`;
      const error = attempt(source);
      const at = span(source, write);
      expect(error?.message).toBe(message("count"));
      expect(error?.diagnosticCode).toBe(CODE);
      expect([error?.line, error?.column]).toEqual([
        at.start.line,
        at.start.column,
      ]);
      expect(error?.end).toEqual(at.end);
    });
  });

  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-let-write-")));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // `lowerSource` refuses `<define>` before it lowers anything.
  it.each(
    [...OPERATORS, ...POSITIONS].filter(
      ([, body]) => !body.includes("<define"),
    ),
  )("lowerSource: %s", (_name, body, write) => {
    const source = `${LET}${body}\n`;
    const { diagnostics } = lowerSource(source, join(dir, "page.mx"), {
      tagRules: "html",
    });
    const found = diagnostics.filter((d) => d.code === CODE);
    const at = span(source, write);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      severity: "error",
      message: message("count"),
      line: at.start.line,
      column: at.start.column,
      end: at.end,
    });
  });

  it("names the binding that is written, not the first `<let>`", () => {
    const source = "<let/a=0/>\n<let/b=0/>\n<p>${b++}</p>\n";
    const error = attempt(source);
    expect(error?.message).toBe(message("b"));
    const at = span(source, "b++");
    expect([error?.line, error?.column]).toEqual([
      at.start.line,
      at.start.column,
    ]);
  });

  it("names the let in a destructuring that also writes other names", () => {
    const error = attempt(`${LET}<p>\${[other, count] = xs}</p>\n`);
    expect(error?.message).toBe(message("count"));
  });

  it("states the rule and the fix, with no decision number", () => {
    expect(message("count")).not.toMatch(/decision|\d{3}/i);
  });

  it("carries no fix: the repair is not mechanical", () => {
    const error = attempt(`${LET}<p>\${count++}</p>\n`);
    expect(error?.fixes).toBeUndefined();
    const { diagnostics } = lowerSource(
      `${LET}<p>\${count++}</p>\n`,
      join(dir, "page.mx"),
      { tagRules: "html" },
    );
    expect(diagnostics.find((d) => d.code === CODE)?.fixes).toBeUndefined();
  });

  it("a scriptlet is refused outright, before any write in it is looked at", () => {
    for (const scriptlet of ["$ count++;", "$ { count++; }"]) {
      const error = attempt(`${LET}${scriptlet}\n<p/>\n`);
      expect(error?.diagnosticCode).toBe("MX_UNSUPPORTED_CONSTRUCT");
      expect(error?.message).toMatch(/^scriptlets/);
    }
  });

  describe("an enclosing scope's `<let>` is written from a deeper block", () => {
    it.each([
      [
        "a `<for>` body",
        "<let/n=0/>\n<for|x| of=xs>\n  <p>${n++}</p>\n</for>\n",
        "n++",
      ],
      [
        "an `<if>` body",
        "<let/n=0/>\n<if=ok>\n  <p>${n += 2}</p>\n</if>\n",
        "n += 2",
      ],
      [
        "an `<else>` body",
        "<let/n=0/>\n<if=ok>\n  <p/>\n</if>\n<else>\n  <p>${n++}</p>\n</else>\n",
        "n++",
      ],
      [
        "an `<if>` in a `<for>` in an `<if>`",
        "<let/n=0/>\n<if=a>\n  <for|x| of=xs>\n    <if=b>\n      <p>${n--}</p>\n    </if>\n  </for>\n</if>\n",
        "n--",
      ],
      [
        "a `<let>` declared in the same body",
        "<for|x| of=xs>\n  <let/n=0/>\n  <p>${n++}</p>\n</for>\n",
        "n++",
      ],
      [
        "an `<if>` body that declares the `<let>`",
        "<if=ok>\n  <let/n=0/>\n  <p class=(n = 1)/>\n</if>\n",
        "n = 1",
      ],
    ])("%s", (_name, source, write) => {
      const error = attempt(source);
      const at = span(source, write);
      expect(error?.message).toBe(message("n"));
      expect(error?.diagnosticCode).toBe(CODE);
      expect([error?.line, error?.column]).toEqual([
        at.start.line,
        at.start.column,
      ]);
      expect(error?.end).toEqual(at.end);
    });
  });
});

describe("what is not render position", () => {
  const ok = (body: string) => {
    expect(attempt(`${LET}${body}\n`)).toBeUndefined();
  };

  it.each([
    ["an event handler method", "<button onClick() { count++ }>x</button>"],
    [
      "an event handler method with a body of several statements",
      "<button onClick() { count += 1; count = count * 2 }>x</button>",
    ],
    [
      "an async handler method",
      "<button onClick: async () { count = await next() }>x</button>",
    ],
    ["an arrow in an attribute", "<button onClick=(() => count++)>x</button>"],
    [
      "an arrow with a block in an attribute",
      "<button onClick=(() => { count = 1 })>x</button>",
    ],
    [
      "a function expression in an attribute",
      "<button onClick=(function () { count-- })>x</button>",
    ],
    [
      "an arrow in a `<let>` attribute (a custom handler prop)",
      "<widget onSelect=(v => { count = v })/>",
    ],
    ["an arrow in a placeholder, called", "<p>${(() => { count++ })()}</p>"],
    [
      "an object method in a placeholder",
      "<p>${{ bump() { count++ } }.bump}</p>",
    ],
    [
      "a getter in an object in an attribute",
      "<p data=({ get x() { return count++ } })/>",
    ],
    [
      "a callback passed to a call in an attribute",
      "<p data=(xs.map(x => (count += x)))/>",
    ],
    [
      "a handler on a nested element",
      "<div><b onClick=() => (count = 0)/></div>",
    ],
    ["an arrow in a class field", "<p>${class { x = () => count++ }}</p>"],
    [
      "an arrow inside a class method",
      "<p>${class { bump() { return () => count++ } }}</p>",
    ],
    [
      "an object method inside a class method",
      "<p>${class { make() { return { bump() { count++ } } } }}</p>",
    ],
    ["a `<script>` body", "<script>count++</script>"],
    [
      "a `<script>` body of several statements",
      "<script>\n  count += 1\n  count = 0\n</script>",
    ],
    ["a read", "<p>${count}</p>"],
    ["a read in an attribute", "<p class=count/>"],
    [
      "a compare",
      "<p>${count == 1} ${count === 1} ${count >= 1} ${count <= 1}</p>",
    ],
    ["a member write on the value", "<p>${count.x = 1}</p>"],
    ["an index write on the value", "<p>${count[0] = 1}</p>"],
    ["an optional member read", "<p>${count?.x}</p>"],
    ["an update of a member", "<p>${count.n++}</p>"],
    ["a delete", "<p>${delete count.x}</p>"],
    ["a parameter of the same name", "<p>${((count) => count++)(1)}</p>"],
    [
      "a destructured parameter of the same name",
      "<p>${(({ count }) => count++)(o)}</p>",
    ],
    [
      "a local of the same name",
      "<p>${(() => { let count = 0; count++; return count })()}</p>",
    ],
    [
      "a catch parameter of the same name",
      "<p>${(() => { try { f() } catch (count) { count = 1 } })()}</p>",
    ],
    [
      "a function name of the same name",
      "<p>${(function count() { count = 1 })}</p>",
    ],
    ["another name", "<p>${other++}</p>"],
    ["a longer name that contains it", "<p>${counter++} ${mycount += 1}</p>"],
    ["a string that contains it", '<p>${"count++"} ${"count = 1"}</p>'],
    ["a template literal text that contains it", "<p>${`count++`}</p>"],
  ])("%s", (_name, body) => {
    ok(body);
  });

  it("static, server and client code cannot see a `<let>`", () => {
    // Module code that names the `<let>` is refused for that, not for the
    // write (see module-scope.test.ts).
    for (const statement of [
      "static count = 1",
      "static function bump() { count++ }",
      "client console.log(count++)",
      "server count = 2",
    ]) {
      const error = attempt(`${LET}${statement}\n<p/>\n`);
      expect(error?.diagnosticCode).toBe("MX_RENDER_ONLY_IN_MODULE");
    }
  });

  it("a function called while the template renders is not followed", () => {
    expect(
      attempt(`${LET}<const/bump=(() => { count++ })/>\n<p>\${bump()}</p>\n`),
    ).toBeUndefined();
  });
});

describe("a name that is not the `<let>`", () => {
  it.each([
    [
      "a loop variable of the same name",
      "<let/count=0/>\n<for|count| of=xs>\n  <p>${count++}</p>\n</for>\n",
    ],
    [
      "a loop index of the same name",
      "<let/i=0/>\n<for|x, i| of=xs>\n  <p>${i++}</p>\n</for>\n",
    ],
    [
      "a `<define>` parameter of the same name",
      "<let/count=0/>\n<define/Card|count|>\n  <p>${count++}</p>\n</define>\n",
    ],
    [
      "a `<const>` of the same name declared later in the block",
      "<let/count=0/>\n<const/count=1/>\n<p>${count++}</p>\n",
    ],
    [
      "a `<let>` that went out of scope with its `<if>`",
      "<if=ok>\n  <let/count=0/>\n  <p/>\n</if>\n<p>${count++}</p>\n",
    ],
    [
      "a `<let>` of a sibling block",
      "<if=ok>\n  <let/count=0/>\n</if>\n<if=other>\n  <p>${count++}</p>\n</if>\n",
    ],
    [
      "a `<let>` that went out of scope with its `<for>`",
      "<for|x| of=xs>\n  <let/count=0/>\n</for>\n<p>${count++}</p>\n",
    ],
    ["a write above the declaration", "<p>${count++}</p>\n<let/count=0/>\n"],
  ])("%s", (_name, source) => {
    const error = attempt(`${source}`);
    expect(error?.diagnosticCode).not.toBe(CODE);
  });

  it("a `<let>` declared again after a loop's shadow is the `<let>` again", () => {
    const source =
      "<let/n=0/>\n<for|n| of=xs>\n  <div><let/n=0/>\n  <p>${n++}</p></div>\n</for>\n";
    expect(attempt(source)?.diagnosticCode).toBe(CODE);
  });

  it("the outer `<let>` is the `<let>` again once the shadowing block ends", () => {
    const source =
      "<let/n=0/>\n<for|n| of=xs>\n  <p>${n}</p>\n</for>\n<p>${n++}</p>\n";
    const error = attempt(source);
    expect(error?.diagnosticCode).toBe(CODE);
    const at = span(source, "n++");
    expect([error?.line, error?.column]).toEqual([
      at.start.line,
      at.start.column,
    ]);
  });

  it("a `<const>` write keeps whatever it did before this check", () => {
    // `<const>` is not a `<let>`: this check says nothing about it.
    const error = attempt("<const/c=1/>\n<p>${c++}</p>\n");
    expect(error?.diagnosticCode).not.toBe(CODE);
  });

  it("a registered tag called `let` is that tag, not the builtin", () => {
    // A custom tag named `let` reclaims the name (as it can reclaim `id`), so
    // the variable it returns is its own value.
    const error = attempt(
      "<let/count=0/>\n<p>${count++}</p>\n",
      withLet,
      "/page.mx",
      {
        let: {
          template: { filename: "/let.mx", source: "<return value=1/>\n" },
        },
      },
    );
    expect(error).toBeUndefined();
  });
});

describe("only the `none` tag-rules preset leaves `let` an ordinary name", () => {
  it.each([...OPERATORS.slice(0, 4), ...POSITIONS.slice(0, 6)])(
    "lowerSource none: %s",
    (_name, body) => {
      const { diagnostics } = lowerSource(
        `${LET}${body}\n`,
        "/work/none-page.mx",
        { tagRules: "none" },
      );
      expect(diagnostics.filter((d) => d.code === CODE)).toEqual([]);
    },
  );

  it("an explicit `html` preset still refuses it", () => {
    const { diagnostics } = lowerSource(
      `${LET}<p>\${count++}</p>\n`,
      "/work/html-page.mx",
      { tagRules: "html" },
    );
    expect(diagnostics.map((d) => d.code)).toContain(CODE);
  });

  it("the `markup` preset refuses it too", () => {
    const { diagnostics } = lowerSource(
      `${LET}<p>\${count++}</p>\n`,
      "/work/markup-page.mx",
      { tagRules: "markup" },
    );
    expect(diagnostics.map((d) => d.code)).toContain(CODE);
  });

  describe("a routed dialect that states `none`", () => {
    let dir: string;
    beforeEach(() => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-let-write-dialect-")));
      dialectProject(dir, {
        module: 'export default { table: {}, tagRules: "none" };',
      });
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("keeps `let` a tag in its own files, and not in `.mx` files", () => {
      const source = `${LET}<p>\${count++}</p>\n`;
      expect(
        attempt(source, withLet, join(dir, "page.tst"))?.diagnosticCode,
      ).not.toBe(CODE);
      expect(
        attempt(source, withLet, join(dir, "page.mx"))?.diagnosticCode,
      ).toBe(CODE);
    });
  });
});

describe("a host or policy that refuses `<let>` never reaches the write", () => {
  const refusal = "`<let>` is the host's to refuse";
  const refusing = (kind: "error" | "unsupported"): HostDeclarations => ({
    ...withLet,
    isDelegatedTag: () => false,
    tags: {
      let:
        kind === "error"
          ? { kind, reason: refusal }
          : { kind, hint: "Use the framework's own state." },
    },
  });

  it.each(["error", "unsupported"] as const)(
    "a `%s` row: the `<let>` is the only error",
    (kind) => {
      const source = `${LET}<p>\${count++}</p>\n`;
      const error = attempt(source, refusing(kind));
      expect(error?.diagnosticCode).toBe("MX_UNSUPPORTED_CONSTRUCT");
      expect([error?.line, error?.column]).toEqual([1, 0]);
      expect(error?.message).not.toContain("cannot be written");
    },
  );
});

describe("a `<let>`'s own attributes", () => {
  it.each([
    ["its initial value", "<let/count=(count = 1)/>\n", "count = 1"],
    ["its initial value, an update", "<let/count=(count++)/>\n", "count++"],
    [
      "a `valueChange` that is not a function",
      "<let/count=0 valueChange=(count = 1, null)/>\n",
      "count = 1",
    ],
  ])("refuses a write in %s", (_name, source, write) => {
    const error = attempt(source);
    const at = span(source, write);
    expect(error?.message).toBe(message("count"));
    expect(error?.diagnosticCode).toBe(CODE);
    expect([error?.line, error?.column]).toEqual([
      at.start.line,
      at.start.column,
    ]);
    expect(error?.end).toEqual(at.end);
  });

  it.each([
    [
      "a `valueChange` arrow",
      "<let/count=0 valueChange=(v => { count = v })/>\n",
    ],
    ["a `valueChange` method", "<let/count=0 valueChange(v) { count = v }/>\n"],
    [
      "a `valueChange` function",
      "<let/count=0 valueChange=(function (v) { count = v })/>\n",
    ],
  ])("accepts %s", (_name, source) => {
    expect(attempt(source)).toBeUndefined();
  });

  it.each([
    "<let/count=0 data-x=(count)/>\n",
    "<let/count=0 data-x=(count += 2)/>\n",
  ])("reports the invalid attribute before its read or write: %s", (source) => {
    const error = attempt(source);
    const at = span(
      source,
      source.slice(source.indexOf("data-x"), source.indexOf("/>")),
    );
    expect(error?.message).toBe(
      "The `<let>` tag only supports the `value=` attribute and its change handler.",
    );
    expect(error?.diagnosticCode).toBe("MX_INVALID_ATTRIBUTE");
    expect([error?.line, error?.column]).toEqual([
      at.start.line,
      at.start.column,
    ]);
    expect(error?.end).toEqual(at.end);
  });

  it("lowerSource refuses the same write", () => {
    const source = "<let/count=(count = 1)/>\n";
    const { diagnostics } = lowerSource(source, "/page.mx", {
      tagRules: "html",
    });
    expect(diagnostics.filter((d) => d.code === CODE)).toHaveLength(1);
  });
});

describe("an inert tag's attributes and arguments", () => {
  const inert = (source: string) =>
    attempt(source, {
      ...withLet,
      tags: {
        log: { kind: "inert", attributes: "none", body: "none" },
        debug: { kind: "inert", attributes: "none", body: "none" },
        id: { kind: "inert", attributes: "none", body: "none" },
        lifecycle: { kind: "inert", attributes: "any", body: "none" },
        script: { kind: "inert", attributes: "any", body: "text" },
      },
    } as never);

  it.each([
    ["`<log>`", "<log=(count++)/>", "count++"],
    ["`<debug>`", "<debug=(count++)/>", "count++"],
    ["`<id>`", "<id/x=(count++)/>", "count++"],
    ["`<lifecycle>`", "<lifecycle onMount=(count++)/>", "count++"],
    ["`<script>`", "<script value=(count++)></script>", "count++"],
  ])("refuses a write in %s", (_name, body, write) => {
    const source = `${LET}${body}\n`;
    const error = inert(source);
    const at = span(source, write);
    expect(error?.message).toBe(message("count"));
    expect(error?.diagnosticCode).toBe(CODE);
    expect([error?.line, error?.column]).toEqual([
      at.start.line,
      at.start.column,
    ]);
    expect(error?.end).toEqual(at.end);
  });

  it.each([
    ["a `<script>` body", "<script>count++</script>"],
    ["a handler on `<lifecycle>`", "<lifecycle onMount=(() => count++)/>"],
    ["a read", "<log=(count)/>"],
  ])("accepts %s", (_name, body) => {
    expect(inert(`${LET}${body}\n`)).toBeUndefined();
  });
});
