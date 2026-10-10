/**
 * `@mxlang/core/syntax/atoms-sugars` (@unstable): a reference dialect
 * (lang-ext-move-sugars-to-mesh, slice a1; decisions 183 and 196): MX's
 * atoms (decision 156) and name sugars (decision 146) as layer-2 triggers,
 * reproducing what core does for them today.
 *
 * Lifetime (decision 183 addendum 6): this module and `syntax/mesh` stay
 * exported, `@unstable`, through the beta, as reference material for
 * extension authors, not as a host's API. Mesh vendors (copies) them at
 * the alpha.15 pin and owns its copy from then on.
 *
 * What it reads:
 *
 * - `:name` in an expression is an atom: a `StringLiteral` of the name
 *   marked `extra.mxAtom = { span }`. It is a name, not a value to operate
 *   on: member access, calls, unary operators, spreading and use as an
 *   object key are refused. `::name` is reserved.
 * - `:name` in an attribute list sets `name` to the atom, spelled by its
 *   token (`authored`), once per tag. Followed by `=value` or
 *   `(params) { body }` it also sets the tag's default value. An async
 *   method (`async :name(p) { b }`, `ctx.valueForm` `"async-method"`) is
 *   refused: Mesh's contracts accept no async method values.
 * - Spaced `#id` and `.class` (chains such as `#main.big` included) are
 *   shorthands, exactly as Marko's tag-adjacent `#id` / `.class`. They take
 *   no value: the table refuses `=`, `:=` and `(` after them (decision 183).
 * - All three attribute rows end a preceding attribute value
 *   (`terminatesValue`): `x=a.b .c` is `x=a.b` and class `c`.
 * - The atom contract keys (`values`, `pattern`, `ref`, `declares`) are
 *   this module's (`contractFields`), checked by its `afterLower` from the
 *   unit's public view, with core's built-in wording and positions
 *   (slice a2; see "Atom contracts" below).
 *
 * Its messages are the user's: they quote no MX decision numbers.
 *
 * Self-contained: it imports types only, so a dialect package's
 * `mxDialect.module` can name it, and Mesh can copy it (`mesh.ts` combines it with the
 * member module).
 */
import type {
  ContractAttr,
  ContractAttributeTag,
  ContractCall,
  ContractCheckContext,
  ContractData,
  ContractFields,
  Dialect,
  LoweredUnit,
  SourceSpan,
  Trigger,
  TriggerAttribute,
  TriggerContext,
  TriggerResult,
  TriggerShorthand,
} from "../index.ts";

/** An atom's name: an identifier, `-` between words (`:rename-all`). */
const NAME = "[A-Za-z_$][\\w$]*(?:-[\\w$]+)*";

/** `:name` in an expression; `::` (with or without a name) is matched so the hook can name it reserved. */
export const ATOM: Trigger = Object.freeze({
  id: "atom",
  chars: ":",
  match: `::(?:${NAME})?|:${NAME}`,
  standIn: "number",
  node: Object.freeze({ call: "atom" }),
});

/**
 * One item of a sugar token, as the attribute-name lexer reads it: a plain
 * character, a `/` that is no comment, a bracket run (`.bg-[#fff]`), or `:`
 * / `::` before a plain character (`#id:name`, `::x`).
 */
const PLAIN = "[^\\x00-\\x20,=()<>/:;\"'`[\\]{}]";
const SLASH = "/[^\\x00-\\x20,=()<>/:;\"'`[\\]{}*]";
const BRACKETS = "\\[[^\\x00-\\x20\"'`[\\]{}]{0,64}\\]";
const ITEM = `(?:${PLAIN}|${SLASH}|${BRACKETS}|:{1,2}${PLAIN})`;
/** A class starts with a name character, so `x=a .5` stays one value. */
const NAME_START = "[A-Za-z_$\\u200c\\u200d\\p{ID_Start}\\p{Mn}\\p{Mc}\\p{Pc}]";

/** `:name` in an attribute list (`uuid :id`). */
export const NAME_SUGAR: Trigger = Object.freeze({
  id: "name",
  chars: ":",
  match: `::?[A-Za-z_$]${ITEM}*`,
  standIn: "keep",
  node: Object.freeze({ call: "name" }),
  terminatesValue: true,
});

/** Spaced `#id` (a chain: `#main.big`). */
export const ID_SUGAR: Trigger = Object.freeze({
  id: "id",
  chars: "#",
  match: `#${ITEM}+`,
  standIn: "keep",
  node: Object.freeze({ call: "shorthand" }),
  terminatesValue: true,
  value: "refuse",
});

/** Spaced `.class` (a chain: `.big#main`). */
export const CLASS_SUGAR: Trigger = Object.freeze({
  id: "class",
  chars: ".",
  match: `\\.${NAME_START}${ITEM}*`,
  standIn: "keep",
  node: Object.freeze({ call: "shorthand" }),
  terminatesValue: true,
  value: "refuse",
});

const IDENTIFIER = /^[A-Za-z_$][\w$-]*$/;

const SECOND_NAME =
  'a tag takes one `:name`; this one already has a name (write the second as `name="…"`)';

/** `{written}` and `{first}` are filled by core (`once`): the later default as written, the earlier one's line:column. */
const SECOND_DEFAULT =
  "`{written}` would set the default attribute (`value`), but the tag already has a default value (at {first}); a sugar followed by `=value` or `(params) { body }` sets it, so write `value=…` once";

const BOUND =
  "a bound value is not supported on name sugar; write name=... value:=...";

/** `async` written before `:name(…) { … }`: the default value would be an async function. */
function asyncMethod(name: string): string {
  return `\`async :${name}(…) { … }\` is not supported: a \`:name\` method value cannot be async; remove \`async\``;
}

function reserved(name: string): string {
  return `\`::${name}\` is reserved: \`::\` will be the Symbol.for sugar; write \`:${name || "name"}\` for an atom`;
}

function misuse(name: string, what: string): string {
  return `\`:${name}\` is an atom, a name and not a value to operate on: ${what} is not allowed on it; write \`"${name}"\` for a string you mean to operate on`;
}

/** `:name` in an expression: the atom, or the module's refusal of its use. */
function atom(
  text: string,
  span: SourceSpan,
  ctx: TriggerContext,
): TriggerResult {
  if (text.startsWith("::")) ctx.fail(reserved(text.slice(2)));
  const name = text.slice(1);
  switch (ctx.use) {
    case "member-object":
      ctx.fail(misuse(name, "member access"));
      break;
    case "callee":
      ctx.fail(misuse(name, "a call"));
      break;
    case "unary":
      ctx.fail(misuse(name, `the unary operator \`${ctx.operator}\``));
      break;
    case "spread":
      ctx.fail(misuse(name, "spreading"));
      break;
    case "key":
      ctx.fail(
        `\`:${name}\` cannot be an object key: an atom is a value; write \`${name}:\` for the key, or \`[:${name}]\` to compute it from the atom`,
      );
  }
  return ctx.expression({
    type: "StringLiteral",
    value: name,
    extra: { raw: JSON.stringify(name), rawValue: name, mxAtom: { span } },
  });
}

/**
 * `:name` in an attribute list: `name` set to the atom, and the default
 * value when one follows. `at` is the `:name` token's span.
 */
function nameSugar(
  name: string,
  ctx: TriggerContext,
  at: SourceSpan,
): TriggerAttribute[] {
  if (name.startsWith(":")) ctx.fail(reserved(name.slice(1)));
  const second = name.indexOf(":");
  if (second >= 0) {
    // At the second `:name`, as core's own check put it.
    const from = at.sourceStart + 1 + second;
    ctx.fail(SECOND_NAME, {
      at: { sourceStart: from, sourceEnd: at.sourceEnd },
    });
  }
  if (!IDENTIFIER.test(name)) {
    ctx.fail(
      `\`:${name}\` is not name sugar; \`:name\` takes an identifier (\`:email\`, \`:first-name\`)`,
    );
  }
  if (ctx.valueForm === ":=") ctx.fail(BOUND, { at });
  if (ctx.valueForm === "async-method") ctx.fail(asyncMethod(name), { at });
  if (ctx.valueForm === "arguments") {
    ctx.fail(
      `arguments are not allowed on \`:name\`: \`:${name}(…)\` is name sugar, not an attribute method`,
      { at },
    );
  }
  // A second spaced `:name` follows the duplicate rule (last wins, with a
  // warning), as any attribute; only `:a:b` in one token is refused above.
  const attrs = [
    ctx.attribute("name", { kind: "atom", name }, { authored: true, at }),
  ];
  if (ctx.value) {
    attrs.push(
      ctx.attribute(null, ctx.value, { authored: true, once: SECOND_DEFAULT }),
    );
  }
  return attrs;
}

/** `#a.b:c`: its shorthands in order, and a trailing `:name`. */
function shorthands(
  text: string,
  span: SourceSpan,
  ctx: TriggerContext,
): (TriggerAttribute | TriggerShorthand)[] {
  const colon = text.indexOf(":");
  const chain = colon < 0 ? text : text.slice(0, colon);
  const parts: (TriggerAttribute | TriggerShorthand)[] = [];
  for (const part of chain.matchAll(/([#.])([^#.]*)/g)) {
    const [, sigil, word] = part;
    if (word === "") {
      const from = span.sourceStart + (part.index ?? 0);
      ctx.fail(`\`${sigil}\` needs a name after it (\`${sigil}main\`)`, {
        at: { sourceStart: from, sourceEnd: from + 1 },
      });
    }
    parts.push(ctx.shorthand(sigil === "#" ? "id" : "class", word as string));
  }
  if (colon >= 0) {
    const at = {
      sourceStart: span.sourceStart + colon,
      sourceEnd: span.sourceEnd,
    };
    // After a chain, core's check puts a second name at the `:name` part.
    if (text.indexOf(":", colon + 1) > colon + 1) ctx.fail(SECOND_NAME, { at });
    parts.push(...nameSugar(text.slice(colon + 1), ctx, at));
  }
  return parts;
}

/*
 * Atom contracts (decision 156, ADR 156 section 4), as this module's
 * `checkContract` and `afterLower` (lang-ext-move-sugars-to-mesh slice a2). The module claims
 * the contract keys (`contractFields`): an attribute's `values`, `pattern`
 * and `ref`, and a tag's `declares`. Core accepts them unchecked and hands
 * them over on `ContractCall.contract`; core keeps the whole-value shape
 * check (`type: "atom"`, decision 156 addendum 6). The diagnostics are
 * core's built-in ones, word for word and at the same positions.
 *
 * 0. **Register** (`checkContract`). Core hands every registered contract
 *    that uses a claimed key to the module, which checks those keys as
 *    core's registration checks them; core places the error as its own.
 * 1. **Declare.** Every call's `declares` entry, plus every name an
 *    `analyze` hook declared, becomes a declaration owned by a scope (a tag
 *    instance). Two of one name and kind in a scope clash.
 * 2. **Check.** Every atom of a contract attribute that states `values`,
 *    `pattern` or `ref` is checked; a `ref` resolves against every
 *    enclosing scope, innermost first, the file scope last.
 *
 * Single file only: a name `ref` cannot find in the file is an error.
 */

/** The contract keys this module owns. */
const CONTRACT_FIELDS: ContractFields = Object.freeze({
  attribute: Object.freeze(["values", "pattern", "ref"]),
  tag: Object.freeze(["declares"]),
});

/** An attribute declaration, as far as this module reads it. */
interface AtomDeclaration {
  readonly type?: unknown;
  readonly values?: readonly string[];
  readonly pattern?: string;
  readonly ref?: string | readonly string[];
}

/** One `declares` entry. */
interface DeclaresEntry {
  readonly kind: string;
  readonly from: string;
  readonly scope?: string | readonly string[];
  readonly uniqueWith?: readonly string[];
  readonly under?: string | readonly string[];
}

interface Declaration {
  kind: string;
  name: string;
  span: SourceSpan;
  uniqueWith: readonly string[];
}

/** Scope owner -> name -> declarations of that name (one per kind). */
type Scopes = Map<object, Map<string, Declaration[]>>;

/** What a contract says about the names an atom may take. */
interface AtomContract {
  values?: readonly string[];
  pattern?: string;
  ref?: readonly string[];
}

/** The file scope: the default owner, and the outermost link of every chain (decision 156 addendum 7). */
const FILE_SCOPE = Object.freeze({});

const DECLARES_KEYS = ["kind", "from", "scope", "uniqueWith", "under"];

/** Most candidates a diagnostic lists before it says `+N more`. */
const CANDIDATE_CAP = 10;

function asList<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value as T];
}

/** A non-empty string, or a non-empty array of them. */
function nonEmptyStrings(value: unknown): boolean {
  const ok = (item: unknown) => typeof item === "string" && item !== "";
  return Array.isArray(value) ? value.length > 0 && value.every(ok) : ok(value);
}

/** "`a`", "`a` or `b`", "`a`, `b` or `c`". */
function orList(names: readonly string[]): string {
  const quoted = names.map((name) => `\`${name}\``);
  return quoted.length < 2
    ? quoted.join("")
    : `${quoted.slice(0, -1).join(", ")} or ${quoted.at(-1)}`;
}

/** `:a, :b, :c`, sorted, at most ten, then ` +N more`. */
function atomList(names: readonly string[]): string {
  const sorted = [...names].sort();
  const shown = sorted.slice(0, CANDIDATE_CAP).map((name) => `:${name}`);
  const rest = sorted.length - shown.length;
  return `${shown.join(", ")}${rest > 0 ? ` +${rest} more` : ""}`;
}

/** 1-based line and 0-based column of `offset`, as core reports positions. */
function lineColumn(
  source: string,
  offset: number,
): { line: number; column: number } {
  const lines = source.split("\n");
  let line = 1;
  let lineStart = 0;
  for (const text of lines) {
    const lineEnd = lineStart + text.length;
    if (offset <= lineEnd) return { line, column: offset - lineStart };
    line++;
    lineStart = lineEnd + 1;
  }
  return {
    line: Math.max(1, lines.length),
    column: Math.max(0, offset - lineStart),
  };
}

/** Optimal-string-alignment distance: insert, delete, substitute, swap adjacent. */
function distance(a: string, b: string): number {
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    const row: number[] = [i];
    for (let j = 1; j <= b.length; j++) row[j] = i === 0 ? j : 0;
    rows.push(row);
  }
  for (let i = 1; i <= a.length; i++) {
    const row = rows[i] as number[];
    const above = rows[i - 1] as number[];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(
        (above[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (above[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(
          row[j] as number,
          ((rows[i - 2] as number[])[j - 2] as number) + 1,
        );
      }
    }
  }
  return (rows[a.length] as number[])[b.length] as number;
}

/**
 * The one candidate nearest to `name`, or `undefined` when nothing is close
 * enough or two tie: one edit always counts, two from five characters, and a
 * name under three never suggests; case-insensitive.
 */
function nearestName(
  name: string,
  candidates: Iterable<string>,
): string | undefined {
  if (name.length < 3) return undefined;
  const limit = name.length >= 5 ? 2 : 1;
  const lower = name.toLowerCase();
  let best: string | undefined;
  let bestDistance = limit + 1;
  let tied = false;
  for (const candidate of new Set(candidates)) {
    if (candidate === name) continue;
    const d = distance(lower, candidate.toLowerCase());
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
      tied = false;
    } else if (d === bestDistance && best !== undefined) {
      tied = true;
    }
  }
  return tied ? undefined : best;
}

// ---------------------------------------------------------------------------
// 0. Register (`checkContract`): the claimed keys, as core's registration
//    checks them, for every registered contract that uses one.
// ---------------------------------------------------------------------------

/** `ctx.fail` of `checkContract`: raised where core's registration error lands. */
type Fail = ContractCheckContext["fail"];

/** A malformed `declares`, as core's registration words it. */
function checkDeclares(fail: Fail, tag: string, declares: unknown): void {
  if (declares === undefined) return;
  const entries: unknown[] = Array.isArray(declares) ? declares : [declares];
  const reject = (problem: string): never =>
    fail(`Invalid \`declares\` of tag "${tag}": ${problem}`);
  if (entries.length === 0) reject("it has no entries");
  for (const entry of entries as Array<Record<string, unknown>>) {
    if (typeof entry !== "object" || entry === null) {
      reject("each entry must be an object");
    }
    for (const key of Object.keys(entry)) {
      if (!DECLARES_KEYS.includes(key)) {
        reject(`unknown key "${key}"; allowed: ${DECLARES_KEYS.join(", ")}`);
      }
    }
    if (typeof entry.kind !== "string" || entry.kind === "") {
      reject("`kind` must be a non-empty kind name");
    }
    if (entry.from !== "id" && entry.from !== "name") {
      reject('`from` must be "id" or "name"');
    }
    for (const key of ["scope", "under"] as const) {
      if (entry[key] !== undefined && !nonEmptyStrings(entry[key])) {
        reject(`\`${key}\` must be a tag name or an array of tag names`);
      }
    }
    if (
      entry.uniqueWith !== undefined &&
      !(Array.isArray(entry.uniqueWith) && nonEmptyStrings(entry.uniqueWith))
    ) {
      reject("`uniqueWith` must be an array of kind names");
    }
  }
}

/** `values`, `pattern` and `ref` of one attribute declaration, as core's registration words a problem. */
function checkAttributeFields(
  fail: Fail,
  owner: string,
  attrName: string,
  declaration: AtomDeclaration,
): void {
  const reject = (problem: string): never =>
    fail(`Invalid "${attrName}" attribute declaration of ${owner}: ${problem}`);
  for (const key of ["values", "pattern", "ref"] as const) {
    if (declaration[key] !== undefined && declaration.type !== "atom") {
      reject(`\`${key}\` requires \`type: "atom"\``);
    }
  }
  if (declaration.type !== "atom") return;
  if (
    declaration.values !== undefined &&
    !(
      Array.isArray(declaration.values) &&
      declaration.values.every((value) => typeof value === "string")
    )
  ) {
    reject("`values` must be an array of strings");
  }
  if (declaration.pattern !== undefined) {
    try {
      if (typeof declaration.pattern !== "string") throw new TypeError();
      new RegExp(declaration.pattern);
    } catch {
      reject("`pattern` must be a valid regular expression source string");
    }
  }
  if (declaration.ref !== undefined && !nonEmptyStrings(declaration.ref)) {
    reject("`ref` must be a kind name or an array of kind names");
  }
}

function entriesOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Every attribute declaration of a contract at any depth, in the order and
 * with the owner labels of core's registration walk: the attributes, then
 * inline `children["*"]` contracts, then named attribute tags, then the
 * `attributeTags["*"]` entries.
 */
function checkContractAttributes(
  fail: Fail,
  owner: string,
  contract: {
    readonly attributes?: unknown;
    readonly attributeTags?: unknown;
    readonly children?: unknown;
  },
  path: Set<object>,
): void {
  const attributes = contract.attributes as
    | Record<string, AtomDeclaration>
    | undefined;
  for (const [attrName, declaration] of Object.entries(attributes ?? {})) {
    if (declaration && typeof declaration === "object") {
      checkAttributeFields(fail, owner, attrName, declaration);
    }
  }
  const nested: Array<readonly [string, unknown]> = [];
  const children = contract.children as Record<string, unknown> | undefined;
  if (
    children &&
    typeof children === "object" &&
    Object.hasOwn(children, "*")
  ) {
    entriesOf(children["*"]).forEach((entry, index) => {
      // A reference by `contract` is that tag's contract, checked as its own.
      if (entry && typeof entry === "object" && "contract" in entry) return;
      nested.push([`${owner}: \`children["*"]\` entry ${index + 1}`, entry]);
    });
  }
  const tags = contract.attributeTags as Record<string, unknown> | undefined;
  for (const [name, declaration] of Object.entries(tags ?? {})) {
    if (name !== "*") nested.push([`${owner}: "<@${name}>"`, declaration]);
  }
  if (tags && Object.hasOwn(tags, "*")) {
    entriesOf(tags["*"]).forEach((entry, index) => {
      nested.push([
        `${owner}: \`attributeTags["*"]\` entry ${index + 1}`,
        entry,
      ]);
    });
  }
  for (const [label, entry] of nested) {
    if (!entry || typeof entry !== "object" || path.has(entry)) continue;
    path.add(entry);
    checkContractAttributes(fail, label, entry, path);
    path.delete(entry);
  }
}

/**
 * The module's `describeAttribute`: what a declaration accepts, for core's
 * whole-value shape error (` (one of :a, :b)`, ` (a declared attribute)`),
 * as core words it on its built-in path.
 */
function describeAttribute(
  declaration: Readonly<Record<string, unknown>>,
): string {
  const { values, ref } = declaration as AtomDeclaration;
  if (Array.isArray(values) && values.every((v) => typeof v === "string")) {
    return ` (one of ${atomList(values)})`;
  }
  if (
    typeof ref === "string" ||
    (Array.isArray(ref) && ref.every((kind) => typeof kind === "string"))
  ) {
    return ` (a declared ${asList(ref).join(" or ")})`;
  }
  return "";
}

/** The module's `checkContract`: the claimed keys of one registered contract. */
function checkContract(
  tag: string,
  contract: ContractData,
  ctx: ContractCheckContext,
): void {
  checkDeclares(ctx.fail, tag, contract.declares);
  checkContractAttributes(ctx.fail, `tag "${tag}"`, contract, new Set());
}

// ---------------------------------------------------------------------------
// 1. Declare.
// ---------------------------------------------------------------------------

/** The name an attribute states as one atom or string, with where it was written. */
function statedName(
  attr: ContractAttr | undefined,
): { name: string; span: SourceSpan } | null {
  if (!attr) return null;
  if (
    attr.kind === "string" ||
    attr.kind === "atom" ||
    attr.kind === "member"
  ) {
    return {
      name: attr.value,
      span: (attr.span ?? attr.nameSpan) as SourceSpan,
    };
  }
  if (attr.kind !== "expression" || attr.bound) return null;
  const node = attr.node as {
    type?: string;
    value?: unknown;
    extra?: { mxAtom?: { span: SourceSpan } };
  } | null;
  if (node?.type !== "StringLiteral" || !attr.span) return null;
  return {
    name: String(node.value),
    span: node.extra?.mxAtom?.span ?? attr.span,
  };
}

function pickEntry(
  declares: unknown,
  parent: string,
): DeclaresEntry | undefined {
  const entries = asList(declares as DeclaresEntry | DeclaresEntry[]);
  return (
    entries.find(
      (entry) =>
        entry.under !== undefined && asList(entry.under).includes(parent),
    ) ?? entries.find((entry) => entry.under === undefined)
  );
}

/** The scope that owns a declaration: the nearest ancestor named by `scope`, else the file. */
function scopeOwner(
  unit: LoweredUnit,
  ancestors: ContractCall["ancestors"],
  scope: string | readonly string[] | undefined,
  declared: { kind: string; name: string; span: SourceSpan },
): object {
  if (scope === undefined) return FILE_SCOPE;
  const names = asList(scope);
  for (let i = ancestors.length - 2; i >= 0; i--) {
    const ancestor = ancestors[i];
    if (ancestor && names.includes(ancestor.tag)) return ancestor.scope;
  }
  return unit.fail(
    `\`${declared.name}\` declares ${/^[aeiou]/.test(declared.kind) ? "an" : "a"} \`${declared.kind}\` scoped to ${orList(names)}, but has no such ancestor`,
    { at: declared.span },
  );
}

function contains(outer: SourceSpan | undefined, inner: SourceSpan): boolean {
  return (
    outer !== undefined &&
    outer.sourceStart <= inner.sourceStart &&
    inner.sourceEnd <= outer.sourceEnd
  );
}

/** Phase 1: every declaration, in source order, into its scope. */
function declare(unit: LoweredUnit): Scopes {
  const pending: Array<{ owner: object; decl: Declaration }> = [];
  for (const call of unit.calls) {
    const declares = call.contract.declares;
    if (!declares) continue;
    const { ancestors } = call;
    const parent =
      ancestors.length > 1
        ? (ancestors[ancestors.length - 2]?.tag ?? "")
        : "#root";
    const entry = pickEntry(declares, parent);
    if (!entry) continue;
    const stated = statedName(
      call.attrs.find(
        (attr) => attr.kind !== "spread" && attr.name === entry.from,
      ),
    );
    if (!stated) continue;
    const decl: Declaration = {
      kind: entry.kind,
      name: stated.name,
      span: stated.span,
      uniqueWith: entry.uniqueWith ?? [],
    };
    pending.push({
      owner: scopeOwner(unit, ancestors, entry.scope, decl),
      decl,
    });
  }
  for (const item of unit.declared) {
    // The tag that caused the derivation anchors the scope: the innermost
    // call whose span holds the declaration's span.
    let anchor: ContractCall | undefined;
    for (const call of unit.calls) {
      if (
        contains(call.span, item.span) &&
        (!anchor ||
          (call.span?.sourceStart ?? 0) >= (anchor.span?.sourceStart ?? 0))
      ) {
        anchor = call;
      }
    }
    const decl: Declaration = {
      kind: item.kind,
      name: item.name,
      span: item.span,
      uniqueWith: [],
    };
    pending.push({
      owner: scopeOwner(unit, anchor?.ancestors ?? [], item.scope, decl),
      decl,
    });
  }
  pending.sort((a, b) => a.decl.span.sourceStart - b.decl.span.sourceStart);

  const scopes: Scopes = new Map();
  for (const { owner, decl } of pending) {
    const names = scopes.get(owner) ?? new Map<string, Declaration[]>();
    scopes.set(owner, names);
    const same = names.get(decl.name) ?? [];
    names.set(decl.name, same);
    const clash = same.find(
      (other) =>
        other.kind === decl.kind ||
        decl.uniqueWith.includes(other.kind) ||
        other.uniqueWith.includes(decl.kind),
    );
    if (clash) {
      const at = lineColumn(unit.source, clash.span.sourceStart);
      const label =
        clash.kind === decl.kind
          ? `\`${decl.kind}\``
          : `\`${decl.kind}\` (it clashes with the \`${clash.kind}\` of the same name)`;
      unit.fail(
        `\`${decl.name}\` is already declared as ${label} at ${at.line}:${at.column + 1}`,
        { at: decl.span, also: [clash.span, decl.span] },
      );
    }
    same.push(decl);
  }
  return scopes;
}

// ---------------------------------------------------------------------------
// 2. Check.
// ---------------------------------------------------------------------------

/** The names of `kinds` visible from a call: innermost scope first, the file last, each once. */
function visibleNames(
  scopes: Scopes,
  chain: readonly object[],
  kinds: readonly string[],
): Array<{ name: string; kind: string }> {
  const seen = new Set<string>();
  const found: Array<{ name: string; kind: string }> = [];
  for (const scope of [...chain].reverse().concat(FILE_SCOPE)) {
    const names = scopes.get(scope);
    if (!names) continue;
    for (const [name, decls] of names) {
      const decl = decls.find((d) => kinds.includes(d.kind));
      if (!decl || seen.has(name)) continue;
      seen.add(name);
      found.push({ name, kind: decl.kind });
    }
  }
  return found;
}

/**
 * The names a contract accepts: `values` and `ref` together intersect,
 * `pattern` filters, and a contract with neither `values` nor `ref` has no
 * list. `visible` is what `ref` can see at the call.
 */
function acceptedNames(
  contract: AtomContract,
  visible: ReadonlyArray<{ name: string }>,
): string[] {
  const { values, pattern, ref } = contract;
  let pool: readonly string[];
  if (ref !== undefined) {
    const names = visible.map((candidate) => candidate.name);
    pool = values ? names.filter((name) => values.includes(name)) : names;
  } else if (values) {
    pool = values;
  } else {
    return [];
  }
  if (pattern === undefined) return [...pool];
  const matcher = new RegExp(pattern);
  return pool.filter((name) => matcher.test(name));
}

function contractOf(declaration: AtomDeclaration): AtomContract {
  const { values, pattern, ref } = declaration;
  return { values, pattern, ref: ref === undefined ? undefined : asList(ref) };
}

/** Every atom-marked string literal under `node`, in source order. */
function markedAtoms(node: unknown): Array<{ name: string; span: SourceSpan }> {
  const found: Array<{ name: string; span: SourceSpan }> = [];
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as {
      type?: unknown;
      value?: unknown;
      extra?: { mxAtom?: { span?: SourceSpan } };
    };
    const mark = record.extra?.mxAtom?.span;
    if (record.type === "StringLiteral" && mark) {
      found.push({ name: String(record.value), span: mark });
      return;
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(node);
  return found.sort((a, b) => a.span.sourceStart - b.span.sourceStart);
}

/** The atoms an attribute's value holds: a whole-value atom, or those inside its expression. */
function atomsOf(
  attr: ContractAttr,
): Array<{ name: string; span: SourceSpan }> {
  if (attr.kind === "atom") {
    return attr.span ? [{ name: attr.value, span: attr.span }] : [];
  }
  if (attr.kind !== "expression" || !attr.span) return [];
  const { sourceStart, sourceEnd } = attr.span;
  return markedAtoms(attr.node).filter(
    ({ span }) =>
      span.sourceStart >= sourceStart && span.sourceEnd <= sourceEnd,
  );
}

/** The text of an attribute written as a plain string (not an atom, not an expression), else undefined. */
function plainStringOf(attr: ContractAttr): string | undefined {
  if (attr.kind === "string" || attr.kind === "member") return attr.value;
  if (attr.kind !== "expression" || attr.bound) return undefined;
  const node = attr.node as {
    type?: string;
    value?: unknown;
    extra?: { mxAtom?: unknown };
  } | null;
  return node?.type === "StringLiteral" && !node.extra?.mxAtom
    ? String(node.value)
    : undefined;
}

function checkAtom(
  unit: LoweredUnit,
  call: ContractCall,
  scopes: Scopes,
  label: string,
  attrName: string,
  declaration: AtomDeclaration,
  atom: { name: string; span: SourceSpan },
): void {
  const owner = `${label}: attribute \`${attrName}\``;
  const { values, pattern, ref } = declaration;
  if (values && !values.includes(atom.name)) {
    const near = nearestName(atom.name, values);
    unit.fail(
      `${owner}: \`:${atom.name}\` is not one of ${atomList(values)}${near ? `; did you mean \`:${near}\`?` : ""}`,
      { at: atom.span },
    );
  }
  if (pattern !== undefined && !new RegExp(pattern).test(atom.name)) {
    unit.fail(
      `${owner}: \`:${atom.name}\` does not match the pattern /${pattern}/`,
      { at: atom.span },
    );
  }
  if (ref === undefined) return;
  const kinds = asList(ref);
  const chain = call.ancestors.map((ancestor) => ancestor.scope);
  const visible = visibleNames(scopes, chain, kinds);
  if (visible.some((candidate) => candidate.name === atom.name)) return;
  const candidates = acceptedNames(contractOf(declaration), visible);
  const near = nearestName(atom.name, candidates);
  const listed = candidates.length
    ? `one of ${atomList(candidates)}`
    : "none declared";
  unit.fail(
    `${owner}: \`:${atom.name}\` is not a declared ${kinds.join(" or ")} here (${listed})${near ? `; did you mean \`:${near}\`?` : ""}`,
    { at: atom.span },
  );
}

/**
 * A plain string where a `ref` atom is expected: the type error, raised once
 * the file's declarations exist so it can list the names the author may mean.
 */
function checkStringForRef(
  unit: LoweredUnit,
  call: ContractCall,
  scopes: Scopes,
  label: string,
  attr: Exclude<ContractAttr, { kind: "spread" }>,
  declaration: AtomDeclaration,
  text: string,
): void {
  const chain = call.ancestors.map((ancestor) => ancestor.scope);
  const names = acceptedNames(
    contractOf(declaration),
    visibleNames(scopes, chain, asList(declaration.ref)),
  );
  const listed = names.length ? `one of ${atomList(names)}` : "none declared";
  const at = "span" in attr && attr.span ? attr.span : attr.nameSpan;
  unit.fail(
    `${label}: attribute ${attr.label} must be atom, got string (${listed}); write it as \`:${text}\``,
    at ? { at } : undefined,
  );
}

/** Queues a check for every atom of every contract attribute in `attrs`. */
function queueAttrs(
  unit: LoweredUnit,
  call: ContractCall,
  scopes: Scopes,
  refs: Array<() => void>,
  label: string,
  attributes: ContractData["attributes"],
  attrs: readonly ContractAttr[],
): void {
  if (!attributes) return;
  for (const attr of attrs) {
    if (attr.kind === "spread" || !Object.hasOwn(attributes, attr.name)) {
      continue;
    }
    const declaration = attributes[attr.name] as AtomDeclaration | undefined;
    if (declaration?.type !== "atom") continue;
    if (
      declaration.values === undefined &&
      declaration.pattern === undefined &&
      declaration.ref === undefined
    ) {
      continue;
    }
    const text =
      declaration.ref === undefined ? undefined : plainStringOf(attr);
    if (text !== undefined) {
      refs.push(() =>
        checkStringForRef(unit, call, scopes, label, attr, declaration, text),
      );
      continue;
    }
    for (const atom of atomsOf(attr)) {
      refs.push(() =>
        checkAtom(unit, call, scopes, label, attr.name, declaration, atom),
      );
    }
  }
}

/** The same, for every attribute tag at any depth, labelled `<box>`: `<@row>`: .... */
function queueAttributeTags(
  unit: LoweredUnit,
  call: ContractCall,
  scopes: Scopes,
  refs: Array<() => void>,
  label: string,
  tags: readonly ContractAttributeTag[],
): void {
  for (const tag of tags) {
    if (!tag.contract) continue;
    const nested = `${label}: \`<@${tag.name}>\``;
    queueAttrs(
      unit,
      call,
      scopes,
      refs,
      nested,
      tag.contract.attributes,
      tag.attrs,
    );
    queueAttributeTags(unit, call, scopes, refs, nested, tag.attributeTags);
  }
}

/** The module's `afterLower`: register, declare every name of the unit, then check every atom against them. */
function checkAtomContracts(unit: LoweredUnit): void {
  const { calls, declared } = unit;
  if (calls.length === 0 && declared.length === 0) return;
  const scopes = declare(unit);
  const refs: Array<() => void> = [];
  for (const call of calls) {
    const label = `\`<${call.tag}>\``;
    queueAttrs(
      unit,
      call,
      scopes,
      refs,
      label,
      call.contract.attributes,
      call.attrs,
    );
    queueAttributeTags(unit, call, scopes, refs, label, call.attributeTags);
  }
  for (const check of refs) check();
}

const atomsSugars = {
  id: "atoms-sugars",
  name: "MX",
  table: Object.freeze({
    expressionTriggers: Object.freeze([ATOM]),
    attributeTriggers: Object.freeze([NAME_SUGAR, ID_SUGAR, CLASS_SUGAR]),
  }),
  lowerTrigger(id, text, span, ctx) {
    switch (id) {
      case "atom":
        return atom(text, span, ctx);
      case "name":
        return nameSugar(text.slice(1), ctx, span);
      default:
        return shorthands(text, span, ctx);
    }
  },
  contractFields: CONTRACT_FIELDS,
  checkContract,
  describeAttribute,
  afterLower: checkAtomContracts,
} satisfies Dialect;

export default Object.freeze(atomsSugars) as Dialect;
