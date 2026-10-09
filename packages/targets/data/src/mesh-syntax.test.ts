/**
 * Slice a1 of `lang-ext-move-sugars-to-mesh` (decisions 183 and 196): Mesh's
 * syntax v4 reference file through `parseData` with the combined reference
 * module `@mxlang/core/syntax/mesh` (atoms and the name sugars as layer-2
 * triggers, plus the `&` member rows), loaded the two ways a consumer loads
 * it. The shapes Mesh reads stay those of the built-in path: a whole-value
 * atom is `{ kind: "atom" }`, an atom inside an expression a `StringLiteral`
 * marked `extra.mxAtom`, a member `{ kind: "member" }` or `extra.mxMember`.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SyntaxModule } from "@mxlang/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ParseDataOptions, parseData } from "./parse.ts";
import type { DataAttr, DataTag } from "./tree.ts";

const MODULE = join(import.meta.dirname, "../../../core/src/syntax/mesh.ts");

/** Through Node's strip-only `require`, as a manifest's `mx.syntax` loads it. */
const meshSyntax = (
  createRequire(import.meta.url)(MODULE) as { default: SyntaxModule }
).default;

let dir: string;
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-mesh-syntax-")));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "mesh-app", mx: { syntax: MODULE } }),
  );
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const BASE: ParseDataOptions = { structural: "reject", imports: "pass" };

const LOADERS: [string, () => [string, ParseDataOptions]][] = [
  ["a manifest naming the module", () => [join(dir, "invoice.mesh.mx"), BASE]],
  [
    "the `syntax` option",
    () => ["/v/invoice.mesh.mx", { ...BASE, syntax: meshSyntax }],
  ],
];

/** An excerpt of `scratch/mesh-syntax-v4.md`'s reference file, every v4 form once. */
const INVOICE = `import { Customer } from "./customer.mesh.mx"

entity :Invoice table="invoices"
  attributes
    uuid :id primary-key
    enum :status values=[:draft, :sent, :paid] default=:draft
    date :dueOn
  relationships
    belongs-to :customer entity=Customer
  computed
    boolean :isOverdue() {
      return &status === :sent && &dueOn < today()
    }
  actions auto=[:read, :destroy] on:load=&visible
    update :send
      do
        set
          &status=:sent
    read :overdue
      filter=() => &isOverdue
      sort
        asc &dueOn
`;

function tags(nodes: readonly unknown[]): DataTag[] {
  return nodes.filter(
    (node): node is DataTag => (node as DataTag).kind === "tag",
  );
}

/** The first tag named `name`, depth first. */
function find(nodes: readonly unknown[], name: string): DataTag {
  for (const tag of tags(nodes)) {
    if (tag.name === name) return tag;
    try {
      return find(tag.children, name);
    } catch {
      // not under this one
    }
  }
  throw new Error(`no <${name}>`);
}

function attr(tag: DataTag, name: string): DataAttr {
  const found = tag.attrs.find(
    (each) => each.kind !== "spread" && each.name === name,
  );
  if (!found) throw new Error(`no attribute ${name} on <${tag.name}>`);
  return found;
}

describe.each(LOADERS)("Mesh's v4 reference file through %s", (_, load) => {
  function parsed() {
    const [file, options] = load();
    const result = parseData(INVOICE, file, options);
    expect(result.diagnostics).toEqual([]);
    return result.tree as NonNullable<typeof result.tree>;
  }

  it("a declaration's name is a whole-value atom", () => {
    const tree = parsed();
    expect(attr(find(tree.children, "entity"), "name")).toMatchObject({
      kind: "atom",
      value: "Invoice",
    });
    expect(attr(find(tree.children, "uuid"), "name")).toMatchObject({
      kind: "atom",
      value: "id",
    });
  });

  it("atoms in expressions are marked string literals", () => {
    const tree = parsed();
    const status = find(tree.children, "enum");
    expect(attr(status, "default")).toMatchObject({
      kind: "atom",
      value: "draft",
    });
    const values = attr(status, "values");
    if (values.kind !== "expression") throw new Error(values.kind);
    expect(values.value.node).toMatchObject({
      type: "ArrayExpression",
      elements: [
        { type: "StringLiteral", value: "draft", extra: { mxAtom: {} } },
        { type: "StringLiteral", value: "sent" },
        { type: "StringLiteral", value: "paid" },
      ],
    });
  });

  it("`:name` then a method is the name and the default value, members inside", () => {
    const overdue = find(parsed().children, "boolean");
    expect(attr(overdue, "name")).toMatchObject({
      kind: "atom",
      value: "isOverdue",
    });
    const value = attr(overdue, "value");
    expect(value.kind).toBe("expression");
    expect(JSON.stringify(value)).toContain('"mxMember"');
    expect(JSON.stringify(value)).toContain('"mxAtom"');
  });

  it("members after a kind, on a tagless line and in a value", () => {
    const tree = parsed();
    expect(attr(find(tree.children, "asc"), "member")).toMatchObject({
      kind: "member",
      value: "dueOn",
    });
    const member = find(find(tree.children, "set").children, "member");
    expect(attr(member, "name")).toMatchObject({ value: "status" });
    expect(attr(member, "value")).toMatchObject({
      kind: "atom",
      value: "sent",
    });
    const load = find(tree.children, "actions").attrs.find(
      (each) => each.kind !== "spread" && each.name.startsWith("on"),
    );
    expect(JSON.stringify(load)).toContain('"mxMember"');
  });
});

describe("what the module refuses (decision 183)", () => {
  it.each([
    ["kind #x=1\n", "The `#x` shorthand takes no value.", 7],
    ["kind .c=1\n", "The `.c` shorthand takes no value.", 7],
    ["kind #name(p) { b }\n", "The `#name` shorthand takes no value.", 10],
  ])("%j", (source, message, offset) => {
    const { diagnostics } = parseData(source, "/v/x.mx", {
      syntax: meshSyntax,
    });
    expect(diagnostics[0]).toMatchObject({ message, offset });
  });
});
