// MX's own test (not vendored): decision 156 atoms. `:name` where an
// expression is expected (attribute values, placeholders, tag and attribute
// arguments, method bodies) is an `atom` node inside the expression node,
// `::name` is one `reserved_atom` token, and the highlight query captures
// atoms as `@string.special.symbol` and the name sugar as `@label`, in the
// grammar's query and in the Zed extension's copy.
//
// The corpus is Mesh's: every line of the brief's sample, and every line of
// Mesh's syntax-v3 Invoice entity (test/fixtures/mesh-invoice.mx, from
// mesh notes/team-lead-2026-10-04/briefs/syntax-v3.md), which put an ERROR at
// the root on 0.1.0-alpha.1 because of its tagless `:name=value` lines.
//
// The last block is the default attribute's value (decision 151 ruling 2 and
// decision 146 addendum 5): the scanner does not end it at a sugar, except
// after a single atom.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Node, Query } from "web-tree-sitter";
import { MX, parseMx } from "../__tests__/util/language.mts";

const here = path.dirname(fileURLToPath(import.meta.url));

function root(src: string): Node {
  const tree = parseMx(src);
  if (!tree) throw new Error(`parse timed out: ${JSON.stringify(src)}`);
  return tree.rootNode;
}

function nodesOf(node: Node, types: string[], out: Node[] = []): Node[] {
  if (types.includes(node.type)) out.push(node);
  for (const child of node.children) if (child) nodesOf(child, types, out);
  return out;
}

/** `type:text@start` of every atom, reserved atom and ERROR node. */
function atoms(src: string): string[] {
  return nodesOf(root(src), ["atom", "reserved_atom", "ERROR"]).map(
    (n) => `${n.type}:${n.text}@${n.startIndex}`,
  );
}

// The brief's sample, one line per case, as full trees.
const SAMPLE: [src: string, tree: string][] = [
  [
    "entity :Invoice\n",
    "(document (element (tag_name (tag_name_fragment)) (shorthand_name (tag_name_fragment)) (concise_open_tag_end) (element_end)))",
  ],
  [
    "uuid :id primary-key\n",
    "(document (element (tag_name (tag_name_fragment)) (shorthand_name (tag_name_fragment)) (attr_name) (concise_open_tag_end) (element_end)))",
  ],
  [
    "enum :status values=[:draft, :sent] default=:draft\n",
    "(document (element (tag_name (tag_name_fragment)) (shorthand_name (tag_name_fragment)) (attr_name) (attr_value (attr_eq) (attr_value_expr (atom) (atom))) (attr_name) (attr_value (attr_eq) (attr_value_expr (atom))) (concise_open_tag_end) (element_end)))",
  ],
  [
    "belongs-to=:Customer :customer\n",
    "(document (element (tag_name (tag_name_fragment)) (attr_value (attr_eq) (attr_value_expr (atom))) (shorthand_name (tag_name_fragment)) (concise_open_tag_end) (element_end)))",
  ],
  [
    "timestamp :insertedAt on=:create\n",
    "(document (element (tag_name (tag_name_fragment)) (shorthand_name (tag_name_fragment)) (attr_name) (attr_value (attr_eq) (attr_value_expr (atom))) (concise_open_tag_end) (element_end)))",
  ],
  [
    "actions auto=[:read, :destroy] on:load=:visible\n",
    "(document (element (tag_name (tag_name_fragment)) (attr_name) (attr_value (attr_eq) (attr_value_expr (atom) (atom))) (attr_name) (attr_value (attr_eq) (attr_value_expr (atom))) (concise_open_tag_end) (element_end)))",
  ],
  [
    "set\n  :status=:paid\n",
    "(document (element (tag_name (tag_name_fragment)) (concise_open_tag_end) (element (tag_name) shorthand: (shorthand_name (tag_name_fragment)) (attr_value (attr_eq) (attr_value_expr (atom))) (concise_open_tag_end) (element_end)) (element_end)))",
  ],
  [
    "boolean :isOverdue({ self }) { return self.status === :sent }\n",
    "(document (element (tag_name (tag_name_fragment)) (shorthand_name (tag_name_fragment)) (args (args_open) (args_expr) (args_close)) (method_body (method_body_open) (method_body_expr (atom)) (method_body_close)) (concise_open_tag_end) (element_end)))",
  ],
  [
    "string :label filter=({ self }) => self.status === :sent\n",
    "(document (element (tag_name (tag_name_fragment)) (shorthand_name (tag_name_fragment)) (attr_name) (attr_value (attr_eq) (attr_value_expr (atom))) (concise_open_tag_end) (element_end)))",
  ],
];

describe("atoms: the brief's sample", () => {
  for (const [src, tree] of SAMPLE) {
    it(JSON.stringify(src), () => {
      assert.strictEqual(root(src).toString(), tree);
    });
  }
});

// [line, name sugar on it, atoms on it], for every line of the Invoice file
// that holds either. Lines not listed hold neither.
const INVOICE_LINES: [line: number, names: string[], atoms: string[]][] = [
  [4, [":Invoice"], []],
  [6, [":id"], []],
  [7, [":number"], []],
  [8, [":status"], [":draft", ":sent", ":paid", ":cancelled", ":draft"]],
  [9, [":amount"], []],
  [10, [":issuedOn"], []],
  [11, [":dueOn"], []],
  [12, [":paidAt"], []],
  [13, [":notes"], []],
  [14, [":needsReview"], []],
  [15, [":paidById"], []],
  [16, [":insertedAt"], [":create"]],
  [17, [":updatedAt"], [":update"]],
  [20, [":customer"], [":Customer"]],
  [21, [":lines"], [":InvoiceLine"]],
  [22, [":payment"], [":Payment"]],
  [25, [":isOverdue"], []],
  [26, [], [":sent"]],
  [28, [":label"], []],
  [31, [":lineCount"], []],
  [32, [":total"], []],
  [34, [], [":read", ":destroy", ":visible"]],
  [35, [], [":create", ":update"]],
  [37, [":dueAfterIssue"], []],
  [
    43,
    [":create"],
    [":number", ":customerId", ":amount", ":issuedOn", ":dueOn", ":notes"],
  ],
  [45, [":send"], []],
  [47, [":invoiceHasLines"], []],
  [54, [":status"], [":sent"]],
  [56, [":pay"], [":paidAt"]],
  [58, [":invoiceIsSent"], []],
  [59, [], [":sent"]],
  [63, [":invoiceHasLines"], []],
  [70, [":status"], [":paid"]],
  [71, [":paidById"], []],
  [74, [":needsReview"], []],
  [75, [], [":customer"]],
  [77, [":applyDiscount"], []],
  [79, [":percent"], []],
  [82, [":amount"], []],
  [84, [":visible"], []],
  [85, [], [":cancelled"]],
  [87, [":overdue"], []],
  [89, [], [":dueOn"]],
  [91, [":forCustomer"], []],
  [93, [":customerId"], []],
  [97, [":staffOrOwnerReads"], [":read"]],
  [99, [":staffWrites"], [":create", ":update", ":destroy"]],
  [101, [":neverDestroyPaid"], [":destroy"]],
  [102, [], [":paid"]],
];

describe("atoms: Mesh's Invoice entity", () => {
  const src = fs.readFileSync(
    path.join(here, "fixtures/mesh-invoice.mx"),
    "utf8",
  );
  const doc = root(src);

  it("parses with no ERROR or MISSING node", () => {
    assert.ok(!doc.hasError, doc.toString());
  });

  const byLine = (types: string[]) => {
    const lines = new Map<number, string[]>();
    for (const n of nodesOf(doc, types)) {
      const line = n.startPosition.row + 1;
      lines.set(line, [...(lines.get(line) ?? []), n.text]);
    }
    return lines;
  };
  const names = byLine(["shorthand_name"]);
  const found = byLine(["atom", "reserved_atom"]);
  const expected = new Map(INVOICE_LINES.map(([l, n, a]) => [l, [n, a]]));
  src.split("\n").forEach((text, at) => {
    const line = at + 1;
    if (!text.trim()) return;
    it(`line ${line}: ${text.trim()}`, () => {
      const [n, a] = expected.get(line) ?? [[], []];
      assert.deepStrictEqual(names.get(line) ?? [], n, "name sugar");
      assert.deepStrictEqual(found.get(line) ?? [], a, "atoms");
    });
  });

  // The four tagless `:name=value` lines Mesh reported on alpha.1, alone.
  for (const line of [
    ":status=:sent",
    ":needsReview=true",
    ":paidById=({ actor }) => actor.id",
    ":amount=({ self, input }) => self.amount * (1 - input.percent / 100)",
  ]) {
    it(`under set: ${line}`, () => {
      const set = root(`set\n  ${line}\n`);
      assert.ok(!set.hasError, set.toString());
    });
  }
});

// ADR 156: where a `:` starts an atom, and where it does not.
const POSITIONS: [name: string, src: string, atoms: string[]][] = [
  ["attribute value", "<div x=:b/>", ["atom::b@7"]],
  ["`x= :b` is the atom", "<div x= :b/>", ["atom::b@8"]],
  ["`x = :b` is the atom", "<div x = :b/>", ["atom::b@9"]],
  ["bound value", "<t x:=:a/>", ["atom::a@6"]],
  ["spread", "<t ...:a/>", ["atom::a@6"]],
  ["attribute tag value", "<@opt=:a/>", ["atom::a@6"]],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
  ["placeholder", "${:strict}", ["atom::strict@2"]],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
  ["concise placeholder", "div -- ${:a} text", ["atom::a@9"]],
  ["tag arguments", "<if(kind === :primary)>x</if>", ["atom::primary@13"]],
  ["attribute arguments", "<t x(:a)/>", ["atom::a@5"]],
  ["call arguments", "<t x=f(:a, :b)/>", ["atom::a@7", "atom::b@11"]],
  ["object value", "<t x={ k: :a }/>", ["atom::a@10"]],
  ["arrow body", "<t x=() => { return :a }/>", ["atom::a@20"]],
  ["unary operand", "<t x=-:a/>", ["atom::a@6"]],
  ["member access on an atom", "<t x=:a.length/>", ["atom::a@5"]],
  [
    "dashes, a trailing one excluded",
    "<t x=[:rename-all, :a-]/>",
    ["atom::rename-all@6", "atom::a@19"],
  ],
  ["`:a - b` is subtraction", "<t x=(:a - b)/>", ["atom::a@6"]],
  ["ternary of two atoms", "<t x=a ? :b : :c/>", ["atom::b@9", "atom::c@14"]],
  ['`a ? :b :c` is `a ? "b" : c`', "<t x=a ? :b :c/>", ["atom::b@9"]],
  ["ternary branch after a member", "<t x=a.b ? c : :d/>", ["atom::d@15"]],
  [
    "concise, atoms everywhere",
    "x=:a ? :b : :c",
    ["atom::a@2", "atom::b@7", "atom::c@12"],
  ],
  ["concise default value", "a x=:b\n  b", ["atom::b@4"]],
  ["`a ? b :c` is a ternary", "<t x=a ? b :c/>", []],
  ["`(x :number)` is a type", "<t x=(x :number) => x/>", []],
  ["after `as` is a type", "<t x=a as :b/>", []],
  ["`x=a :b` is the name sugar", "<t x=a :b/>", []],
  ["`[a :b]` is not an atom", "<t x=[a :b]/>", []],
  ["string", '<t x="a :b"/>', []],
  ["template text", "<t x=`a :b`/>", []],
  ["regex", "<t x=/:b/ />", []],
  ["static stays TypeScript", "static const a = :b", []],
  ["scriptlet stays TypeScript", "$ const a = :b", []],
  ["`::a` is reserved", "<t x=::a/>", ["reserved_atom:::a@5"]],
  ["`{k::a}` is reserved", "<t x={k::a}/>", ["reserved_atom:::a@7"]],
  ["`a?b::c` is reserved", "<t x=a?b::c/>", ["reserved_atom:::c@8"]],
];

describe("atoms: positions (ADR 156)", () => {
  for (const [name, src, expected] of POSITIONS) {
    it(name, () => {
      assert.deepStrictEqual(atoms(src), expected);
    });
  }
});

// A default attribute's value is the tag's `value=` with no name before the
// `=`. Decision 151 ruling 2 exempts it from the after-value rule, so `.ident`
// and `:ident` after whitespace stay part of the value (member access, as in
// Marko); decision 146 addendum 5 splits it at `:name` when the value is a
// single atom. A named attribute (and a spread) keep the rule. Same trees in
// html and concise mode; the values and the sugar as written.
function shape(src: string): [values: string[], sugar: string[]] {
  const doc = root(src);
  assert.ok(!doc.hasError, doc.toString());
  return [
    nodesOf(doc, ["attr_value", "attr_bound_value", "attr_spread"]).map(
      (n) => n.text,
    ),
    nodesOf(doc, ["shorthand_name", "shorthand_class", "shorthand_id"]).map(
      (n) => n.text,
    ),
  ];
}

const DEFAULT_VALUE: [src: string, values: string[], sugar: string[]][] = [
  // --- decision 151 ruling 2: the default value is exempt (html mode)
  ["<if=a .b></if>", ["=a .b"], []],
  ["<if=a :b></if>", ["=a :b"], []],
  ["<if=a ?? b :c></if>", ["=a ?? b :c"], []],
  ["<if=foo\n  .bar()></if>", ["=foo\n  .bar()"], []],
  ["<const/x=items\n  .filter(Boolean)/>", ["=items\n  .filter(Boolean)"], []],
  ["<let/x=a .b/>", ["=a .b"], []],
  ["<a=1 .d=2/>", ["=1 .d=2"], []],
  // A bound `:=` value with no name is the default value too.
  ["<x:=a .b/>", [":=a .b"], []],
  // A named attribute (and its own sugar) still splits after the value.
  ["<if=a b=1 .c></if>", ["=a", "=1"], [".c"]],
  // A spread is not exempt.
  ["<x ...a.b :c/>", ["...a.b"], [":c"]],
  // --- decision 146 addendum 5: a single atom splits at `:name`
  ["<x=:Customer :customer/>", ["=:Customer"], [":customer"]],
  ["<x=:A.b :c/>", ["=:A.b :c"], []],
  ["<x=:a + :b/>", ["=:a + :b"], []],
  ["<x=:a :b/>", ["=:a"], [":b"]],
  // --- the same in concise mode
  ["belongs-to=:Customer :customer\n", ["=:Customer"], [":customer"]],
  ["belongs-to=a :b\n", ["=a :b"], []],
  ["belongs-to=:A.b :c\n", ["=:A.b :c"], []],
  ["belongs-to=:a + :b\n", ["=:a + :b"], []],
  // --- regressions: a named attribute keeps the after-value split
  ["x y=a :b\n", ["=a"], [":b"]],
  ["x y=a .b\n", ["=a"], [".b"]],
  ["x y=:a :b\n", ["=:a"], [":b"]],
  ["<x y=a :b/>", ["=a"], [":b"]],
  ["<x y=a .b/>", ["=a"], [".b"]],
  ["<x y=:a :b/>", ["=:a"], [":b"]],
];

describe("default attribute values: ruling 2 and addendum 5", () => {
  for (const [src, values, sugar] of DEFAULT_VALUE) {
    it(JSON.stringify(src), () => {
      assert.deepStrictEqual(shape(src), [values, sugar]);
    });
  }
});

const QUERIES = {
  grammar: path.join(here, "../queries/highlights.scm"),
  zed: path.join(here, "../../zed/languages/mx/highlights.scm"),
};

describe("atoms: captures", () => {
  for (const [name, file] of Object.entries(QUERIES)) {
    it(`${name}: atoms are @string.special.symbol, the name sugar @label`, () => {
      const query = new Query(MX, fs.readFileSync(file, "utf-8"));
      const doc = root(
        "<:a x=:b/>\nenum :status values=[:draft] default=:draft\nbelongs-to=:C :c\n",
      );
      assert.ok(!doc.hasError, doc.toString());
      const caps = query
        .captures(doc)
        .filter((c) => c.name === "string.special.symbol" || c.name === "label")
        .map((c) => `${c.node.text}@${c.name}`);
      assert.deepStrictEqual(caps, [
        ":a@label",
        ":b@string.special.symbol",
        ":status@label",
        ":draft@string.special.symbol",
        ":draft@string.special.symbol",
        ":C@string.special.symbol",
        ":c@label",
      ]);
    });
  }
});
