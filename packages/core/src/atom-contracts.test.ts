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

function compile(
  source: string,
  customTags: Record<string, CustomTag>,
  host: HostDeclarations = declarations,
): void {
  compileSource(source, "/tmp/mx-atom-contracts/page.mx", host, {
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
  host?: HostDeclarations,
): TranslateError {
  try {
    compile(source, customTags, host);
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

/** A host that takes attribute-tag attributes (`attrTags: 2`). */
const attrTagHost: HostDeclarations = { ...declarations, attrTags: 2 };

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

describe("the name sugar against string, enum and atom (decision 156 addendum 6)", () => {
  const field = (name: object): Record<string, CustomTag> => ({
    field: { attributes: { name, x: { type: "string" } } },
  });

  it("satisfies a string-typed name as its string", () => {
    for (const source of ["<field :email/>", "<field:email/>"]) {
      expect(() => compile(source, field({ type: "string" }))).not.toThrow();
    }
  });

  it("satisfies an enum on name as its string, and a miss names the enum", () => {
    const tags = field({ enum: ["email", "phone"] });
    expect(() => compile("<field :email/>", tags)).not.toThrow();
    expect(fails("<field :emial/>", tags).message).toMatch(/one of .*email/);
  });

  it("satisfies an atom-typed name as the atom", () => {
    expect(() =>
      compile("<field :email/>", field({ type: "atom" })),
    ).not.toThrow();
  });

  it("is still a string for other types", () => {
    expect(fails("<field :email/>", field({ type: "number" })).message).toMatch(
      /must be number, got string/,
    );
  });

  it("an explicit atom against string stays an error", () => {
    const error = fails("<field name=:a x=:b/>", field({ type: "atom" }));
    expect(error.message).toMatch(/attribute `x` must be string, got atom/);
    expect(
      fails("<field name=:a/>", field({ type: "string" })).message,
    ).toMatch(/must be string, got atom/);
  });

  it('name="title" against an atom-typed name stays an error', () => {
    expect(
      fails('<field name="title"/>', field({ type: "atom" })).message,
    ).toMatch(/must be atom, got string/);
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
    const error = fails(bad, mesh);
    expect(error.message).toBe(
      "`<policy>`: attribute `load`: `:title` is not a declared relationship or computed here",
    );
    expect(pos(error)).toEqual(at(bad, ":title", 1));
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
    const error = fails(source, tags);
    expect(error.message).toBe(
      "`<policy>`: attribute `accept`: `:x` is not a declared attribute here",
    );
    expect(pos(error)).toEqual(at(source, ":x", 1));
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
    const miss = "<root><node#a/><link to=:c/></root>";
    const error = fails(miss, tags);
    expect(error.message).toBe(
      "`<link>`: attribute `to`: `:c` is not a declared node here",
    );
    expect(pos(error)).toEqual(at(miss, ":c"));
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
    const error = fails(source, tags);
    expect(error.message).toBe(
      "`<policy>`: attribute `accept`: `:a` is not a declared attribute here",
    );
    expect(pos(error)).toEqual(at(source, ":a", 1));
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
    const error = fails(bad, tags);
    expect(error.message).toBe(
      "`<use>`: attribute `v`: `:x` is not a declared k here",
    );
    expect(pos(error)).toEqual(at(bad, ":x", 1));
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
    const error = fails(outside, tags);
    expect(error.message).toBe(
      "`<policy>`: attribute `require`: `:implicit` is not a declared attribute or argument here",
    );
    expect(pos(error)).toEqual(at(outside, ":implicit"));
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

describe("round 3: attribute-tag attributes (decision 156 addendum 7)", () => {
  const tags: Record<string, CustomTag> = {
    node: { declares: { kind: "node", from: "id" } },
    box: {
      attributeTags: {
        row: {
          repeatable: true,
          attributes: {
            mode: { type: "atom", values: ["a", "b"] },
            code: { type: "atom", pattern: "^[a-z]+$" },
            to: { type: "atom", ref: "node" },
          },
          attributeTags: {
            cell: { attributes: { mode: { type: "atom", values: ["x"] } } },
          },
        },
      },
    },
  };

  it("values: a name outside the list is a positioned error with did-you-mean", () => {
    const source = "<box><@row mode=:zzz/></box>";
    const error = fails(source, tags, attrTagHost);
    expect(error.message).toBe(
      "`<box>`: `<@row>`: attribute `mode`: `:zzz` is not one of :a, :b",
    );
    expect({ line: error.line, column: error.column }).toEqual(
      at(source, ":zzz"),
    );
    expect(() =>
      compile("<box><@row mode=:a/></box>", tags, attrTagHost),
    ).not.toThrow();
    expect(fails("<box><@row mode=:c/></box>", tags, attrTagHost).message).toBe(
      "`<box>`: `<@row>`: attribute `mode`: `:c` is not one of :a, :b",
    );
  });

  it("pattern: a name that does not match is a positioned error", () => {
    const source = "<box><@row code=:A1/></box>";
    const error = fails(source, tags, attrTagHost);
    expect(error.message).toBe(
      "`<box>`: `<@row>`: attribute `code`: `:A1` does not match the pattern /^[a-z]+$/",
    );
    expect({ line: error.line, column: error.column }).toEqual(
      at(source, ":A1"),
    );
  });

  it("ref: resolves against the declarations the call can see", () => {
    expect(() =>
      compile("<box#b><@row to=:a/></box><node#a/>", tags, attrTagHost),
    ).not.toThrow();
    const source = "<node#a/><box><@row to=:nope/></box>";
    const error = fails(source, tags, attrTagHost);
    expect(error.message).toBe(
      "`<box>`: `<@row>`: attribute `to`: `:nope` is not a declared node here",
    );
    expect({ line: error.line, column: error.column }).toEqual(
      at(source, ":nope"),
    );
  });

  it("checks a nested attribute tag with the nested owner label", () => {
    const source = "<box><@row><@cell mode=:y/></@row></box>";
    const error = fails(source, tags, attrTagHost);
    expect(error.message).toBe(
      "`<box>`: `<@row>`: `<@cell>`: attribute `mode`: `:y` is not one of :x",
    );
    expect({ line: error.line, column: error.column }).toEqual(
      at(source, ":y"),
    );
  });

  it("checks an atom list on an attribute tag, at the item", () => {
    const source = "<box><@row mode=[:a, :q]/></box>";
    const error = fails(source, tags, attrTagHost);
    expect(error.message).toBe(
      "`<box>`: `<@row>`: attribute `mode`: `:q` is not one of :a, :b",
    );
    expect({ line: error.line, column: error.column }).toEqual(
      at(source, ":q"),
    );
  });

  it("checks every repeated attribute tag", () => {
    const source = "<box><@row mode=:a/><@row mode=:z/></box>";
    const error = fails(source, tags, attrTagHost);
    expect(error.column).toBe(at(source, ":z").column);
  });
});

describe("round 3: the default scope is the file (decision 156 addendum 7)", () => {
  const tags: Record<string, CustomTag> = {
    node: { declares: { kind: "node", from: "id" } },
    link: { attributes: { to: { type: "atom", ref: "node" } } },
    wrap: {},
  };

  it("top-level siblings see each other, in either order", () => {
    expect(() =>
      compile("<node#a/><node#b/><link to=:a/>", tags),
    ).not.toThrow();
    expect(() => compile("<link to=:b/><node#b/>", tags)).not.toThrow();
  });

  it("a declaration in one top-level tag is visible in another", () => {
    expect(() =>
      compile("<wrap><node#a/></wrap><wrap><link to=:a/></wrap>", tags),
    ).not.toThrow();
  });

  it("a miss still names the kind and position", () => {
    const source = "<node#a/><link to=:c/>";
    const error = fails(source, tags);
    expect(error.message).toBe(
      "`<link>`: attribute `to`: `:c` is not a declared node here",
    );
    expect({ line: error.line, column: error.column }).toEqual(
      at(source, ":c"),
    );
  });

  it("two top-level declarations of one name still clash", () => {
    const error = fails("<node#a/>\n<node#a/>", tags);
    expect(error.message).toBe("`a` is already declared as `node` at 1:7");
    expect(error.line).toBe(2);
  });

  it("a ctx.declare whose span is outside every call lands in the file scope", () => {
    const derived: Record<string, CustomTag> = {
      root: {
        analyze(_calls, ctx) {
          ctx.declare("k", "foo", { span: { sourceStart: 0, sourceEnd: 4 } });
        },
      },
      use: { attributes: { v: { type: "atom", ref: "k" } } },
    };
    expect(() =>
      compile("text here\n<root/><use v=:foo/>", derived),
    ).not.toThrow();
    const error = fails("text here\n<root/><use v=:bar/>", derived);
    expect(error.message).toBe(
      "`<use>`: attribute `v`: `:bar` is not a declared k here",
    );
  });
});

describe("round 3: type errors are positioned at the value", () => {
  const tags: Record<string, CustomTag> = {
    box: {
      attributes: { kind: { type: "atom" } },
      attributeTags: { row: { attributes: { kind: { type: "atom" } } } },
    },
  };

  it("a string where an atom is expected is at the string", () => {
    const source = '<box kind="title"/>';
    const error = fails(source, tags, attrTagHost);
    expect(error.message).toBe(
      "`<box>`: attribute `kind` must be atom, got string",
    );
    expect({ line: error.line, column: error.column }).toEqual(
      at(source, '"title"'),
    );
  });

  it("a number and a dynamic value are at the value", () => {
    const number = "<box kind=3/>";
    expect({ ...pos(fails(number, tags)) }).toEqual(at(number, "3"));
    const fn = "<box kind=() => 1/>";
    expect({ ...pos(fails(fn, tags)) }).toEqual(at(fn, "() => 1"));
  });

  it("an attribute tag's string is at the string too", () => {
    const source = '<box><@row kind="t"/></box>';
    const error = fails(source, tags, attrTagHost);
    expect(error.message).toBe(
      "`<box>`: `<@row>`: attribute `kind` must be atom, got string",
    );
    expect({ line: error.line, column: error.column }).toEqual(
      at(source, '"t"'),
    );
  });
});

function pos(error: TranslateError) {
  return { line: error.line, column: error.column };
}
