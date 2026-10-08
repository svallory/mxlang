import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import { TranslateError } from "./core.ts";
import type {
  CustomTag,
  CustomTagAttributeTag,
  TagCall,
} from "./custom-tags.ts";
import type { HostDeclarations } from "./declarations.ts";
import { testTargetLookup } from "./test-targets.ts";

const targets = testTargetLookup();
const declarations: HostDeclarations = {
  tags: {},
  isElement: () => true,
  isComponent: () => false,
  attrTags: 2,
  resolveAttributeMethod: () => true,
};

function compile(
  source: string,
  attributeTags: CustomTag["attributeTags"],
): TagCall {
  let seen: TagCall | undefined;
  compileSource(source, "/tmp/mx-wildcard-attrtag/page.mx", declarations, {
    targets,
    customTags: {
      resource: {
        attributeTags,
        transform(call) {
          seen = call;
          void call.attributeTags;
          return [];
        },
      },
    },
    tagDiscoveryDirs: [],
    warnings: [],
    emitIr: () => "",
  });
  if (!seen) throw new Error("no call");
  return seen;
}

function error(
  source: string,
  attributeTags: CustomTag["attributeTags"],
): TranslateError {
  try {
    compile(source, attributeTags);
  } catch (caught) {
    if (caught instanceof TranslateError) return caught;
    throw caught;
  }
  throw new Error("expected a TranslateError");
}

describe('attributeTags["*"] matching', () => {
  it("a matched name takes the wildcard entry's inline contract: its attributes apply", () => {
    const call = compile("<resource><@action-run kind='x'/></resource>", {
      "*": { attributes: { kind: { type: "string", required: true } } },
    });
    expect(call.attributeTags[0]?.name).toBe("action-run");
    expect(call.attributeTags[0]?.attrs[0]).toMatchObject({ name: "kind" });
  });

  it("the pattern is anchored by MX: a partial match is no match", () => {
    const message = error("<resource><@action/></resource>", {
      "*": { pattern: "action-run" },
    }).message;
    expect(message).toContain("unknown attribute tag `<@action>`");
  });

  it("entries are tried in declaration order: the first match wins", () => {
    const call = compile("<resource><@on_click x=1/></resource>", {
      "*": [
        { pattern: "^on_.*", attributes: { x: { type: "number" } } },
        { attributes: { y: { type: "string" } } },
      ],
    });
    expect(call.attributeTags[0]?.name).toBe("on_click");
  });

  it("an entry with no pattern is a catch-all", () => {
    const call = compile("<resource><@anything/></resource>", { "*": {} });
    expect(call.attributeTags[0]?.name).toBe("anything");
  });

  it("explicit entries win over `*`", () => {
    const call = compile("<resource><@known a='explicit'/></resource>", {
      known: { attributes: { a: { type: "string" } } },
      "*": { attributes: { b: { type: "string" } } },
    });
    expect(call.attributeTags[0]?.name).toBe("known");
    // SAFETY: a static attribute always carries its name; only spreads do not.
    const attr = call.attributeTags[0]?.attrs[0] as { name?: string };
    expect(attr.name).toBe("a");
  });

  it("a name with no explicit entry and no match is the usual unknown-name error", () => {
    const message = error("<resource><@nope/></resource>", {
      "*": { pattern: "^action-" },
    }).message;
    expect(message).toContain("unknown attribute tag `<@nope>`");
  });

  it("an unmatched name is still unknown when only explicit entries exist", () => {
    expect(
      error("<resource><@nope/></resource>", { known: {} }).message,
    ).toContain("unknown attribute tag `<@nope>`");
  });

  it("the matched contract's nested attribute tags apply", () => {
    const nested: CustomTagAttributeTag = {
      attributeTags: { inner: { attributes: { n: { type: "number" } } } },
    };
    const call = compile("<resource><@row><@inner n=1/></@row></resource>", {
      "*": nested,
    });
    expect(call.attributeTags[0]?.attributeTags[0]?.name).toBe("inner");
  });

  it("an unmatched nested name under a wildcard-matched tag is unknown", () => {
    expect(() =>
      compile("<resource><@row><@nope/></@row></resource>", {
        "*": { attributeTags: { inner: {} } },
      }),
    ).toThrow(/unknown attribute tag `<@nope>`/);
  });

  it("an unknown attribute on a wildcard-matched tag is positioned", () => {
    expect(() =>
      compile("<resource><@row nope=1/></resource>", {
        "*": { attributes: {} },
      }),
    ).toThrow(/accepts no attributes/);
  });
});

describe('attributeTags["*"] cardinality', () => {
  it("`repeatable` applies per matched name: two `<@row>` under a non-repeatable entry is one error naming `row`", () => {
    const message = error("<resource><@row/><@row/></resource>", {
      "*": {},
    }).message;
    expect(message).toContain("attribute tag `<@row>` may not be repeated");
  });

  it("one `<@row>` and one `<@col>` under a non-repeatable entry are both fine", () => {
    const call = compile("<resource><@row/><@col/></resource>", { "*": {} });
    expect(call.attributeTags.map((tag) => tag.name)).toEqual(["row", "col"]);
  });

  it("repeatable: true allows the same name twice", () => {
    const call = compile("<resource><@row/><@row/></resource>", {
      "*": { repeatable: true },
    });
    expect(call.attributeTags).toHaveLength(2);
  });
});

describe('attributeTags["*"] registration errors', () => {
  it("a value that is neither an object nor a list of objects", () => {
    expect(() =>
      compileSource(
        "<resource/>",
        "/tmp/mx-wildcard-attrtag/page.mx",
        declarations,
        {
          targets,
          customTags: {
            resource: {
              attributeTags: {
                "*": 1,
              } as unknown as CustomTag["attributeTags"],
              transform: () => [],
            },
          },
          tagDiscoveryDirs: [],
          warnings: [],
          emitIr: () => "",
        },
      ),
    ).toThrow(
      /`attributeTags\["\*"\]` must be an entry object or a list of entry objects/,
    );
  });

  it("an unknown key in an entry", () => {
    expect(() =>
      compile("<resource/>", {
        "*": { contract: "x" } as unknown as CustomTagAttributeTag,
      }),
    ).toThrow(/Unknown key "contract"/);
  });

  it("`required` on an entry is rejected: a wildcard has no single name to require", () => {
    expect(() => compile("<resource/>", { "*": { required: true } })).toThrow(
      /Unknown key "required"/,
    );
  });

  it("a non-string pattern", () => {
    expect(() =>
      compile("<resource/>", {
        "*": { pattern: 1 } as unknown as CustomTagAttributeTag,
      }),
    ).toThrow(/`pattern` must be a string/);
  });

  it("an invalid pattern", () => {
    expect(() => compile("<resource/>", { "*": { pattern: "(" } })).toThrow(
      /invalid `pattern`/,
    );
  });

  it("a pattern whose unbalanced `)` would escape the anchors", () => {
    expect(() =>
      compile("<resource/>", { "*": { pattern: "a)|(?:b" } }),
    ).toThrow(/invalid `pattern`/);
  });

  it("an inline entry that contains itself", () => {
    const entry: CustomTagAttributeTag = {};
    const declared = entry as CustomTagAttributeTag & { attributeTags?: never };
    entry.attributeTags = { "*": declared as never };
    expect(() => compile("<resource/>", { "*": entry })).toThrow(
      /`attributeTags\["\*"\]` holds an entry that contains itself/,
    );
  });
});
