import { describe, expect, it } from "vitest";
import { type AtomFacts, atomCandidates } from "./atom-contracts.ts";
import { compileSource } from "./compile.ts";
import { TranslateError } from "./core.ts";
import type { CustomTag } from "./custom-tags.ts";
import type { HostDeclarations } from "./declarations.ts";
import { testTargetLookup } from "./test-targets.ts";

/**
 * Decision 156 PR 2 part B: the candidates an atom can take at a position
 * (`atomCandidates`), and the diagnostics that list them. Rows write the cursor
 * as `|` in the source.
 */

const targets = testTargetLookup();
const declarations: HostDeclarations = {
  tags: {},
  isElement: () => true,
  isComponent: () => false,
  isDelegatedTag: () => true,
  resolveDefaultTag: () => "setter",
  attrTags: 2,
};

function run(
  source: string,
  customTags: Record<string, CustomTag>,
): { facts: AtomFacts; error?: TranslateError } {
  try {
    const result = compileSource(
      source,
      "/tmp/mx-atom-candidates/page.mx",
      declarations,
      {
        targets,
        customTags,
        tagDiscoveryDirs: [],
        warnings: [],
        emitIr: () => "",
      },
    );
    return { facts: result.atomFacts as AtomFacts };
  } catch (cause) {
    if (!(cause instanceof TranslateError)) throw cause;
    return { facts: cause.atomFacts as AtomFacts, error: cause };
  }
}

/** Candidates at the `|` of `marked`, computed on the facts of the source without it. */
function candidates(marked: string, tags: Record<string, CustomTag>) {
  const offset = marked.indexOf("|");
  // The last good facts: the buffer with an atom where the cursor is.
  const source = marked.replace(":|", ":x").replace("|", "");
  const { facts } = run(source, tags);
  return atomCandidates(facts.facts, facts.derived, offset);
}

const names = (list: { name: string }[]) => list.map((item) => item.name);

const mesh: Record<string, CustomTag> = {
  entity: {},
  attributes: {},
  actions: {},
  arguments: {},
  string: {
    attributes: { name: { type: "atom" } },
    declares: [
      { kind: "attribute", from: "name", under: "attributes" },
      {
        kind: "argument",
        from: "name",
        under: "arguments",
        scope: ["create", "update", "action"],
      },
    ],
  },
  uuid: {
    attributes: { name: { type: "atom" } },
    declares: { kind: "attribute", from: "name" },
  },
  action: {
    attributes: { name: { type: "atom" } },
    declares: { kind: "action", from: "name" },
  },
  create: { attributes: { name: { type: "atom" } } },
  update: { attributes: { name: { type: "atom" } } },
  policy: {
    attributes: {
      accept: { type: "atom", ref: "attribute" },
      arg: { type: "atom", ref: "argument" },
      either: { type: "atom", ref: ["attribute", "action"] },
      types: { type: "atom", values: ["read", "create"] },
      free: { type: "atom" },
      text: { type: "string" },
    },
  },
  setter: {
    attributes: { name: { type: "atom", ref: "attribute" }, value: {} },
  },
  field: {
    attributes: { name: { type: "atom" } },
    declares: { kind: "attribute", from: "name", scope: "entity" },
  },
  set: { defaultTag: "setter" },
};

describe("atomCandidates: values", () => {
  it("lists the contract's values with no kind", () => {
    expect(candidates("<policy types=:|/>", mesh)).toEqual([
      { name: "read" },
      { name: "create" },
    ]);
  });

  it("completes inside a list and mid-word", () => {
    expect(names(candidates("<policy types=[:read, :cr|]/>", mesh))).toEqual([
      "read",
      "create",
    ]);
  });
});

describe("atomCandidates: ref", () => {
  const entity = [
    "<entity>",
    "  <attributes>",
    "    <uuid :id/>",
    "    <string :title/>",
    "  </attributes>",
    "  <policy accept=:| />",
    "</entity>",
  ].join("\n");

  it("lists the declared names of the kind with it as detail, each once", () => {
    expect(candidates(entity, mesh)).toEqual([
      { name: "id", kind: "attribute" },
      { name: "title", kind: "attribute" },
    ]);
  });

  it("takes several kinds and keeps each name once (the first kind that declared it)", () => {
    const source = [
      "<entity>",
      "  <attributes><uuid :id/></attributes>",
      "  <actions><action :id/><action :publish/></actions>",
      "  <policy either=:| />",
      "</entity>",
    ].join("\n");
    expect(
      candidates(source, mesh)
        .map((c) => `${c.name}:${c.kind}`)
        .sort(),
    ).toEqual(["id:attribute", "publish:action"]);
  });

  it("puts the innermost scope first and the file scope last", () => {
    const source = [
      "<uuid :outer/>",
      "<entity>",
      "  <field :inner/>",
      "  <policy accept=:| />",
      "</entity>",
    ].join("\n");
    expect(names(candidates(source, mesh))).toEqual(["inner", "outer"]);
  });

  it("includes a declaration scoped to an ancestor (`under` and `scope`)", () => {
    const where = (first: string, second: string) =>
      [
        "<entity>",
        "  <create :make>",
        "    <arguments><string :title/></arguments>",
        `    <policy arg=${first} />`,
        "  </create>",
        "  <update :change>",
        `    <policy arg=${second} />`,
        "  </update>",
        "</entity>",
      ].join("\n");
    expect(candidates(where(":|", ":x"), mesh)).toEqual([
      { name: "title", kind: "argument" },
    ]);
    // Outside `create` the argument is not visible.
    expect(candidates(where(":x", ":|"), mesh)).toEqual([]);
  });

  it("includes names an analyze hook declared with ctx.declare", () => {
    const tags: Record<string, CustomTag> = {
      ...mesh,
      derive: {
        attributes: { from: { type: "string" } },
        analyze(calls, ctx) {
          for (const call of calls) {
            const from = call.attrs.find(
              (a) => a.kind === "static" && a.name === "from",
            );
            if (from?.kind !== "static" || !call.span) continue;
            ctx.declare("attribute", from.value, { span: call.span });
          }
        },
      },
    };
    expect(
      names(candidates('<derive from="made"/><policy accept=:| />', tags)),
    ).toEqual(["made"]);
  });

  it("does not throw on a clash; the duplicate shows once", () => {
    const source = "<uuid :id/><uuid :id/><policy accept=:| />";
    const { error } = run(source.replace(":|", ":x"), mesh);
    expect(error?.message).toMatch(/already declared/);
    expect(candidates(source, mesh)).toEqual([
      { name: "id", kind: "attribute" },
    ]);
  });

  it("works from the facts of a compile that failed its atom check", () => {
    const source = "<uuid :id/><policy accept=:idd/>";
    expect(run(source, mesh).error?.message).toMatch(/not a declared/);
    expect(
      names(candidates("<uuid :id/><policy accept=:id|d/>", mesh)),
    ).toEqual(["id"]);
  });

  it("works for an attribute-tag attribute", () => {
    const tags: Record<string, CustomTag> = {
      ...mesh,
      box: {
        attributeTags: {
          row: { attributes: { pick: { type: "atom", ref: "attribute" } } },
        },
      },
    };
    expect(
      names(candidates("<uuid :id/><box><@row pick=:| /></box>", tags)),
    ).toEqual(["id"]);
  });
});

describe("atomCandidates: the name sugar", () => {
  it("completes `name` of the default tag a `set` body writes", () => {
    expect(candidates("<uuid :id/><set><:|=1/></set>", mesh)).toEqual([
      { name: "id", kind: "attribute" },
    ]);
  });

  it("completes the `:name` after an unnamed-tag default", () => {
    expect(names(candidates("<uuid :id/><setter :|/>", mesh))).toEqual(["id"]);
  });
});

describe("atomCandidates: nothing to offer", () => {
  it("has no candidates without a contract, or with a bare atom type", () => {
    expect(candidates("<policy free=:|/>", mesh)).toEqual([]);
    expect(candidates("<other x=:|/>", mesh)).toEqual([]);
    expect(candidates("<policy text=:|/>", mesh)).toEqual([]);
  });

  it("has no candidates outside any tag or attribute value", () => {
    expect(candidates("|<policy accept=:a/>", mesh)).toEqual([]);
    expect(candidates("<policy |accept=:a/>", mesh)).toEqual([]);
  });

  it("has no candidates when the facts are empty", () => {
    expect(atomCandidates([], [], 3)).toEqual([]);
  });
});

describe("the atom diagnostics list the candidates", () => {
  const message = (source: string, tags = mesh) => {
    const { error } = run(source, tags);
    if (!error) throw new Error("expected an error");
    return error.message;
  };

  it("values: sorted, with did-you-mean", () => {
    expect(message("<policy types=:crate/>")).toBe(
      "`<policy>`: attribute `types`: `:crate` is not one of :create, :read; did you mean `:create`?",
    );
  });

  it("values: the sorted list when nothing is close", () => {
    expect(message("<policy types=:zzzzzz/>")).toBe(
      "`<policy>`: attribute `types`: `:zzzzzz` is not one of :create, :read",
    );
  });

  it("ref: lists the visible names, sorted, with did-you-mean", () => {
    expect(message("<uuid :title/><uuid :id/><policy accept=:titel/>")).toBe(
      "`<policy>`: attribute `accept`: `:titel` is not a declared attribute here (one of :id, :title); did you mean `:title`?",
    );
  });

  it("ref: says so when nothing of the kind is declared", () => {
    expect(message("<policy accept=:titel/>")).toBe(
      "`<policy>`: attribute `accept`: `:titel` is not a declared attribute here (none declared)",
    );
  });

  it("caps the list at 10 with `+N more`", () => {
    const letters = "abcdefghijkl".split("");
    const tags: Record<string, CustomTag> = {
      box: { attributes: { m: { type: "atom", values: letters } } },
    };
    expect(message("<box m=:zzzzzz/>", tags)).toBe(
      "`<box>`: attribute `m`: `:zzzzzz` is not one of :a, :b, :c, :d, :e, :f, :g, :h, :i, :j +2 more",
    );
    const refs = letters.map((l) => `<uuid :${l}/>`).join("");
    expect(message(`${refs}<policy accept=:zzzzzz/>`)).toBe(
      "`<policy>`: attribute `accept`: `:zzzzzz` is not a declared attribute here (one of :a, :b, :c, :d, :e, :f, :g, :h, :i, :j +2 more)",
    );
  });

  it("exactly 10 candidates are not capped", () => {
    const letters = "abcdefghij".split("");
    const tags: Record<string, CustomTag> = {
      box: { attributes: { m: { type: "atom", values: letters } } },
    };
    expect(message("<box m=:zzzzzz/>", tags)).toBe(
      "`<box>`: attribute `m`: `:zzzzzz` is not one of :a, :b, :c, :d, :e, :f, :g, :h, :i, :j",
    );
  });

  it("string where an atom with values is expected lists the values", () => {
    expect(message('<policy types="read"/>')).toBe(
      "`<policy>`: attribute `types` must be atom, got string (one of :create, :read)",
    );
  });

  it("string where an atom ref is expected names the kinds it may refer to", () => {
    expect(message('<policy either="id"/>')).toBe(
      "`<policy>`: attribute `either` must be atom, got string (a declared attribute or action)",
    );
  });

  it("string where a bare atom is expected is unchanged", () => {
    expect(message('<policy free="x"/>')).toBe(
      "`<policy>`: attribute `free` must be atom, got string",
    );
  });

  it("a string item in a list lists the values too", () => {
    expect(message('<policy types=[:read, "x"]/>')).toBe(
      "`<policy>`: attribute `types` must be atom, got string (one of :create, :read)",
    );
  });
});
