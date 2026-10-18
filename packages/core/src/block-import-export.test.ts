// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * `import` and `export` inside a `static`, `server` or `client` block.
 *
 * Marko reads the statements inside the one block as the module's own, so an
 * `import` or an `export` there is valid (stock Marko 6.4.4 compiles every row
 * below; `packages/targets/html/src/block-import-export.test.ts` pins the
 * module code it emits). The block's braces used to reach the statement check
 * ("'import' and 'export' may only appear at the top level.") and the
 * TypeScript strip (`export default` crashed it with an internal TypeError).
 * Only an `import` or `export` below the block's own statements is still
 * refused, and a real syntax error in the block is reported ahead of it.
 */
import { describe, expect, it } from "vitest";
import { lowerSource } from "./ir-entry/index.ts";

const PLACEMENT =
  "An `import` or `export` must be a statement of the module: at the top of the file, after `static`, `server` or `client`, or directly inside that statement's `{ … }` block. This one is inside a nested block, an `if` or a function body; move it out to the block's own statements.";

function lower(source: string) {
  return lowerSource(source, "/f/t.mx", { tagRules: "html" });
}

/** The code of every `Static` statement lowered to module scope. */
function hoisted(source: string): string[] {
  const { ir, diagnostics } = lower(source);
  expect(diagnostics).toEqual([]);
  return (ir?.hoisted ?? []).map((statement) => statement.code);
}

describe("an import or export in a static block is a module statement", () => {
  it.each([
    [
      "an import",
      'static { import x from "./x" }\n<div/>',
      'import x from "./x"',
    ],
    ["a bare import", 'static { import "./side" }\n<div/>', 'import "./side"'],
    [
      "a type-only import",
      'static { import type { T } from "./x"; const a: T = 1 }\n<div/>',
      'import type { T } from "./x"; const a: T = 1',
    ],
    [
      "an export of a declaration",
      "static { export const z = 1 }\n<div/>",
      "export const z = 1",
    ],
    [
      "an export of a function",
      "static { export function f() {} }\n<div/>",
      "export function f() {}",
    ],
    [
      "an export list after a declaration",
      "static { const y = 1; export { y } }\n<div/>",
      "const y = 1; export { y }",
    ],
    [
      "an export from",
      'static { export { a } from "./x" }\n<div/>',
      'export { a } from "./x"',
    ],
    [
      "an export star",
      'static { export * from "./x" }\n<div/>',
      'export * from "./x"',
    ],
    [
      "type exports",
      "static { export type T = number; export interface I {} }\n<div/>",
      "export type T = number; export interface I {}",
    ],
    [
      "an import used by a later statement",
      'static { import x from "./x"; const y = x; }\n<div>${y}</div>',
      'import x from "./x"; const y = x;',
    ],
    [
      "a block over several lines",
      'static {\n  import x from "./x";\n  export const y = x;\n}\n<div/>',
      'import x from "./x";\n  export const y = x;',
    ],
    [
      "a namespace's own exports",
      "static { export namespace N { export const a = 1 } }\n<div/>",
      "export namespace N { export const a = 1 }",
    ],
  ])("%s", (_name, source, code) => {
    expect(hoisted(source)).toEqual([code]);
  });

  it("is the same module code as the statement written without the block", () => {
    expect(hoisted('static import x from "./x"\n<div/>')).toEqual(
      hoisted('static { import x from "./x" }\n<div/>'),
    );
  });
});

describe("server and client blocks with an import or export lower without an error", () => {
  it.each([
    ["server import", 'server { import x from "./x" }\n<div/>'],
    ["server export const", "server { export const z = 1 }\n<div/>"],
    ["server export star", 'server { export * from "./x" }\n<div/>'],
    ["client import", 'client { import x from "./x"; }\n<div/>'],
    ["client export const", "client { export const y = 1 }\n<div/>"],
    ["client export from", 'client { export { a } from "./x" }\n<div/>'],
  ])("%s", (_name, source) => {
    const { ir, diagnostics } = lower(source);
    expect(diagnostics).toEqual([]);
    expect(ir).toBeDefined();
  });
});

describe("a block without an import or export keeps its module code", () => {
  it.each([
    ["a declaration", "static { let q = 1 }\n<div/>", "let q = 1"],
    [
      "several statements",
      "static { let a = 1; let b = a }\n<div/>",
      "let a = 1; let b = a",
    ],
    [
      "a typed declaration",
      "static { let x: number = 1 }\n<div/>",
      "let x: number = 1",
    ],
    [
      "two blocks",
      "static { let a = 1 } { let b = 2 }\n<div/>",
      "{ let a = 1 } { let b = 2 }",
    ],
  ])("%s", (_name, source, code) => {
    expect(hoisted(source)).toEqual([code]);
  });
});

describe("an import or export below the block's statements is still refused", () => {
  /** [source, line, column] of the refused declaration: 1-based line, 0-based column. */
  it.each([
    ["a nested block", 'static { { import x from "./x" } }\n<div/>', 1, 11],
    ["an if body", "static { if (a) { export const q = 1 } }\n<div/>", 1, 18],
    [
      "a function body",
      'static { function f() { import x from "./x" } }\n<div/>',
      1,
      24,
    ],
    [
      "a second block",
      'static { import x from "./x" } { import y from "./y" }\n<div/>',
      1,
      9,
    ],
    [
      "a server block nested",
      'server { { import x from "./x" } }\n<div/>',
      1,
      11,
    ],
    [
      "a client block nested",
      'client { { import x from "./x" } }\n<div/>',
      1,
      11,
    ],
    [
      "the second line of a block",
      'static {\n  { import x from "./x" }\n}\n<div/>',
      2,
      4,
    ],
  ])("%s", (_name, source, line, column) => {
    const { ir, diagnostics } = lower(source);
    expect(ir).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      severity: "error",
      code: "MX_INVALID_STATEMENT",
      message: PLACEMENT,
      line,
      column,
    });
  });

  it("refuses a top-level statement that is not in a block, as before", () => {
    const { diagnostics } = lower(
      'static if (a) { import x from "./x" }\n<div/>',
    );
    expect(diagnostics[0]?.message).toBe(PLACEMENT);
  });
});

describe("a syntax error in a block with an import is reported where it is", () => {
  it("a plain syntax error, not the import", () => {
    const { diagnostics } = lower(
      'static {\n  import x from "./x";\n  let a = ;\n}\n<div/>',
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "MX_INVALID_STATEMENT",
      message: "Unexpected token",
      line: 3,
      column: 10,
    });
  });

  it("a decorator", () => {
    const { diagnostics } = lower(
      'static {\n  import x from "./x";\n  @d class C {}\n}\n<div/>',
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toMatch(
      /^Decorators are not read inside a `static` statement/,
    );
    expect([diagnostics[0]?.line, diagnostics[0]?.column]).toEqual([3, 2]);
  });

  it("JSX", () => {
    const { diagnostics } = lower(
      'static {\n  import x from "./x";\n  const a = <b/>;\n}\n<div/>',
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toMatch(
      /^JSX is not read inside a `static` statement/,
    );
    expect([diagnostics[0]?.line, diagnostics[0]?.column]).toEqual([3, 12]);
  });

  it("the same errors in a block without an import keep their position", () => {
    const { diagnostics } = lower("static {\n  let a = ;\n}\n<div/>");
    expect([diagnostics[0]?.line, diagnostics[0]?.column]).toEqual([2, 10]);
  });
});

const SECOND_DEFAULT =
  "A template is already its own default export, so this default export would give the module a second one and the module would not load. Use a named export instead (`export const x`, or `export { x }`).";

/** `[line, column]` (1-based line, 0-based column) of `offset` in `source`. */
function positionOf(source: string, offset: number): [number, number] {
  const before = source.slice(0, offset).split("\n");
  return [before.length, (before.at(-1) ?? "").length];
}

/** Runs `fn` with the console silenced; returns what was written to it (Babel's TypeScript plugin warns there). */
function consoleOutput(fn: () => void): string[] {
  const lines: string[] = [];
  const methods = ["warn", "error", "log"] as const;
  const originals = methods.map((method) => console[method]);
  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
  }
  try {
    fn();
  } finally {
    methods.forEach((method, index) => {
      console[method] = originals[index] as never;
    });
  }
  return lines;
}

const KEYWORDS = ["static", "server", "client"] as const;

/** [name, keyword => [source, the refused export's text]] */
const REFUSED: [string, (k: string) => [string, string]][] = [
  [
    "a block, export default <expression>",
    (k) => [
      `${k} { const foo = 1; export default foo }\n<div/>`,
      "export default foo",
    ],
  ],
  [
    "a block, export default <literal>",
    (k) => [`${k} { export default 5 }\n<div/>`, "export default 5"],
  ],
  [
    "a block, export default function",
    (k) => [
      `${k} { export default function f() {} }\n<div/>`,
      "export default function f() {}",
    ],
  ],
  [
    "a block, export default class",
    (k) => [
      `${k} { export default class C {} }\n<div/>`,
      "export default class C {}",
    ],
  ],
  [
    "a block, export { x as default } beside the declaration",
    (k) => [
      `${k} { const q = 1; export { q as default } }\n<div/>`,
      "export { q as default }",
    ],
  ],
  [
    "a block, export { x as default } of an earlier statement",
    (k) => [
      `${k} const q = 1;\n${k} { export { q as default } }\n<div/>`,
      "export { q as default }",
    ],
  ],
  [
    'a block, export { x as "default" }',
    (k) => [
      `${k} { const q = 1; export { q as "default" } }\n<div/>`,
      'export { q as "default" }',
    ],
  ],
  [
    "a block, export { default } from",
    (k) => [
      `${k} { export { default } from "./m" }\n<div/>`,
      'export { default } from "./m"',
    ],
  ],
  [
    "a block, export { a as default } from",
    (k) => [
      `${k} { export { a as default } from "./m" }\n<div/>`,
      'export { a as default } from "./m"',
    ],
  ],
  [
    "a block, export * as default from",
    (k) => [
      `${k} { export * as default from "./m" }\n<div/>`,
      'export * as default from "./m"',
    ],
  ],
  [
    "a block with a named export beside the default one",
    (k) => [
      `${k} {\n  export const a = 1;\n  export default a;\n}\n<div/>`,
      "export default a;",
    ],
  ],
  [
    "block-less, export default <literal>",
    (k) => [`${k} export default 5;\n<div/>`, "export default 5;"],
  ],
  [
    "block-less, export default function",
    (k) => [
      `${k} export default function f() {}\n<div/>`,
      "export default function f() {}",
    ],
  ],
  [
    "block-less, export { x as default } of an earlier statement",
    (k) => [
      `${k} const q = 1;\n${k} export { q as default };\n<div/>`,
      "export { q as default };",
    ],
  ],
  [
    "block-less, export { default } from",
    (k) => [
      `${k} export { default } from "./m";\n<div/>`,
      'export { default } from "./m";',
    ],
  ],
  [
    "block-less, export { a as default } from",
    (k) => [
      `${k} export { a as default } from "./m";\n<div/>`,
      'export { a as default } from "./m";',
    ],
  ],
];

describe("a default export in a static, server or client statement is refused", () => {
  for (const keyword of KEYWORDS) {
    it.each(REFUSED)(`${keyword}: %s`, (_name, build) => {
      const [source, exported] = build(keyword);
      const at = source.indexOf(exported);
      const { ir, diagnostics } = lower(source);
      expect(ir).toBeUndefined();
      expect(diagnostics).toHaveLength(1);
      const [line, column] = positionOf(source, at);
      const [endLine, endColumn] = positionOf(source, at + exported.length);
      expect(diagnostics[0]).toMatchObject({
        severity: "error",
        code: "MX_INVALID_STATEMENT",
        message: SECOND_DEFAULT,
        line,
        column,
        end: { line: endLine, column: endColumn },
      });
    });
  }

  it("names the form and the fix, with no decision number or link", () => {
    expect(SECOND_DEFAULT).toContain("default export");
    expect(SECOND_DEFAULT).toContain("Use a named export instead");
    expect(SECOND_DEFAULT).not.toMatch(/decision|https?:/i);
  });

  it("refuses the export in a second statement, not the first", () => {
    const source = "static const a = 1;\nstatic export default a;\n<div/>";
    const { diagnostics } = lower(source);
    expect(diagnostics[0]).toMatchObject({ line: 2, column: 7 });
  });
});

describe("a type-only default export is erased, so it is not a second default", () => {
  it.each([
    ["static", "static export default interface I {}"],
    ["static block", "static { export default interface I {} }"],
    ["server", "server export default interface I {}"],
    ["client", "client export default interface I {}"],
    ["export type", "static { type T = 1; export type { T as default } }"],
    ["a type specifier", "static { type T = 1; export { type T as default } }"],
    [
      "an import type in the same statement",
      'static { import type { T } from "./m"; export { T as default } }',
    ],
    [
      "export default of an import type in the same statement",
      'static { import type { T } from "./m"; export default T }',
    ],
    [
      "a type specifier import in the same statement",
      'static { import { type T } from "./m"; export { T as default } }',
    ],
  ])("%s", (_name, statement) => {
    const { ir, diagnostics } = lower(`${statement}\n<div/>`);
    expect(diagnostics).toEqual([]);
    expect(ir).toBeDefined();
  });
});

describe("a type imported by an earlier statement is not known to the default-export check", () => {
  it("refuses `export { T as default }`, as the spec says", () => {
    const { diagnostics } = lower(
      'static import type { T } from "./m";\nstatic export { T as default };\n<div/>',
    );
    expect(diagnostics[0]?.message).toBe(SECOND_DEFAULT);
  });
});

describe("a named export never reads as a default one", () => {
  it.each([
    ["export const", "static { export const a = 1 }"],
    ["export function", "static export function f() {}"],
    ["export list", "static { const a = 1; export { a } }"],
    ["export rename", "static { const a = 1; export { a as b } }"],
    [
      "a name that contains default",
      "static { const a = 1; export { a as defaults } }",
    ],
    ["export star", 'static export * from "./m";'],
    ["export star as", 'static export * as ns from "./m";'],
    ["export from", 'static export { a } from "./m";'],
    ["server export list", "server { const a = 1; export { a } }"],
    ["client export const", "client { export const a = 1 }"],
  ])("%s", (_name, statement) => {
    const { ir, diagnostics } = lower(`${statement}\n<div/>`);
    expect(diagnostics).toEqual([]);
    expect(ir).toBeDefined();
  });

  it("refuses a top-level `export default` that has no keyword, as Marko does", () => {
    const { diagnostics } = lower("export default foo;\n<div/>");
    expect(diagnostics.map((d) => d.code)).toEqual(["MX_INVALID_STATEMENT"]);
  });
});

describe("an export list names a binding an earlier statement declares", () => {
  const CASES: [string, string, string][] = [
    [
      "an earlier static statement",
      "static const q = 1;\nstatic export { q };\n<div/>",
      "export { q }",
    ],
    [
      "an earlier static import",
      'static import { q } from "./q";\nstatic export { q };\n<div/>',
      "export { q }",
    ],
    [
      "an earlier server statement",
      "server const q = 1;\nserver export { q };\n<div/>",
      "export { q }",
    ],
    [
      "a rename",
      "static const q = 1;\nstatic export { q as other };\n<div/>",
      "export { q as other }",
    ],
    [
      "a block",
      "static const q = 1;\nstatic { export { q } }\n<div/>",
      "export { q }",
    ],
    [
      "an earlier statement, several names",
      "static const a = 1;\nstatic const b = 2;\nstatic export { a, b as c };\n<div/>",
      "export { a, b as c }",
    ],
  ];

  it.each(CASES)(
    "%s compiles, with nothing on the console",
    (_name, source, code) => {
      const lines = consoleOutput(() => {
        const { ir, diagnostics } = lower(source);
        expect(diagnostics).toEqual([]);
        // A `server` statement is the target's to emit; it is not hoisted here.
        if (source.startsWith("static")) {
          expect(
            ir?.hoisted.map((statement) => statement.code).join("\n"),
          ).toContain(code);
        }
      });
      expect(lines).toEqual([]);
    },
  );

  it("compiles a client binding", () => {
    const lines = consoleOutput(() => {
      const { diagnostics } = lower(
        "client const q = 1;\nclient export { q };\n<div/>",
      );
      expect(diagnostics).toEqual([]);
    });
    expect(lines).toEqual([]);
  });

  it("keeps the statement's own text", () => {
    const { ir } = lower("static const q = 1;\nstatic export { q };\n<div/>");
    expect((ir?.hoisted ?? []).map((statement) => statement.code)).toEqual([
      "const q = 1;",
      "export { q };",
    ]);
  });

  it("still reports a real syntax error in such a statement", () => {
    const { diagnostics } = lower(
      "static const q = 1;\nstatic export { q as };\n<div/>",
    );
    expect(diagnostics[0]?.code).toBe("MX_INVALID_STATEMENT");
    expect(diagnostics[0]?.line).toBe(2);
  });
});
