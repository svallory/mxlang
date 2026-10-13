/**
 * Every `MX_INVALID_TAG_VAR` raised at a call blames the variable, not the
 * tag: the `/var` is what cannot bind. Two raises used to point at the start
 * of the tag, with no end, while the "declares no `<return>`" raise beside them
 * already underlined the variable:
 *
 * - a `/var` on a tag with no template (an L2 sidecar): "it has no template,
 *   so it has no `<return>` to bind";
 * - a `/var` on an imported `.mx` unit MX cannot read (missing, or does not
 *   compile): "`/n` on `<B>` can't bind: …".
 *
 * Both go through `compileSource` and the `ir-entry` `lowerSource`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import type { CustomTag } from "./custom-tags.ts";
import type { Policy } from "./declarations.ts";
import { lowerSource } from "./ir-entry/index.ts";
import { lookup } from "./test-targets.ts";

const dir = mkdtempSync(join(tmpdir(), "mx-tag-var-siblings-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PAGE = join(dir, "page.mx");
writeFileSync(join(dir, "broken.mx"), "<if=>\n");
writeFileSync(join(dir, "returns.mx"), "<b>x</b>\n<return value=1/>\n");

/** A tag with a `transform` and no template: nothing to read a `<return>` from. */
const sidecar: CustomTag = {
  transform: (call) => call.content?.children ?? [],
};

const policy: Policy = {
  tags: {},
  isElement: () => true,
  isComponent: (name) => /^[A-Z]/.test(name),
};

interface Position {
  line: number;
  column: number;
}
interface Failure extends Position {
  message: string;
  code: string | undefined;
  end: Position | undefined;
}

function compile(source: string): Failure | undefined {
  try {
    compileSource(source, PAGE, policy, {
      targets: lookup,
      tagDiscoveryDirs: [],
      customTags: { box: sidecar },
      emitIr: () => "",
    });
  } catch (caught) {
    const error = caught as {
      message: string;
      diagnosticCode?: string;
      line: number;
      column: number;
      end?: Position;
    };
    return {
      message: error.message,
      code: error.diagnosticCode,
      line: error.line,
      column: error.column,
      end: error.end,
    };
  }
  return undefined;
}

function lower(source: string): Failure | undefined {
  const { diagnostics } = lowerSource(source, PAGE, {
    customTags: { box: sidecar },
    structural: "pass",
  });
  const [first] = diagnostics;
  if (!first) return undefined;
  expect(diagnostics).toHaveLength(1);
  return {
    message: first.message,
    code: first.code,
    line: first.line,
    column: first.column,
    end: first.end && { line: first.end.line, column: first.end.column },
  };
}

const NO_TEMPLATE =
  "`/var` on `<box>` is not supported: it has no template, so it has no `<return>` to bind";

/** [label, source, line, column, endLine, endColumn] */
type Row = [string, string, number, number, number, number];

const SIDECAR_ROWS: Row[] = [
  ["plain", "<box/x/>\n", 1, 5, 1, 6],
  ["shorthand", "<box.cls#id/x/>\n", 1, 12, 1, 13],
  ["type arguments", "<box<string>/x/>\n", 1, 13, 1, 14],
  ["a nested call", "<div>\n  <box/n a=1\n    b=2/>\n</div>\n", 2, 7, 2, 8],
  ["a multi-line destructuring", "<box/{\n  a,\n  b,\n}/>\n", 1, 5, 4, 1],
  ["a body", "<box/x a=1>hi</box>\n", 1, 5, 1, 6],
];

describe("/var on a tag with no template blames the variable", () => {
  it.each(SIDECAR_ROWS)("compile: %s", (_label, source, l, c, el, ec) => {
    expect(compile(source)).toEqual({
      message: NO_TEMPLATE,
      code: "MX_INVALID_TAG_VAR",
      line: l,
      column: c,
      end: { line: el, column: ec },
    });
  });

  it.each(SIDECAR_ROWS)("lowerSource: %s", (_label, source, l, c, el, ec) => {
    expect(lower(source)).toEqual({
      message: NO_TEMPLATE,
      code: "MX_INVALID_TAG_VAR",
      line: l,
      column: c,
      end: { line: el, column: ec },
    });
  });

  it("compiles the same call without a tag variable (control)", () => {
    expect(compile("<box/>\n")).toBeUndefined();
    expect(lower("<box/>\n")).toBeUndefined();
  });
});

const IMPORTED = (tag: string, call: string): string =>
  `import ${tag} from "./missing.mx"\n${call}\n`;
const BROKEN = (tag: string, call: string): string =>
  `import ${tag} from "./broken.mx"\n${call}\n`;

/** [label, source, tag, variable, line, column, endLine, endColumn] */
type ImportRow = [
  string,
  string,
  string,
  string,
  number,
  number,
  number,
  number,
];

const IMPORT_ROWS: ImportRow[] = [
  ["plain", IMPORTED("M", "<M/n/>"), "M", "n", 2, 3, 2, 4],
  ["shorthand", IMPORTED("M", "<M.cls#id/n/>"), "M", "n", 2, 10, 2, 11],
  ["type arguments", IMPORTED("M", "<M<string>/n/>"), "M", "n", 2, 11, 2, 12],
  [
    "a multi-line destructuring",
    IMPORTED("M", "<M/{\n  a,\n  b,\n}/>"),
    "M",
    "{ a, b }",
    2,
    3,
    5,
    1,
  ],
  [
    "a nested call",
    IMPORTED("M", "<div>\n  <M/n a=1\n    b=2/>\n</div>"),
    "M",
    "n",
    3,
    5,
    3,
    6,
  ],
  ["a unit that does not compile", BROKEN("B", "<B/n/>"), "B", "n", 2, 3, 2, 4],
];

describe("/var on an imported unit MX cannot read blames the variable", () => {
  it.each(IMPORT_ROWS)(
    "compile: %s",
    (_label, source, tag, _name, l, c, el, ec) => {
      const failure = compile(source);
      expect(failure?.code).toBe("MX_INVALID_TAG_VAR");
      expect(failure?.message).toContain(`on \`<${tag}>\` can't bind: `);
      expect(failure).toMatchObject({
        line: l,
        column: c,
        end: { line: el, column: ec },
      });
    },
  );

  // The data path refuses any call of a template tag before it gets to the
  // `/var`, so an unreadable import never reaches this raise there: the
  // refusal is the data-file one, at the tag. Pinned so a change to that
  // ordering shows up here.
  it("lowerSource: the data path refuses the call of a template tag first", () => {
    const failure = lower(IMPORTED("M", "<M/n/>"));
    expect(failure).toMatchObject({
      code: "MX_NOT_IN_DATA_FILE",
      line: 2,
      column: 0,
    });
  });

  it("names the cause: missing, and does not compile", () => {
    expect(compile(IMPORTED("M", "<M/n/>"))?.message).toMatch(
      /^`\/n` on `<M>` can't bind: .*missing\.mx could not be resolved$/,
    );
    expect(compile(BROKEN("B", "<B/n/>"))?.message).toMatch(
      /^`\/n` on `<B>` can't bind: .*broken\.mx does not compile/,
    );
  });

  it("compiles a readable unit that returns, with a tag variable (control)", () => {
    const source = 'import R from "./returns.mx"\n<R/n/>\n';
    expect(compile(source)).toBeUndefined();
  });
});
