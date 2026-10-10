/**
 * A dialect's tag rules on every compile entry (decision 212 item 8 and its
 * addendum item 1): `compileSource` and `parseFragment` parse a dialect's
 * files under the preset the dialect states, never the target's, as
 * `lowerSource` does; MX's own files keep the host's. The caller's host
 * file kinds reach routing from the target lookup `compileSource` and
 * `parseFragment` are given.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import { TranslateError } from "./core.ts";
import type { HostDeclarations } from "./declarations.ts";
import { parseFragment } from "./fragment.ts";
import { lowerSource } from "./ir-entry/index.ts";
import type { Dialect } from "./syntax-table.ts";
import { dialectProject } from "./test-dialect-project.ts";
import { lookup, testTargetLookupWithSegments } from "./test-targets.ts";

const host: HostDeclarations = {
  name: "tag-rules-test",
  attrTags: 2,
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
      message: `\`mx.dialect.extensions\` cannot claim \`.solid.mx\`: ${REASON}; a dialect claims its own extensions (\`.mesh.mx\`)`,
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

// A test preload may run MX's suites through a dialect set on this global;
// those files are still MX's, under their target's rules.
describe("the test fallback dialect keeps MX's own tag rules", () => {
  const FALLBACK = Symbol.for("@mxlang/core:fallbackSyntaxForTesting");
  const global = globalThis as Record<symbol, unknown>;
  afterEach(() => {
    delete global[FALLBACK];
  });

  it("its `tagRules` never reach the compile entries", () => {
    global[FALLBACK] = Object.freeze({
      id: "fallback",
      name: "Fallback",
      table: {},
      tagRules: "none",
    });
    expect(compile(join(dir, "page.mx"))).toContain(VOID_ERROR);
    expect(fragment(join(dir, "page.mx"))).toContain(VOID_ERROR);
  });

  // `<html-comment>`'s raw body comes from the HTML rules' taglib, which this
  // test host does not register: the fallback must not bring it in.
  it("the host's own taglibs stay in force under it", () => {
    const source = "<html-comment>x <i>z</html-comment>\n";
    const run = () =>
      messageOf(() =>
        compileSource(source, join(dir, "page.mx"), host, {
          targets: lookup,
          emitIr: () => "",
        }),
      );
    const without = run();
    expect(without).toBeDefined();
    global[FALLBACK] = Object.freeze({ id: "fallback", name: "F", table: {} });
    expect(run()).toBe(without);
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
