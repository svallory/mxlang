/**
 * `package.json#mx.syntax` (decision 182, PR C): resolution from the nearest
 * manifest, validation positioned at the manifest, interning by hash, and the
 * pre-pass that fails a file at the first construct core cannot lower yet,
 * which a default-row project never pays for.
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import { TranslateError } from "./core.ts";
import { parseFragment } from "./fragment.ts";
import { mxTemplateParser } from "./marko-frontend.ts";
import { mxParses } from "./mx-parse.ts";
import {
  defaultSyntax,
  defaultSyntaxHash,
  normalizeMxSyntax,
  resolveSyntax,
  type SyntaxTable,
  syntaxHash,
  syntaxHashes,
  type Trigger,
} from "./syntax-table.ts";
import { lookup as targets } from "./test-targets.ts";

const declarations = {
  tags: {},
  isElement: () => true,
  isComponent: () => false,
};

const MEMBER: Trigger = {
  id: "member",
  chars: "&",
  match: "&[\\p{L}\\p{Nl}_$][\\p{L}\\p{Nl}\\p{Mn}\\p{Mc}\\p{Nd}\\p{Pc}_$]*",
  standIn: "identifier",
  node: { call: "member" },
};

const MESH = {
  expressionTriggers: [MEMBER],
  attributeTriggers: [MEMBER],
  lineTriggers: [MEMBER],
};

/**
 * MESH with a built-in node kind, which an inline `mx.syntax` may use: a
 * `{ call }` node needs a syntax module (decision 182 addendum 5).
 */
const INLINE_ROW: Trigger = { ...MEMBER, node: "identifier" };
const INLINE = {
  expressionTriggers: [INLINE_ROW],
  attributeTriggers: [{ ...MEMBER, node: "attribute" } as Trigger],
  lineTriggers: [INLINE_ROW],
};

/** MESH as an explicit table: the option path keeps "has no lowering yet". */
const EXPLICIT: SyntaxTable = Object.freeze({ ...defaultSyntax(), ...MESH });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mx-syntax-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function manifest(at: string, mx: unknown): string {
  mkdirSync(at, { recursive: true });
  const file = join(at, "package.json");
  writeFileSync(file, `{\n  "name": "x",\n  "mx": ${JSON.stringify(mx)}\n}\n`);
  return file;
}

function caught(run: () => unknown): TranslateError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TranslateError);
    return error as TranslateError;
  }
  throw new Error("expected an error");
}

const compile = (source: string, file: string, syntax?: SyntaxTable) =>
  compileSource(source, file, declarations, {
    targets,
    emitIr: () => "ok",
    ...(syntax ? { syntax } : {}),
  });

describe("normalizeMxSyntax", () => {
  it("core's default row is the parser's DEFAULT_SYNTAX", () => {
    expect(defaultSyntax()).toEqual(mxTemplateParser().DEFAULT_SYNTAX);
    expect(Object.isFrozen(defaultSyntax().placeholder)).toBe(true);
  });

  it("no mx.syntax is the default row itself", () => {
    expect(normalizeMxSyntax(undefined, "/app/package.json")).toBe(
      defaultSyntax(),
    );
  });

  it("overlays the default row, freezes, and interns by content", () => {
    const a = normalizeMxSyntax(INLINE, "/a/package.json");
    const b = normalizeMxSyntax(structuredClone(INLINE), "/b/package.json");
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.expressionTriggers[0])).toBe(true);
    expect(a.concise).toBe(true);
    expect(a.placeholder).toEqual({ open: "${", close: "}" });
    expect(syntaxHash(a)).not.toBe(syntaxHash(defaultSyntax()));
  });

  it("an overlay equal to the default row hashes as the default row", () => {
    expect(
      syntaxHash(normalizeMxSyntax({ concise: true }, "/a/package.json")),
    ).toBe(syntaxHash(defaultSyntax()));
  });

  it.each([
    [42, "`mx.syntax` must be an object"],
    [{ tagTypes: { div: 0 } }, "tag types are taglib-owned"],
    [{ triggers: [] }, "`mx.syntax.triggers` is not a syntax table field"],
    [
      { lineTriggers: [{ ...MEMBER, chars: "<" }] },
      '`mx.syntax.lineTriggers[0].chars` (trigger "member"): lineTriggers may not be armed on "<"',
    ],
    [{ concise: false }, "`mx.syntax.concise`: turning concise mode off"],
  ])("refuses %j at the manifest's mx.syntax key", (value, message) => {
    const file = manifest(dir, { tags: "tags", syntax: value });
    const error = caught(() => normalizeMxSyntax(value, file));
    expect(error.file).toBe(file);
    expect([error.line, error.column]).toEqual([3, 23]);
    expect(error.message).toContain(message);
  });
});

describe("resolveSyntax", () => {
  it("uses the nearest manifest, and a dependency's files its own", () => {
    manifest(dir, { syntax: INLINE });
    const dep = join(dir, "node_modules", "dep");
    manifest(dep, {});
    expect(resolveSyntax(join(dir, "src/page.mx")).lineTriggers).toHaveLength(
      1,
    );
    expect(resolveSyntax(join(dep, "page.mx"))).toBe(defaultSyntax());
  });

  it("a relative or virtual name gets the default row", () => {
    expect(resolveSyntax("page.mx")).toBe(defaultSyntax());
  });

  it("an unchanged manifest is not re-read; an edited one is", () => {
    const file = manifest(dir, { syntax: INLINE });
    const page = join(dir, "page.mx");
    const first = resolveSyntax(page);
    expect(resolveSyntax(page)).toBe(first);
    writeFileSync(file, '{ "name": "x", "mx": {} }');
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
    expect(resolveSyntax(page)).toBe(defaultSyntax());
  });
});

describe("a table core cannot lower yet fails the file loudly", () => {
  it.each([
    ["x=() => &status\n", "`member` trigger has no lowering yet", 1, 8],
    ["div\n  span\n    &title\n", "`member` trigger has no lowering yet", 3, 4],
    ["sort asc &dueOn\n", "`member` trigger has no lowering yet", 1, 9],
  ])(
    "%j (an explicit `{ call }` table with no module)",
    (source, message, line, column) => {
      const page = join(dir, "page.mx");
      const error = caught(() => compile(source, page, EXPLICIT));
      expect(error.message).toBe(message);
      expect(error.file).toBe(page);
      expect([error.line, error.column]).toEqual([line, column]);
    },
  );

  it("block tags and filters name their construct", () => {
    const table = normalizeMxSyntax(
      {
        blockTag: { open: "{%", close: "%}" },
        filter: { open: "::", close: "::" },
      },
      join(dir, "package.json"),
    );
    const page = join(dir, "page.mx");
    expect(caught(() => compile("<p>{% x %}</p>", page, table)).message).toBe(
      "a block tag has no lowering yet",
    );
    expect(caught(() => compile("<p>::md::x::</p>", page, table)).message).toBe(
      "the `md` filter has no lowering yet",
    );
  });

  it("an error the table causes is reported too", () => {
    // A row that refuses a value (slice a1 of lang-ext-move-sugars-to-mesh;
    // a match a word character would continue now declines silently).
    const table = normalizeMxSyntax(
      {
        attributeTriggers: [
          { ...MEMBER, node: "attribute", value: "refuse" } as Trigger,
        ],
      },
      join(dir, "package.json"),
    );
    const error = caught(() => compile("x &a=1\n", join(dir, "p.mx"), table));
    expect(error.message).toContain("The `&a` shorthand takes no value.");
  });

  it("a file that uses none of the table compiles as with the default row", () => {
    manifest(dir, { syntax: INLINE });
    const source = "<div class=a>${x && y}</div>\n";
    expect(compile(source, join(dir, "page.mx")).code).toBe(
      compile(source, "/elsewhere/page.mx").code,
    );
  });

  it("an invalid explicit table is the caller's error at the file start, naming the option", () => {
    const page = join(dir, "page.mx");
    const bad = Object.freeze({
      ...defaultSyntax(),
      expressionTriggers: [{ ...MEMBER, match: "&[" }],
    });
    const error = caught(() => compile("<p/>\n", page, bad));
    expect(error.message).toMatch(
      /^the `syntax` option is not a valid syntax table: `syntax\.expressionTriggers\[0\]\.match` \(trigger "member"\): `match` is not a valid regex/,
    );
    expect([error.file, error.line, error.column]).toEqual([page, 1, 0]);
    const fragment = caught(() =>
      parseFragment("<p/>", { filename: page, syntax: bad }),
    );
    expect(fragment.message).toBe(error.message);
  });

  it("an explicit null is refused, not read as omitted (review 442/443 verify)", () => {
    manifest(dir, { syntax: INLINE });
    const page = join(dir, "page.mx");
    const error = caught(() =>
      compileSource("<p/>\n", page, declarations, {
        targets,
        emitIr: () => "ok",
        syntax: null as unknown as SyntaxTable,
      }),
    );
    expect(error.message).toBe(
      "the `syntax` option must be a syntax table object, not null; omit it to use the file's `package.json#mx.syntax`",
    );
    expect([error.file, error.line, error.column]).toEqual([page, 1, 0]);
    expect(
      caught(() =>
        parseFragment("<p/>", {
          filename: page,
          syntax: null as unknown as SyntaxTable,
        }),
      ).message,
    ).toBe(error.message);
  });

  it("an explicit table's tagTypes is refused, as in a manifest", () => {
    const page = join(dir, "page.mx");
    const typed = { ...defaultSyntax(), tagTypes: { div: 2 as const } };
    expect(caught(() => compile("<div/>\n", page, typed)).message).toBe(
      "the `syntax` option's `tagTypes` must be empty: tag types are taglib-owned, computed from the tags and their parseOptions",
    );
  });

  it("an explicit table wins over the manifest", () => {
    manifest(dir, { syntax: INLINE });
    const page = join(dir, "page.mx");
    expect(() => compile("x=&a\n", page, defaultSyntax())).toThrow(
      /&a|Unexpected/,
    );
  });

  it("a fragment's position is shifted by its base", () => {
    const table = EXPLICIT;
    const error = caught(() =>
      parseFragment("<p x=&a/>", {
        filename: join(dir, "page.solid.mx"),
        baseOffset: 40,
        baseLine: 4,
        baseColumn: 10,
        syntax: table,
      }),
    );
    expect([error.line, error.column]).toEqual([5, 15]);
  });
});

describe("the default row costs nothing", () => {
  it("hashes the default row zero times, and a frozen custom table once", () => {
    defaultSyntaxHash(); // the process's one hash of the default row
    const plain = join(dir, "plain");
    manifest(plain, { tags: "tags" });
    const before = syntaxHashes.count;
    for (let i = 0; i < 3; i++) {
      compile("<p>a</p>\n", join(plain, "page.mx"));
      compile("<p>a</p>\n", "/virtual/page.mx", defaultSyntax());
      parseFragment("<p/>", { filename: join(plain, "page.mx") });
    }
    expect(syntaxHashes.count).toBe(before);

    const custom = Object.freeze({
      ...defaultSyntax(),
      blockTag: Object.freeze({ open: "{%", close: "%}" }),
    });
    for (let i = 0; i < 3; i++) {
      compile("<p>a</p>\n", join(plain, "page.mx"), custom);
    }
    expect(syntaxHashes.count).toBe(before + 1);
  });

  it("parses once per compile, whatever the table (port PR 5: no pre-pass)", () => {
    manifest(dir, { tags: "tags" });
    const plain = join(dir, "page.mx");
    const once = (run: () => unknown) => {
      const before = mxParses.count;
      run();
      expect(mxParses.count).toBe(before + 1);
    };
    once(() => compile("<p>a</p>\n", plain));
    once(() => compile("<p>a</p>\n", "/virtual/page.mx"));
    once(() => parseFragment("<p/>", { filename: plain }));

    const same = join(dir, "same");
    manifest(same, { syntax: { concise: true } });
    once(() => compile("<p>a</p>\n", join(same, "page.mx")));

    const other = join(dir, "other");
    manifest(other, { syntax: INLINE });
    once(() => compile("<p>a</p>\n", join(other, "page.mx")));
    // A built-in node kind lowers in core: one parse, no error.
    once(() => compile("x=&a\n", join(other, "page.mx")));
  });
});
