// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { describe, expect, it } from "vitest";
import { diagnosticsOf } from "./fixtures/type-check.ts";
import { compile } from "./index.ts";

/**
 * The type-check projection's two views of a page's module statements.
 *
 * The server view (the module that renders, the template, `static` and
 * `server` code) reads a `client` name as `undefined`, as the module that runs
 * declares it `var q;`. Client code reads a `server` name as `undefined`, as
 * the browser has none, and keeps every meaning of its own imports. Each row
 * is a source and the diagnostics TypeScript reports on it, as
 * `[code, authored text at the mapped span]`: no row may report on generated
 * text (`?`).
 */

const FILES = {
  "one.ts":
    "export function clamp(v: number): number { return v }\nexport const one = 1;\nexport interface Row { a: number }\nexport class Klass {}\n",
  "chart.ts": "export default class Chart {}\n",
  "f.ts": "export declare function fmt(v: string): string;\n",
  "x.ts": "export const input = 1;\n",
  "side.ts": "",
};

const NUL = { noUnusedLocals: true };
const ESO = { noUnusedLocals: true, erasableSyntaxOnly: true };

type Row = [
  name: string,
  source: string,
  expected: Array<[number, string]>,
  compilerOptions?: Record<string, boolean>,
];

function found(source: string, compilerOptions?: Record<string, boolean>) {
  return diagnosticsOf(source, { files: FILES, compilerOptions }).map(
    (d) => [d.code, d.at] as [number, string],
  );
}

const CI = 'client import { one } from "./one.ts";\n';

describe("client code reading server names", () => {
  const rows: Row[] = [
    [
      "A1 a server const",
      "server const secret = 1;\nclient const n = secret.toFixed(1);\n<div/>",
      [[18048, "secret"]],
    ],
    [
      "A2 a server import",
      'server import { clamp } from "./one.ts";\nclient const r = clamp(1);\n<div/>',
      [
        [2722, "clamp"],
        [18048, "clamp"],
      ],
    ],
    [
      "A3 a server import-equals alias",
      "server namespace Lib { export const v = 1 }\nserver import v = Lib.v;\nclient const t = v.toFixed(1);\n<div/>",
      [[18048, "v"]],
    ],
    [
      "A4 a server ambient export",
      "server export declare const s: number;\nclient const n = s.toFixed(1);\n<div/>",
      [[18048, "s"]],
    ],
    [
      "A5 a server function and class",
      "server function f() { return 1 }\nserver class K {}\nclient const n = f();\nclient const k = new K();\n<div/>",
      [
        [2722, "f"],
        [18048, "f"],
        [18048, "K"],
      ],
    ],
    [
      "A6 a nested server var",
      "server if (true) { var hv = 1 }\nclient const n = hv.toFixed(1);\n<div/>",
      [[18048, "hv"]],
    ],
    [
      "A7 a server label is not a name",
      "server x: for (;;) { break x }\nclient const x = 1;\nclient const y = x.toFixed(1);\n<div/>",
      [],
    ],
    [
      "A8 static and plain-import names are shared",
      'static const k = 1;\nimport { one } from "./one.ts";\nclient const n = k.toFixed(1) + one;\n<div/>',
      [],
    ],
    [
      "A9 a static var merged with a server var",
      "static var s = 1;\nserver var s = 2;\nclient const n = s.toFixed(1);\n<div/>",
      [],
    ],
    [
      "A10 a server var merged with a client var",
      "server var s = 1;\nclient var s = 2;\nclient const n = s.toFixed(1);\n<div>${s.toFixed(1)}</div>",
      [],
    ],
    [
      "A11 a nested client var of a server name",
      "server var i = 0;\nclient for (var i = 0; i < 3; i++) {}\n<div/>",
      [],
    ],
    [
      "A12 a client label is not a name",
      "server var x = 1;\nclient x: for (;;) { break x }\nclient const y = x.toFixed(1);\n<div/>",
      [[18048, "x"]],
    ],
    [
      "A13 server types stay usable in client code",
      'server import { Row, Klass } from "./one.ts";\nclient let r: Row | null = null;\nclient let k: Klass | null = null;\n<div/>',
      [],
    ],
    [
      "A14 KNOWN LIMIT: typeof a server name in client code is undefined",
      'server import { clamp } from "./one.ts";\nclient let t: ReturnType<typeof clamp> | null = null;\n<div/>',
      [[2344, "typeof clamp"]],
    ],
    [
      "A15 a client namespace body reads a server name",
      "server const secret = 1;\nclient namespace Api { export const k = secret.toFixed(1) }\n<div/>",
      [[18048, "secret"]],
    ],
    [
      "A16 KNOWN LIMIT: a client namespace merged with a server one stays at module level",
      "server namespace N { export const a = 1 }\nclient namespace N { export const b = 2 }\nclient const t = N.b;\nclient const u = N.a;\n<div>${N.a}</div>",
      [],
    ],
    [
      "A17 a static namespace merged with a client one",
      "static namespace N { export const a = 1 }\nclient namespace N { export const b = 2 }\nclient const t = N.a + N.b;\n<div>${N.a}</div>",
      [],
    ],
    [
      "A18 a listed client value of a server name",
      "server const secret = 1;\nclient { var q = 1; export { q } }\nserver var q = 0;\n<div/>",
      // The two server declarations nothing reads, as in any module.
      [
        [6133, "secret"],
        [6133, "q"],
      ],
      NUL,
    ],
    [
      "A20 a client declare merged with a server function",
      "client declare function f(x: number): void;\nserver function f(x: number) {}\nclient f(1);\n<div/>",
      [],
    ],
  ];
  it.each(rows)("%s", (_name, source, expected, options) => {
    expect(found(source, options)).toEqual(expected);
  });
});

describe("the server view of client names", () => {
  const rows: Row[] = [
    [
      "B1 a client import",
      `${CI}<div>\${one.toFixed(1)}</div>`,
      [[18048, "one"]],
    ],
    [
      "B2 a client default import",
      'client import Chart from "./chart.ts";\n<div>${String(new Chart())}</div>',
      [[18048, "Chart"]],
    ],
    [
      "B3 a client namespace import",
      'client import * as ns from "./one.ts";\n<div>${ns.one}</div>',
      [[18048, "ns"]],
    ],
    [
      "B4 a renamed client import",
      'client import { one as uno } from "./one.ts";\n<div>${uno.toFixed(1)}</div>',
      [[18048, "uno"]],
    ],
    [
      "B5 a client namespace",
      "client namespace Api { export const k = 1 }\n<div>${Api.k}</div>",
      [[18048, "Api"]],
    ],
    [
      "B6 a client declare",
      "client declare const d: number;\n<div>${d.toFixed(1)}</div>",
      [[18048, "d"]],
    ],
    [
      "B7 a client declare global stays",
      "client declare global { interface Window { mxTest: number } }\n<div/>",
      [],
    ],
    [
      "B8 a client type-only namespace stays",
      "client namespace T { export type X = number }\nexport interface Input { x?: T.X }\n<div/>",
      [],
    ],
    [
      "B9 a server statement reads a client import",
      `${CI}server const z = one.toFixed(1);\n<div/>`,
      [[18048, "one"]],
    ],
    [
      "B10 a static statement reads a client import",
      `${CI}static const z = one.toFixed(1);\n<div/>`,
      [[18048, "one"]],
    ],
    [
      "B11 a server statement reads a client namespace",
      "client namespace Api { export const k = 1 }\nserver const z = Api.k;\n<div/>",
      [[18048, "Api"]],
    ],
    [
      "B12 a client type specifier stays",
      'client import { type Row } from "./one.ts";\nexport interface Input { r?: Row }\n<div/>',
      [],
    ],
    [
      "B13 a module-level type naming a client value import is reported",
      'client import { Row } from "./one.ts";\nexport interface Input { r?: Row }\n<div/>',
      [[2749, "Row"]],
    ],
    [
      "B14 a tag variable wins over a client import",
      'client import { one as y } from "./one.ts";\n<div><const/y=2/>${y.toFixed(1)}</div>',
      [],
    ],
    [
      "B15 a tag variable wins over a client declare",
      "client declare const count: number;\n<let/count=0/>\n<div>${count}</div>",
      [],
    ],
    [
      "B16 the render's input wins over a client import of that spelling",
      'client import { input } from "./x.ts";\nexport interface Input { a: number }\n<div>${input.a}</div>',
      [],
    ],
    [
      "B17 client code keeps every meaning of an import",
      'client import { one, clamp, Klass, Row } from "./one.ts";\nclient const k: Klass = new Klass();\nclient const r: Row = { a: clamp(one) };\n<div/>',
      [
        [6133, "k"],
        [6133, "r"],
      ],
      ESO,
    ],
    [
      "B18 a client default import is a type in client code",
      'client import Chart from "./chart.ts";\nclient const c: Chart = new Chart();\n<div/>',
      [],
    ],
    [
      "B19 an unknown client import name",
      'client import { missing } from "./one.ts";\n<div/>',
      [[2694, "missing"]],
    ],
    ["B20 an unused client import", `${CI}<div/>`, [[6133, "one"]], NUL],
    [
      "B21 a side-effect import and generated text under erasableSyntaxOnly",
      `client import "./side.ts";\n${CI}client const n = one;\n<div/>`,
      [[6133, "n"]],
      ESO,
    ],
    [
      "B22 an unused client default import is reported once",
      'client import Chart from "./chart.ts";\n<div/>',
      [[6133, "Chart"]],
      NUL,
    ],
    [
      "B23 KNOWN LIMIT: a client namespace body reading a client default import is undefined",
      'client import Chart from "./chart.ts";\nclient namespace A { export const c = new Chart() }\n<div/>',
      [[18048, "Chart"]],
    ],
  ];
  it.each(rows)("%s", (_name, source, expected, options) => {
    expect(found(source, options)).toEqual(expected);
  });
});

describe("a refinement naming a client binding", () => {
  const CC = 'client import { clamp } from "./one.ts";\n';
  const rows: Row[] = [
    [
      "C1 a client function",
      "client function clamp(v: number) { return v }\n<let/q=1/>\n<input value:clamp:=q/>",
      [],
    ],
    ["C2 a client import", `${CC}<let/q=1/>\n<input value:clamp:=q/>`, []],
    [
      "C3 the argument is the bound value",
      `${CC}<let/q="a"/>\n<input value:clamp:=q/>`,
      [[2345, "q"]],
    ],
    [
      "C4 a client declare",
      "client declare function fmt(v: number): number;\n<let/q=1/>\n<input value:fmt:=q/>",
      [],
    ],
    [
      "C5 a client const",
      "client const clamp = (v: number) => v;\n<let/q=1/>\n<input value:clamp:=q/>",
      [],
    ],
    [
      "C6 a tag variable wins",
      "client declare function fmt(x: string): string;\n<const/fmt=(v: number) => v/>\n<let/q=1/>\n<input value:fmt:=q/>",
      [],
    ],
    [
      "C7 a tag param wins",
      'client import { fmt } from "./f.ts";\n<let/q=1/>\n<for|fmt| of=[(v: number) => v]><input value:fmt:=q/></for>',
      [],
    ],
    [
      "C8 a define param wins",
      'client import { fmt } from "./f.ts";\n<let/q=1/>\n<define/Row|fmt: (v: number) => number|><input value:fmt:=q/></define>',
      [],
    ],
    [
      "C9 a binding of a sibling scope does not",
      "client declare function fmt(x: number): number;\n<let/q=1/>\n<input value:fmt:=q/>\n<if=true><const/fmt=(v: string) => v/></if>",
      [],
    ],
    [
      "C10 a declare merged with a type-only namespace",
      "client declare function f(x: number): number;\nclient namespace f { export type T = 1 }\n<let/q=1/>\n<input value:f:=q/>",
      [],
    ],
    [
      "C11 a later binding of the block wins",
      'client declare function fmt(v: number): number;\n<let/q="a"/>\n<input value:fmt:=q/>\n<const/fmt=(v: string) => v/>',
      [],
    ],
    [
      "C12 a name no client statement declares keeps its probe",
      'static function fn(next: string): string { return next }\nstatic const q = "a";\n<input value:fnn:=q/>',
      [[2304, "fnn"]],
    ],
  ];
  it.each(rows)("%s", (_name, source, expected, options) => {
    expect(found(source, options)).toEqual(expected);
  });
});

describe("the projection's layout", () => {
  it.each(["<div/>", "static const k = 1;\n<div/>"])(
    "D1 no client view without a client statement: %j",
    (source) => {
      const { code } = compile(source, "/f/t.mx", { typeCheck: true });
      expect(code).not.toContain("__mxClient");
    },
  );
});

describe("the module that runs is unchanged", () => {
  /** The module origin/main emits, around the hoisted line and the body. */
  const module = (hoisted: string, body: string, text = true) =>
    [
      'import { escape as __mxEscape, createOut as __mxCreateOut, type Out as __MxOut } from "@mxlang/target-html";',
      "",
      ...(hoisted ? [hoisted, ""] : []),
      "export interface Input {}",
      "",
      ...(text
        ? [
            "function __mxTextOf(__mxValue: unknown): string {",
            '  return __mxValue || __mxValue === 0 ? __mxValue + "" : "";',
            "}",
            "",
          ]
        : []),
      "function T(input: Input): string {",
      "  const __mxOut = __mxCreateOut();",
      "  __mxRender(input, __mxOut);",
      "  return __mxOut.toString();",
      "}",
      "T.render = __mxRender;",
      "",
      "function __mxRender(input: Input, __mxOut: __MxOut): void {",
      body,
      "}",
      "export { __mxRender as render };",
      'Object.defineProperty(T, Symbol.for("mx.component"), { value: true });',
      "",
      "export default T as ((input: Input) => string) & { render: typeof __mxRender };",
      "",
    ].join("\n");
  const div = (read: string) =>
    `  __mxOut.write("<div>");\n  __mxOut.write(__mxEscape(__mxTextOf(${read})));\n  __mxOut.write("</div>");`;

  it.each([
    [
      `${CI}<div>\${one.toFixed(1)}</div>`,
      module("var one;", div("one.toFixed(1)")),
    ],
    [
      "client namespace Api { export const k = 1 }\n<div>${Api.k}</div>",
      module("var Api;", div("Api.k")),
    ],
    [
      "client declare const d: number;\n<div>${d.toFixed(1)}</div>",
      module("", div("d.toFixed(1)")),
    ],
    [
      "server const secret = 1;\nclient const n = secret.toFixed(1);\n<div/>",
      module(
        "const secret = 1;\nvar n;",
        '  __mxOut.write("<div></div>");',
        false,
      ),
    ],
  ])("D2 %j without typeCheck", (source, expected) => {
    expect(compile(source, "/f/t.mx").code).toBe(expected);
  });
});
