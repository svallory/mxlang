/**
 * A handler cannot read a derived `<const>` after writing a `<let>` the
 * `<const>` depends on: targets disagree on whether the read shows the old or
 * the new value. Core raises one error, positioned at the read with its end, on
 * `lowerSource` and on the html default policy. The scope is the one the module
 * header of `stale-derived-read.ts` states; each line of it has a block here.
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
import { lookup } from "./test-targets.ts";

const CODE = "MX_STALE_DERIVED_READ";

const message = (name: string, written: string, line: number) =>
  `\`${name}\` is stale here: it derives from \`${written}\`, which this handler wrote on line ${line}. Compute from \`${written}\` directly, or move the check into a \`<script>\`, which runs after the write settles on every target.`;

/** A host that has `<let>` (and a delegated `<widget>` that takes arguments). */
const withLet: HostDeclarations = {
  name: "let-test",
  attrTags: 2,
  tags: {},
  isElement: () => true,
  isComponent: (name) => /^[A-Z]/.test(name),
  isBuiltinTag: (name) => name === "let",
  isDelegatedTag: (name) => name === "let" || name === "widget",
  resolveDelegatedTag: () => ({}),
  resolveAttributeMethod: () => true,
};

function attempt(
  source: string,
  declarations: HostDeclarations = withLet,
  filename = "/page.mx",
): TranslateError | undefined {
  try {
    compileSource(source, filename, declarations, {
      targets: lookup,
      emitIr: () => "",
    } as never);
  } catch (error) {
    return error as TranslateError;
  }
  return undefined;
}

/** 1-based line, 0-based column of an offset. */
function where(source: string, offset: number) {
  const before = source.slice(0, offset).split("\n");
  return { line: before.length, column: before.at(-1)?.length ?? 0 };
}

/**
 * Where the read of `name` is: inside the first occurrence of `around` (the
 * name's first occurrence in it), with its end.
 */
function readAt(source: string, around: string, name: string) {
  const at = source.indexOf(around);
  if (at < 0) throw new Error(`no ${around} in ${source}`);
  const start = at + around.indexOf(name);
  return {
    start: where(source, start),
    end: where(source, start + name.length),
  };
}

/** `<let/items>` and the `<const>` derived from it, then `body`. */
const CART =
  "<let/items=[]/>\n<const/total=items.reduce((sum, it) => sum + it.price, 0)/>\n";

type Row = {
  name: string;
  /** Everything after the declarations. */
  body: string;
  /** Text that contains the stale read. */
  around: string;
  /** The `<const>` read. */
  read: string;
  /** The `<let>` written. */
  written: string;
  /** The line of the write, 1-based, in the whole source. */
  line: number;
  /** The declarations above the body; the cart by default. */
  head?: string;
};

const stale = (source: string, row: Row) => {
  const error = attempt(source);
  const at = readAt(source, row.around, row.read);
  expect(error?.message).toBe(message(row.read, row.written, row.line));
  expect(error?.diagnosticCode).toBe(CODE);
  expect([error?.line, error?.column]).toEqual([
    at.start.line,
    at.start.column,
  ]);
  expect(error?.end).toEqual(at.end);
  expect(error?.fixes).toBeUndefined();
};

function check(rows: Row[]) {
  it.each(rows.map((row) => [row.name, row] as const))(
    "compileSource: %s",
    (_name, row) => stale(`${row.head ?? CART}${row.body}\n`, row),
  );
}

describe("the cart: a read after a write in the same handler", () => {
  check([
    {
      name: "the shopping cart of the batching note",
      body: [
        "<button onClick() {",
        "  items = [...items, input.candidate];",
        "  if (total > 100) {",
        "    applyDiscount();",
        "  }",
        "}>Add</button>",
      ].join("\n"),
      around: "total > 100",
      read: "total",
      written: "items",
      line: 4,
    },
  ]);

  it("names the line of the write, and the read stays the error's position", () => {
    const source = `${CART}<button onClick() {\n  log(1);\n  items = [];\n  log(2);\n  log(total);\n}>Add</button>\n`;
    const error = attempt(source);
    expect(error?.message).toBe(message("total", "items", 5));
    expect(error?.line).toBe(7);
  });

  it("states the rule and the fixes in order, with no decision number", () => {
    const text = message("total", "items", 5);
    expect(text.indexOf("Compute from")).toBeLessThan(
      text.indexOf("move the check into a `<script>`"),
    );
    expect(text).not.toMatch(/decision|\d{3}/i);
  });

  it("lowerSource raises the same error, once", () => {
    const source = `${CART}<button onClick() {\n  items = [];\n  log(total);\n}>Add</button>\n`;
    const { diagnostics } = lowerSource(source, "/page.mx", {
      tagRules: "html",
    });
    const found = diagnostics.filter((d) => d.code === CODE);
    const at = readAt(source, "log(total)", "total");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      severity: "error",
      message: message("total", "items", 4),
      line: at.start.line,
      column: at.start.column,
      end: at.end,
    });
    expect(found[0]?.fixes).toBeUndefined();
  });
});

describe("handlers: an `on…` attribute of any tag", () => {
  const write = "  items = [];\n  log(total);\n";
  check([
    {
      name: "an attribute method",
      body: `<button onClick() {\n${write}}>x</button>`,
      around: "log(total)",
      read: "total",
      written: "items",
      line: 4,
    },
    {
      name: "an arrow in parentheses",
      body: `<button onClick=(() => {\n${write}})>x</button>`,
      around: "log(total)",
      read: "total",
      written: "items",
      line: 4,
    },
    {
      name: "an arrow with an expression body",
      body: "<button onClick=(() => (items = [], total))>x</button>",
      around: ", total",
      read: "total",
      written: "items",
      line: 3,
    },
    {
      name: "a function expression",
      body: `<button onClick=function () {\n${write}}>x</button>`,
      around: "log(total)",
      read: "total",
      written: "items",
      line: 4,
    },
    {
      name: "an async method",
      body: `<button onClick() {\n  items = [];\n  await Promise.resolve();\n  log(total);\n}>x</button>`.replace(
        "onClick()",
        "async onClick()",
      ),
      around: "log(total)",
      read: "total",
      written: "items",
      line: 4,
    },
    {
      name: "a handler spelled `on-click`",
      body: `<button on-click() {\n${write}}>x</button>`,
      around: "log(total)",
      read: "total",
      written: "items",
      line: 4,
    },
    {
      name: "a handler with a parameter",
      body: `<input onInput(event) {\n  items = [event.target.value];\n  log(total);\n}/>`,
      around: "log(total)",
      read: "total",
      written: "items",
      line: 4,
    },
    {
      name: "a handler of a delegated tag",
      body: `<widget onSelect() {\n${write}}/>`,
      around: "log(total)",
      read: "total",
      written: "items",
      line: 4,
    },
    {
      name: "a handler of an attribute tag",
      body: `<widget>\n  <@item onSelect() {\n${write}  }/>\n</widget>`,
      around: "log(total)",
      read: "total",
      written: "items",
      line: 5,
    },
    {
      name: "a handler of a component call",
      body: `<define/Card>\n  <p/>\n</define>\n<Card onSelect() {\n${write}}/>`,
      around: "log(total)",
      read: "total",
      written: "items",
      line: 7,
    },
    {
      name: "a handler inside an `<if>`",
      body: `<if=ok>\n  <button onClick() {\n  ${write}  }>x</button>\n</if>`,
      around: "log(total)",
      read: "total",
      written: "items",
      line: 5,
    },
    {
      name: "a handler inside a `<for>`",
      body: `<for|row| of=rows>\n  <button onClick() {\n  ${write}  }>\${row}</button>\n</for>`,
      around: "log(total)",
      read: "total",
      written: "items",
      line: 5,
    },
    {
      name: "a handler inside a `<define>`",
      body: `<define/Row|row|>\n  <button onClick() {\n  ${write}  }>\${row}</button>\n</define>`,
      around: "log(total)",
      read: "total",
      written: "items",
      line: 5,
    },
    {
      name: "a handler in a nested element",
      body: `<div>\n  <ul>\n    <li onClick() {\n    ${write}    }>x</li>\n  </ul>\n</div>`,
      around: "log(total)",
      read: "total",
      written: "items",
      line: 6,
    },
  ]);

  it("reports the first stale handler of a tag with two", () => {
    const source = `${CART}<button onClick() { items = []; log(total) } onFocus() { items = []; log(total) }>x</button>\n`;
    const error = attempt(source);
    expect(error?.diagnosticCode).toBe(CODE);
    expect(error?.column).toBe(source.split("\n")[2]?.indexOf("total"));
  });
});

describe("the dependency set is transitive", () => {
  check([
    {
      name: "a `<const>` of a `<const>`",
      head: "<let/items=[]/>\n<const/count=items.length/>\n<const/total=count * 2/>\n",
      body: "<button onClick() {\n  items = [];\n  log(total);\n}>x</button>",
      around: "log(total)",
      read: "total",
      written: "items",
      line: 5,
    },
    {
      name: "the middle `<const>` read directly",
      head: "<let/items=[]/>\n<const/count=items.length/>\n<const/total=count * 2/>\n",
      body: "<button onClick() {\n  items = [];\n  log(count);\n}>x</button>",
      around: "log(count)",
      read: "count",
      written: "items",
      line: 5,
    },
    {
      name: "three levels",
      head: "<let/items=[]/>\n<const/a=items.length/>\n<const/b=a + 1/>\n<const/c=b + 1/>\n",
      body: "<button onClick() {\n  items = [];\n  log(c);\n}>x</button>",
      around: "log(c)",
      read: "c",
      written: "items",
      line: 6,
    },
    {
      name: "a `<const>` of two `<let>`s: the one written is named",
      head: "<let/a=0/>\n<let/b=0/>\n<const/sum=a + b/>\n",
      body: "<button onClick() {\n  b = 1;\n  log(sum);\n}>x</button>",
      around: "log(sum)",
      read: "sum",
      written: "b",
      line: 5,
    },
    {
      name: "a `<const>` of a `<const>` and another `<let>`: the deeper `<let>` is named",
      head: "<let/a=0/>\n<let/b=0/>\n<const/x=a * 2/>\n<const/y=x + b/>\n",
      body: "<button onClick() {\n  a = 1;\n  log(y);\n}>x</button>",
      around: "log(y)",
      read: "y",
      written: "a",
      line: 6,
    },
    {
      name: "a destructuring `<const>`, either name",
      head: "<let/items=[]/>\n<const/[first, second]=items/>\n",
      body: "<button onClick() {\n  items = [];\n  log(second);\n}>x</button>",
      around: "log(second)",
      read: "second",
      written: "items",
      line: 4,
    },
    {
      name: "a `<const>` that mentions the `<let>` only in a callback",
      head: "<let/suffix=''/>\n<const/labels=names.map((n) => n + suffix)/>\n",
      body: "<button onClick() {\n  suffix = '!';\n  log(labels);\n}>x</button>",
      around: "log(labels)",
      read: "labels",
      written: "suffix",
      line: 4,
    },
    {
      name: "a `<const>` that mentions the `<let>` in a template literal",
      head: "<let/n=0/>\n<const/label=`n is ${n}`/>\n",
      body: "<button onClick() {\n  n = 1;\n  log(label);\n}>x</button>",
      around: "log(label)",
      read: "label",
      written: "n",
      line: 4,
    },
    {
      name: "a `<const>` declared in an enclosing block",
      head: "<let/items=[]/>\n",
      body: "<if=ok>\n  <const/total=items.length/>\n  <button onClick() {\n    items = [];\n    log(total);\n  }>x</button>\n</if>",
      around: "log(total)",
      read: "total",
      written: "items",
      line: 5,
    },
    {
      name: "a `<let>` and a `<const>` declared in the same block as the handler's tag",
      head: "",
      body: "<let/n=0/>\n<const/double=n * 2/>\n<button onClick() {\n  n++;\n  log(double);\n}>x</button>",
      around: "log(double)",
      read: "double",
      written: "n",
      line: 4,
    },
  ]);
});

describe("every way to write the `<let>`", () => {
  const forms: Array<[string, string, string, string]> = [
    ["assignment", "items = []", "<const/total=items.length/>", "items"],
    ["addition", "n += 1", "<const/total=n * 2/>", "n"],
    ["subtraction", "n -= 1", "<const/total=n * 2/>", "n"],
    ["multiplication", "n *= 2", "<const/total=n * 2/>", "n"],
    ["exponent", "n **= 2", "<const/total=n * 2/>", "n"],
    ["bitwise or", "n |= 2", "<const/total=n * 2/>", "n"],
    ["logical and", "n &&= 2", "<const/total=n * 2/>", "n"],
    ["logical or", "n ||= 2", "<const/total=n * 2/>", "n"],
    ["nullish", "n ??= 2", "<const/total=n * 2/>", "n"],
    ["postfix increment", "n++", "<const/total=n * 2/>", "n"],
    ["prefix increment", "++n", "<const/total=n * 2/>", "n"],
    ["postfix decrement", "n--", "<const/total=n * 2/>", "n"],
    ["prefix decrement", "--n", "<const/total=n * 2/>", "n"],
    ["array destructuring", "[n] = [1]", "<const/total=n * 2/>", "n"],
    [
      "array destructuring with a rest",
      "[, , ...n] = xs",
      "<const/total=n * 2/>",
      "n",
    ],
    ["object destructuring", "({ n } = o)", "<const/total=n * 2/>", "n"],
    [
      "object destructuring that renames",
      "({ value: n } = o)",
      "<const/total=n * 2/>",
      "n",
    ],
    [
      "nested destructuring with a default",
      "({ a: [n = 3] } = o)",
      "<const/total=n * 2/>",
      "n",
    ],
    ["object rest", "({ a, ...n } = o)", "<const/total=n * 2/>", "n"],
    [
      "a write inside a larger expression",
      "log(n = 1)",
      "<const/total=n * 2/>",
      "n",
    ],
    [
      "a write behind a conditional",
      "ok && (n = 1)",
      "<const/total=n * 2/>",
      "n",
    ],
  ];

  it.each(forms)("%s", (_name, write, derived, written) => {
    const head = `<let/${written}=0/>\n<let/items=[]/>\n${derived}\n`;
    const source = `${head}<button onClick() {\n  ${write};\n  log(total);\n}>x</button>\n`;
    const error = attempt(source);
    const at = readAt(source, "log(total)", "total");
    expect(error?.message).toBe(message("total", written, 5));
    expect(error?.diagnosticCode).toBe(CODE);
    expect([error?.line, error?.column]).toEqual([
      at.start.line,
      at.start.column,
    ]);
    expect(error?.end).toEqual(at.end);
  });
});

describe("the ways to read the `<const>`", () => {
  const reads: Array<[string, string, string]> = [
    ["a call argument", "log(total)", "total"],
    ["a comparison", "if (total > 100) log()", "total"],
    ["a template literal", "log(`n=${total}`)", "total"],
    ["a shorthand property", "log({ total })", "total"],
    ["a member read", "log(total.length)", "total"],
    ["an optional chain", "log(total?.length)", "total"],
    ["`typeof`", "log(typeof total)", "total"],
    ["an assignment to a local", "const x = total", "total"],
    ["a return", "return total", "total"],
    ["a spread", "log(...total)", "total"],
    ["a compound write to another name", "other += total", "total"],
    ["a tag-position call", "total()", "total"],
  ];
  it.each(reads)("%s", (_name, statement, read) => {
    const source = `${CART}<button onClick() {\n  items = [];\n  ${statement};\n}>x</button>\n`;
    const error = attempt(source);
    const at = readAt(source, statement, read);
    expect(error?.diagnosticCode).toBe(CODE);
    expect(error?.message).toBe(message("total", "items", 4));
    expect([error?.line, error?.column]).toEqual([
      at.start.line,
      at.start.column,
    ]);
    expect(error?.end).toEqual(at.end);
  });

  it("reports the first read, not a later one", () => {
    const source = `${CART}<button onClick() {\n  items = [];\n  log(total);\n  log(total);\n}>x</button>\n`;
    const error = attempt(source);
    expect(error?.line).toBe(5);
  });

  it("reports the first stale read when an earlier read is before the write", () => {
    const source = `${CART}<button onClick() {\n  log(total);\n  items = [];\n  log(total);\n}>x</button>\n`;
    const error = attempt(source);
    expect(error?.line).toBe(6);
  });
});

describe('"after" is source order in the handler\'s own body', () => {
  const body = (handler: string) =>
    `${CART}<button onClick() {\n${handler}\n}>x</button>\n`;

  it.each([
    [
      "a write in an earlier `if` branch, a read after the block",
      "  if (ok) {\n    items = [];\n  }\n  log(total);",
      "log(total)",
    ],
    [
      "a write in an `if` branch, a read in the `else`",
      "  if (ok) {\n    items = [];\n  } else {\n    log(total);\n  }",
      "log(total)",
    ],
    [
      "a write in a `try`, a read in the `catch`",
      "  try {\n    items = [];\n  } catch {\n    log(total);\n  }",
      "log(total)",
    ],
    [
      "a write in a `try`, a read in the `finally`",
      "  try {\n    items = [];\n  } finally {\n    log(total);\n  }",
      "log(total)",
    ],
    [
      "a write in one `switch` case, a read in the next",
      "  switch (k) {\n    case 1:\n      items = [];\n    case 2:\n      log(total);\n  }",
      "log(total)",
    ],
    [
      "a write in a block, a read after it",
      "  {\n    items = [];\n  }\n  log(total);",
      "log(total)",
    ],
    [
      "a read after an `await`",
      "  items = [];\n  await sleep();\n  log(total);",
      "log(total)",
    ],
    [
      "a read in a callback that runs inline is still not looked into",
      "  items = [];\n  log(total);",
      "log(total)",
    ],
    [
      "a read in the condition of the statement after the write",
      "  items = [];\n  while (total > 0) { tick() }",
      "total > 0",
    ],
    [
      "a read in the same statement after the write, comma expression",
      "  (items = [], log(total));",
      "log(total)",
    ],
    [
      "a read in the right operand of `&&` after a write in the left",
      "  (items = []) && log(total);",
      "log(total)",
    ],
  ])("%s", (_name, handler, around) => {
    const source = body(handler);
    const error = attempt(source);
    const at = readAt(source, around, "total");
    expect(error?.diagnosticCode).toBe(CODE);
    expect([error?.line, error?.column]).toEqual([
      at.start.line,
      at.start.column,
    ]);
    expect(error?.end).toEqual(at.end);
  });

  it("the async handler's read is named with the write's line", () => {
    const source = `${CART}<button onClick=async () => {\n  items = [];\n  await sleep();\n  log(total);\n}>x</button>\n`;
    expect(attempt(source)?.message).toBe(message("total", "items", 4));
  });
});

describe("a loop that repeats the write", () => {
  const body = (handler: string) =>
    `${CART}<button onClick() {\n${handler}\n}>x</button>\n`;

  it.each([
    [
      "`for`: a read before the write in the body",
      "  for (let i = 0; i < 3; i++) {\n    log(total);\n    items = [...items, i];\n  }",
      "log(total)",
    ],
    [
      "`for`: a read in the test",
      "  for (let i = 0; i < total; i++) {\n    items = [...items, i];\n  }",
      "i < total",
    ],
    [
      "`for`: a read in the update",
      "  for (let i = 0; i < 3; i += total) {\n    items = [...items, i];\n  }",
      "i += total",
    ],
    [
      "`for` with only a test that reads, no initializer",
      "  for (; i < total; i++) {\n    items = [...items, i];\n  }",
      "i < total",
    ],
    [
      "`for` with only an update that reads",
      "  for (; ok(); i += total) {\n    items = [...items, i];\n  }",
      "i += total",
    ],
    [
      "`for…of`",
      "  for (const x of xs) {\n    log(total);\n    items = [...items, x];\n  }",
      "log(total)",
    ],
    [
      "`for…in`",
      "  for (const k in o) {\n    log(total);\n    items = [...items, k];\n  }",
      "log(total)",
    ],
    [
      "`while`: the condition",
      "  while (total < 10) {\n    items = [...items, 1];\n  }",
      "total < 10",
    ],
    [
      "`while`: the body",
      "  while (ok()) {\n    log(total);\n    items = [...items, 1];\n  }",
      "log(total)",
    ],
    [
      "`do…while`: a read before the write",
      "  do {\n    log(total);\n    items = [...items, 1];\n  } while (ok());",
      "log(total)",
    ],
    [
      "a nested loop where only the outer one repeats the write",
      "  for (const a of as) {\n    log(total);\n    for (const b of bs) {\n      items = [...items, b];\n    }\n  }",
      "log(total)",
    ],
    [
      "the write in a nested block of the loop body",
      "  for (const x of xs) {\n    log(total);\n    if (x) {\n      items = [...items, x];\n    }\n  }",
      "log(total)",
    ],
  ])("%s", (_name, handler, around) => {
    const source = body(handler);
    const error = attempt(source);
    const at = readAt(source, around, "total");
    expect(error?.diagnosticCode).toBe(CODE);
    expect(error?.message).toMatch(
      /^`total` is stale here: it derives from `items`/,
    );
    expect([error?.line, error?.column]).toEqual([
      at.start.line,
      at.start.column,
    ]);
    expect(error?.end).toEqual(at.end);
  });

  it.each([
    [
      "a loop that only reads, a write after it",
      "  for (const x of xs) {\n    log(total);\n  }\n  items = [];",
    ],
    [
      "a loop that writes and a read before it, outside",
      "  log(total);\n  for (const x of xs) {\n    items = [...items, x];\n  }",
    ],
    [
      "two loops: the read in the first, the write in the second",
      "  for (const x of xs) {\n    log(total);\n  }\n  for (const y of ys) {\n    items = [...items, y];\n  }",
    ],
    [
      "a `for…of` subject that reads, run once before the body",
      "  for (const x of total.toString()) {\n    items = [...items, x];\n  }",
    ],
    [
      "a `for…in` subject that reads",
      "  for (const k in { total }) {\n    items = [];\n  }",
    ],
    [
      "a `for` initializer that reads",
      "  for (let i = 0, m = total; i < m; i++) {\n    items = [...items, i];\n  }",
    ],
  ])("accepts %s", (_name, handler) => {
    expect(attempt(body(handler))).toBeUndefined();
  });
});

describe("what is not a stale read", () => {
  const handler = (statements: string, head = CART) =>
    `${head}<button onClick(${statements.startsWith("PARAM") ? "total" : ""}) {\n${statements.replace("PARAM", "")}\n}>x</button>\n`;

  it.each([
    ["a read before the write", "  log(total);\n  items = [];"],
    ["a read in the value of the write", "  items = [...items, total];"],
    ["a read in the value of a compound write", "  items += total;"],
    ["a read with no write", "  log(total);"],
    ["a write with no read", "  items = [];"],
    ["a write to a member of the `<let>`", "  items.push(1);\n  log(total);"],
    ["a write to a property of the `<let>`", "  items.x = 1;\n  log(total);"],
    ["a write to an unrelated name", "  other = 1;\n  log(total);"],
    ["a read of the `<let>` after the write", "  items = [];\n  log(items);"],
    [
      "a read in a `setTimeout` callback",
      "  items = [];\n  setTimeout(() => log(total), 0);",
    ],
    [
      "a read in a `.then` callback",
      "  items = [];\n  fetchIt().then(function () { log(total) });",
    ],
    [
      "a read in a nested arrow handler",
      "  items = [];\n  const later = () => total;\n  queue(later);",
    ],
    [
      "a read in an immediately called arrow (not looked into)",
      "  items = [];\n  log((() => total)());",
    ],
    [
      "a read in an object method",
      "  items = [];\n  log({ get() { return total } });",
    ],
    [
      "a write inside a nested callback (not counted)",
      "  [1].forEach(() => { items = []; });\n  log(total);",
    ],
    [
      "a write in a nested function the handler declares",
      "  function reset() { items = []; }\n  log(total);",
    ],
    [
      "a read in a class method",
      "  items = [];\n  log(class { m() { return total } });",
    ],
    [
      "a `<const>` write is not a write of a `<let>`",
      "  total = 1;\n  log(total);",
    ],
    [
      "a read after a write that sits only in an earlier loop iteration's sibling function",
      "  const reset = () => { items = [] };\n  log(total);",
    ],
  ])("%s", (_name, statements) => {
    expect(attempt(handler(statements))).toBeUndefined();
  });

  it.each([
    ["a parameter", "PARAM  items = [];\n  log(total);"],
    ["a local `const`", "  items = [];\n  const total = 1;\n  log(total);"],
    ["a local `let`", "  let total = 1;\n  items = [];\n  log(total);"],
    ["a local `var`", "  items = [];\n  var total = 1;\n  log(total);"],
    ["a local function", "  items = [];\n  function total() {}\n  log(total);"],
    [
      "a catch parameter",
      "  items = [];\n  try { go() } catch (total) { log(total) }",
    ],
    [
      "a `for…of` variable",
      "  items = [];\n  for (const total of xs) { log(total) }",
    ],
    [
      "a destructured local",
      "  items = [];\n  const { total } = o;\n  log(total);",
    ],
    [
      "a block-scoped local in an enclosing block",
      "  items = [];\n  { const total = 1; log(total); }",
    ],
  ])("a local that shadows the `<const>`: %s", (_name, statements) => {
    expect(attempt(handler(statements))).toBeUndefined();
  });

  it("a read of the outer `<const>` after the shadowing block is still stale", () => {
    const source = handler(
      "  items = [];\n  { const total = 1; log(total); }\n  log(total);",
    );
    const error = attempt(source);
    expect(error?.diagnosticCode).toBe(CODE);
    expect(error?.line).toBe(6);
  });

  it.each([
    ["a parameter", "onClick(items)", "  items = [];\n  log(total);"],
    [
      "a local `let`",
      "onClick()",
      "  let items = [];\n  items = [1];\n  log(total);",
    ],
    [
      "a destructured parameter",
      "onClick({ items })",
      "  items = [];\n  log(total);",
    ],
  ])("a local that shadows the `<let>`: %s", (_name, params, statements) => {
    const source = `${CART}<button ${params} {\n${statements}\n}>x</button>\n`;
    expect(attempt(source)).toBeUndefined();
  });

  it("a `<let>` of the same name declared again below the `<const>` is not what it depends on", () => {
    const source = `${CART}<if=ok>\n  <let/items=[]/>\n  <button onClick() {\n    items = [];\n    log(total);\n  }>x</button>\n</if>\n`;
    expect(attempt(source)).toBeUndefined();
  });

  it("a `<const>` that does not depend on the written `<let>`", () => {
    const source = `<let/items=[]/>\n<let/other=0/>\n<const/doubled=other * 2/>\n<button onClick() {\n  items = [];\n  log(doubled);\n}>x</button>\n`;
    expect(attempt(source)).toBeUndefined();
  });

  it("a `<const>` of plain values is not derived", () => {
    const source = `<let/items=[]/>\n<const/limit=100/>\n<const/twice=limit * 2/>\n<button onClick() {\n  items = [];\n  log(limit, twice);\n}>x</button>\n`;
    expect(attempt(source)).toBeUndefined();
  });

  it("a `<const>` that depends on an input value only", () => {
    const source = `<let/items=[]/>\n<const/title=input.title/>\n<button onClick() {\n  items = [];\n  log(title);\n}>x</button>\n`;
    expect(attempt(source)).toBeUndefined();
  });

  it("a `<const>` that mentions a `<let>` only by a property name", () => {
    const source = `<let/items=[]/>\n<const/k=o.items/>\n<button onClick() {\n  items = [];\n  log(k);\n}>x</button>\n`;
    expect(attempt(source)).toBeUndefined();
  });

  it("a `<const>` that mentions the name inside a function that shadows it", () => {
    const source = `<let/items=[]/>\n<const/f=((items) => items.length)/>\n<button onClick() {\n  items = [];\n  log(f);\n}>x</button>\n`;
    expect(attempt(source)).toBeUndefined();
  });

  it("a `<const>` declared below the handler's tag is not detected", () => {
    const source = `<let/items=[]/>\n<button onClick() {\n  items = [];\n  log(total);\n}>x</button>\n<const/total=items.length/>\n`;
    expect(attempt(source)).toBeUndefined();
  });

  it("a `<const>` of a block that has ended", () => {
    const source = `<let/items=[]/>\n<if=ok>\n  <const/total=items.length/>\n</if>\n<button onClick() {\n  items = [];\n  log(total);\n}>x</button>\n`;
    expect(attempt(source)).toBeUndefined();
  });

  it("a `<for>` variable of the same name", () => {
    const source = `${CART}<for|total| of=totals>\n  <button onClick() {\n    items = [];\n    log(total);\n  }>x</button>\n</for>\n`;
    expect(attempt(source)).toBeUndefined();
  });

  it("a `<define>` parameter of the same name", () => {
    const source = `${CART}<define/Row|total|>\n  <button onClick() {\n    items = [];\n    log(total);\n  }>x</button>\n</define>\n`;
    expect(attempt(source)).toBeUndefined();
  });

  it("a `<const>` of the same name declared again is the new one", () => {
    const source = `${CART}<if=ok>\n  <const/total=1/>\n  <button onClick() {\n    items = [];\n    log(total);\n  }>x</button>\n</if>\n`;
    expect(attempt(source)).toBeUndefined();
  });

  it("the shadow ends with its block", () => {
    const source = `${CART}<if=ok>\n  <const/total=1/>\n</if>\n<button onClick() {\n  items = [];\n  log(total);\n}>x</button>\n`;
    expect(attempt(source)?.diagnosticCode).toBe(CODE);
  });
});

describe("what is not a handler", () => {
  const stale = "{\n  items = [];\n  log(total);\n}";

  it.each([
    [
      "a `<script>` body",
      `${CART}<button onClick() { items = []; }>x</button>\n<script>\n  if (total > 100) applyDiscount();\n</script>\n`,
    ],
    [
      "a `<script>` that writes and reads",
      `${CART}<script>\n  items = [];\n  log(total);\n</script>\n`,
    ],
    [
      "a function attribute that is not an event",
      `${CART}<widget render=(() => { items = []; return total })/>\n`,
    ],
    [
      "a function attribute named like an event inside a word",
      `${CART}<widget common=(() => { items = []; return total })/>\n`,
    ],
    [
      "an attribute named `on`",
      `${CART}<widget on=(() => { items = []; return total })/>\n`,
    ],
    [
      "an attribute named `one`",
      `${CART}<widget one=(() => { items = []; return total })/>\n`,
    ],
    [
      "a handler held in a variable",
      `${CART}<const/save=(() => { items = []; return total })/>\n<button onClick=save>x</button>\n`,
    ],
    [
      "a handler built by a call",
      `${CART}<button onClick=makeHandler(() => { items = []; return total })>x</button>\n`,
    ],
    [
      "a function value declared with `<const>`",
      `${CART}<const/save=(() => { items = []; return total })/>\n<button onClick() { save() }>x</button>\n`,
    ],
    [
      "a string-valued event attribute",
      `${CART}<button onClick="items = []; total">x</button>\n`,
    ],
    ["a spread of handlers", `${CART}<button ...handlers>x</button>\n`],
    [
      "a `<lifecycle>` hook (not an event handler; not detected)",
      `${CART}<lifecycle onMount() { items = []; log(total) } onUpdate() { items = []; log(total) }/>\n`,
    ],
    [
      "a `<let>`'s `valueChange`",
      `${CART}<let/count=0 valueChange(v) { items = []; log(total); count = v }/>\n`,
    ],
  ])("%s", (_name, source) => {
    expect(attempt(source)).toBeUndefined();
  });

  it("an `onClick` whose value is not a function is not looked into", () => {
    expect(
      attempt(
        `${CART}<button onClick=(ok ? ${stale.replace(/^\{/, "() => {")} : null)>x</button>\n`,
      ),
    ).toBeUndefined();
  });
});

describe("only a file with a `<let>` and a derived `<const>` is checked", () => {
  it("no `<let>`: a `<const>` of a plain value", () => {
    const source = `<const/total=input.items.length/>\n<button onClick() {\n  input.items = [];\n  log(total);\n}>x</button>\n`;
    expect(attempt(source)).toBeUndefined();
  });

  it("a `<let>` and no `<const>`", () => {
    const source = `<let/items=[]/>\n<button onClick() {\n  items = [];\n  log(items);\n}>x</button>\n`;
    expect(attempt(source)).toBeUndefined();
  });
});

describe("only the `none` tag-rules preset leaves `let` an ordinary name", () => {
  const source = `${CART}<button onClick() {\n  items = [];\n  log(total);\n}>x</button>\n`;

  it("lowerSource none: nothing fires", () => {
    const { diagnostics } = lowerSource(source, "/work/none-page.mx", {
      tagRules: "none",
    });
    expect(diagnostics.filter((d) => d.code === CODE)).toEqual([]);
  });

  it("an explicit `html` preset refuses it", () => {
    const { diagnostics } = lowerSource(source, "/work/html-page.mx", {
      tagRules: "html",
    });
    expect(diagnostics.map((d) => d.code)).toContain(CODE);
  });

  it("the `markup` preset refuses it too", () => {
    const { diagnostics } = lowerSource(source, "/work/markup-page.mx", {
      tagRules: "markup",
    });
    expect(diagnostics.map((d) => d.code)).toContain(CODE);
  });
});

describe("a host or policy that refuses `<let>` never reaches the read", () => {
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
      const source = `${CART}<button onClick() {\n  items = [];\n  log(total);\n}>x</button>\n`;
      const error = attempt(source, refusing(kind));
      expect(error?.diagnosticCode).toBe("MX_UNSUPPORTED_CONSTRUCT");
      expect([error?.line, error?.column]).toEqual([1, 0]);
      expect(error?.message).not.toContain("is stale here");
    },
  );
});

describe("a registered tag called `let` is that tag, not the builtin", () => {
  it("declares nothing, so nothing is stale", () => {
    let error: TranslateError | undefined;
    try {
      compileSource(
        `${CART}<button onClick() {\n  items = [];\n  log(total);\n}>x</button>\n`,
        "/page.mx",
        { ...withLet, isBuiltinTag: () => false },
        {
          targets: lookup,
          emitIr: () => "",
          customTags: { let: { attributes: { "*": {} } } },
        } as never,
      );
    } catch (caught) {
      error = caught as TranslateError;
    }
    expect(error?.diagnosticCode).not.toBe(CODE);
  });
});

describe("lowerSource keeps going after the error", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-stale-read-")));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps lowering the tag, so its other errors are reported too", () => {
    const source = `${CART}<button class=(items = [1]) onClick() {\n  items = [];\n  log(total);\n}><p>\${items++}</p></button>\n`;
    const { diagnostics } = lowerSource(source, join(dir, "page.mx"), {
      tagRules: "html",
    });
    const codes = diagnostics.map((d) => d.code);
    expect(codes).toContain(CODE);
    expect(codes.filter((c) => c === "MX_LET_WRITE_IN_RENDER")).toHaveLength(2);
  });

  it("reports a stale read in a second handler after the first handler's", () => {
    const source = `${CART}<button onClick() {\n  items = [];\n  log(total);\n}>a</button>\n<button onClick() {\n  items = [];\n  log(total);\n}>b</button>\n`;
    const { diagnostics } = lowerSource(source, join(dir, "page.mx"), {
      tagRules: "html",
    });
    expect(diagnostics.filter((d) => d.code === CODE)).toHaveLength(2);
  });
});
