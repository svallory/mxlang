import * as babelParser from "@babel/parser";
import type { Node } from "@mxlang/core";

/**
 * Stock Marko's TypeScript pass replaces every read of an unexported
 * `const enum` member (`E.A`, `E["A"]`) with the member's value and removes
 * the declaration, so `${E.A}` prints the value and `typeof E` is
 * `"undefined"`. This module computes the member values and applies both
 * halves to a compiled module.
 */
type Value = number | string;

/** Member values of the const enums a compile has seen, by enum name. */
export type ConstEnums = Map<string, Map<string, Value>>;

const BINARY: Record<string, (a: number, b: number) => number> = {
  "+": (a, b) => a + b,
  "-": (a, b) => a - b,
  "*": (a, b) => a * b,
  "/": (a, b) => a / b,
  "%": (a, b) => a % b,
  "**": (a, b) => a ** b,
  "<<": (a, b) => a << b,
  ">>": (a, b) => a >> b,
  ">>>": (a, b) => a >>> b,
  "|": (a, b) => a | b,
  "&": (a, b) => a & b,
  "^": (a, b) => a ^ b,
};

/** The constant a member initializer stands for, or `undefined` when it is not one. */
function evaluate(
  node: Node,
  own: ReadonlyMap<string, Value>,
  known: ConstEnums,
  name: string,
): Value | undefined {
  switch (node?.type) {
    case "NumericLiteral":
    case "StringLiteral":
      return node.value;
    case "TemplateLiteral":
      return node.expressions.length === 0
        ? node.quasis[0].value.cooked
        : undefined;
    case "Identifier":
      return own.get(node.name);
    case "MemberExpression": {
      if (node.object?.type !== "Identifier") return undefined;
      const members =
        node.object.name === name ? own : known.get(node.object.name);
      const key = memberKey(node);
      return key === undefined ? undefined : members?.get(key);
    }
    case "UnaryExpression": {
      const operand = evaluate(node.argument, own, known, name);
      if (typeof operand !== "number") return undefined;
      if (node.operator === "-") return -operand;
      if (node.operator === "+") return operand;
      if (node.operator === "~") return ~operand;
      return undefined;
    }
    case "BinaryExpression": {
      const left = evaluate(node.left, own, known, name);
      const right = evaluate(node.right, own, known, name);
      if (left === undefined || right === undefined) return undefined;
      if (node.operator === "+" && typeof left === "string") {
        return left + right;
      }
      if (typeof left !== "number" || typeof right !== "number") {
        return undefined;
      }
      return BINARY[node.operator]?.(left, right);
    }
    default:
      return undefined;
  }
}

/** `E.A` and `E["A"]`: the member name, else `undefined`. */
function memberKey(node: Node): string | undefined {
  if (!node.computed) {
    return node.property?.type === "Identifier"
      ? node.property.name
      : undefined;
  }
  return node.property?.type === "StringLiteral"
    ? node.property.value
    : undefined;
}

/** The member values of a `const enum` declaration, `undefined` when one is not constant. */
function membersOf(
  declaration: Node,
  known: ConstEnums,
): Map<string, Value> | undefined {
  const members = new Map<string, Value>();
  let next: number | undefined = 0;
  for (const member of declaration.members ?? declaration.body?.members ?? []) {
    const key =
      member.id?.type === "Identifier" ? member.id.name : member.id?.value;
    if (typeof key !== "string") return undefined;
    let value: Value | undefined;
    if (member.initializer) {
      value = evaluate(member.initializer, members, known, declaration.id.name);
    } else {
      value = next;
    }
    if (value === undefined) return undefined;
    members.set(key, value);
    next = typeof value === "number" ? value + 1 : undefined;
  }
  return members;
}

const isUnexportedConstEnum = (statement: Node): boolean =>
  statement?.type === "TSEnumDeclaration" &&
  statement.const === true &&
  !statement.declare;

/** Records the unexported `const enum`s among a `client` statement's statements. */
export function collectConstEnums(statements: Node[], into: ConstEnums): void {
  for (const statement of statements) {
    if (!isUnexportedConstEnum(statement)) continue;
    const members = membersOf(statement, into);
    if (members) into.set(statement.id.name, members);
  }
}

function walk(value: unknown, visit: (node: Node) => boolean): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  const node = value as Node;
  if (typeof node.type === "string" && !visit(node)) return;
  for (const [key, field] of Object.entries(node)) {
    if (key === "loc" || key === "extra") continue;
    walk(field, visit);
  }
}

/**
 * `code` with the members of every unexported `const enum` replaced by their
 * values, and the declarations of those enums that `code` itself holds (a
 * `static`/`server` block) removed. `known` holds the enums a `client`
 * statement declared, which `code` does not contain.
 */
export function inlineConstEnums(code: string, known: ConstEnums): string {
  let program: Node;
  try {
    program = babelParser.parse(code, {
      sourceType: "module",
      plugins: [["typescript", { disallowAmbiguousJSXLike: false }]],
    }).program;
  } catch {
    return code;
  }
  const enums: ConstEnums = new Map(known);
  const removals: Array<{ start: number; end: number }> = [];
  for (const statement of program.body) {
    if (!isUnexportedConstEnum(statement)) continue;
    const members = membersOf(statement, enums);
    if (!members) continue;
    enums.set(statement.id.name, members);
    removals.push({ start: statement.start, end: statement.end });
  }
  if (enums.size === 0) return code;
  const edits: Array<{ start: number; end: number; text: string }> = [
    ...removals.map((r) => ({ ...r, text: "" })),
  ];
  walk(program.body, (node) => {
    if (removals.some((r) => r.start === node.start && r.end === node.end)) {
      return false;
    }
    if (node.type !== "MemberExpression") return true;
    if (node.object?.type !== "Identifier") return true;
    const key = memberKey(node);
    const value =
      key === undefined ? undefined : enums.get(node.object.name)?.get(key);
    if (value === undefined) return true;
    edits.push({
      start: node.start,
      end: node.end,
      text:
        typeof value === "string"
          ? JSON.stringify(value)
          : value < 0 || Object.is(value, -0)
            ? `(${value})`
            : `${value}`,
    });
    return false;
  });
  let result = code;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    const end =
      edit.text === "" && result[edit.end] === "\n" ? edit.end + 1 : edit.end;
    result = result.slice(0, edit.start) + edit.text + result.slice(end);
  }
  return result;
}
