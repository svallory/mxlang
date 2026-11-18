/**
 * A dialect's tag rules on every compile entry: `compileSource` and
 * `parseFragment` parse a dialect's files under the preset the dialect states,
 * never the target's, as `lowerSource` does; MX's own files keep the host's.
 * The caller's host file kinds reach routing from the target lookup
 * `compileSource` and `parseFragment` are given.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import { type Ctx, newCtx, TranslateError } from "./core.ts";
import type { CustomTag } from "./custom-tags.ts";
import type { HostDeclarations } from "./declarations.ts";
import { parseFragment } from "./fragment.ts";
import type { Ir, IrNode } from "./ir.ts";
import { lowerSource } from "./ir-entry/index.ts";
import { lower, lowerChildren } from "./lower.ts";
import type { Dialect } from "./syntax-table.ts";
import { dialectProject } from "./test-dialect-project.ts";
import { lookup, testTargetLookupWithSegments } from "./test-targets.ts";

const host: HostDeclarations = {
  name: "tag-rules-test",
  tags: {},
  isElement: () => true,
  isComponent: () => false,
  isDelegatedTag: () => false,
  resolveAttributeMethod: () => true,
};

// A child inside a void element: an error under the HTML rules, a child tag
// under `none`.
const VOID_CHILD = "<input><child/></input>\n";
const VOID_ERROR = 'The closing "input" tag was not expected';

// A catch-all `"*"` parent. The `transform`s let both tags lower on a host
// that claims no tag, so only the wildcard check decides the outcome.
const WILDCARD_HOLDER: Record<string, CustomTag> = {
  holder: { children: { "*": [{ contract: "entry" }] }, transform: () => [] },
  entry: { transform: () => [] },
};

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-dialect-tag-rules-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function messageOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  return undefined;
}

const compile = (filename: string, options: { dialect?: Dialect } = {}) =>
  messageOf(() =>
    compileSource(VOID_CHILD, filename, host, {
      targets: lookup,
      emitIr: () => "",
      ...options,
    }),
  );

const fragment = (filename: string, options: { dialect?: Dialect } = {}) =>
  messageOf(() => parseFragment(VOID_CHILD, { filename, ...options }));

const none: Dialect = Object.freeze({
  id: "loose",
  name: "Loose",
  table: {},
  tagRules: "none",
});

describe.each([
  ["compileSource", compile],
  ["parseFragment", fragment],
] as const)("%s reads the dialect's `tagRules`", (_, run) => {
  it("a routed dialect's `none` applies to its files only", () => {
    dialectProject(dir, {
      module: 'export default { table: {}, tagRules: "none" };',
    });
    expect(run(join(dir, "page.tst"))).toBeUndefined();
    expect(run(join(dir, "page.mx"))).toContain(VOID_ERROR);
  });

  it("a routed dialect that states none gets the strict `html` rules", () => {
    dialectProject(dir, { module: "export default { table: {} };" });
    expect(run(join(dir, "page.tst"))).toContain(VOID_ERROR);
  });

  it("the `dialect` option's `tagRules` applies", () => {
    expect(run("/page.mx", { dialect: none })).toBeUndefined();
  });
});

describe("`lowerSource`'s own `tagRules` wins over the routed dialect's", () => {
  it("in the compile it runs, too", () => {
    dialectProject(dir, {
      module: 'export default { table: {}, tagRules: "none" };',
    });
    const page = join(dir, "page.tst");
    expect(lowerSource(VOID_CHILD, page).diagnostics).toEqual([]);
    expect(
      lowerSource(VOID_CHILD, page, { tagRules: "html" }).diagnostics.map(
        (diagnostic) => diagnostic.message,
      ),
    ).toEqual([VOID_ERROR]);
  });
});

// A region file (`.solid.mx`) reaches core only through `parseFragment`, from
// its host's region entry: both entries must refuse a dialect that claims it.
describe.each([
  [
    "compileSource",
    (filename: string) =>
      compileSource(VOID_CHILD, filename, host, {
        targets: testTargetLookupWithSegments("solid"),
        emitIr: () => "",
      }),
  ],
  [
    "parseFragment",
    (filename: string) =>
      parseFragment(VOID_CHILD, {
        filename,
        targets: testTargetLookupWithSegments("solid"),
      }),
  ],
] as const)("`%s` hands routing its target's host file kinds", (_, run) => {
  const caught = (filename: string) => {
    let error: unknown;
    try {
      run(filename);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(TranslateError);
    const { file, line, column, message } = error as TranslateError;
    return { file, line, column, message };
  };
  const REASON = "`.solid.mx` is a host's file kind, which MX owns";

  it("a dialect claiming one is an error at its `mx.dialect.extensions`", () => {
    const { packageFile } = dialectProject(dir, {
      manifest: { extensions: [".tst", ".solid.mx"] },
      module: "export default { table: {} };",
    });
    const expected = {
      file: packageFile,
      line: 7,
      column: 6,
      message: `\`mx.dialect.extensions\` cannot claim \`.solid.mx\`: ${REASON}; a dialect claims its own extensions (\`.mydsl.mx\`)`,
    };
    expect(caught(join(dir, "page.tst"))).toEqual(expected);
    expect(caught(join(dir, "page.solid.mx"))).toEqual(expected);
  });

  // The project's `package.json`: `mx.extensions` on line 7, the second
  // entry's key on line 9.
  it("`mx.extensions` routing one is an error at the entry", () => {
    const { projectFile } = dialectProject(dir, {
      module: "export default { table: {} };",
      mx: { extensions: { ".tst": "test", ".solid.mx": "test" } },
    });
    const expected = {
      file: projectFile,
      line: 9,
      column: 6,
      message: `\`mx.extensions\` cannot route \`.solid.mx\`: ${REASON}`,
    };
    expect(caught(join(dir, "page.tst"))).toEqual(expected);
    expect(caught(join(dir, "page.solid.mx"))).toEqual(expected);
  });
});

describe("a dialect's id is unique on the compile path too", () => {
  it("two dependencies with one id fail `compileSource`, naming both", () => {
    dialectProject(dir, { packageName: "a-dialect" });
    dialectProject(dir, {
      packageName: "b-dialect",
      manifest: { extensions: [".b"] },
    });
    expect(compile(join(dir, "page.mx"))).toBe(
      "two dialects have the id `test`: a-dialect and b-dialect. A dialect's id is its identity; keep one of these dependencies",
    );
  });
});

// Under `none` every name but the reserved ones is an ordinary tag (spec
// §13.7.3), so a host's row for it does not apply; a reserved name's does.
describe("the host's tag rows under the `none` tag rules", () => {
  const rows: HostDeclarations = {
    ...host,
    tags: {
      probe: { kind: "error", reason: "R" },
      define: { kind: "error", reason: "D" },
    },
  };
  const compileWithRows = (
    source: string,
    filename: string,
    options: { dialect?: Dialect; customTags?: Record<string, CustomTag> } = {},
  ) =>
    messageOf(() =>
      compileSource(source, filename, rows, {
        targets: lookup,
        emitIr: () => "",
        ...options,
      }),
    );

  it("a row for a name that is not reserved does not apply", () => {
    expect(
      compileWithRows("<probe/>\n", "/page.mx", { dialect: none }),
    ).toBeUndefined();
  });

  it("a row for a reserved name applies", () => {
    expect(compileWithRows("<define/>\n", "/page.mx", { dialect: none })).toBe(
      "D",
    );
  });

  it("outside `none` the row applies", () => {
    expect(compileWithRows("<probe/>\n", "/page.mx")).toBe("R");
  });

  it("a row for a name that is not reserved does not keep a wildcard from claiming it", () => {
    expect(
      compileWithRows("<holder><zzz/></holder>\n", "/page.mx", {
        dialect: none,
        customTags: WILDCARD_HOLDER,
      }),
    ).toBeUndefined();
    expect(
      compileWithRows("<holder><probe/></holder>\n", "/page.mx", {
        dialect: none,
        customTags: WILDCARD_HOLDER,
      }),
    ).toBeUndefined();
    expect(
      compileWithRows("<holder><probe/></holder>\n", "/page.mx", {
        customTags: WILDCARD_HOLDER,
      }),
    ).toBe(
      "`<holder>`: `<probe>` is not allowed here; names must not already be a tag (`<probe>` is a built-in tag, so the wildcard does not apply to it)",
    );
  });
});

function printExpression(node: unknown): string {
  const require = createRequire(import.meta.url);
  const { generator } = require("@marko/compiler/internal/babel");
  return generator(node, { concise: true }).code;
}

/** A fragment entry's body and `Ctx`: `parseFragment`, then `newCtx`. */
const fragmentCtx = (
  source: string,
  filename: string,
  options: { dialect?: Dialect; declarations?: HostDeclarations } = {},
) => {
  const { body } = parseFragment(source, {
    filename,
    ...(options.dialect ? { dialect: options.dialect } : {}),
  });
  const ctx = newCtx(
    source,
    printExpression,
    options.declarations ?? host,
    undefined,
    filename,
    lookup,
  );
  return { body, ctx };
};

// A fragment entry (`parseFragment` + `newCtx` + `lower`) sets no tag rules;
// lowering adopts the ones of the dialect the parse registered on the body.
describe("lowering a fragment adopts the file's tag rules", () => {
  const tagRulesAfterLower = (
    filename: string,
    options: { dialect?: Dialect; preset?: Ctx["tagRules"] } = {},
  ) => {
    const { body, ctx } = fragmentCtx("<div/>\n", filename, options);
    if (options.preset) ctx.tagRules = options.preset;
    lower(ctx, body);
    return ctx.tagRules;
  };

  it("the `dialect` option's `none`", () => {
    expect(tagRulesAfterLower("/page.mx", { dialect: none })).toBe("none");
  });

  it("a routed dialect's `none`", () => {
    dialectProject(dir, {
      module: 'export default { table: {}, tagRules: "none" };',
    });
    expect(tagRulesAfterLower(join(dir, "page.tst"))).toBe("none");
  });

  it("a routed dialect that states none gets `html`", () => {
    dialectProject(dir, { module: "export default { table: {} };" });
    expect(tagRulesAfterLower(join(dir, "page.tst"))).toBe("html");
  });

  it("MX's own file gets none", () => {
    expect(tagRulesAfterLower("/page.mx")).toBeUndefined();
  });

  it("a value the caller set is kept", () => {
    expect(
      tagRulesAfterLower("/page.mx", { dialect: none, preset: "markup" }),
    ).toBe("markup");
  });

  it("`lowerChildren` adopts it too", () => {
    const { body, ctx } = fragmentCtx("<div/>\n", "/page.mx", {
      dialect: none,
    });
    lowerChildren(ctx, body);
    expect(ctx.tagRules).toBe("none");
  });

  it("a host row for a name that is not reserved does not apply", () => {
    const { body, ctx } = fragmentCtx("<probe/>\n", "/page.mx", {
      dialect: none,
      declarations: {
        ...host,
        tags: { probe: { kind: "error", reason: "R" } },
      },
    });
    expect(messageOf(() => lower(ctx, body))).toBeUndefined();
  });

  it("a host row for a name that is not reserved does not keep a wildcard from claiming it", () => {
    const claimed = (source: string) => {
      const { body, ctx } = fragmentCtx(source, "/page.mx", {
        dialect: none,
        declarations: {
          ...host,
          tags: { probe: { kind: "error", reason: "R" } },
        },
      });
      ctx.customTags = WILDCARD_HOLDER;
      return messageOf(() => lower(ctx, body));
    };
    expect(claimed("<holder><zzz/></holder>\n")).toBeUndefined();
    expect(claimed("<holder><probe/></holder>\n")).toBeUndefined();
  });
});

// `compileSource` lowers a preset file with the preset's native elements
// (none under `none`); a fragment entry lowers it with the same set.
describe("lowering a fragment adopts the preset's native elements", () => {
  /** The first body node through `compileSource` and the fragment path. */
  const firstNodes = (source: string, dialect: Dialect) => {
    let compiled: Ir | undefined;
    compileSource(source, "/page.mx", host, {
      targets: lookup,
      emitIr: (ir) => {
        compiled = ir;
        return "";
      },
      dialect,
    });
    const { body, ctx } = fragmentCtx(source, "/page.mx", { dialect });
    return [compiled?.body[0], lower(ctx, body).body[0]];
  };
  const shape = (node: IrNode | undefined) =>
    node?.kind === "Element"
      ? { kind: node.kind, name: node.name, void: node.void }
      : { kind: node?.kind };

  it("a void web name with a body lowers on both paths under `none`", () => {
    expect(compile("/page.mx", { dialect: none })).toBeUndefined();
    const { body, ctx } = fragmentCtx(VOID_CHILD, "/page.mx", {
      dialect: none,
    });
    expect(messageOf(() => lower(ctx, body))).toBeUndefined();
  });

  it("a literal dynamic web name stays dynamic under `none`", () => {
    expect(firstNodes('<${"div"}/>\n', none).map(shape)).toEqual([
      { kind: "Component" },
      { kind: "Component" },
    ]);
  });

  it("outside `none` the host's natives stay", () => {
    const html: Dialect = Object.freeze({
      id: "strict",
      name: "Strict",
      table: {},
    });
    expect(firstNodes('<${"br"}/>\n', html).map(shape)).toEqual([
      { kind: "Element", name: "br", void: true },
      { kind: "Element", name: "br", void: true },
    ]);
  });
});
