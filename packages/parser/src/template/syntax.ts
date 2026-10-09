/**
 * The syntax table (decision 182; design note `language-extensions/core.md`,
 * "The syntax table"): one plain-data object per parse that parametrizes the
 * grammar. No field is a function, so a native lexer can take the same
 * struct; everything the parser needs is compiled from the data once per
 * table (`compileSyntax`, cached per object).
 *
 * `DEFAULT_SYNTAX` is the `.mx` row: today's grammar, byte for byte. Atoms
 * (decision 156) and the `:name` / `#id` / `.class` sugars keep their own
 * code paths until `lang-ext-move-sugars-to-mesh` moves them onto the table.
 */
import type { TagType } from "./util/constants.ts";

/**
 * What the expression parser sees in place of a trigger's text, always of
 * the same length so offsets stay one-to-one (see `standInText`).
 */
export type StandIn = "number" | "identifier" | "keep";

/** What core builds from a trigger (lowering, not this parser). */
export type TriggerNode =
  | "string"
  | "identifier"
  | "attribute"
  | { readonly call: string };

export interface Trigger {
  /** Unique within its list (one id may name a row in several positions, as Mesh's `&` does); names the trigger in events and diagnostics. */
  readonly id: string;
  /** The first characters that arm it, as the body of a regex character class (`":"`, `"A-Z"`, `"&"`). */
  readonly chars: string;
  /** The matcher, anchored at the armed character by the parser: a regex source in the RE2 subset (no look-around, no back-references). */
  readonly match: string;
  readonly standIn: StandIn;
  readonly node: TriggerNode;
  /** Attribute triggers only: a space and then this trigger ends the preceding attribute value. */
  readonly terminatesValue?: boolean;
}

export interface SyntaxTable {
  /** `${` and `}`; `$!{` is derived. Only the default is supported by this parser. */
  readonly placeholder: {
    readonly open: string;
    readonly close: string;
  } | null;
  /** `$ ` at a concise line start. Only the default is supported by this parser. */
  readonly inlineScript: { readonly trigger: string } | null;
  /** `{% … %}` block forms; null on the default row (PR B). */
  readonly blockTag: { readonly open: string; readonly close: string } | null;
  /** Filter blocks; null on the default row (PR B). */
  readonly filter: { readonly open: string; readonly close: string } | null;
  /** Concise mode; turned off only by a language (layer 3), never by a project. */
  readonly concise: boolean;
  /** Armed where an operand is expected, in the expressions that lex atoms. */
  readonly expressionTriggers: readonly Trigger[];
  /** Armed on the first character of an attribute name. */
  readonly attributeTriggers: readonly Trigger[];
  /** Armed at the start of a tagless concise line (decision 182 addendum 1). */
  readonly lineTriggers: readonly Trigger[];
  /** Text position; empty on the `.mx` row, always (layer 3 only). */
  readonly textTriggers: readonly Trigger[];
  /** Tag types computed before the parse (PR B); empty on the default row. */
  readonly tagTypes: Readonly<Record<string, TagType>>;
  /** Reserved: the language of embedded expressions. */
  readonly expressionLanguage: "ts";
}

/** One problem with a table. Positioned diagnostics are the resolver's job (it knows the manifest). */
export interface SyntaxDiagnostic {
  /** The offending field, as a path (`expressionTriggers[0].match`). */
  readonly field: string;
  readonly triggerId?: string;
  readonly message: string;
}

/** The `.mx` row: today's grammar, byte for byte. Deeply frozen. */
export const DEFAULT_SYNTAX: SyntaxTable = Object.freeze({
  placeholder: Object.freeze({ open: "${", close: "}" }),
  inlineScript: Object.freeze({ trigger: "$ " }),
  blockTag: null,
  filter: null,
  concise: true,
  expressionTriggers: Object.freeze([]),
  attributeTriggers: Object.freeze([]),
  lineTriggers: Object.freeze([]),
  textTriggers: Object.freeze([]),
  tagTypes: Object.freeze({}),
  expressionLanguage: "ts",
});

const LISTS = [
  "expressionTriggers",
  "attributeTriggers",
  "lineTriggers",
  "textTriggers",
] as const;
type ListName = (typeof LISTS)[number];

/**
 * Characters each list may not be armed on, beyond the rules every list
 * shares (whitespace and line breaks are never a trigger's first character).
 */
const REFUSED: Record<ListName, { chars: string; why: string }> = {
  // A separator or a group closer ends or splits the expression.
  expressionTriggers: {
    chars: ",;)]}",
    why: "it separates or closes an expression",
  },
  // Attribute syntax beyond the name's first character is not parametrized.
  attributeTriggers: {
    chars: "<>/=,;()[]",
    why: "it is attribute or open-tag syntax",
  },
  // Decision 182 addendum 1; `$` because `inlineScript` is always on here.
  lineTriggers: {
    chars: "<-/@$",
    why: "it starts a tag, a delimited block, a comment, an attribute tag or an inline script",
  },
  // core.md, "Validation".
  textTriggers: { chars: "<$/\\", why: "it is template syntax" },
};

/**
 * Validates a table, which may come from JSON (`package.json#mx.syntax`):
 * its shape, then the rules of core.md "Validation" and decision 182
 * addendum 1, then what this parser does not support yet. Returns every
 * problem; empty means the parser can take the table.
 */
export function validateSyntaxTable(table: unknown): SyntaxDiagnostic[] {
  const out: SyntaxDiagnostic[] = [];
  const fail = (field: string, message: string, triggerId?: string) =>
    out.push(
      triggerId === undefined
        ? { field, message }
        : { field, triggerId, message },
    );
  if (!isRecord(table)) {
    fail("", "a syntax table is an object");
    return out;
  }

  const pair = (field: "placeholder" | "blockTag" | "filter") => {
    const value = table[field];
    if (value === null) return;
    if (
      !isRecord(value) ||
      typeof value.open !== "string" ||
      typeof value.close !== "string" ||
      value.open === "" ||
      value.close === ""
    ) {
      fail(
        field,
        `\`${field}\` is null or { open, close } with non-empty strings`,
      );
      return;
    }
    if (value.open.startsWith("<")) {
      fail(
        `${field}.open`,
        `\`${field}.open\` may not start with "<", the tag opener`,
      );
    }
  };
  pair("placeholder");
  pair("blockTag");
  pair("filter");
  const opens = (["placeholder", "blockTag", "filter"] as const).flatMap(
    (field) => {
      const value = table[field];
      return isRecord(value) && typeof value.open === "string"
        ? [{ field, open: value.open }]
        : [];
    },
  );
  for (let i = 0; i < opens.length; i++) {
    for (let j = i + 1; j < opens.length; j++) {
      const a = opens[i] as { field: string; open: string };
      const b = opens[j] as { field: string; open: string };
      if (a.open === b.open) {
        fail(
          `${b.field}.open`,
          `\`${a.field}.open\` and \`${b.field}.open\` are both ${JSON.stringify(a.open)}`,
        );
      }
    }
  }

  const inlineScript = table.inlineScript;
  if (
    inlineScript !== null &&
    !(
      isRecord(inlineScript) &&
      typeof inlineScript.trigger === "string" &&
      inlineScript.trigger !== ""
    )
  ) {
    fail(
      "inlineScript",
      "`inlineScript` is null or { trigger } with a non-empty string",
    );
  }
  if (typeof table.concise !== "boolean")
    fail("concise", "`concise` is a boolean");
  if (table.expressionLanguage !== "ts") {
    fail(
      "expressionLanguage",
      '`expressionLanguage` is reserved and must be "ts"',
    );
  }
  if (!isRecord(table.tagTypes)) fail("tagTypes", "`tagTypes` is an object");

  for (const list of LISTS) {
    const ids = new Map<string, string>();
    const triggers = table[list];
    if (!Array.isArray(triggers)) {
      fail(list, `\`${list}\` is an array of triggers`);
      continue;
    }
    const armed: { at: string; id: string; first: RegExp }[] = [];
    triggers.forEach((trigger: unknown, index) => {
      const at = `${list}[${index}]`;
      const problems = validateTrigger(trigger, list, at);
      const id =
        isRecord(trigger) && typeof trigger.id === "string"
          ? trigger.id
          : undefined;
      for (const problem of problems) fail(problem.field, problem.message, id);
      if (id === undefined) return;
      const seen = ids.get(id);
      if (seen !== undefined)
        fail(`${at}.id`, `trigger id "${id}" is also used by ${seen}`, id);
      else ids.set(id, at);
      if (problems.length > 0) return;
      // Two triggers of one list on one first character: their matchers
      // would compete for the same position. Telling whether two regexes
      // overlap is not decidable cheaply, so any shared character is refused.
      const first = classOf((trigger as Trigger).chars) as RegExp;
      for (const other of armed) {
        const shared = sharedCharacter(first, other.first);
        if (shared !== undefined) {
          fail(
            `${at}.chars`,
            `"${id}" and "${other.id}" (${other.at}) are both armed on ${JSON.stringify(shared)}; one first character arms at most one trigger per list`,
            id,
          );
        }
      }
      armed.push({ at, id, first });
    });
  }

  // What the grammar allows but this parser does not implement yet; a table
  // that sets one is refused rather than silently parsed as the default.
  const unsupported = (field: string, what: string) =>
    fail(field, `${what} is not supported by this parser yet`);
  if (
    isRecord(table.placeholder) &&
    (table.placeholder.open !== "${" || table.placeholder.close !== "}")
  ) {
    unsupported("placeholder", "a placeholder other than the default");
  } else if (table.placeholder === null)
    unsupported("placeholder", "turning placeholders off");
  if (isRecord(table.inlineScript) && table.inlineScript.trigger !== "$ ") {
    unsupported("inlineScript", 'an inline script trigger other than "$ "');
  } else if (table.inlineScript === null)
    unsupported("inlineScript", "turning inline scripts off");
  if (table.blockTag !== null && table.blockTag !== undefined)
    unsupported("blockTag", "`blockTag`");
  if (table.filter !== null && table.filter !== undefined)
    unsupported("filter", "`filter`");
  if (table.concise === false)
    unsupported(
      "concise",
      "turning concise mode off (a language's choice, layer 3)",
    );
  if (Array.isArray(table.textTriggers) && table.textTriggers.length > 0) {
    unsupported(
      "textTriggers",
      "a text trigger (layer 3 only; never on the `.mx` row)",
    );
  }
  if (isRecord(table.tagTypes) && Object.keys(table.tagTypes).length > 0) {
    unsupported("tagTypes", "a precomputed `tagTypes` table");
  }
  return out;
}

function validateTrigger(
  trigger: unknown,
  list: ListName,
  at: string,
): { field: string; message: string }[] {
  const out: { field: string; message: string }[] = [];
  if (!isRecord(trigger))
    return [{ field: at, message: "a trigger is an object" }];
  const { id, chars, match, standIn, node, terminatesValue } = trigger;
  if (typeof id !== "string" || id === "")
    out.push({ field: `${at}.id`, message: "`id` is a non-empty string" });
  if (standIn !== "number" && standIn !== "identifier" && standIn !== "keep") {
    out.push({
      field: `${at}.standIn`,
      message: '`standIn` is "number", "identifier" or "keep"',
    });
  }
  if (
    !(
      node === "string" ||
      node === "identifier" ||
      node === "attribute" ||
      (isRecord(node) && typeof node.call === "string" && node.call !== "")
    )
  ) {
    out.push({
      field: `${at}.node`,
      message: '`node` is "string", "identifier", "attribute" or { call }',
    });
  }
  if (terminatesValue !== undefined) {
    if (typeof terminatesValue !== "boolean") {
      out.push({
        field: `${at}.terminatesValue`,
        message: "`terminatesValue` is a boolean",
      });
    } else if (terminatesValue && list !== "attributeTriggers") {
      out.push({
        field: `${at}.terminatesValue`,
        message: "`terminatesValue` applies to attribute triggers only",
      });
    }
  }

  const first =
    typeof chars === "string" && chars !== "" ? classOf(chars) : undefined;
  if (first === undefined) {
    out.push({
      field: `${at}.chars`,
      message: '`chars` is the body of a character class, such as ":" or "A-Z"',
    });
  } else {
    const whitespace = sharedCharacter(first, /[\s]/u);
    if (whitespace !== undefined) {
      out.push({
        field: `${at}.chars`,
        message: `a trigger is never armed on whitespace or a line break (${JSON.stringify(whitespace)})`,
      });
    }
    const refused = REFUSED[list];
    for (const char of refused.chars) {
      if (first.test(char)) {
        out.push({
          field: `${at}.chars`,
          message: `${list} may not be armed on ${JSON.stringify(char)}: ${refused.why}`,
        });
      }
    }
    // core.md "Validation": a number stand-in on a character an expression
    // token starts with would change what the expression parser reads.
    if (list === "expressionTriggers" && standIn === "number") {
      const token = sharedCharacter(first, /[$_A-Za-z0-9'"`()[\]{}]/u);
      if (token !== undefined) {
        out.push({
          field: `${at}.standIn`,
          message: `a trigger armed on an expression token (${JSON.stringify(token)}) takes standIn "identifier" or "keep"`,
        });
      }
    }
  }

  if (typeof match !== "string" || match === "") {
    out.push({
      field: `${at}.match`,
      message: "`match` is a non-empty regex source",
    });
  } else {
    const problem = re2Problem(match);
    if (problem !== undefined)
      out.push({ field: `${at}.match`, message: problem });
    else if (matcherOf(match).test("")) {
      out.push({
        field: `${at}.match`,
        message:
          "`match` matches the empty string; a trigger consumes at least its first character",
      });
    }
  }
  return out;
}

/**
 * Why `source` is outside the RE2 subset (or not a regex at all), if it is:
 * look-around and back-references, which a linear-time engine cannot run.
 */
function re2Problem(source: string): string | undefined {
  try {
    matcherOf(source);
  } catch (error) {
    return `\`match\` is not a valid regex: ${(error as Error).message}`;
  }
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "\\") {
      const next = source[i + 1] ?? "";
      if (!inClass && (/[1-9]/.test(next) || next === "k")) {
        return "`match` uses a back-reference, which is outside the RE2 subset";
      }
      i++;
    } else if (inClass) {
      if (char === "]") inClass = false;
    } else if (char === "[") {
      inClass = true;
    } else if (char === "(" && source[i + 1] === "?") {
      const kind = source.slice(i + 2, i + 4);
      if (
        kind[0] === "=" ||
        kind[0] === "!" ||
        kind === "<=" ||
        kind === "<!"
      ) {
        return "`match` uses a look-around, which is outside the RE2 subset";
      }
    }
  }
  return undefined;
}

/** The first character of `class` (a `RegExp` for one character) that `other` also matches, scanning ASCII then the BMP. */
function sharedCharacter(first: RegExp, other: RegExp): string | undefined {
  for (let code = 0; code < 0x10000; code++) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const char = String.fromCharCode(code);
    if (first.test(char) && other.test(char)) return char;
  }
  return undefined;
}

function classOf(chars: string): RegExp | undefined {
  try {
    return new RegExp(`^[${chars}]$`, "u");
  } catch {
    return undefined;
  }
}

function matcherOf(source: string): RegExp {
  return new RegExp(source.startsWith("^") ? source.slice(1) : source, "uy");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// The compiled form the parser reads: per list, a 128-entry table indexed by
// an ASCII first character (validation allows at most one trigger per
// character), plus the triggers armed on non-ASCII characters.

export interface CompiledTrigger {
  readonly id: string;
  readonly standIn: StandIn;
  readonly terminatesValue: boolean;
  readonly first: RegExp;
  readonly matcher: RegExp;
}

export interface TriggerSet {
  readonly ascii: readonly (CompiledTrigger | undefined)[];
  readonly other: readonly CompiledTrigger[];
}

export interface CompiledSyntax {
  readonly expression: TriggerSet | null;
  readonly attribute: TriggerSet | null;
  readonly line: TriggerSet | null;
  /** Whether any attribute trigger sets `terminatesValue`. */
  readonly terminators: boolean;
}

const compiled = new WeakMap<object, CompiledSyntax>();

/** The default row compiles to no trigger sets at all: the parser's checks are one `null` test. */
export const DEFAULT_COMPILED: CompiledSyntax = Object.freeze({
  expression: null,
  attribute: null,
  line: null,
  terminators: false,
});
compiled.set(DEFAULT_SYNTAX, DEFAULT_COMPILED);

/**
 * The parser's form of `table`, cached per table object. Throws a
 * `TypeError` listing every problem when the table does not validate: the
 * resolver (PR C) reports positioned diagnostics before a table gets here.
 */
export function compileSyntax(table: SyntaxTable): CompiledSyntax {
  const cached = compiled.get(table);
  if (cached) return cached;
  const problems = validateSyntaxTable(table);
  if (problems.length > 0) {
    throw new TypeError(
      `invalid syntax table:\n${problems.map((p) => `  ${p.field}: ${p.message}`).join("\n")}`,
    );
  }
  const set = (triggers: readonly Trigger[]): TriggerSet | null => {
    if (triggers.length === 0) return null;
    const ascii: (CompiledTrigger | undefined)[] = new Array(128).fill(
      undefined,
    );
    const other: CompiledTrigger[] = [];
    for (const trigger of triggers) {
      const first = classOf(trigger.chars) as RegExp;
      const entry: CompiledTrigger = {
        id: trigger.id,
        standIn: trigger.standIn,
        terminatesValue: trigger.terminatesValue === true,
        first,
        matcher: matcherOf(trigger.match),
      };
      for (let code = 0; code < 128; code++) {
        if (first.test(String.fromCharCode(code))) ascii[code] = entry;
      }
      if (sharedCharacter(first, /[^\0-\x7f]/u) !== undefined)
        other.push(entry);
    }
    return { ascii, other };
  };
  const result: CompiledSyntax = {
    expression: set(table.expressionTriggers),
    attribute: set(table.attributeTriggers),
    line: set(table.lineTriggers),
    terminators: table.attributeTriggers.some(
      (t) => t.terminatesValue === true,
    ),
  };
  compiled.set(table, result);
  return result;
}

/**
 * The trigger of `set` armed at `pos` whose matcher matches there, and where
 * the match ends; undefined when none. The matcher is anchored (sticky) at
 * `pos`; an empty match never counts.
 */
export function matchTrigger(
  set: TriggerSet,
  data: string,
  pos: number,
): { trigger: CompiledTrigger; end: number } | undefined {
  const code = data.charCodeAt(pos);
  let trigger: CompiledTrigger | undefined;
  if (code < 128) trigger = set.ascii[code];
  else if (!Number.isNaN(code)) {
    const char = String.fromCodePoint(data.codePointAt(pos) as number);
    trigger = set.other.find((t) => t.first.test(char));
  }
  if (trigger === undefined) return undefined;
  const { matcher } = trigger;
  matcher.lastIndex = pos;
  const found = matcher.exec(data);
  if (found === null || found[0].length === 0) return undefined;
  return { trigger, end: pos + found[0].length };
}

/**
 * The stand-in of a trigger's `text` (always the same length):
 *
 * - `"number"`: the atom rule (decision 156), `0.` plus zeros (`0` for one
 *   character), a numeric literal Babel reads at the same offsets.
 * - `"identifier"`: `_` followed by the text with every character outside
 *   `[A-Za-z0-9_$]` (each UTF-16 unit) replaced by `_`: `&status` reads as
 *   `_status`. One identifier, never a reserved word (it starts with `_`)
 *   and readable in a TypeScript message. A consumer tells a stand-in from
 *   authored text by the trigger's span, exactly as atoms do.
 * - `"keep"`: the text itself.
 */
export function standInText(standIn: StandIn, text: string): string {
  switch (standIn) {
    case "number":
      return text.length === 1 ? "0" : `0.${"0".repeat(text.length - 2)}`;
    case "identifier": {
      let out = "_";
      for (let i = 1; i < text.length; i++) {
        const char = text[i] as string;
        out += /[A-Za-z0-9_$]/.test(char) ? char : "_";
      }
      return out;
    }
    default:
      return text;
  }
}
