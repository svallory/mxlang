/**
 * `<effect>` is not an MX tag, in any form (spec §11). Core raises one error
 * on `lowerSource` and on every target that declares nothing for the name,
 * positioned at the tag name with its end. A host that declares its own
 * disposition for `effect` keeps it, and the `none` tag-rules preset leaves
 * `effect` an ordinary tag name.
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import { TranslateError } from "./core.ts";
import type { HostDeclarations } from "./declarations.ts";
import { lowerSource } from "./ir-entry/index.ts";
import { dialectProject } from "./test-dialect-project.ts";
import { lookup } from "./test-targets.ts";

const MESSAGE =
  "`<effect>` is not an MX tag. Use `<script>`: its body runs after render and again when a value it reads changes.";
const CODE = "MX_RESERVED_EFFECT_TAG";

/** Every form of the tag, with the 0-based column of its name in `<if=x>`-free source. */
const FORMS: Array<[string, string]> = [
  ["bodied with text", "<effect>go()</effect>"],
  ["bodied with an element", "<effect><div>x</div></effect>"],
  ["bodied with a method", "<effect() { go() }>x</effect>"],
  ["self-closing", "<effect/>"],
  ["self-closing method", "<effect() { go() }/>"],
  ["self-closing value", "<effect=go()/>"],
  ["an attribute", '<effect foo="bar"/>'],
  ["a spread", "<effect ...input.attrs/>"],
  ["a variable", "<effect/x/>"],
];

/** A host that accepts every tag: nothing here may rescue `<effect>`. */
const open: HostDeclarations = {
  name: "effect-test",
  attrTags: 2,
  tags: {},
  isElement: () => true,
  isComponent: () => false,
  isDelegatedTag: () => false,
  resolveAttributeMethod: () => true,
};

function thrown(source: string, filename = "/page.mx"): TranslateError {
  try {
    compileSource(source, filename, open, {
      targets: lookup,
      emitIr: () => "",
    });
  } catch (error) {
    return error as TranslateError;
  }
  throw new Error("expected an error");
}

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-effect-tag-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("`<effect>` is one error in every form", () => {
  it.each(FORMS)("compileSource: %s", (_name, source) => {
    const error = thrown(source);
    expect(error.message).toBe(MESSAGE);
    expect(error.diagnosticCode).toBe(CODE);
    expect([error.line, error.column]).toEqual([1, 1]);
    expect(error.end).toEqual({ line: 1, column: 7 });
  });

  it.each(FORMS)("lowerSource: %s", (_name, source) => {
    const { diagnostics } = lowerSource(`${source}\n`, join(dir, "page.mx"));
    const effect = diagnostics.filter((d) => d.code === CODE);
    expect(effect).toHaveLength(1);
    expect(effect[0]).toMatchObject({
      severity: "error",
      message: MESSAGE,
      line: 1,
      column: 1,
      end: { line: 1, column: 7 },
    });
  });

  it("points at the name of a nested tag", () => {
    const error = thrown("<if=x>\n  <effect/>\n</if>\n");
    expect([error.line, error.column]).toEqual([2, 3]);
    expect(error.end).toEqual({ line: 2, column: 9 });
  });

  it("states the rule and the fix, with no decision number", () => {
    expect(MESSAGE).not.toMatch(/decision|\d{3}/i);
    expect(thrown("<effect/>").message).not.toMatch(/decision|\d{3}/i);
  });
});

describe("only the `none` tag-rules preset leaves `effect` an ordinary name", () => {
  it.each(FORMS)("lowerSource none: %s", (_name, source) => {
    const { diagnostics } = lowerSource(`${source}\n`, join(dir, "page.mx"), {
      tagRules: "none",
    });
    expect(diagnostics.filter((d) => d.code === CODE)).toEqual([]);
  });

  it("an explicit `html` preset still refuses it", () => {
    const { diagnostics } = lowerSource("<effect/>\n", join(dir, "page.mx"), {
      tagRules: "html",
    });
    expect(diagnostics.map((d) => d.code)).toContain(CODE);
  });

  it("a routed dialect that states `none` keeps it a tag, in its own files only", () => {
    dialectProject(dir, {
      module: 'export default { table: {}, tagRules: "none" };',
    });
    expect(() => thrown("<effect/>\n", join(dir, "page.tst"))).toThrow(
      "expected an error",
    );
    expect(thrown("<effect/>\n", join(dir, "page.mx")).message).toBe(MESSAGE);
  });
});

/** `compileSource` with `customTags`, returning the error or `undefined`. */
function attempt(
  source: string,
  filename: string,
  customTags: Record<string, unknown>,
): TranslateError | undefined {
  try {
    compileSource(source, filename, open, {
      targets: lookup,
      emitIr: () => "",
      customTags,
    } as never);
  } catch (error) {
    return error as TranslateError;
  }
  return undefined;
}

describe("a parent's contract never decides `<effect>`", () => {
  const exact = (error: TranslateError | undefined) => {
    expect(error?.message).toBe(MESSAGE);
    expect(error?.diagnosticCode).toBe(CODE);
    expect([error?.line, error?.column]).toEqual([2, 3]);
    expect(error?.end).toEqual({ line: 2, column: 9 });
  };

  it("inside a parent whose children are a closed list", () => {
    exact(
      attempt("<list>\n  <effect>go()</effect>\n</list>\n", "/page.mx", {
        list: { children: { item: {} } },
        item: {},
      }),
    );
  });

  it("inside a parent whose children are a wildcard", () => {
    exact(
      attempt("<resource>\n  <effect/>\n</resource>\n", "/page.mx", {
        resource: {
          children: { "*": [{ pattern: ".+", contract: "attribute" }] },
        },
        attribute: { attributes: { value: {} } },
      }),
    );
  });

  it("lowerSource says the same inside a closed list", () => {
    const { diagnostics } = lowerSource(
      "<list>\n  <effect>go()</effect>\n</list>\n",
      join(dir, "page.mx"),
      { customTags: { list: { children: { item: {} } }, item: {} } },
    );
    expect(diagnostics.map((d) => [d.code, d.message])).toContainEqual([
      CODE,
      MESSAGE,
    ]);
  });

  it("under the `none` preset a wildcard parent claims it as a child", () => {
    const { diagnostics } = lowerSource(
      "<resource>\n  <effect/>\n</resource>\n",
      join(dir, "page.mx"),
      {
        tagRules: "none",
        customTags: {
          resource: {
            children: { "*": [{ pattern: ".+", contract: "attribute" }] },
          },
          attribute: { attributes: { value: {} } },
        },
      },
    );
    expect(diagnostics.map((d) => d.code)).not.toContain(CODE);
  });
});

describe("a user tag named `effect` is reserved too", () => {
  it("a registered `effect` custom tag is refused at the use", () => {
    const error = attempt("<effect/>\n", "/page.mx", { effect: {} });
    expect(error?.message).toBe(MESSAGE);
    expect(error?.diagnosticCode).toBe(CODE);
  });

  it("a `tags/effect.mx` file is refused at the use", () => {
    mkdirSync(join(dir, "tags"));
    writeFileSync(join(dir, "tags", "effect.mx"), "<p>x</p>\n");
    const page = join(dir, "page.mx");
    let error: TranslateError | undefined;
    try {
      compileSource("<effect/>\n", page, open, {
        targets: lookup,
        emitIr: () => "",
        tagDiscoveryDirs: [join(dir, "tags")],
      } as never);
    } catch (caught) {
      error = caught as TranslateError;
    }
    expect(error?.message).toBe(MESSAGE);
    expect(error?.diagnosticCode).toBe(CODE);
  });

  it("a `none` dialect file keeps using its own `effect` tag", () => {
    dialectProject(dir, {
      module: 'export default { table: {}, tagRules: "none" };',
    });
    expect(
      attempt("<effect>go()</effect>\n", join(dir, "page.tst"), {
        effect: { transform: () => [] },
      }),
    ).toBeUndefined();
  });
});

describe("the walks core makes beside the file's own use the file's rules", () => {
  const marker = { analyze() {}, transform: () => [] };

  it("an `analyze` tag next to `<effect>` in a `none` dialect file", () => {
    dialectProject(dir, {
      module: 'export default { table: {}, tagRules: "none" };',
    });
    expect(
      attempt("<marker/>\n<effect/>\n", join(dir, "page.tst"), { marker }),
    ).toBeUndefined();
  });

  it("an `analyze` tag next to `<effect>` in an MX file still gets the error", () => {
    const error = attempt("<marker/>\n<effect/>\n", join(dir, "page.mx"), {
      marker,
    });
    expect(error?.diagnosticCode).toBe(CODE);
  });

  it("a tag unit in a `none` dialect file may use `effect`; the same unit in an MX file may not", () => {
    dialectProject(dir, {
      module: 'export default { table: {}, tagRules: "none" };',
    });
    const unit = (filename: string) => ({
      outer: { template: { filename, source: "<effect/>\n" } },
    });
    // The caller is a dialect file, so the caller's preset is `none` either
    // way; only the unit's own file decides.
    expect(
      attempt(
        "<outer/>\n",
        join(dir, "page.tst"),
        unit(join(dir, "outer.tst")),
      ),
    ).toBeUndefined();
    expect(
      attempt("<outer/>\n", join(dir, "page.tst"), unit(join(dir, "outer.mx")))
        ?.diagnosticCode,
    ).toBe(CODE);
  });
});

/** A host that states its own disposition for `effect`, as the embedded hosts do. */
const hostWith = (row: HostDeclarations["tags"][string]): HostDeclarations => ({
  ...open,
  tags: { effect: row },
});

function attemptOn(
  declarations: HostDeclarations,
  source: string,
  customTags?: Record<string, unknown>,
): TranslateError | undefined {
  try {
    compileSource(source, "/page.mx", declarations, {
      targets: lookup,
      emitIr: () => "",
      customTags,
    } as never);
  } catch (error) {
    return error as TranslateError;
  }
  return undefined;
}

describe("a host that declares `effect` keeps its own error", () => {
  const row = {
    kind: "error",
    reason: "`<effect>` is the host's to refuse",
  } as const;

  it.each(FORMS)("%s: the host's reason and code, not core's", (_n, source) => {
    const error = attemptOn(hostWith(row), source);
    expect(error?.message).toBe(row.reason);
    expect(error?.diagnosticCode).toBe("MX_UNSUPPORTED_CONSTRUCT");
    expect(error?.message).not.toContain("Use `<script>`");
  });

  it("uses the code the row carries", () => {
    const error = attemptOn(
      hostWith({ ...row, code: "MX_INERT_TAG_SHAPE" }),
      "<effect/>",
    );
    expect(error?.diagnosticCode).toBe("MX_INERT_TAG_SHAPE");
  });

  it("wins over a parent's closed list and its wildcard", () => {
    for (const customTags of [
      { list: { children: { item: {} } }, item: {} },
      {
        list: { children: { "*": [{ pattern: ".+", contract: "item" }] } },
        item: { attributes: { value: {} } },
      },
    ]) {
      const error = attemptOn(
        hostWith(row),
        "<list>\n  <effect/>\n</list>\n",
        customTags,
      );
      expect(error?.message).toBe(row.reason);
    }
  });

  it("an inert row is the host's reading too: core adds nothing", () => {
    const inert = hostWith({ kind: "inert", reason: "nothing", body: "text" });
    expect(attemptOn(inert, "<effect/>")).toBeUndefined();
  });
});
