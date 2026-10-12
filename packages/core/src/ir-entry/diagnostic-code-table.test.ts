// biome-ignore-all lint/suspicious/noTemplateCurlyInString: sources contain `${`
/**
 * One row per diagnostic code in the catalogue (`MX_DIAGNOSTIC_CODES`): a
 * small source (or setup) that makes the code appear, and the position its
 * diagnostic starts at. Positions only: no message text is asserted here (the
 * wording is pinned in `diagnostic-codes.test.ts`).
 *
 * Most rows go through `lowerSource`. A code `lowerSource` cannot reach is
 * asserted through the API that reports it: `compileSource` (the lowering
 * shape rules, which the default dialect's data-file refusal pre-empts in
 * `lowerSource`, and the host-declared rules), `scanCustomTags` (the scan's
 * own diagnostics), or the function that raises it. The codes no input
 * reaches are listed in `UNREACHABLE` with the reason.
 *
 * The catalogue-equality test keeps the three in step: every catalogue code
 * has a row or an `UNREACHABLE` entry, and neither names a code the
 * catalogue lacks.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rewriteReadsInCode } from "../accessor-reads.ts";
import { compileSource, type HostOptions } from "../compile.ts";
import type { CustomTag } from "../custom-tags.ts";
import type { Policy } from "../declarations.ts";
import { MX_DIAGNOSTIC_CODES } from "../diagnostic-codes.ts";
import { MEMBER } from "../fixtures/syntax/member-fixture.ts";
import { parseFragment } from "../fragment.ts";
import { scanCustomTags } from "../scan.ts";
import { scanCached } from "../scan-cache.ts";
import { dialectProject } from "../test-dialect-project.ts";
import { testTargetLookup } from "../test-targets.ts";
import { type LowerSourceOptions, lowerSource } from "./index.ts";

const targets = testTargetLookup();

/** One diagnostic as a row sees it, whichever API reported it. */
interface Found {
  code: string | undefined;
  /** Absent on a scan diagnostic that states none. */
  severity: string | undefined;
  line: number;
  column: number;
}

interface Env {
  /** A new empty real directory under the test root. */
  fresh(): string;
}

interface Row {
  code: string;
  line: number;
  column: number;
  /** The API the row goes through, for the test title. */
  via: string;
  run(env: Env): Found[];
}

let root = "";
const env: Env = {
  fresh() {
    return realpathSync(mkdtempSync(join(root, "d-")));
  },
};
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "mx-code-table-")));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(dir: string, path: string, text: string): string {
  const file = join(dir, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
  return file;
}

// --- Readers: each API's diagnostics as `Found` -------------------------

function ofLower(
  source: string,
  filename: string,
  options?: LowerSourceOptions,
): Found[] {
  return lowerSource(source, filename, options).diagnostics.map((d) => ({
    code: d.code,
    severity: d.severity,
    line: d.line,
    column: d.column,
  }));
}

/** A thrown error (or the several a compile throws together) as `Found`. */
function ofThrown(cause: unknown): Found[] {
  const error = cause as {
    errors?: { diagnosticCode?: string; line: number; column: number }[];
    diagnosticCode?: string;
    line: number;
    column: number;
  };
  const all = error.errors?.length ? error.errors : [error];
  return all.map((e) => ({
    code: e.diagnosticCode,
    severity: "error",
    line: e.line,
    column: e.column,
  }));
}

const DECLARATIONS: Record<string, unknown> = {
  tags: {},
  isElement: () => true,
  isComponent: (name: string, ctx: { defines: Set<string> }) =>
    ctx.defines.has(name),
};

function ofCompile(
  source: string,
  filename: string,
  declarations: Record<string, unknown> = {},
  host: Record<string, unknown> = {},
): Found[] {
  const warnings: { code?: string; line: number; column: number }[] = [];
  const found: Found[] = [];
  try {
    compileSource(
      source,
      filename,
      { ...DECLARATIONS, ...declarations } as unknown as Policy,
      {
        targets,
        customTags: {},
        tagDiscoveryDirs: [],
        emitIr: () => "",
        warnings,
        ...host,
      } as unknown as HostOptions,
    );
  } catch (cause) {
    found.push(...ofThrown(cause));
  }
  for (const w of warnings) {
    found.push({
      code: w.code,
      severity: "warning",
      line: w.line,
      column: w.column,
    });
  }
  return found;
}

function ofScan(file: string): Found[] {
  try {
    return scanCustomTags(file, { targets }).diagnostics.map((d) => ({
      code: d.code,
      severity: d.severity,
      line: d.line,
      column: d.column,
    }));
  } catch (cause) {
    return ofThrown(cause);
  }
}

// --- Row builders --------------------------------------------------------

/** `lowerSource(source, <dir>/page.mx, options)`. */
function lowerRow(
  code: string,
  source: string,
  line: number,
  column: number,
  options?: LowerSourceOptions,
): Row {
  return {
    code,
    line,
    column,
    via: "lowerSource",
    run: (e) => ofLower(source, join(e.fresh(), "page.mx"), options),
  };
}

/** `compileSource` with host declarations and host options over the test defaults. */
function compileRow(
  code: string,
  source: string,
  line: number,
  column: number,
  declarations: Record<string, unknown> = {},
  host: Record<string, unknown> = {},
): Row {
  return {
    code,
    line,
    column,
    via: "compileSource",
    run: (e) =>
      ofCompile(source, join(e.fresh(), "page.mx"), declarations, host),
  };
}

/** `compileSource` of a file next to callee files written into its directory. */
function calleeRow(
  code: string,
  files: Record<string, string>,
  source: string,
  line: number,
  column: number,
): Row {
  return {
    code,
    line,
    column,
    via: "compileSource",
    run: (e) => {
      const dir = e.fresh();
      for (const [name, text] of Object.entries(files)) write(dir, name, text);
      return ofCompile(source, join(dir, "page.mx"), ATTR_TAGS);
    },
  };
}

/** A row whose setup and reading are its own. */
function callRow(
  code: string,
  line: number,
  column: number,
  via: string,
  run: (env: Env) => Found[],
): Row {
  return { code, line, column, via, run };
}

// --- Fixtures ------------------------------------------------------------

/** A host that takes attribute tags (the `AttrTag` Input), so the callee rules apply. */
const ATTR_TAGS = { attrTags: 2, name: "TestHost" };

const CARD = `export interface Input {
  head: AttrTag<{ as: "renderable" }>
  opt?: AttrTag
  many?: AttrTag[]
  title?: string
}
<div/>
`;
const BAD_CALLEE =
  "export interface Input { x?: AttrTag<{ as: string }> }\n<div/>\n";
const CARD_IMPORT = "import Card from './Card.mx'\n";

/** Contracts for the contract-rule rows. */
const CONTRACTS = {
  card: {
    attributes: {
      title: { type: "string", required: true },
      n: { type: "number" },
      mode: { enum: ["a", "b"] },
    },
    children: { item: { required: true }, hdr: {} },
  },
  item: { attributes: { v: { type: "string", literalOnly: true } } },
  hdr: { parents: ["card"] },
  leaf: { children: {} },
  wild: { children: { "*": { pattern: "^x-.*$" }, itemx: {} } },
  closed: { children: { item: {} } },
} as unknown as Record<string, CustomTag>;

/** A table with block tags and filters, and no lowering for either. */
const BLOCK_TABLE = {
  blockTag: { open: "{%", close: "%}" },
  filter: { open: "::", close: "::" },
};

const MEMBER_TABLE = {
  expressionTriggers: [MEMBER],
  attributeTriggers: [MEMBER],
  lineTriggers: [MEMBER],
};

/** A dialect with no triggers and the given `afterLower`. */
const afterLower = (hook: (unit: never) => void): LowerSourceOptions => ({
  dialect: { id: "t", name: "MX", table: {}, afterLower: hook } as never,
});

/**
 * The kit test dialect's module: it reads a tag file's contract from a leading
 * `<!-- {json} -->` comment and forwards the diagnostics of lowering the file.
 */
const KIT_HOOK = String.raw`export default {
  table: {},
  tagFile(file, ctx) {
    const lowered = ctx.lower();
    const head = /^<!--([\s\S]*?)-->/.exec(file.source);
    return {
      contract: head ? JSON.parse(head[1]) : {},
      diagnostics: lowered.diagnostics.map((x) => ({
        severity: x.severity,
        message: x.message,
        line: x.line,
        column: x.column,
        ...(x.code ? { code: x.code } : {}),
        ...(x.file ? { file: x.file } : {}),
      })),
    };
  },
};`;

/** A project using the `kit` dialect (`.kit.mx`, tags in `concepts/` and `components/`). */
function kitProject(
  dir: string,
  options: { hook?: boolean; manifest?: Record<string, unknown> } = {},
): void {
  dialectProject(dir, {
    packageName: "kit-dialect",
    manifest: {
      id: "kit",
      name: "Kit",
      extensions: [".kit.mx"],
      tagDirs: ["concepts", "components"],
      ...options.manifest,
    },
    module: options.hook ? KIT_HOOK : "export default { table: {} };",
  });
}

/** The scan's custom tags, lowered against: a `.kit.mx` page in `dir`. */
function lowerKit(dir: string, source: string): Found[] {
  const file = join(dir, "page.kit.mx");
  const { customTags } = scanCached(file, { targets });
  return ofLower(source, file, { customTags });
}

/** A scan row over a kit project: `setup` writes the files, the page is `page`. */
function kitScanRow(
  code: string,
  line: number,
  column: number,
  setup: (dir: string) => void,
  page = "page.kit.mx",
  manifest?: Record<string, unknown>,
): Row {
  return callRow(code, line, column, "scanCustomTags", (e) => {
    const dir = e.fresh();
    kitProject(dir, { manifest });
    setup(dir);
    return ofScan(join(dir, page));
  });
}

/** A lowering row over a kit project with the hook. */
function kitLowerRow(
  code: string,
  line: number,
  column: number,
  setup: (dir: string) => void,
  source: string,
  hook = true,
): Row {
  return callRow(code, line, column, "lowerSource", (e) => {
    const dir = e.fresh();
    kitProject(dir, { hook });
    setup(dir);
    return lowerKit(dir, source);
  });
}

/** A lowering row over a test dialect project (`.tst`) the setup writes. */
function dialectRow(
  code: string,
  line: number,
  column: number,
  setup: (dir: string) => void,
): Row {
  return callRow(code, line, column, "lowerSource", (e) => {
    const dir = e.fresh();
    setup(dir);
    return ofLower("<div/>\n", join(dir, "page.tst"));
  });
}

// --- The table -----------------------------------------------------------

const ROWS: Row[] = [
  // Parse errors of the template parser, through the front end's mapping.
  lowerRow("MX_PARSE_MISMATCHED_CLOSING_TAG", "<div></span>\n", 1, 5),
  lowerRow("MX_PARSE_MISSING_END_TAG", "<x>\n", 1, 0),
  lowerRow("MX_PARSE_EXTRA_CLOSING_TAG", "</x>\n", 1, 0),
  lowerRow("MX_PARSE_MALFORMED_OPEN_TAG", "<x\n", 1, 0),
  lowerRow("MX_PARSE_EXPRESSION", "<x a=(1 +)/>\n", 1, 9),
  lowerRow("MX_PARSE_INVALID_TAG_PARAMS", "<x|a b|/>\n", 1, 5),
  lowerRow("MX_PARSE_INVALID_EXPRESSION", "<div a=(]>", 1, 7),
  lowerRow("MX_PARSE_MALFORMED_PLACEHOLDER", "<div a=`${}`/>", 1, 10),
  lowerRow("MX_PARSE_INVALID_REGULAR_EXPRESSION", "<div a=/abc", 1, 7),
  lowerRow("MX_PARSE_INVALID_ATTR_TYPE_PARAMS", "<div a<T>=1/>\n", 1, 7),
  lowerRow(
    "MX_PARSE_AMBIGUOUS_ATTRIBUTE_VALUE",
    "<if=count > 10 && flag />",
    1,
    4,
  ),
  lowerRow(
    "MX_PARSE_INVALID_TEMPLATE_STRING",
    "<hello message=`Hello\n    ${foo}!></hello>",
    1,
    15,
  ),
  lowerRow("MX_PARSE_MALFORMED_CDATA", "<![CDATA[oops", 1, 0),
  lowerRow(
    "MX_PARSE_INVALID_HTML_COMMENT",
    '<div hidden <!-- the label --> id="b">hi</div>',
    1,
    12,
  ),
  lowerRow("MX_PARSE_MALFORMED_COMMENT", "b selected something test=/*", 1, 26),
  lowerRow("MX_PARSE_INVALID_ATTRIBUTE_NAME", "<foo(a){}<A>/>\n", 1, 9),
  lowerRow("MX_PARSE_MISSING_TAG_VARIABLE", "<foo/, x=1/>\n", 1, 5),
  lowerRow("MX_PARSE_INVALID_STRING", '<a href="', 1, 8),
  lowerRow(
    "MX_PARSE_INVALID_TAG_ARGUMENT",
    "<for(var i = 0; i < 10; i++) (nonsense!)></for>",
    1,
    29,
  ),
  lowerRow(
    "MX_PARSE_INVALID_ATTRIBUTE_ARGUMENT",
    "<div for(var i = 0; i < 10; i++) (nonsense!)></div>",
    1,
    34,
  ),
  lowerRow("MX_PARSE_MALFORMED_DOCUMENT_TYPE", "<!DOCTYPE html PUBLIC", 1, 0),
  lowerRow("MX_PARSE_INVALID_TAG_TYPES", "<foo <A>>\n  hi\n</>\n", 1, 6),
  lowerRow("MX_PARSE_INVALID_CODE_AFTER_SEMICOLON", "div; /x", 1, 5),
  lowerRow("MX_PARSE_INVALID_CHARACTER", "--\nA\n---\nB\n--", 3, 2),
  lowerRow(
    "MX_PARSE_INVALID_INDENTATION",
    "p\n    <b>Hello</b>\n        BAD",
    3,
    8,
  ),
  lowerRow("MX_PARSE_INVALID_LINE_START", "- foo", 1, 0),
  lowerRow("MX_PARSE_ROOT_TAG_ONLY", "div\n  static const x = 1\n", 2, 2),
  lowerRow("MX_PARSE_INVALID_TAG_SHORTHAND", "#foo#bar", 1, 4),
  lowerRow("MX_PARSE_INVALID_ATTRIBUTE_VALUE", "<span class=>\n", 1, 12),
  lowerRow("MX_PARSE_MALFORMED_DECLARATION", '<?xml version="1.0"', 1, 0),
  lowerRow("MX_PARSE_MALFORMED_CLOSE_TAG", "<div></div", 1, 5),

  // The front end's own rules.
  lowerRow("MX_ATTRIBUTE_TAG_AT_ROOT", "<@foo/>\n", 1, 1),
  lowerRow("MX_TAG_NAME_MISSING", ",\n", 1, 0),
  lowerRow("MX_EXPECTED_SINGLE_EXPRESSION", "<x b=${1 2}/>\n", 1, 6),
  lowerRow("MX_RESERVED_TAG_NAME", "<% x %>\n", 1, 1),
  lowerRow("MX_STATEMENT_IN_HTML_MODE", "<static const x = 1/>\n", 1, 1),
  lowerRow("MX_INPUT_ENDS_IN_DELIMITER", "div(a\n", 1, 3),
  lowerRow(
    "MX_UNESCAPED_PLACEHOLDER_IN_ATTRIBUTE_VALUE",
    "<x a=$!{y}/>\n",
    1,
    7,
  ),

  // Registration and the contract rules.
  lowerRow("MX_UNKNOWN_TAG", "<p>\n  <opem/>\n</p>\n", 2, 2, {
    customTags: { open: {}, p: {} },
    unknownTags: "reject",
  }),
  lowerRow(
    "MX_UNKNOWN_ATTRIBUTE",
    "<card title='a' bogus=1>\n  <item/>\n</card>\n",
    1,
    16,
    { customTags: CONTRACTS },
  ),
  lowerRow("MX_MISSING_ATTRIBUTE", "<card>\n  <item/>\n</card>\n", 1, 0, {
    customTags: CONTRACTS,
  }),
  lowerRow(
    "MX_INVALID_ATTRIBUTE_VALUE",
    "<card title='a' n='x'>\n  <item/>\n</card>\n",
    1,
    16,
    { customTags: CONTRACTS },
  ),
  lowerRow("MX_TAG_NOT_ALLOWED", "<leaf>\n  <item/>\n</leaf>\n", 2, 2, {
    customTags: CONTRACTS,
  }),
  lowerRow("MX_PARENT_NOT_ALLOWED", "<div>\n  <hdr/>\n</div>\n", 2, 2, {
    customTags: CONTRACTS,
  }),
  lowerRow(
    "MX_REPEATED_CHILD",
    "<card title='a'>\n  <item/>\n  <item/>\n</card>\n",
    3,
    2,
    { customTags: CONTRACTS },
  ),
  lowerRow("MX_MISSING_CHILD", "<card title='a'>\n  <hdr/>\n</card>\n", 1, 0, {
    customTags: CONTRACTS,
  }),
  lowerRow("MX_UNCHECKABLE_CHILD", "<leaf>\n  <${x}/>\n</leaf>\n", 2, 2, {
    customTags: CONTRACTS,
  }),
  lowerRow("MX_NEAR_EXPLICIT_CHILD", "<wild>\n  <x-itemx/>\n</wild>\n", 2, 2, {
    customTags: CONTRACTS,
  }),
  lowerRow("MX_CONTENT_NOT_ALLOWED", "stub\n  x\n", 1, 0, {
    customTags: { stub: { parseOptions: { openTagOnly: true } } },
  }),
  lowerRow("MX_TEXT_NOT_ALLOWED", "<closed>\n  hi\n</closed>\n", 2, 2, {
    customTags: CONTRACTS,
  }),
  lowerRow(
    "MX_STRUCTURAL_CONSTRUCT",
    "<x>\n  <if=1>\n    <y/>\n  </if>\n</x>\n",
    2,
    2,
    { structural: "reject" },
  ),
  lowerRow("MX_NOT_IN_DATA_FILE", "<define/f>\n  x\n</define>\n", 1, 0),
  lowerRow("MX_RESERVED_TAG", "<if=1>\n  x\n</if>\n", 1, 0, {
    customTags: { if: {} },
  }),
  lowerRow("MX_INVALID_CONTRACT", "<x/>\n", 1, 0, {
    customTags: { x: { children: { inner: {} }, bogus: 1 } as never },
  }),

  // Lowering rules reachable through lowerSource.
  lowerRow("MX_RESERVED_BINDING", "<const/__mx=1/>\n", 1, 7),
  lowerRow(
    "MX_UNSUPPORTED_MARKO_FILE",
    "import X from './a.marko'\n<X/>\n",
    2,
    0,
  ),
  lowerRow("MX_DUPLICATE_ATTRIBUTE", "<x a=1 a=2/>\n", 1, 3),
  lowerRow("MX_INVALID_IF", "<if>\n  x\n</if>\n", 1, 0),
  lowerRow("MX_INVALID_FOR", "<for>\n  x\n</for>\n", 1, 0),
  lowerRow("MX_INVALID_CONST", "<const>\n", 1, 0),
  lowerRow("MX_INVALID_ATTRIBUTE", "<const/x=1 y=2/>\n", 1, 1),
  lowerRow("MX_INVALID_BOUND_ATTRIBUTE", "<x a:=1/>\n", 1, 6),
  lowerRow("MX_INVALID_SHORTHAND", "<div.1/>\n", 1, 5),
  lowerRow(
    "MX_INVALID_TAG_CALL",
    'export interface Input { data?: AttrTag<{ as: "data" }> }\n<${input.data}/>\n',
    2,
    1,
  ),

  // Dialect hooks, through the `dialect` option.
  // A template parse error under a dialect's table keeps the parser's code.
  lowerRow("MX_PARSE_MALFORMED_BLOCK_TAG", "<p>{% x", 1, 3, {
    dialect: { id: "t", name: "MX", table: BLOCK_TABLE } as never,
  }),
  lowerRow("MX_PARSE_MALFORMED_FILTER", "<p>::md::x", 1, 3, {
    dialect: { id: "t", name: "MX", table: BLOCK_TABLE } as never,
  }),
  lowerRow("MX_NO_LOWERING", "rule x=&a\n", 1, 7, {
    dialect: { id: "t", name: "MX", table: MEMBER_TABLE } as never,
  }),
  lowerRow("MX_INVALID_TRIGGER_USE", "rule x=((&a) => 1)\n", 1, 9, {
    dialect: {
      id: "t",
      name: "MX",
      table: MEMBER_TABLE,
      // A member in an expression, as the fixture dialect lowers it.
      lowerTrigger: (_id: string, text: string, span: unknown, ctx: never) =>
        (ctx as { attribute: (n: string, v: unknown) => unknown }).attribute(
          "member",
          { kind: "member", name: text.slice(1), span },
        ),
    } as never,
  }),
  lowerRow("MX_DIALECT_ERROR", "<x/>\n<y/>\n", 2, 0, {
    ...afterLower(((unit: { fail: (message: string, at: object) => void }) =>
      unit.fail("nope", { at: { sourceStart: 5, sourceEnd: 6 } })) as never),
  }),
  lowerRow("MX_DIALECT_HOOK_ERROR", "rule x=&a\n", 1, 7, {
    dialect: {
      id: "t",
      name: "MX",
      table: MEMBER_TABLE,
      lowerTrigger: () => {
        throw new Error("boom");
      },
    } as never,
  }),
  lowerRow("MX_DIALECT_WARNING", "<x/>\n<y/>\n", 2, 0, {
    ...afterLower(((unit: { warn: (message: string, at: object) => void }) =>
      unit.warn("w", { sourceStart: 5, sourceEnd: 6 })) as never),
  }),
  // Suspicious: an `afterLower` that throws is MX_INTERNAL_ERROR at 1:0, where
  // a `lowerTrigger` that throws is MX_DIALECT_HOOK_ERROR at the trigger.
  lowerRow("MX_INTERNAL_ERROR", "<x/>\n", 1, 0, {
    ...afterLower((() => {
      throw new Error("boom");
    }) as never),
  }),
  lowerRow("MX_TAG_ERROR", "<x/>\n", 1, 0, {
    customTags: {
      x: {
        transform: (_call: unknown, ctx: { fail: (m: string) => never }) =>
          ctx.fail("bad"),
      } as never,
    },
  }),
  lowerRow("MX_TAG_HOOK_ERROR", "<x/>\n", 1, 0, {
    customTags: {
      x: {
        transform: () => {
          throw new Error("boom");
        },
      } as never,
    },
  }),

  // The compile path: lowering rules `lowerSource` pre-empts with
  // MX_NOT_IN_DATA_FILE, and the host-declared rules.
  compileRow("MX_INVALID_DEFINE", "<define/>\n", 1, 0),
  compileRow("MX_INVALID_RETURN", "<return value=1>\n  x\n</return>\n", 1, 0),
  compileRow("MX_INVALID_TRY", "<try>\n  x\n</try>\n", 1, 0),
  compileRow("MX_UNBOUND_COMPONENT", "<Foo/>\n", 1, 0),
  compileRow(
    "MX_DUPLICATE_VALUE_ATTRIBUTE",
    "<return value=1 value=2/>\n",
    1,
    16,
  ),
  compileRow(
    "MX_UNSUPPORTED_TAG_ARGUMENTS",
    "<define/Foo|a|>\n</define>\n<Foo(x) a=1/>\n",
    3,
    1,
  ),
  compileRow("MX_INVALID_TAG_NAME", "<foo~bar/>\n", 1, 1),
  compileRow("MX_UNSUPPORTED_CONSTRUCT", "<div(1) a=1/>\n", 1, 5),
  compileRow(
    "MX_NOT_A_DOM_EVENT",
    "<button onDoubleClick=f>x</button>\n",
    1,
    8,
  ),
  compileRow(
    "MX_DEFINE_EXTRA_PARAMS",
    '<define/Card|title, head|><div>${title}</div></define>\n<Card title="a"/>\n',
    2,
    1,
    { defineCallPassesAttrs: true },
  ),
  compileRow(
    "MX_LOWERCASE_BINDING_NOT_CALLED",
    "<define/section|x|>d</define>\n<div>\n  <section/>\n</div>\n",
    3,
    2,
  ),
  compileRow("MX_INERT_TAG_SHAPE", "<mytag>\n  hi\n</mytag>\n", 1, 0, {
    tags: { mytag: { kind: "inert", reason: "inert", body: "none" } },
  }),
  compileRow(
    "MX_INVALID_STATEMENT",
    "import { x } from 'y'\nexport { x }\n",
    2,
    9,
  ),

  // Callee `Input` rules (the callee is a file next to the caller).
  calleeRow(
    "MX_MISSING_ATTRIBUTE_TAG",
    { "Card.mx": CARD },
    `${CARD_IMPORT}<Card/>\n`,
    2,
    1,
  ),
  calleeRow(
    "MX_UNKNOWN_ATTRIBUTE_TAG",
    { "Card.mx": CARD },
    `${CARD_IMPORT}<Card>\n  <@head>H</@head>\n  <@nope/>\n</Card>\n`,
    4,
    3,
  ),
  calleeRow(
    "MX_REPEATED_ATTRIBUTE_TAG",
    { "Card.mx": CARD },
    `${CARD_IMPORT}<Card>\n  <@head>H</@head>\n  <@head>I</@head>\n</Card>\n`,
    4,
    4,
  ),
  calleeRow(
    "MX_INVALID_ATTRIBUTE_TAG",
    { "Card.mx": CARD },
    `${CARD_IMPORT}<Card title='x'>\n  <@head>H</@head>\n  <@title>t</@title>\n</Card>\n`,
    4,
    3,
  ),
  calleeRow(
    "MX_INVALID_CALLEE_INPUT",
    { "Bad.mx": BAD_CALLEE },
    "import Bad from './Bad.mx'\n<Bad>\n  <@x/>\n</Bad>\n",
    3,
    4,
  ),
  calleeRow(
    "MX_UNREADABLE_CALLEE_INPUT",
    {},
    "import X from './Missing.mx'\n<X>\n  <@x/>\n</X>\n",
    2,
    1,
  ),

  // A template tag (a custom tag with a template) called with what it drops or reserves.
  ...[
    ["MX_BODY_DROPPED", "<panel>\n  hi\n</panel>\n", 1, 0],
    ["MX_ATTRIBUTE_TAG_DROPPED", "<panel>\n  <@x>hi</@x>\n</panel>\n", 1, 0],
    ["MX_RESERVED_INPUT", "<panel content=1/>\n", 1, 7],
    ["MX_INVALID_TAG_VAR", "<panel/v/>\n", 1, 0],
  ].map(([code, source, line, column]) =>
    callRow(
      code as string,
      line as number,
      column as number,
      "compileSource",
      (e) => {
        const dir = e.fresh();
        return ofCompile(source as string, join(dir, "page.mx"), ATTR_TAGS, {
          customTags: {
            panel: {
              template: {
                filename: join(dir, "tags", "panel.mx"),
                source: "<div/>\n",
              },
            },
          },
        });
      },
    ),
  ),

  // Dialect packages: the manifest, the module and the project's config.
  dialectRow("MX_INVALID_DIALECT_MANIFEST", 11, 6, (dir) =>
    dialectProject(dir, {
      manifest: { targets: [] },
      module: "export default { table: {} };",
    }),
  ),
  dialectRow("MX_DIALECT_CONFLICT", 5, 4, (dir) => {
    for (const id of ["a", "b"]) {
      dialectProject(dir, {
        packageName: `${id}-dialect`,
        manifest: { id },
        module: "export default { table: {} };",
      });
    }
  }),
  dialectRow("MX_MODULE_LOAD_FAILED", 1, 0, (dir) =>
    dialectProject(dir, { module: 'throw new Error("reached");' }),
  ),
  dialectRow("MX_INVALID_DIALECT_MODULE", 1, 0, (dir) =>
    dialectProject(dir, { module: "export default { table: { foo: 1 } };" }),
  ),
  dialectRow("MX_INVALID_DIALECT_CONTRACT", 1, 41, (dir) =>
    dialectProject(dir, {
      module:
        "export default { table: {}, contracts: { card: { bogus: 1 } } };",
    }),
  ),
  dialectRow("MX_INVALID_CONFIG", 7, 4, (dir) =>
    dialectProject(dir, {
      module: "export default { table: {} };",
      mx: { syntax: "x" },
    }),
  ),

  // Tag discovery: the scan's diagnostics and the tag-file hook.
  kitScanRow(
    "MX_INVALID_TAG_FILE_NAME",
    1,
    0,
    (dir) => void write(dir, "components/-bad.kit.mx", "<div/>\n"),
  ),
  kitScanRow(
    "MX_MISPLACED_TAG_FILE",
    1,
    0,
    (dir) => void write(dir, "tags/button.kit.mx", "<div/>\n"),
    "page.mx",
  ),
  kitScanRow(
    "MX_DOTTED_TAG_FILE_NAME",
    1,
    0,
    (dir) => void write(dir, "components/money.component.kit.mx", "<div/>\n"),
  ),
  kitScanRow(
    "MX_SIDECAR_IGNORED",
    1,
    0,
    (dir) => void write(dir, "components/x.tag.ts", "export default {};\n"),
    "page.kit.mx",
    { sidecars: false },
  ),
  callRow("MX_IGNORED_CONFIG", 1, 0, "scanCustomTags", (e) => {
    const dir = e.fresh();
    write(dir, "package.json", "{");
    write(dir, "tags/x.mx", "<div/>\n");
    return ofScan(join(dir, "page.mx"));
  }),
  callRow("MX_INVALID_PARSE_OPTIONS", 1, 17, "scanCustomTags", (e) => {
    const dir = e.fresh();
    write(dir, "package.json", "{}");
    write(
      dir,
      "tags/x.tag.ts",
      'export default { parseOptions: { text: "yes" } };',
    );
    return ofScan(join(dir, "page.mx"));
  }),
  callRow("MX_SHADOWED_CONTRACT", 1, 0, "scanCustomTags", (e) => {
    const dir = e.fresh();
    write(
      dir,
      "package.json",
      JSON.stringify({ mx: { contracts: ["./a.ts", "./b.ts"] } }),
    );
    write(dir, "a.ts", "export default { box: {} };");
    write(dir, "b.ts", "export default { box: {} };");
    return ofScan(join(dir, "page.mx"));
  }),
  kitLowerRow(
    "MX_TAG_FILE_ERROR",
    2,
    2,
    (dir) => void write(dir, "components/money.kit.mx", "<div/>\n"),
    "<div>\n  <money/>\n</div>\n",
    false,
  ),
  kitLowerRow(
    "MX_TAG_FILE_CYCLE",
    2,
    2,
    (dir) => {
      write(dir, "concepts/a.kit.mx", "<b/>\n");
      write(dir, "concepts/b.kit.mx", "<div>\n  <a/>\n</div>\n");
    },
    "<a/>\n",
  ),
  kitLowerRow(
    "MX_INVALID_DEFAULT_TAG",
    1,
    0,
    (dir) =>
      void write(
        dir,
        "concepts/money.kit.mx",
        '<!-- {"defaultTag":"nowhere"} -->\n<div/>\n',
      ),
    "<money>\n  <.x/>\n</money>\n",
  ),

  // APIs that report a code directly.
  callRow("MX_INVALID_API_USE", 1, 2, "parseFragment", () => {
    try {
      parseFragment("<x/>", { baseLine: 0, baseOffset: 5, baseColumn: 2 });
      return [];
    } catch (cause) {
      return ofThrown(cause);
    }
  }),
  callRow("MX_INVALID_ACCESSOR_ASSIGNMENT", 3, 4, "rewriteReadsInCode", () => {
    try {
      rewriteReadsInCode(
        "p = 1",
        new Map([["p", { read: "p()", assignError: "x" }]]) as never,
        { line: 3, column: 4 } as never,
      );
      return [];
    } catch (cause) {
      return ofThrown(cause);
    }
  }),
];

/** Codes no input reaches, each with the reason. */
const UNREACHABLE: readonly { code: string; reason: string }[] = [
  {
    code: "MX_FRONT_END_INTERNAL",
    reason:
      "an internal defect of the parser's front end; by design no input produces it",
  },
  {
    code: "MX_PARSE_RESERVED_TAG_NAME",
    reason:
      "the front end refuses statement words first (`<static .../>`, `<import x/>` give MX_STATEMENT_IN_HTML_MODE) and a dialect `tagTypes` table is refused with MX_INVALID_DIALECT_MODULE",
  },
  {
    code: "MX_TAG_TYPES_MISMATCH",
    reason:
      "only a caller of the parser API passing a `tagTypes` table that disagrees with `tagShape` produces it; lowerSource and dialects refuse `tagTypes`",
  },
  {
    code: "MX_INVALID_EXPRESSION",
    reason:
      "needs a `MarkoParseError` node in a recovered `parseFragment` parse; every expression and param error tried (`<${1 +}/>`, `<const/{ a, b: a }=x/>`, `<for|{ a, b: a }|>`, `<define/Foo|{a=}|>`) is a MX_PARSE_* error first",
  },
];

// --- The tests -----------------------------------------------------------

const CATALOGUE = new Map(MX_DIAGNOSTIC_CODES.map((e) => [e.code, e]));

describe("diagnostic code table", () => {
  it("lists exactly the catalogue's codes, each once", () => {
    const listed = [
      ...ROWS.map((row) => row.code),
      ...UNREACHABLE.map((u) => u.code),
    ];
    expect(listed.filter((code, i) => listed.indexOf(code) !== i)).toEqual([]);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...CATALOGUE.keys()].filter((c) => !listed.includes(c))).toEqual(
      [],
    );
    expect(listed.filter((c) => !CATALOGUE.has(c))).toEqual([]);
    expect(listed).toHaveLength(MX_DIAGNOSTIC_CODES.length);
  });

  it("gives every unreachable code a reason", () => {
    for (const { code, reason } of UNREACHABLE) {
      expect(reason.length, code).toBeGreaterThan(10);
    }
  });

  it.each(ROWS)("$code through $via at $line:$column", (row) => {
    const found = row.run(env);
    const hit = found.find((d) => d.code === row.code);
    expect(hit, `got ${JSON.stringify(found)}`).toBeDefined();
    if (!hit) return;
    expect([hit.line, hit.column]).toEqual([row.line, row.column]);
    // A scan diagnostic may state no severity of its own.
    if (hit.severity !== undefined) {
      expect(hit.severity).toBe(CATALOGUE.get(row.code)?.severity);
    }
  });
});
