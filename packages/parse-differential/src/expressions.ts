/**
 * The expression differential (PR 3, brief §1.2.8): every MX container's
 * Babel payload is structurally equal to the Babel node in today's tree at
 * the same position — type, every own field, `start`/`end`, `loc` with
 * `index`, `extra`, comments — after today's atom stand-ins are converted
 * with the same rule the front end uses (decision 156 addendum 1). A failed
 * container is compared against today's `MarkoParseError`: label and
 * bounded position.
 *
 * Today's tree carries no payload for a module statement's code (it is a
 * Marko tag with attributes; lowering slices the source), so those
 * containers have no counterpart and are skipped (`NOT_COMPARED`).
 * Tag-adjacent shorthand containers and `MxModuleStatement.code` are the
 * two skips; everything else must pair up.
 */
import { atomStandIn } from "../../parser/src/frontend/expressions.ts";
import { lineStartsOf, offsetOf } from "./rules.ts";

// biome-ignore lint/suspicious/noExplicitAny: Marko's and Babel's nodes are untyped here
type Node = any;

export interface TodayEntry {
  readonly kind:
    | "expression"
    | "statements"
    | "pattern"
    | "args"
    | "params"
    | "typeArgs"
    | "typeParams"
    | "template";
  /** The payload node, or an array of them (statements, args, params). */
  readonly nodes: readonly Node[];
  /** Today's failure, when the position holds a `MarkoParseError`. */
  readonly error?: { label: string; start: number; end: number };
  readonly start: number;
  readonly end: number;
}

const point = (node: Node): number =>
  node?.start ?? node?.loc?.start?.index ?? Number.MAX_SAFE_INTEGER;
const endOf = (node: Node): number =>
  node?.end ?? node?.loc?.end?.index ?? Number.MIN_SAFE_INTEGER;

/** The entry's range: payload extent, the error's container range on failure. */
function entryRange(nodes: readonly Node[]): { start: number; end: number } {
  let start = Number.MAX_SAFE_INTEGER;
  let end = Number.MIN_SAFE_INTEGER;
  for (const node of nodes) {
    start = Math.min(start, point(node));
    end = Math.max(end, endOf(node));
  }
  return { start, end };
}

/** Collects today's expression positions from the raw Marko AST, in document order. */
export function todayExpressions(
  ast: Node,
  source: string,
  starts: readonly number[],
): TodayEntry[] {
  const out: TodayEntry[] = [];
  const list = (nodes: readonly Node[], kind: TodayEntry["kind"]) => {
    if (!nodes || nodes.length === 0) return;
    const failed = nodes.length === 1 && nodes[0]?.type === "MarkoParseError";
    const range = entryRange(nodes);
    if (failed) {
      const error = nodes[0];
      // Marko's createParseError: `loc` is the container range, `errorLoc`
      // the bounded point.
      const start = offsetOf(starts, error.loc.start);
      const end = offsetOf(starts, error.loc.end);
      const pointAt = error.errorLoc
        ? {
            start: offsetOf(starts, error.errorLoc.start),
            end: offsetOf(starts, error.errorLoc.start),
          }
        : undefined;
      out.push({
        kind,
        nodes: [],
        error: {
          label: error.label,
          start: pointAt?.start ?? start,
          end: pointAt?.end ?? end,
        },
        start,
        end,
      });
      return;
    }
    out.push({ kind, nodes, start: range.start, end: range.end });
  };
  const one = (node: Node, kind: TodayEntry["kind"]) => {
    if (!node) return;
    list([node], kind);
  };
  const typeList = (value: Node, kind: TodayEntry["kind"]) =>
    list(
      Array.isArray(value)
        ? value
        : value?.type === "MarkoParseError"
          ? [value]
          : value
            ? [value]
            : [],
      kind,
    );

  /** Whether `=` precedes the node: an authored `x=function…` value, not Marko's method (`marko.ts`'s `afterEquals`). */
  const afterEquals = (node: Node): boolean => {
    let at = (node?.start ?? node?.loc?.start?.index ?? 0) - 1;
    while (at >= 0 && /\s/.test(source[at])) at--;
    return source[at] === "=";
  };
  const visitAttr = (attr: Node): void => {
    if (!attr) return;
    if (attr.type === "MarkoSpreadAttribute") {
      one(attr.value, "expression");
      return;
    }
    if (attr.arguments) list(attr.arguments, "args");
    const value = attr.value;
    if (value?.type === "FunctionExpression" && !afterEquals(value)) {
      // Marko's method shorthand: params and body parsed separately; the
      // body is `parseBlock`'s BlockStatement, directives and innerComments
      // included (A22).
      list(value.params, "params");
      typeList(value.typeParameters, "typeParams");
      const body = value.body?.body ?? [];
      if (body.length === 1 && body[0]?.type === "MarkoParseError")
        list(body, "statements");
      else
        one(
          {
            type: "Block",
            body,
            directives: value.body?.directives ?? [],
            innerComments: value.body?.innerComments ?? [],
          },
          "statements",
        );
      return;
    }
    one(value, "expression");
  };

  const visit = (node: Node): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    switch (node.type) {
      case "MarkoTag": {
        const name = node.name;
        // A dynamic name's payload: the parsed expression or template
        // literal; a static StringLiteral name is not a container.
        if (name && name.type !== "StringLiteral") {
          one(
            name,
            name.type === "TemplateLiteral" ? "template" : "expression",
          );
        }
        typeList(node.typeArguments, "typeArgs");
        one(node.var, "pattern");
        list(node.arguments, "args");
        typeList(node.body?.typeParameters, "typeParams");
        list(node.body?.params, "params");
        for (const attr of node.attributes ?? []) visitAttr(attr);
        visit(node.body?.body ?? []);
        visit(node.attributeTags ?? []);
        return;
      }
      case "MarkoPlaceholder":
        one(node.value, "expression");
        return;
      case "MarkoScriptlet": {
        // Marko keeps a scriptlet's block `innerComments` on the scriptlet
        // and drops its directives (`markoScriptlet(block.body)`); a failed
        // body is the bare `MarkoParseError`.
        const body = node.body ?? [];
        if (body.length === 1 && body[0]?.type === "MarkoParseError")
          list(body, "statements");
        else
          one(
            {
              type: "Block",
              body,
              innerComments: node.innerComments ?? [],
            },
            "statements",
          );
        return;
      }
      default:
        return;
    }
  };
  visit(ast.program?.body ?? []);
  // Convert today's atom stand-ins with the front end's own rule, so both
  // sides carry the public StringLiteral shape.
  for (const entry of out) convert(entry.nodes, source);
  return out;
}

/** `core/src/atoms.ts`'s conversion, applied to today's raw tree for the comparison. */
function convert(nodes: readonly Node[], source: string): void {
  const seen = new Set<unknown>();
  const visit = (value: Node): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value.type !== "string") return;
    const at = value.loc?.start?.index ?? value.start;
    if (value.type === "NumericLiteral" && source[at] === ":") {
      const end = value.loc?.end?.index ?? value.end;
      const name = source.slice(at + 1, end);
      value.type = "StringLiteral";
      value.value = name;
      value.extra = {
        raw: JSON.stringify(name),
        rawValue: name,
        mxAtom: { span: { sourceStart: at, sourceEnd: end } },
      };
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "loc" && key !== "extra") visit(child);
    }
  };
  nodes.forEach(visit);
}

export interface MxEntry {
  readonly kind: TodayEntry["kind"];
  readonly start: number;
  readonly end: number;
  readonly node: unknown;
  readonly error: { message: string; start: number; end: number } | null;
}

/** Collects the MX containers that have a counterpart in today's tree, in document order. */
export function mxExpressions(document: Node): MxEntry[] {
  const out: MxEntry[] = [];
  const KIND = {
    MxExpression: "expression",
    MxStatements: "statements",
    MxPattern: "pattern",
    MxArguments: "args",
    MxParameterList: "params",
    MxTypeArguments: "typeArgs",
    MxTypeParameters: "typeParams",
  } as const;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as Node;
    if (node.kind === "dynamic") return; // the tag's own branch handled it
    if (node.type === "MxShorthand" || node.type === "MxModuleStatement") {
      // No counterpart in today's tree (merged loc-less shorthands; a raw
      // string statement) — except the attribute-position sugar parts'
      // default/args, which today's merged attribute does carry.
      if (node.type === "MxShorthand") {
        visit(node.default);
        visit(node.args);
      }
      return;
    }
    if (typeof node.type === "string" && node.type in KIND && "outer" in node) {
      out.push({
        kind: KIND[node.type as keyof typeof KIND],
        start: node.start,
        end: node.end,
        node:
          node.type === "MxStatements" && node.error === null
            ? {
                type: "Block",
                body: node.node,
                directives: node.directives ?? [],
                innerComments: node.innerComments ?? [],
              }
            : node.node,
        error: node.error
          ? {
              message: node.error.message,
              start: node.error.start,
              end: node.error.end,
            }
          : null,
      });
      return;
    }
    // A dynamic name's container rides in `expression` (not the MxExpression key).
    if (node.type === "MxTag" || node.type === "MxReturn") {
      if (node.name?.kind === "dynamic") {
        const expression = node.name.expression;
        out.push({
          kind:
            expression.node?.type === "TemplateLiteral"
              ? "template"
              : "expression",
          start: expression.start,
          end: expression.end,
          node: expression.node,
          error: expression.error
            ? {
                message: expression.error.message,
                start: expression.error.start,
                end: expression.error.end,
              }
            : null,
        });
      }
    }
    for (const field of Object.values(node)) visit(field);
  };
  visit(document.body);
  return out;
}

const POSITION_KEYS = new Set(["start", "end", "loc"]);

/** Structural comparison: type, own fields, positions, extra, comments. */
export function nodeDifferences(
  mx: unknown,
  today: unknown,
  source: string,
  starts: readonly number[],
  path = "",
): string[] {
  const out: string[] = [];
  const fail = (what: string) => out.push(`${path || "node"}: ${what}`);

  if (Array.isArray(mx) || Array.isArray(today)) {
    const a = Array.isArray(mx) ? mx : [mx];
    const b = Array.isArray(today) ? today : [today];
    if (a.length !== b.length) {
      fail(`length ${a.length} != ${b.length}`);
      return out;
    }
    for (let i = 0; i < a.length; i++)
      out.push(...nodeDifferences(a[i], b[i], source, starts, `${path}[${i}]`));
    return out;
  }
  if (!mx || !today || typeof mx !== "object" || typeof today !== "object") {
    if (mx !== today) fail(`${show(mx)} != ${show(today)}`);
    return out;
  }

  const mxNode = mx as Node;
  const todayNode = today as Node;
  if (mxNode.type !== todayNode.type) {
    fail(`type ${mxNode.type} != ${todayNode.type}`);
    return out;
  }

  // Positions: either side may carry `start`/`end` or only `loc` with index.
  const ms = mxNode.start ?? mxNode.loc?.start?.index;
  const me = mxNode.end ?? mxNode.loc?.end?.index;
  const ts = todayNode.start ?? todayNode.loc?.start?.index;
  const te = todayNode.end ?? todayNode.loc?.end?.index;
  if (typeof ms === "number" && typeof ts === "number" && ms !== ts)
    fail(`start ${ms} != ${ts}`);
  if (typeof me === "number" && typeof te === "number" && me !== te)
    fail(`end ${me} != ${te}`);
  if (mxNode.loc && todayNode.loc) {
    for (const [key, a, b] of [
      ["line", mxNode.loc.start?.line, todayNode.loc.start?.line],
      ["column", mxNode.loc.start?.column, todayNode.loc.start?.column],
      ["end line", mxNode.loc.end?.line, todayNode.loc.end?.line],
      ["end column", mxNode.loc.end?.column, todayNode.loc.end?.column],
    ] as const) {
      if (typeof a === "number" && typeof b === "number" && a !== b)
        fail(`loc ${key} ${a} != ${b}`);
    }
  } else if (mxNode.loc && !todayNode.loc && typeof ms !== "number") {
    // neither positioned: fine (a rebuilt node)
  }

  const keys = new Set([...Object.keys(mxNode), ...Object.keys(todayNode)]);
  for (const key of keys) {
    if (POSITION_KEYS.has(key)) continue;
    const a = mxNode[key];
    const b = todayNode[key];
    if (a === undefined && b === undefined) continue;
    if (a === undefined || b === undefined) {
      // Today's tree went through `@babel/types`'s `cloneNode`, which keeps
      // only a node's declared `NODE_FIELDS`, `loc`, comments and `extra`: a
      // falsy field the raw parser sets (`method: false`, `id: null`) is
      // dropped there and carried here. Only a truthy MX-only field — or a
      // non-empty comments/extra mismatch — is a real difference.
      const present = (a === undefined ? b : a) as unknown;
      const empty =
        present === null ||
        present === false ||
        present === "" ||
        (Array.isArray(present) && present.length === 0) ||
        (present &&
          typeof present === "object" &&
          !Array.isArray(present) &&
          Object.keys(present).length === 0);
      if (empty) continue;
      fail(
        `${key}: only ${a === undefined ? "today" : "MX"} has it (${show(present)})`,
      );
      continue;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
      out.push(...nodeDifferences(a, b, source, starts, `${path}.${key}`));
      continue;
    }
    if (a && b && typeof a === "object" && typeof b === "object") {
      out.push(...nodeDifferences(a, b, source, starts, `${path}.${key}`));
      continue;
    }
    if (a !== b) fail(`${key} ${show(a)} != ${show(b)}`);
  }
  return out;
}

function show(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || typeof value !== "object") return String(value);
  return "{…}";
}

/**
 * Compares the two collected lists: every MX entry pairs with a today entry
 * of the same kind at an overlapping range; paired entries compare payload
 * or failure. Returns the differences and how many containers compared.
 */
export function compareExpressions(
  mx: readonly MxEntry[],
  today: readonly TodayEntry[],
  source: string,
): { compared: number; differences: string[] } {
  const differences: string[] = [];
  let compared = 0;
  const used = new Set<number>();
  for (const entry of mx) {
    // An empty payload (`()`, `||`) has nothing to compare: today's tree
    // holds an empty array with no range. A statements block with no body
    // but directives or inner comments does compare.
    const emptyBlock =
      entry.error === null &&
      Array.isArray(entry.node) &&
      entry.node.length === 0;
    const block = entry.node as { body?: unknown[] } | null;
    const emptyStatements =
      entry.error === null &&
      block !== null &&
      typeof block === "object" &&
      Array.isArray(block.body) &&
      block.body.length === 0;
    if (emptyBlock) continue;
    if (
      emptyStatements &&
      (block as { directives?: unknown[] }).directives?.length === 0 &&
      (block as { innerComments?: unknown[] }).innerComments?.length === 0
    )
      continue;
    let best = -1;
    for (let i = 0; i < today.length; i++) {
      if (used.has(i)) continue;
      const candidate = today[i] as TodayEntry;
      if (candidate.kind !== entry.kind) continue;
      const overlaps =
        candidate.start < entry.end && entry.start < candidate.end + 1;
      if (overlaps) {
        best = i;
        break;
      }
    }
    if (best < 0) {
      // A rebuilt template-literal node carries no position through Marko's
      // clone (A17): pair by kind order instead.
      const byKind = today.findIndex(
        (candidate, i) => !used.has(i) && candidate.kind === entry.kind,
      );
      if (
        byKind >= 0 &&
        (entry.kind === "template" ||
          today[byKind].start === Number.MAX_SAFE_INTEGER)
      ) {
        best = byKind;
      }
    }
    if (best < 0) {
      differences.push(
        `no counterpart in today's tree: ${entry.kind} [${entry.start},${entry.end}) ${JSON.stringify(source.slice(entry.start, entry.end))}`,
      );
      continue;
    }
    used.add(best);
    const pair = today[best] as TodayEntry;
    compared++;
    if (entry.error !== null) {
      if (!pair.error) {
        differences.push(
          `MX failed ${entry.kind} [${entry.start},${entry.end}) but today's parse succeeded`,
        );
      } else if (
        // Ruling 2026-10-08: Babel 7.29.8's wording (the fork) stands, so a
        // trailing period is the one accepted message difference.
        entry.error.message.replace(/\.$/, "") !==
          pair.error.label.replace(/\.$/, "") ||
        entry.error.start !== pair.error.start ||
        entry.error.end !== pair.error.end
      ) {
        differences.push(
          `${entry.kind} [${entry.start},${entry.end}): MX error ${JSON.stringify(entry.error.message)}@[${entry.error.start},${entry.error.end}) != today ${JSON.stringify(pair.error.label)}@[${pair.error.start},${pair.error.end})`,
        );
      }
      continue;
    }
    if (pair.error) {
      differences.push(
        `today failed ${entry.kind} [${entry.start},${entry.end}) (${JSON.stringify(pair.error.label)}) but MX's parse succeeded`,
      );
      continue;
    }
    const starts = lineStartsOf(source);
    differences.push(
      ...nodeDifferences(
        entry.node,
        pair.nodes,
        source,
        starts,
        `${entry.kind} [${entry.start},${entry.end})`,
      ).map(
        (line) =>
          `${source.slice(entry.start, entry.end).slice(0, 40)} | ${line}`,
      ),
    );
  }
  return { compared, differences };
}
