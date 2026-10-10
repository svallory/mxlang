/**
 * A dialect's table (decision 182, PR C; decisions 202 and 212): a file
 * routed to a dialect package by its extension parses with that dialect's
 * table, resolved from the nearest manifest; the table's own problems are
 * positioned in the dialect's module, tables are interned by hash, the
 * removed `mx.syntax` is an error at its key, and the constructs core cannot
 * lower yet fail loudly while a default-row project never pays for them.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
  dialectTagRules,
  resolveSyntax,
  resolveSyntaxOf,
  type SyntaxTable,
  syntaxHash,
  syntaxHashes,
  type Trigger,
} from "./syntax-table.ts";
import { dialectProject } from "./test-dialect-project.ts";
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
 * MESH with a built-in node kind, which a table-only dialect may use: a
 * `{ call }` node needs the dialect's `lowerTrigger` (decision 182 addendum 5).
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
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-syntax-")));
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

/** A page of the test dialect: `dialectProject`'s package claims `.tst`. */
const PAGE = "page.tst";

/**
 * A project in `at` using a table-only dialect package that claims `.tst`
 * (`extra` is the project's `mx` config). Returns the project's
 * `package.json`.
 */
function dialect(at: string, table: unknown, extra?: object): string {
  mkdirSync(at, { recursive: true });
  return dialectProject(at, {
    module: `export default ${JSON.stringify({ table })};`,
    ...(extra ? { mx: extra } : {}),
  }).projectFile;
}

/** The test dialect's module file in the project at `at`. */
const dialectModule = (at: string) =>
  join(at, "node_modules", "test-dialect", "index.mjs");

/** A table overlaid on the default row, as a dialect's `table` is. */
const overlay = (fields: object): SyntaxTable =>
  Object.freeze({ ...defaultSyntax(), ...fields }) as SyntaxTable;

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
    ...(syntax ? { dialect: syntax } : {}),
  });

describe("a dialect's table", () => {
  it("core's default row is the parser's DEFAULT_SYNTAX", () => {
    expect(defaultSyntax()).toEqual(mxTemplateParser().DEFAULT_SYNTAX);
    expect(Object.isFrozen(defaultSyntax().placeholder)).toBe(true);
  });

  it("a file no dialect claims gets the default row itself", () => {
    manifest(dir, { tags: "tags" });
    expect(resolveSyntax(join(dir, "page.mx"))).toBe(defaultSyntax());
    const app = join(dir, "app");
    dialect(app, INLINE);
    expect(resolveSyntax(join(app, "page.mx"))).toBe(defaultSyntax());
  });

  it("overlays the default row, freezes, and interns by content", () => {
    dialect(join(dir, "a"), INLINE);
    dialect(join(dir, "b"), structuredClone(INLINE));
    const a = resolveSyntax(join(dir, "a", PAGE));
    expect(resolveSyntax(join(dir, "b", PAGE))).toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.expressionTriggers[0])).toBe(true);
    expect(a.concise).toBe(true);
    expect(a.placeholder).toEqual({ open: "${", close: "}" });
    expect(syntaxHash(a)).not.toBe(syntaxHash(defaultSyntax()));
  });

  it("an overlay equal to the default row is the default row", () => {
    dialect(dir, { concise: true });
    expect(resolveSyntax(join(dir, PAGE))).toBe(defaultSyntax());
  });

  it.each([
    [{ tagTypes: { div: 0 } }, "tag types are taglib-owned"],
    [{ triggers: [] }, "`table.triggers` is not a syntax table field"],
    [
      { lineTriggers: [{ ...MEMBER, chars: "<" }] },
      '`table.lineTriggers[0].chars` (trigger "member"): lineTriggers may not be armed on "<"',
    ],
    [{ concise: false }, "`table.concise`: turning concise mode off"],
  ])("refuses %j in the dialect file", (value, message) => {
    dialect(dir, value, { tags: "tags" });
    const error = caught(() => resolveSyntax(join(dir, PAGE)));
    expect(error.file).toBe(dialectModule(dir));
    expect([error.line, error.column]).toEqual([1, 0]);
    expect(error.message).toContain(message);
  });
});

describe("the removed `package.json#mx.syntax`", () => {
  const REMOVED =
    "`mx.syntax` is removed: a syntax of your own is a dialect, a package that declares itself in its `package.json#mx.dialect` (`id`, `name`, the `extensions` it claims, its `module`) and is one of the project's dependencies; a file goes to the dialect that claims its extension. `.mx` files are always MX's.";

  it.each([
    ["an inline table", { lineTriggers: [] }],
    ["a module path", "./dialect.ts"],
    ["a list", ["./dialect.ts"]],
  ])("(%s) is an error at its key", (_, value) => {
    const file = manifest(dir, { tags: "tags", syntax: value });
    const error = caught(() => resolveSyntax(join(dir, "page.mx")));
    expect(error.file).toBe(file);
    expect([error.line, error.column]).toEqual([3, 23]);
    expect(error.message).toBe(REMOVED);
  });

  it.each([
    [
      "mx.config.json",
      '{\n  "tags": "tags",\n  "syntax": "./dialect.ts"\n}\n',
      [3, 2],
    ],
    ["mx.config.yaml", "tags: tags\nsyntax: ./dialect.ts\n", [2, 0]],
  ])("is an error at its key in %s too", (name, text, position) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), '{ "name": "x" }\n');
    writeFileSync(join(dir, name), text);
    const error = caught(() => resolveSyntax(join(dir, "page.mx")));
    expect(error.file).toBe(join(dir, name));
    expect([error.line, error.column]).toEqual(position);
    expect(error.message).toBe(REMOVED);
  });

  it("is refused for a dialect's files too", () => {
    const file = dialect(dir, INLINE, { syntax: "./x.ts" });
    const error = caught(() => resolveSyntax(join(dir, PAGE)));
    expect(error.file).toBe(file);
    expect(error.message).toBe(REMOVED);
  });
});

describe("a dialect's tag rules (ruling 211)", () => {
  it("are `html` when the dialect declares none (decision 212 item 8)", () => {
    expect(dialectTagRules({ id: "test", name: "Test", table: {} })).toBe(
      "html",
    );
  });

  it.each(["html", "markup", "none"] as const)(
    "are the dialect's own `%s` when it declares them",
    (tagRules) => {
      expect(
        dialectTagRules({ id: "test", name: "Test", table: {}, tagRules }),
      ).toBe(tagRules);
    },
  );
});

describe("resolveSyntax", () => {
  it("uses the nearest manifest, and a dependency's files its own", () => {
    dialect(dir, INLINE);
    const dep = join(dir, "node_modules", "dep");
    manifest(dep, {});
    expect(resolveSyntax(join(dir, "src", PAGE)).lineTriggers).toHaveLength(1);
    expect(resolveSyntax(join(dep, PAGE))).toBe(defaultSyntax());
  });

  it("a relative or virtual name gets the default row", () => {
    expect(resolveSyntax("page.mx")).toBe(defaultSyntax());
    expect(resolveSyntax(PAGE)).toBe(defaultSyntax());
  });

  it("an unchanged manifest is not re-read; an edited one is", () => {
    const file = dialect(dir, INLINE);
    const page = join(dir, PAGE);
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
    "%j (an explicit `{ call }` table with no dialect hook)",
    (source, message, line, column) => {
      const page = join(dir, "page.mx");
      const error = caught(() => compile(source, page, EXPLICIT));
      expect(error.message).toBe(message);
      expect(error.file).toBe(page);
      expect([error.line, error.column]).toEqual([line, column]);
    },
  );

  it("block tags and filters name their construct", () => {
    const table = overlay({
      blockTag: { open: "{%", close: "%}" },
      filter: { open: "::", close: "::" },
    });
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
    const table = overlay({
      attributeTriggers: [
        { ...MEMBER, node: "attribute", value: "refuse" } as Trigger,
      ],
    });
    const error = caught(() => compile("x &a=1\n", join(dir, "p.mx"), table));
    expect(error.message).toContain("The `&a` shorthand takes no value.");
  });

  it("a file that uses none of the table compiles as with the default row", () => {
    dialect(dir, INLINE);
    const source = "<div class=a>${x && y}</div>\n";
    expect(compile(source, join(dir, PAGE)).code).toBe(
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
      /^the `dialect` option is not a valid syntax table: `dialect\.expressionTriggers\[0\]\.match` \(trigger "member"\): `match` is not a valid regex/,
    );
    expect([error.file, error.line, error.column]).toEqual([page, 1, 0]);
    const fragment = caught(() =>
      parseFragment("<p/>", { filename: page, dialect: bad }),
    );
    expect(fragment.message).toBe(error.message);
  });

  it("an explicit null is refused, not read as omitted (review 442/443 verify)", () => {
    dialect(dir, INLINE);
    const page = join(dir, "page.mx");
    const error = caught(() =>
      compileSource("<p/>\n", page, declarations, {
        targets,
        emitIr: () => "ok",
        dialect: null as unknown as SyntaxTable,
      }),
    );
    expect(error.message).toBe(
      "the `dialect` option must be a dialect or a syntax table object, not null; omit it to use the dialect that claims the file's extension",
    );
    expect([error.file, error.line, error.column]).toEqual([page, 1, 0]);
    expect(
      caught(() =>
        parseFragment("<p/>", {
          filename: page,
          dialect: null as unknown as SyntaxTable,
        }),
      ).message,
    ).toBe(error.message);
  });

  it("an explicit table's tagTypes is refused, as in a manifest", () => {
    const page = join(dir, "page.mx");
    const typed = { ...defaultSyntax(), tagTypes: { div: 2 as const } };
    expect(caught(() => compile("<div/>\n", page, typed)).message).toBe(
      "the `dialect` option's `tagTypes` must be empty: tag types are taglib-owned, computed from the tags and their parseOptions",
    );
  });

  it("an explicit table wins over the file's dialect", () => {
    dialect(dir, INLINE);
    const page = join(dir, PAGE);
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
        dialect: table,
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
    dialect(same, { concise: true });
    once(() => compile("<p>a</p>\n", join(same, PAGE)));

    const other = join(dir, "other");
    dialect(other, INLINE);
    once(() => compile("<p>a</p>\n", join(other, PAGE)));
    // A built-in node kind lowers in core: one parse, no error.
    once(() => compile("x=&a\n", join(other, PAGE)));
  });
});

/**
 * A dialect's `module` is a file path inside its package, to JavaScript
 * Node can load: an installed dialect that ships TypeScript would load under
 * Bun and Vitest and fail for every Node user, and a package specifier is
 * not a path. Both are errors at `mx.dialect.module` (line 10 of the
 * dialect's `package.json`).
 */
describe("`mx.dialect.module` is a path to JavaScript", () => {
  function moduleError(run: () => unknown): TranslateError {
    try {
      run();
    } catch (error) {
      if (error instanceof TranslateError) return error;
      throw error;
    }
    throw new Error("expected a TranslateError");
  }

  it.each(["./index.ts", "./src/dialect.mts", "./dialect.cts", "./x.tsx"])(
    "an installed dialect's TypeScript module `%s` is an error",
    (module) => {
      const { packageFile } = dialectProject(dir, {
        manifest: { module },
        module: "export default { table: {} };",
      });
      const error = moduleError(() => resolveSyntaxOf(join(dir, "page.tst")));
      expect(error.file).toBe(packageFile);
      expect([error.line, error.column]).toEqual([10, 6]);
      expect(error.message).toBe(
        `the dialect \`test\`'s module "${module}" is TypeScript: an installed dialect's module must be JavaScript Node can load. Build it to \`.js\`, \`.mjs\` or \`.cjs\` and point \`mx.dialect.module\` at the build`,
      );
    },
  );

  it("a workspace dialect linked into `node_modules` may point at TypeScript", () => {
    const source = join(dir, "packages", "test-dialect");
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, "package.json"),
      JSON.stringify({
        name: "test-dialect",
        mx: {
          dialect: {
            id: "test",
            name: "Test",
            extensions: [".tst"],
            module: "./index.ts",
          },
        },
      }),
    );
    writeFileSync(
      join(source, "index.ts"),
      'export default { table: {}, tagRules: "none" as const };\n',
    );
    mkdirSync(join(dir, "app", "node_modules"), { recursive: true });
    symlinkSync(source, join(dir, "app", "node_modules", "test-dialect"));
    writeFileSync(
      join(dir, "app", "package.json"),
      JSON.stringify({ devDependencies: { "test-dialect": "0.0.0" } }),
    );
    expect(resolveSyntaxOf(join(dir, "app", "page.tst")).dialect?.id).toBe(
      "test",
    );
  });

  it.each([
    ["a scoped specifier", "@scope/pkg/dialect"],
    ["an installed package's file", "other-pkg/dialect.js"],
  ])("%s is an error saying it is a path inside the package", (_, module) => {
    mkdirSync(join(dir, "node_modules", "other-pkg"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules", "other-pkg", "dialect.js"),
      "module.exports = {};\n",
    );
    const { packageFile, packageDir } = dialectProject(dir, {
      manifest: { module },
    });
    const error = moduleError(() => resolveSyntaxOf(join(dir, "page.tst")));
    expect(error.file).toBe(packageFile);
    expect([error.line, error.column]).toEqual([10, 6]);
    expect(error.message).toBe(
      `the dialect \`test\`'s module "${module}" cannot be resolved from ${packageDir}: \`mx.dialect.module\` is a file path inside the dialect's package ("./dist/dialect.js"), not a package specifier`,
    );
  });

  it("a missing relative path keeps the plain message", () => {
    const { packageDir } = dialectProject(dir, {
      manifest: { module: "dist/missing.js" },
    });
    const error = moduleError(() => resolveSyntaxOf(join(dir, "page.tst")));
    expect(error.message).toBe(
      `the dialect \`test\`'s module "dist/missing.js" cannot be resolved from ${packageDir}. Check \`mx.dialect.module\`.`,
    );
  });
});
