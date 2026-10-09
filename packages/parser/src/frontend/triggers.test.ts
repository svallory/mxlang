/**
 * `MxTrigger` (decision 182, PR A) in the front end: where each position's
 * node sits, its exact offsets, the stand-in the payload parsed, the span
 * invariant with triggers, and that the default row changes no tree.
 */
import { describe, expect, it } from "vitest";
import { PROBES } from "../template/grammar-spec.cases.ts";
import {
  createParser,
  DEFAULT_SYNTAX,
  type SyntaxTable,
  TagType,
  type Trigger,
} from "../template/index.ts";
import { parse } from "./parse.ts";
import { characters, expressionHeavy, tokens } from "./test-support/fuzz.ts";
import { checkInvariants } from "./test-support/invariants.ts";
import { OPTIONS } from "./test-support/options.ts";
import { projectDocument } from "./test-support/project.ts";

const MEMBER: Trigger = {
  id: "member",
  chars: "&",
  match: "&[A-Za-z_$][A-Za-z0-9_$]*",
  standIn: "identifier",
  node: { call: "member" },
};

const MESH: SyntaxTable = {
  ...DEFAULT_SYNTAX,
  expressionTriggers: [MEMBER],
  attributeTriggers: [MEMBER],
  lineTriggers: [MEMBER],
};

const meshParse = (source: string) =>
  parse(source, { ...OPTIONS, syntax: MESH });

// biome-ignore lint/suspicious/noExplicitAny: reads nodes of every shape
type Node = any;

/** The document's nodes and containers without Babel payloads, for exact comparison. */
const shape = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (key, field) => (key === "node" ? undefined : field)),
  );

describe("the & member row through the front end", () => {
  it("expression position: in the container's triggers, beside its atoms", () => {
    const document = meshParse("x=() => &status === :sent");
    expect(document.errors).toEqual([]);
    expect(checkInvariants(document, OPTIONS.tagShape)).toEqual([]);
    const value = (document.body[0] as Node).attributes[0].value;
    expect(value.source).toBe("() => &status === :sent");
    expect(value.atoms).toEqual([
      { type: "MxAtom", start: 20, end: 25, name: "sent" },
    ]);
    expect(value.triggers).toEqual([
      {
        type: "MxTrigger",
        start: 8,
        end: 15,
        id: "member",
        text: "&status",
        value: null,
      },
    ]);
    // The payload parsed `_status`, the same length, and is marked.
    const left = value.node.body.left;
    expect(left).toMatchObject({
      type: "Identifier",
      start: 8,
      end: 15,
      name: "_status",
      extra: {
        mxTrigger: { id: "member", span: { sourceStart: 8, sourceEnd: 15 } },
      },
    });
    expect(value.node.body.right).toMatchObject({
      type: "StringLiteral",
      value: "sent",
    });
  });

  it("expression position: two triggers in one value", () => {
    const document = meshParse("x load=[&customer, &other]");
    expect(document.errors).toEqual([]);
    expect(checkInvariants(document, OPTIONS.tagShape)).toEqual([]);
    const value = (document.body[0] as Node).attributes[0].value;
    expect(value.triggers).toEqual([
      {
        type: "MxTrigger",
        start: 8,
        end: 17,
        id: "member",
        text: "&customer",
        value: null,
      },
      {
        type: "MxTrigger",
        start: 19,
        end: 25,
        id: "member",
        text: "&other",
        value: null,
      },
    ]);
    expect(
      value.node.elements.map((e: Node) => [e.name, e.extra.mxTrigger.id]),
    ).toEqual([
      ["_customer", "member"],
      ["_other", "member"],
    ]);
  });

  it("attribute position: in the tag's attributes, in source order", () => {
    const document = meshParse("sort asc &dueOn");
    expect(document.errors).toEqual([]);
    expect(checkInvariants(document, OPTIONS.tagShape)).toEqual([]);
    expect(projectDocument(document)).toEqual([
      'tag "sort" [0,4) [0,15) open=[0,15) mode=html concise',
      '  attr "asc" [5,8) name=[5,8)',
      '  trigger member "&dueOn" [9,15)',
    ]);
    expect((document.body[0] as Node).attributes[1]).toEqual({
      type: "MxTrigger",
      start: 9,
      end: 15,
      id: "member",
      text: "&dueOn",
      value: null,
    });
  });

  it("line position: children of the enclosing block, with and without =value", () => {
    const document = meshParse("entity Order\n  &title\n  &amount=qty * price");
    expect(document.errors).toEqual([]);
    expect(checkInvariants(document, OPTIONS.tagShape)).toEqual([]);
    expect(projectDocument(document)).toEqual([
      'tag "entity" [0,6) [0,43) open=[0,12) mode=html concise',
      '  attr "Order" [7,12) name=[7,12)',
      '  trigger member "&title" [15,21)',
      '  trigger member "&amount" [24,43) = value "qty * price" [32,43)',
    ]);
    const [title, amount] = (document.body[0] as Node).body;
    expect(title).toEqual({
      type: "MxTrigger",
      start: 15,
      end: 21,
      id: "member",
      text: "&title",
      value: null,
    });
    expect(shape(amount)).toEqual({
      type: "MxTrigger",
      start: 24,
      end: 43,
      id: "member",
      text: "&amount",
      value: {
        type: "MxExpression",
        start: 32,
        end: 43,
        source: "qty * price",
        outer: { start: 32, end: 43 },
        atoms: [],
        error: null,
      },
    });
    expect(amount.value.node).toMatchObject({
      type: "BinaryExpression",
      operator: "*",
      start: 32,
      end: 43,
    });
  });

  it("a value's own triggers belong to the value's container", () => {
    const document = meshParse("&a=[&b, :c]");
    expect(document.errors).toEqual([]);
    expect(checkInvariants(document, OPTIONS.tagShape)).toEqual([]);
    const [line] = document.body as Node[];
    expect(line.value.triggers.map((t: Node) => [t.text, t.start])).toEqual([
      ["&b", 4],
    ]);
    expect(line.value.atoms.map((a: Node) => a.name)).toEqual(["c"]);
  });

  it("a fragment base offsets every trigger", () => {
    const document = parse("x=&a\n&b", {
      ...OPTIONS,
      syntax: MESH,
      base: { offset: 100, line: 3, column: 4 },
    });
    expect(checkInvariants(document)).toEqual([]);
    expect(
      (document.body[0] as Node).attributes[0].value.triggers[0],
    ).toMatchObject({ start: 102, end: 104 });
    expect(document.body[1]).toMatchObject({
      type: "MxTrigger",
      start: 105,
      end: 107,
    });
  });

  it("a text-only tag's lines still must start with `-`", () => {
    const document = meshParse("textarea\n  &a");
    expect(document.errors.map((e) => e.code)).toEqual(["INVALID_LINE_START"]);
  });

  it("a template error inside a trigger value is returned with the partial tree", () => {
    const document = meshParse("e\n  &a=");
    expect(document.complete).toBe(false);
    expect(document.errors.map((e) => e.code)).toEqual([
      "INVALID_ATTRIBUTE_VALUE",
    ]);
  });
});

describe("the table option", () => {
  it("an invalid table is a TypeError at the call, not an internal error", () => {
    expect(() =>
      parse("x", { ...OPTIONS, syntax: { ...MESH, concise: false } }),
    ).toThrow(TypeError);
  });

  it("DEFAULT_SYNTAX gives every grammar-corpus probe the tree of no table at all", () => {
    const differ = PROBES.filter((probe) => {
      const plain = parse(probe.input, OPTIONS);
      const tabled = parse(probe.input, { ...OPTIONS, syntax: DEFAULT_SYNTAX });
      return JSON.stringify(plain) !== JSON.stringify(tabled);
    }).map((probe) => probe.id);
    expect(differ).toEqual([]);
  });
});

describe("the & table over many inputs", () => {
  /**
   * The triggers the template parser announces, as `start,end`, with the
   * front end's statement typing (a concise keyword line is a statement,
   * which arms no trigger); tag body modes do not change what is armed.
   */
  const announced = (source: string): string[] => {
    const found: string[] = [];
    let open: number | undefined;
    createParser(
      {
        onTrigger: (t) => found.push(`${t.start},${t.end}`),
        onOpenTagStart: (r) => {
          open = r.start;
        },
        onOpenTagName: (t) => {
          const concise = open === undefined;
          open = undefined;
          const written = source.slice(t.start, t.end);
          return concise &&
            t.expressions.length === 0 &&
            OPTIONS.statementKeywords.has(written as never)
            ? TagType.statement
            : undefined;
        },
      },
      { syntax: MESH },
    ).parse(source);
    return found.sort();
  };
  const listed = (document: unknown): string[] => {
    const found: string[] = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      if (!value || typeof value !== "object") return;
      const node = value as Node;
      if (node.type === "MxTrigger") {
        found.push(`${node.start},${node.end}`);
      }
      for (const [key, field] of Object.entries(node)) {
        if (key !== "node") walk(field);
      }
    };
    walk((document as Node).body);
    return found.sort();
  };

  it("never throws, keeps the span invariant, and lists each announced trigger once", () => {
    const inputs: { id: string; source: string }[] = PROBES.map((p) => ({
      id: p.id,
      source: p.input,
    }));
    for (let seed = 1; seed <= 1000; seed++) {
      inputs.push({ id: `characters#${seed}`, source: characters(seed, 40) });
      inputs.push({ id: `tokens#${seed}`, source: tokens(seed) });
      inputs.push({ id: `expr#${seed}`, source: expressionHeavy(seed) });
    }
    // The corpus and fuzz inputs with an `&` written as a member.
    for (const p of PROBES) {
      if (/[=[(,]\s*[a-z]/.test(p.input)) {
        inputs.push({
          id: `${p.id}&`,
          source: p.input.replace(/([=[(,]\s*)([a-z])/g, "$1&$2"),
        });
      }
    }
    let withTriggers = 0;
    const problems: string[] = [];
    for (const { id, source } of inputs) {
      const document = meshParse(source);
      const where = `${id} ${JSON.stringify(source.slice(0, 80))}`;
      if (document.errors.some((e) => e.code === "MX_FRONT_END_INTERNAL")) {
        problems.push(`${where}: internal error`);
      }
      for (const problem of checkInvariants(document)) {
        problems.push(`${where}: ${problem}`);
      }
      const nodes = listed(document);
      if (nodes.length > 0) withTriggers++;
      if (new Set(nodes).size !== nodes.length) {
        problems.push(`${where}: a trigger listed twice`);
      }
      // Only a complete parse lists every announced trigger (an error stops
      // the tree where the template parser stopped).
      if (document.complete) {
        // A statement's continuation line (`static x = 1\n, &y`, g0895)
        // reports its words as attributes; the statement covers them, so
        // no node is built there, exactly as for `onAttrName`.
        const statements = (document.body as Node[]).filter(
          (node) => node.type === "MxModuleStatement",
        );
        const events = announced(source).filter((event) => {
          const start = Number(event.split(",")[0]);
          return !statements.some(
            (node) => node.start <= start && start < node.untrimmedEnd,
          );
        });
        if (JSON.stringify(events) !== JSON.stringify(nodes)) {
          problems.push(
            `${where}: announced ${events.join(" ")} listed ${nodes.join(" ")}`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
    expect(withTriggers).toBeGreaterThan(300);
  }, 120_000);
});
