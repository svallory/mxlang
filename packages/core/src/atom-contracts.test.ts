import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import { TranslateError } from "./core.ts";
import type { CustomTag } from "./custom-tags.ts";
import type { HostDeclarations } from "./declarations.ts";
import { testTargetLookup } from "./test-targets.ts";

/**
 * Decision 156, PR 2: atom contracts (ADR 156 section 4). Every row compiles an
 * `.mx` source through `compileSource` with contract-only tags the way a
 * vocabulary registers them, and asserts the positioned diagnostics.
 */

const targets = testTargetLookup();
const declarations: HostDeclarations = {
  tags: {},
  isElement: () => true,
  isComponent: () => false,
  isDelegatedTag: () => true,
  resolveDefaultTag: () => "setter",
};

function compile(source: string, customTags: Record<string, CustomTag>): void {
  compileSource(source, "/tmp/mx-atom-contracts/page.mx", declarations, {
    targets,
    customTags,
    tagDiscoveryDirs: [],
    warnings: [],
    emitIr: () => "",
  });
}

function fails(
  source: string,
  customTags: Record<string, CustomTag>,
): TranslateError {
  try {
    compile(source, customTags);
  } catch (cause) {
    expect(cause).toBeInstanceOf(TranslateError);
    return cause as TranslateError;
  }
  throw new Error("expected a TranslateError");
}

/** The 1-based line and 0-based column of `needle`'s first occurrence. */
function at(source: string, needle: string, nth = 0) {
  let index = -1;
  for (let i = 0; i <= nth; i++) index = source.indexOf(needle, index + 1);
  const before = source.slice(0, index).split("\n");
  return {
    line: before.length,
    column: before[before.length - 1]?.length ?? 0,
  };
}

// A Mesh-shaped vocabulary: kinds `attribute`, `argument`, `action`,
// `relationship`, `computed`, declared from `name` under the right parents.
const mesh: Record<string, CustomTag> = {
  entity: {},
  attributes: {},
  actions: {},
  arguments: {},
  relationships: {},
  string: {
    attributes: { name: { type: "atom" } },
    declares: [
      { kind: "attribute", from: "name", under: "attributes" },
      {
        kind: "argument",
        from: "name",
        under: "arguments",
        scope: ["create", "read", "update", "destroy", "action"],
      },
    ],
  },
  update: {
    attributes: { name: { type: "atom" } },
    declares: { kind: "action", from: "name" },
  },
  uuid: {
    attributes: { name: { type: "atom" }, "primary-key": {} },
    declares: { kind: "attribute", from: "name" },
  },
  action: {
    attributes: { name: { type: "atom" } },
    declares: { kind: "action", from: "name" },
  },
  "has-many": {
    attributes: { name: { type: "atom" } },
    declares: { kind: "relationship", from: "name" },
  },
  calc: {
    attributes: { name: { type: "atom" } },
    declares: { kind: "computed", from: "name" },
  },
  policy: {
    attributes: {
      accept: { type: "atom", ref: "attribute" },
      load: { type: "atom", ref: ["relationship", "computed"] },
      require: { type: "atom", ref: ["attribute", "argument"] },
      types: { type: "atom", values: ["create", "read", "update", "destroy"] },
    },
  },
  setter: {
    attributes: {
      name: { type: "atom", ref: "attribute" },
      value: {},
    },
  },
  set: { defaultTag: "setter" },
};

describe("open atom, values and pattern", () => {
  const tags: Record<string, CustomTag> = {
    box: {
      attributes: {
        any: { type: "atom" },
        mode: { type: "atom", values: ["strict", "loose"] },
        slug: { type: "atom", pattern: "^[a-z]+$" },
        both: { type: "atom", values: ["a1", "b2"], pattern: "^[a-z]\\d$" },
      },
    },
  };

  it("accepts any atom for { type: 'atom' }", () => {
    expect(() => compile("<box any=:whatever-it-is/>", tags)).not.toThrow();
    expect(() => compile("<box any=[:a, :b]/>", tags)).not.toThrow();
  });

  it("restricts to values with a positioned did-you-mean error", () => {
    const source = "<box mode=:strct/>";
    const error = fails(source, tags);
    expect(error.message).toMatch(/strct/);
    expect(error.message).toMatch(/did you mean `:?strict`/i);
    expect({ line: error.line, column: error.column }).toEqual(
      at(source, ":strct"),
    );
    expect(() => compile("<box mode=:strict/>", tags)).not.toThrow();
  });

  it("lists the values when nothing is close enough", () => {
    const error = fails("<box mode=:zzzzzz/>", tags);
    expect(error.message).toMatch(/strict/);
    expect(error.message).toMatch(/loose/);
    expect(error.message).not.toMatch(/did you mean/i);
  });

  it("restricts the name by pattern, with or without values", () => {
    expect(() => compile("<box slug=:abc/>", tags)).not.toThrow();
    const source = "<box slug=:ab-c/>";
    const error = fails(source, tags);
    expect(error.message).toMatch(/pattern/);
    expect({ line: error.line, column: error.column }).toEqual(
      at(source, ":ab-c"),
    );
    expect(() => compile("<box both=:a1/>", tags)).not.toThrow();
    expect(() => compile("<box both=:c3/>", tags)).toThrow(/values|one of/);
    expect(() => compile("<box both=:b9/>", tags)).toThrow(/values|one of|b9/);
  });

  it("checks every atom of a list at its own position", () => {
    const source = "<box mode=[:strict, :lose]/>";
    const error = fails(source, tags);
    expect({ line: error.line, column: error.column }).toEqual(
      at(source, ":lose"),
    );
  });
});

describe("atom against string, both ways", () => {
  const tags: Record<string, CustomTag> = {
    box: {
      attributes: {
        label: { type: "string" },
        kind: { type: "atom" },
        n: { type: "number" },
      },
    },
  };

  it("an atom where the contract says string is a type error", () => {
    const source = "<box label=:title/>";
    const error = fails(source, tags);
    expect(error.message).toMatch(/must be string, got atom/);
    expect({ line: error.line, column: error.column }).toEqual(
      at(source, ":title"),
    );
    expect(() => compile('<box label="title"/>', tags)).not.toThrow();
  });

  it("a string where the contract says atom is a type error", () => {
    const error = fails('<box kind="title"/>', tags);
    expect(error.message).toMatch(/must be atom, got string/);
    expect(() => compile("<box kind=:title/>", tags)).not.toThrow();
  });

  it("a string item in an atom list is a type error at the item", () => {
    const source = '<box kind=[:a, "b"]/>';
    const error = fails(source, tags);
    expect(error.message).toMatch(/must be atom, got string/);
    expect({ line: error.line, column: error.column }).toEqual(
      at(source, '"b"'),
    );
  });

  it("an atom where the contract says number names atom", () => {
    expect(() => compile("<box n=:four/>", tags)).toThrow(
      /must be number, got atom/,
    );
  });

  it("an expression the checker cannot see passes", () => {
    expect(() => compile("<box kind=other/>", tags)).not.toThrow();
  });

  it("without a contract an atom is never an error", () => {
    expect(() =>
      compile("<box x=:a y=[:b, :c] z=(1 ? :d : :e)/>", { box: {} }),
    ).not.toThrow();
    expect(() => compile("<box x=:a/>", {})).not.toThrow();
  });
});

describe("references", () => {
  it("accepts a declared name; a typo is a positioned did-you-mean error", () => {
    const ok = `<entity :invoice>
  <attributes>
    <string :title/>
    <string :body/>
  </attributes>
  <policy accept=[:title, :body]/>
</entity>`;
    expect(() => compile(ok, mesh)).not.toThrow();

    const bad = ok.replace(":body]", ":bdy]");
    const error = fails(bad, mesh);
    expect(error.message).toMatch(/did you mean `:?body`/i);
    expect({ line: error.line, column: error.column }).toEqual(at(bad, ":bdy"));
  });

  it("order in the file does not matter", () => {
    const source = `<entity :invoice>
  <policy accept=[:title]/>
  <attributes>
    <string :title/>
  </attributes>
</entity>`;
    expect(() => compile(source, mesh)).not.toThrow();
  });

  it("an undeclared name errors even with no near candidate", () => {
    const error = fails(
      `<entity :invoice>
  <attributes><string :title/></attributes>
  <policy accept=:zzzzzz/>
</entity>`,
      mesh,
    );
    expect(error.message).toMatch(/zzzzzz/);
    expect(error.message).toMatch(/attribute/);
    expect(error.message).not.toMatch(/did you mean/i);
  });

  it("a union ref accepts a name declared as either kind", () => {
    const source = `<entity :invoice>
  <relationships><has-many :items/></relationships>
  <attributes><string :title/><calc :total/></attributes>
  <policy load=[:items, :total]/>
</entity>`;
    expect(() => compile(source, mesh)).not.toThrow();
    const bad = source.replace(":total]", ":title]");
    // `title` is an attribute, not a relationship or computed.
    expect(() => compile(bad, mesh)).toThrow(/title/);
  });

  it("the kind of the declaration must match", () => {
    const error = fails(
      `<entity :invoice>
  <attributes><string :title/></attributes>
  <relationships><has-many :items/></relationships>
  <policy accept=:items/>
</entity>`,
      mesh,
    );
    expect(error.message).toMatch(/items/);
  });

  it('the name sugar is a reference: `:status="paid"` under set', () => {
    const ok = `<entity :invoice>
  <attributes><string :status/></attributes>
  <actions>
    <action :pay>
      <set>
        <:status="paid"/>
      </set>
    </action>
  </actions>
</entity>`;
    expect(() => compile(ok, mesh)).not.toThrow();
    const bad = ok.replace(":status=", ":statuss=");
    const error = fails(bad, mesh);
    expect(error.message).toMatch(/did you mean `:?status`/i);
    expect({ line: error.line, column: error.column }).toEqual(
      at(bad, ":statuss"),
    );
  });

  it('`name="title"` where name is typed atom is a type error, `:title` satisfies it', () => {
    const source = `<entity :invoice>
  <attributes><string name="title"/></attributes>
</entity>`;
    expect(fails(source, mesh).message).toMatch(/must be atom, got string/);
  });

  it("a cross-file name is not checked when the contract states no ref", () => {
    const tags: Record<string, CustomTag> = {
      "belongs-to": { attributes: { value: { type: "atom" } } },
    };
    expect(() => compile("<belongs-to=:Customer/>", tags)).not.toThrow();
  });
});

describe("declares", () => {
  it("scope: arguments are visible only inside their action", () => {
    const ok = `<entity :invoice>
  <attributes><string :title/></attributes>
  <actions>
    <action :rename>
      <arguments><string :newTitle/></arguments>
      <policy require=[:title, :newTitle]/>
    </action>
  </actions>
</entity>`;
    expect(() => compile(ok, mesh)).not.toThrow();

    const outside = `<entity :invoice>
  <attributes><string :title/></attributes>
  <actions>
    <action :rename>
      <arguments><string :newTitle/></arguments>
    </action>
    <action :other>
      <policy require=:newTitle/>
    </action>
  </actions>
</entity>`;
    expect(fails(outside, mesh).message).toMatch(/newTitle/);
  });

  it("the entry whose `under` names the parent beats one without", () => {
    const tags: Record<string, CustomTag> = {
      ...mesh,
      thing: {
        attributes: { name: { type: "atom" } },
        declares: [
          { kind: "attribute", from: "name" },
          {
            kind: "argument",
            from: "name",
            under: "arguments",
            scope: "action",
          },
        ],
      },
    };
    // Under `arguments` only the specific entry applies: `thing :x` is an
    // argument, not an attribute, so `accept=:x` fails.
    const source = `<entity :e>
  <actions>
    <action :go>
      <arguments><thing :x/></arguments>
    </action>
  </actions>
  <policy accept=:x/>
</entity>`;
    expect(() => compile(source, tags)).toThrow(/x/);
    // With no matching parent the general entry applies.
    const general = `<entity :e>
  <attributes><thing :x/></attributes>
  <policy accept=:x/>
</entity>`;
    expect(() => compile(general, tags)).not.toThrow();
  });

  it("from: 'id' declares from the #id sugar", () => {
    const tags: Record<string, CustomTag> = {
      root: {},
      node: { declares: { kind: "node", from: "id" } },
      link: { attributes: { to: { type: "atom", ref: "node" } } },
    };
    expect(() =>
      compile("<root><node#a/><node#b/><link to=:a/></root>", tags),
    ).not.toThrow();
    expect(() => compile("<root><node#a/><link to=:c/></root>", tags)).toThrow(
      /c/,
    );
  });

  it("an `under` array matches any of the parents", () => {
    const tags: Record<string, CustomTag> = {
      ...mesh,
      field: {
        attributes: { name: { type: "atom" } },
        declares: {
          kind: "attribute",
          from: "name",
          under: ["attributes", "extras"],
        },
      },
      extras: {},
    };
    const source = `<entity :e>
  <extras><field :a/></extras>
  <policy accept=:a/>
</entity>`;
    expect(() => compile(source, tags)).not.toThrow();
  });

  it("a tag with no entry matching its parent declares nothing", () => {
    const tags: Record<string, CustomTag> = {
      ...mesh,
      field: {
        attributes: { name: { type: "atom" } },
        declares: { kind: "attribute", from: "name", under: "attributes" },
      },
    };
    const source = `<entity :e>
  <actions><field :a/></actions>
  <policy accept=:a/>
</entity>`;
    expect(() => compile(source, tags)).toThrow(/a/);
  });

  it("resolves innermost scope first across nested scopes", () => {
    const tags: Record<string, CustomTag> = {
      outer: { declares: { kind: "k", from: "id" } },
      inner: {},
      let: {
        attributes: { name: { type: "atom" } },
        declares: { kind: "k", from: "name", scope: "inner" },
      },
      use: { attributes: { v: { type: "atom", ref: "k" } } },
    };
    // `x` declared in the `inner` scope is invisible outside it.
    const ok = "<outer#o><inner><let :x/><use v=:x/></inner></outer>";
    expect(() => compile(ok, tags)).not.toThrow();
    const bad = "<outer#o><inner><let :x/></inner><use v=:x/></outer>";
    expect(() => compile(bad, tags)).toThrow(/x/);
  });
});

describe("scope names", () => {
  it("an array scope matches the nearest ancestor among the names, e.g. <update>", () => {
    const ok = `<entity :invoice>
  <attributes><string :title/></attributes>
  <actions>
    <update :rename>
      <arguments><string :newTitle/></arguments>
      <policy require=[:newTitle, :title]/>
    </update>
    <update :other>
      <policy require=:newTitle/>
    </update>
  </actions>
</entity>`;
    const error = fails(ok, mesh);
    expect(error.message).toMatch(/newTitle/);
    expect(error.line).toBe(at(ok, ":newTitle", 2).line);
  });

  it("no ancestor with a scope name is a positioned error at the declaration", () => {
    const source = `<entity :invoice>
  <arguments><string :x/></arguments>
</entity>`;
    const error = fails(source, mesh);
    expect(error.message).toBe(
      "`x` declares an `argument` scoped to `create`, `read`, `update`, `destroy` or `action`, but has no such ancestor",
    );
    expect({ line: error.line, column: error.column }).toEqual(
      at(source, ":x"),
    );
  });
});

describe("duplicates", () => {
  it("two declarations of one name and kind in one scope are an error carrying both spans", () => {
    const source = `<entity :invoice>
  <attributes>
    <string :title/>
    <uuid :title/>
  </attributes>
</entity>`;
    const error = fails(source, mesh);
    expect(error.message).toMatch(/title/);
    expect(error.message).toMatch(/already declared|duplicate/i);
    const second = at(source, ":title", 1);
    expect({ line: error.line, column: error.column }).toEqual(second);
    expect(error.spans).toHaveLength(2);
    const [first, last] = error.spans ?? [];
    expect(source.slice(first?.sourceStart, first?.sourceEnd)).toBe(":title");
    expect(first?.sourceStart).toBeLessThan(last?.sourceStart ?? 0);
    // The message names the first position too.
    const firstAt = at(source, ":title", 0);
    expect(error.message).toContain(`${firstAt.line}:${firstAt.column + 1}`);
  });

  it("the same name in two scopes is fine", () => {
    const source = `<entity :invoice>
  <attributes><string :title/></attributes>
  <actions>
    <action :a><arguments><string :title/></arguments></action>
  </actions>
</entity>`;
    // attribute `title` (entity scope) and argument `title` (action scope):
    // different kind and scope.
    expect(() => compile(source, mesh)).not.toThrow();
  });

  it("uniqueWith extends the clash to other kinds in the scope", () => {
    const tags: Record<string, CustomTag> = {
      ...mesh,
      attr: {
        attributes: { name: { type: "atom" } },
        declares: {
          kind: "attribute",
          from: "name",
          uniqueWith: ["relationship"],
        },
      },
    };
    const source = `<entity :e>
  <attr :items/>
  <relationships><has-many :items/></relationships>
</entity>`;
    expect(fails(source, tags).message).toMatch(/items/);
    // Without uniqueWith on either side the same pair is allowed.
    expect(() => compile(source, mesh)).not.toThrow();
  });
});

describe("derived declarations from analyze (ctx.declare)", () => {
  it("a hook-added name is visible to every reference, wherever it is written", () => {
    const tags: Record<string, CustomTag> = {
      ...mesh,
      "belongs-to": {
        attributes: { name: { type: "atom" } },
        analyze(calls, ctx) {
          for (const call of calls) {
            const name = call.attrs.find(
              (a) => a.kind === "static" && a.name === "name",
            );
            if (name?.kind !== "static" || !call.span) continue;
            ctx.declare("attribute", `${name.value}Id`, { span: call.span });
          }
        },
      },
    };
    const source = `<entity :invoice>
  <policy accept=:listId/>
  <relationships><belongs-to :list/></relationships>
</entity>`;
    expect(() => compile(source, tags)).not.toThrow();
    expect(() => compile(source.replace(":listId", ":listIdd"), tags)).toThrow(
      /did you mean `:?listId`/i,
    );
  });

  it("clashes with a written declaration of the same name and kind", () => {
    const tags: Record<string, CustomTag> = {
      ...mesh,
      "belongs-to": {
        attributes: { name: { type: "atom" } },
        analyze(calls, ctx) {
          for (const call of calls) {
            if (call.span)
              ctx.declare("attribute", "listId", { span: call.span });
          }
        },
      },
    };
    const source = `<entity :invoice>
  <attributes><string :listId/></attributes>
  <relationships><belongs-to :list/></relationships>
</entity>`;
    const error = fails(source, tags);
    expect(error.message).toMatch(/listId/);
    expect(error.spans).toHaveLength(2);
  });

  it("scope names an ancestor of the tag the span belongs to", () => {
    const tags: Record<string, CustomTag> = {
      ...mesh,
      derive: {
        analyze(calls, ctx) {
          for (const call of calls) {
            if (call.span) {
              ctx.declare("argument", "implicit", {
                span: call.span,
                scope: "action",
              });
            }
          }
        },
      },
    };
    const ok = `<entity :e>
  <actions>
    <action :go><derive/><policy require=:implicit/></action>
  </actions>
</entity>`;
    expect(() => compile(ok, tags)).not.toThrow();
    const outside = `<entity :e>
  <actions>
    <action :go><derive/></action>
    <action :other><policy require=:implicit/></action>
  </actions>
</entity>`;
    expect(() => compile(outside, tags)).toThrow(/implicit/);
  });
});

describe("kinds merge across contract modules", () => {
  it("one kind name is one namespace for tags from different modules", () => {
    const core: Record<string, CustomTag> = {
      entity: {},
      string: {
        attributes: { name: { type: "atom" } },
        declares: { kind: "attribute", from: "name" },
      },
      policy: { attributes: { accept: { type: "atom", ref: "attribute" } } },
    };
    const extension: Record<string, CustomTag> = {
      money: {
        attributes: { name: { type: "atom" } },
        declares: { kind: "attribute", from: "name" },
      },
    };
    const tags = { ...core, ...extension };
    const source =
      "<entity><string :title/><money :price/><policy accept=[:title, :price]/></entity>";
    expect(() => compile(source, tags)).not.toThrow();
    // and they collide like any two declarations of one kind
    const dup = "<entity><string :x/><money :x/></entity>";
    expect(fails(dup, tags).message).toMatch(/x/);
  });
});

describe("registration", () => {
  it("rejects `values`, `pattern` and `ref` without type: 'atom'", () => {
    for (const bad of [
      { type: "string", values: ["a"] },
      { type: "string", pattern: "a" },
      { ref: "k" },
    ]) {
      expect(() =>
        compile("<box/>", { box: { attributes: { a: bad as never } } }),
      ).toThrow(/atom/);
    }
  });

  it("rejects an invalid pattern, a malformed declares entry and unknown keys", () => {
    expect(() =>
      compile("<box/>", {
        box: { attributes: { a: { type: "atom", pattern: "(" } } },
      }),
    ).toThrow(/pattern/);
    expect(() =>
      compile("<box/>", {
        box: { declares: { kind: "k", from: "nope" } as never },
      }),
    ).toThrow(/from/);
    expect(() =>
      compile("<box/>", { box: { declares: { from: "name" } as never } }),
    ).toThrow(/kind/);
    expect(() =>
      compile("<box/>", {
        box: { declares: { kind: "k", from: "id", scoped: "x" } as never },
      }),
    ).toThrow(/scoped/);
  });
});
