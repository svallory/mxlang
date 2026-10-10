import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as core from "../index.ts";
import type { DelegatedTag } from "../ir.ts";
import type { SyntaxModule } from "../syntax-table.ts";
import {
  type LowerSourceOptions,
  lowerFile,
  lowerSource,
  type Spanned,
} from "./index.ts";

/**
 * `lowerSource`, the IR entry point (decision 204). The diagnostics it reports
 * replaced `@mxlang/data`'s `parseData` text for text and position for
 * position; the pinned cases below are the ones a first cut got wrong.
 */

function tagOf(node: { kind: string } | undefined): Spanned<DelegatedTag> {
  expect(node?.kind).toBe("DelegatedTag");
  return (node as unknown as { tag: Spanned<DelegatedTag> }).tag;
}

function errors(source: string, options?: LowerSourceOptions) {
  return lowerSource(source, "/t.mx", options).diagnostics.map((d) => [
    d.severity,
    d.message,
    d.line,
    d.column,
    d.offset,
  ]);
}

/**
 * `<const>` and `<return>` are open-tag-only under every preset (lead ruling
 * on review of decision 204's `none`), as `@mxlang/data`'s taglib made them.
 * Without the flag a `<const/y=1>` not self-closed swallows what follows, and
 * a child written inside one is silently dropped.
 */
describe("open-tag-only statements: parseData's text and position", () => {
  it("a `<const>` with no closing tag ends at its opening tag", () => {
    const result = lowerSource("<const/y=1>\n<a/>\n", "/t.mx");
    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.body.map((node) => node.kind)).toEqual([
      "Const",
      "DelegatedTag",
    ]);
  });

  it("a `<const>` with no closing tag inside a tag does not take the parent's closing tag", () => {
    const result = lowerSource("<x>\n  <const/y=1>\n</x>", "/t.mx");
    expect(result.diagnostics).toEqual([]);
    const x = tagOf(result.ir?.body[0]);
    expect(x.name).toBe("x");
    expect(x.children.map((node) => node.kind)).toEqual(["Const"]);
  });

  it('`structural: "reject"` names the `<const>`', () => {
    expect(errors("<const/y=1>\n", { structural: "reject" })).toEqual([
      [
        "error",
        "the data tree is static; this file's consumer does not evaluate `<const>`",
        1,
        0,
        0,
      ],
    ]);
  });

  it("a closing `</const>` is a parse error", () => {
    expect(errors("<const/y=1></const>")).toEqual([
      ["error", 'The closing "const" tag was not expected', 1, 11, 11],
    ]);
  });

  // The silent drop: without `openTagOnly` both sources lowered with no
  // diagnostic and an IR that had lost the child.
  it("a child inside `<const>` is an error, never dropped silently (tag syntax)", () => {
    const result = lowerSource("<const/y=1><b/></const>", "/t.mx");
    expect(result.ir).toBeUndefined();
    expect(errors("<const/y=1><b/></const>")).toEqual([
      ["error", 'The closing "const" tag was not expected', 1, 15, 15],
    ]);
  });

  it("a child inside `<const>` is an error, never dropped silently (concise syntax)", () => {
    const result = lowerSource("const/y=1\n  a\n", "/t.mx");
    expect(result.ir).toBeUndefined();
    expect(errors("const/y=1\n  a\n")).toEqual([
      ["error", "Line has extra indentation at the beginning", 2, 2, 12],
    ]);
  });

  it("a `<return>` with no closing tag gets the reserved-name message", () => {
    expect(errors("<return value=1>\n<a/>\n")).toEqual([
      [
        "error",
        "`<return>` needs the evaluated mode: the data tree is static and has no value to return",
        1,
        0,
        0,
      ],
    ]);
  });

  it("a closing `</return>` is a parse error", () => {
    expect(errors("<return value=1></return>")).toEqual([
      ["error", 'The closing "return" tag was not expected', 1, 16, 16],
    ]);
  });

  it("a child inside a concise `return` is an error", () => {
    expect(errors("return value=1\n  a\n")).toEqual([
      ["error", "Line has extra indentation at the beginning", 2, 2, 17],
    ]);
  });

  it.each(["markup", "html"] as const)(
    "the `%s` preset agrees on a child inside `<const>`",
    (tagRules) => {
      expect(
        lowerSource("<const/y=1><b/></const>", "/t.mx", { tagRules }).ir,
      ).toBeUndefined();
      expect(
        lowerSource("const/y=1\n  a\n", "/t.mx", { tagRules }).ir,
      ).toBeUndefined();
    },
  );
});

/**
 * The web elements whose parse rules the `none` preset leaves out: measured on
 * Marko 6.3.51 (`marko-html.json`), 14 `openTagOnly` names, 4 `text` names and
 * `pre` (`preserveWhitespace` only). Under `none` each is an ordinary tag.
 */
const NATIVE_RULE_NAMES = [
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "pre",
  "script",
  "source",
  "style",
  "textarea",
  "title",
  "track",
  "wbr",
];

describe("the `none` preset (default): no native element rules", () => {
  it.each(NATIVE_RULE_NAMES)("`<%s>` accepts a child tag", (name) => {
    const result = lowerSource(`<${name}><child/></${name}>\n`, "/t.mx");
    expect(result.diagnostics).toEqual([]);
    const tag = tagOf(result.ir?.body[0]);
    expect(tag.name).toBe(name);
    expect(tag.children).toHaveLength(1);
    expect(tagOf(tag.children[0]).name).toBe("child");
  });

  it.each(["pre", "script", "style", "textarea"])(
    "`<%s>` keeps no whitespace text around a child tag",
    (name) => {
      const result = lowerSource(
        `<${name}>\n  <child/>\n</${name}>\n`,
        "/t.mx",
      );
      expect(result.diagnostics).toEqual([]);
      const tag = tagOf(result.ir?.body[0]);
      expect(tag.children).toHaveLength(1);
      expect(tagOf(tag.children[0]).name).toBe("child");
    },
  );

  it("host-owned names (`id`, `log`, `debug`, `class`) are ordinary tags", () => {
    const result = lowerSource(
      "<id=1/>\n<log=x/>\n<debug=y/>\n<class=z/>\n",
      "/t.mx",
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.body.map((node) => tagOf(node).name)).toEqual([
      "id",
      "log",
      "debug",
      "class",
    ]);
  });

  it("`markup` makes `<input>` void again", () => {
    expect(
      lowerSource("<input><child/></input>\n", "/t.mx", { tagRules: "markup" })
        .ir,
    ).toBeUndefined();
  });

  it("an unknown preset is a diagnostic, not a throw", () => {
    const result = lowerSource("<a/>", "/t.mx", {
      tagRules: "nope" as never,
    });
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.severity).toBe("error");
  });
});

describe("the returned IR", () => {
  it("trims a concise tag's span of its line terminator", () => {
    const source = "b\n  c\nd\n";
    const result = lowerSource(source, "/t.mx");
    expect(result.diagnostics).toEqual([]);
    const spans = result.ir?.body.map((node) => {
      const { sourceStart, sourceEnd } = tagOf(node).span;
      return source.slice(sourceStart, sourceEnd);
    });
    expect(spans).toEqual(["b\n  c", "d"]);
    const c = tagOf(tagOf(result.ir?.body[0]).children[0]);
    expect(source.slice(c.span.sourceStart, c.span.sourceEnd)).toBe("c");
  });

  it("trims CRLF too", () => {
    const source = "b\r\n  c\r\n";
    const b = tagOf(lowerSource(source, "/t.mx").ir?.body[0]);
    expect(source.slice(b.span.sourceStart, b.span.sourceEnd)).toBe("b\r\n  c");
  });

  it("leaves a `<tag/>` span as written", () => {
    const source = "<a x=1/>\n";
    const a = tagOf(lowerSource(source, "/t.mx").ir?.body[0]);
    expect(source.slice(a.span.sourceStart, a.span.sourceEnd)).toBe("<a x=1/>");
  });

  it("gives every `DelegatedTag` an `args` array", () => {
    const result = lowerSource("<a><b/></a>", "/t.mx");
    const a = tagOf(result.ir?.body[0]);
    expect(a.args).toEqual([]);
    expect(tagOf(a.children[0]).args).toEqual([]);
  });

  it("is a fresh copy on every call", () => {
    const first = lowerSource("<a x=1/>", "/t.mx").ir;
    const second = lowerSource("<a x=1/>", "/t.mx").ir;
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first?.body[0]).not.toBe(second?.body[0]);
  });

  it("returns no IR and every parse error on a failed parse", () => {
    const result = lowerSource("<a>\n", "/t.mx");
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.every((d) => d.severity === "error")).toBe(true);
  });
});

/**
 * The fields `SpannedIr` requires beyond `span` (Mesh review of PR 484): a
 * static attribute's `valueSpan` and an `Import`'s `from` and `names`. The
 * reads below go through the types without a cast, so a regression to
 * optional fails typecheck as well as the assertions.
 */
describe("required beyond `span`", () => {
  const slice = (
    source: string,
    span: { sourceStart: number; sourceEnd: number },
  ) => source.slice(span.sourceStart, span.sourceEnd);

  function staticValues(source: string, options?: LowerSourceOptions) {
    const result = lowerSource(source, "/t.mx", options);
    expect(result.diagnostics).toEqual([]);
    return tagOf(result.ir?.body[0]).attrs.flatMap((attr) =>
      attr.kind === "static"
        ? [[attr.name, slice(source, attr.valueSpan)]]
        : [],
    );
  }

  it("a static attribute's `valueSpan`: plain, empty, atom, default", () => {
    expect(staticValues(`<a x="s" e="" m=:strict/>`)).toEqual([
      ["x", `"s"`],
      ["e", `""`],
      ["m", ":strict"],
    ]);
    expect(staticValues(`<a="post"/>`)).toEqual([["value", `"post"`]]);
  });

  it("a static attribute's `valueSpan`: shorthand id and class", () => {
    expect(staticValues("<a#main.big/>")).toEqual([
      ["class", "big"],
      ["id", "main"],
    ]);
  });

  it("a static attribute's `valueSpan`: a member", () => {
    const memberSyntax = (
      createRequire(import.meta.url)("../syntax/member.ts") as {
        default: SyntaxModule;
      }
    ).default;
    expect(staticValues("sort asc &dueOn\n", { syntax: memberSyntax })).toEqual(
      [["member", "&dueOn"]],
    );
  });

  it("an `Import`'s `from` and `names`, `[]` for a side-effect import", () => {
    const source = [
      `import { a, b as c } from "./m"`,
      `import "./side"`,
      `import type T from "./t"`,
      "<x/>",
      "",
    ].join("\n");
    const result = lowerSource(source, "/t.mx");
    expect(result.diagnostics).toEqual([]);
    const imports = result.ir?.imports.map((node) => [
      node.from,
      node.names.map((name) => [name.imported, name.local]),
    ]);
    expect(imports).toEqual([
      [
        "./m",
        [
          ["a", "a"],
          ["b", "c"],
        ],
      ],
      ["./side", []],
      ["./t", [["default", "T"]]],
    ]);
  });

  // TODO ir-entry-contract-default-spans: a contract `default` materializes a
  // positionless attribute, which the span invariant rejects, as `parseData`
  // did (same two messages). Pinned so the limit is visible, not silent.
  it("a contract `default` is still an invariant error, as in `parseData`", () => {
    expect(
      errors("<box/>\n", {
        customTags: {
          box: {
            attributes: {
              size: { type: "string", default: "s" },
              n: { type: "number", default: 3 },
            },
          },
        },
      }).map(([, message]) => message),
    ).toEqual([
      "internal error: @mxlang/core: IR invariant broken — static attribute `size` carries no span",
      "internal error: @mxlang/core: IR invariant broken — attribute `n` carries no span",
    ]);
  });
});

describe("lowerFile", () => {
  it("reads the file and lowers it", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-lower-file-"));
    try {
      const path = join(dir, "page.mx");
      writeFileSync(path, "<a x=1/>\n");
      const result = lowerFile(path);
      expect(result.diagnostics).toEqual([]);
      expect(tagOf(result.ir?.body[0]).name).toBe("a");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when the file cannot be read", () => {
    expect(() => lowerFile("/no/such/dir/page.mx")).toThrow(/ENOENT/);
  });
});

describe("IR_VERSION", () => {
  // A dialect asserts it; a change to it is a change to every dialect's pin.
  it("is exported from core's entry as 1", () => {
    expect(core.IR_VERSION).toBe(1);
  });
});
