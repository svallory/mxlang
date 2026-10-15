/**
 * `Dialect.bindingsCallTags`: with `false`, no file-local binding turns a
 * capitalized tag into a component call in the dialect's files, so the
 * contract, the wildcard and the unknown-tag rules read the tag as if it were
 * unbound. Without the flag (or with `true`), a binding wins as before.
 *
 * The dialect `lexi` is a fixture, not any real dialect.
 */
import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import type { CustomTag } from "./custom-tags.ts";
import type { Policy } from "./declarations.ts";
import type { Ir } from "./ir.ts";
import { lowerSource } from "./ir-entry/index.ts";
import type { Dialect } from "./syntax-table.ts";
import { lookup } from "./test-targets.ts";

const TASK: CustomTag = {
  attributes: { k: { type: "string", required: true } },
};
const MISSING_K = {
  code: "MX_MISSING_ATTRIBUTE",
  line: 3,
};

function lexi(extra: Partial<Dialect> = {}): Dialect {
  return { id: "lexi", name: "Lexi", table: {}, ...extra } as Dialect;
}

const WITH_CONTRACT = { contracts: { Task: TASK } };
const WITH_WILDCARD = {
  contracts: { entities: { children: { "*": TASK } } },
};
const CLOSED = { ...WITH_CONTRACT, unknownTags: "reject" as const };

function brief(source: string, dialect: Dialect) {
  const result = lowerSource(source, "/v/p.mx", { dialect });
  return {
    diagnostics: result.diagnostics.map((d) => ({
      code: d.code,
      message: d.message,
      line: d.line,
      column: d.column,
    })),
    imports: (result.ir?.imports ?? []).map((i) => i.code),
  };
}

const codes = (r: ReturnType<typeof brief>) => r.diagnostics.map((d) => d.code);

/** A binding of `Task`, one source per way a file binds a name. */
const BINDINGS: Array<[string, string]> = [
  ["named import", 'import { Task } from "./t";\n'],
  ["default import", 'import Task from "./t";\n'],
  ["namespace import", 'import * as Task from "./t";\n'],
  ["`<const>`", "<const/Task=1/>\n"],
];

describe("bindingsCallTags: false reads a bound tag as unbound", () => {
  describe.each(BINDINGS)("%s", (_, binding) => {
    it("applies the contract: a missing required attribute is reported", () => {
      const lines = binding.split("\n").length - 1;
      const result = brief(
        `${binding}<Task/>\n`,
        lexi({ ...WITH_CONTRACT, bindingsCallTags: false }),
      );
      expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([
        ["MX_MISSING_ATTRIBUTE", lines + 1],
      ]);
      const unbound = brief("<Task/>\n", lexi(WITH_CONTRACT));
      expect(unbound.diagnostics.map((d) => d.code)).toEqual([
        "MX_MISSING_ATTRIBUTE",
      ]);
    });

    it("accepts a complete call, as the unbound tag does", () => {
      expect(
        brief(
          `${binding}<Task k="a"/>\n`,
          lexi({ ...WITH_CONTRACT, bindingsCallTags: false }),
        ).diagnostics,
      ).toEqual([]);
    });

    it("lets a wildcard claim the child", () => {
      const flagged = brief(
        `${binding}<entities>\n  <Task k="a"/>\n</entities>\n`,
        lexi({ ...WITH_WILDCARD, bindingsCallTags: false }),
      );
      expect(flagged.diagnostics).toEqual([]);
      const missing = brief(
        `${binding}<entities>\n  <Task/>\n</entities>\n`,
        lexi({ ...WITH_WILDCARD, bindingsCallTags: false }),
      );
      expect(codes(missing)).toEqual(["MX_MISSING_ATTRIBUTE"]);
    });

    it("hands a tag no contract names to the unknown-tag rule", () => {
      const result = brief(
        `${binding}<Other/>\n`,
        lexi({ ...CLOSED, bindingsCallTags: false }),
      );
      expect(codes(result)).toEqual(["MX_UNKNOWN_TAG"]);
      const unbound = brief("<Other/>\n", lexi(CLOSED));
      expect(codes(unbound)).toEqual(["MX_UNKNOWN_TAG"]);
    });

    it("lowers with no contract at all as the unbound tag does", () => {
      const dialect = lexi({ bindingsCallTags: false });
      expect(brief(`${binding}<Task/>\n`, dialect).diagnostics).toEqual([]);
    });
  });

  it("keeps every import in `ir.imports` with its specifiers", () => {
    const result = lowerSource(
      'import { Task, Other as O } from "./t";\nimport Def from "./d";\n<Task k="a"/>\n',
      "/v/p.mx",
      { dialect: lexi({ ...WITH_CONTRACT, bindingsCallTags: false }) },
    );
    expect(result.diagnostics).toEqual([]);
    const imports = result.ir?.imports ?? [];
    expect(imports.map((i) => i.bindings)).toEqual([["Task", "O"], ["Def"]]);
    expect(imports.map((i) => i.code)).toEqual([
      'import { Task, Other as O } from "./t";',
      'import Def from "./d";',
    ]);
  });

  it("covers a loop parameter named like a tag", () => {
    const flagged = brief(
      "<for|Task| of=[1]>\n<Task/>\n</for>\n",
      lexi({ ...WITH_CONTRACT, bindingsCallTags: false }),
    );
    expect(codes(flagged)).toEqual(["MX_MISSING_ATTRIBUTE"]);
    const plain = brief(
      "<for|Task| of=[1]>\n<Task/>\n</for>\n",
      lexi(WITH_CONTRACT),
    );
    expect(codes(plain)).toEqual(["MX_NOT_IN_DATA_FILE"]);
  });

  it("covers a `<define>` of the name: the define is refused, the call is read as unbound", () => {
    const flagged = brief(
      "<define/Task=1/>\n<Task/>\n",
      lexi({ ...WITH_CONTRACT, bindingsCallTags: false }),
    );
    expect(flagged.diagnostics.map((d) => [d.code, d.line])).toEqual([
      ["MX_NOT_IN_DATA_FILE", 1],
      ["MX_MISSING_ATTRIBUTE", 2],
    ]);
  });
});

describe("controls: the binding still wins without the flag", () => {
  const sources = [
    'import { Task } from "./t";\n<Task k="a"/>\n',
    'import Task from "./t";\n<Task k="a"/>\n',
    '<const/Task=1/>\n<Task k="a"/>\n',
  ];
  const wildcard =
    'import { Task } from "./t";\n<entities>\n  <Task k="a"/>\n</entities>\n';

  it.each([
    ["no flag", {}],
    ["`true`", { bindingsCallTags: true }],
  ])("a dialect with %s", (_, flag) => {
    for (const source of sources) {
      const result = brief(source, lexi({ ...WITH_CONTRACT, ...flag }));
      expect(codes(result)).toEqual(["MX_NOT_IN_DATA_FILE"]);
    }
    const wild = brief(wildcard, lexi({ ...WITH_WILDCARD, ...flag }));
    expect(codes(wild)).toEqual(["MX_TAG_NOT_ALLOWED"]);
  });

  it("the default row (no dialect) keeps a binding a call", () => {
    const result = lowerSource(
      'import { Task } from "./t";\n<Task k="a"/>\n',
      "/v/p.mx",
    );
    expect(result.diagnostics.map((d) => d.code)).not.toContain(
      "MX_MISSING_ATTRIBUTE",
    );
  });
});

describe("the refusal names the tag", () => {
  it("a named import: the tag, the cause and both fixes", () => {
    const result = brief(
      'import { Task } from "./t";\n<Task k="a"/>\n',
      lexi(WITH_CONTRACT),
    );
    expect(result.diagnostics).toEqual([
      {
        code: "MX_NOT_IN_DATA_FILE",
        message:
          "`<Task>` is bound in this file, so it is a dynamic tag; data files are static, so they need a name. Rename the binding (for an import, `import { Task as TaskRef }`) or set `bindingsCallTags: false` in the dialect",
        line: 2,
        column: 0,
      },
    ]);
  });

  it("without a dialect the text offers the rename only", () => {
    const result = lowerSource(
      'import { Task } from "./t";\n<Task k="a"/>\n',
      "/v/p.mx",
      {},
    );
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      "`<Task>` is bound in this file, so it is a dynamic tag; data files are static, so they need a name. Rename the binding (for an import, `import { Task as TaskRef }`)",
    ]);
  });

  it("a `<const>` binding names the tag as well", () => {
    const result = brief(
      '<const/Task=1/>\n<Task k="a"/>\n',
      lexi(WITH_CONTRACT),
    );
    expect(result.diagnostics[0]?.message).toMatch(
      /^`<Task>` is bound in this file/,
    );
  });

  it("a real dynamic tag keeps the old text", () => {
    const result = brief("<${x}/>\n", lexi());
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX syntax in a message.
      "a dynamic tag (`<${expr}>`) has no name; data files are static, so they need one",
    ]);
  });
});

describe("the wildcard refusal", () => {
  it("says a bound child is not claimed, and how to fix it", () => {
    const result = brief(
      'import { Task } from "./t";\n<entities>\n  <Task k="a"/>\n</entities>\n',
      lexi(WITH_WILDCARD),
    );
    expect(result.diagnostics).toEqual([
      {
        code: "MX_TAG_NOT_ALLOWED",
        message:
          "`<entities>`: `<Task>` is not allowed here; names must not already be a tag (`<Task>` is bound in this file, so the wildcard does not apply to it; rename the binding)",
        line: 3,
        column: 2,
      },
    ]);
  });

  it("reads as English with a pattern and a catch-all", () => {
    const dialect = lexi({
      contracts: {
        Plain: {},
        entities: {
          children: {
            "*": [{ pattern: "item-*", attributes: {} }, { attributes: {} }],
          },
        },
      },
    });
    const result = brief("<entities>\n  <Plain/>\n</entities>\n", dialect);
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      expect.stringContaining("must match `item-*`, or not already be a tag"),
    ]);
  });
});

describe("a host that routes imports as components", () => {
  // A host's own `isComponent` answers `imports.has`; the flag must keep the
  // binding from reaching it, or the call is a component whatever the dialect says.
  const policy: Policy = {
    tags: {},
    isElement: () => false,
    isComponent: (name, ctx) => ctx.imports.has(name),
  };
  const bodyKinds = (dialect: Dialect): string[] => {
    let captured: Ir | undefined;
    try {
      compileSource(
        'import { Task } from "./t";\n<Task/>\n',
        "/v/p.mx",
        policy,
        {
          targets: lookup,
          tagDiscoveryDirs: [],
          dialect,
          emitIr: (ir) => {
            captured = ir;
            return "";
          },
        },
      );
    } catch (error) {
      return [`throws: ${(error as Error).message}`];
    }
    return (captured?.body ?? []).map((node) => node.kind);
  };

  it("without the flag the import is a component call", () => {
    expect(bodyKinds(lexi())).toEqual(["Component"]);
  });

  it("with the flag the tag is unbound: a capitalized tag no one defines", () => {
    expect(bodyKinds(lexi({ bindingsCallTags: false }))).toEqual([
      "throws: `<Task>` is bound in this file, but Lexi files never call a binding as a tag (`bindingsCallTags: false`), and no `Task` tag is registered: register one, or call the binding as `<${Task}>`",
    ]);
  });
});
