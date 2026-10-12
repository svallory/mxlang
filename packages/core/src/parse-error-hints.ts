/**
 * Fix hints for Marko's own parse errors (audit item 14).
 *
 * `@marko/compiler` reports a syntax mistake in the vocabulary of its parser
 * ("Unexpected token, expected \"{\""), which says what it could not read but
 * not what to write. MX recognises the few mistakes authors from other
 * template languages make and appends one short sentence to the reason, in
 * place: same message, same position, nothing else changes. An error it does
 * not recognise is left untouched.
 *
 * Marko 6.3.51 is the authority for every suggestion (`<div id>` and
 * `<const/x=1/>` compile; a `$` scriptlet is rejected outright with
 * "Scriptlets are not supported when using the tags api.").
 */

import type { HostDeclarations } from "./declarations.ts";

// With colours on (CI, FORCE_COLOR) Marko wraps the reason in escape codes that
// run to the end of the line, so allow SGR sequences after the reason.
const SGR = "(?:\\u001b\\[[0-9;]*m)*";

type Located = Error & {
  loc?: { start?: { line: number; column: number; index?: number } };
  label?: unknown;
  errors?: unknown[];
};

/** What to write instead of a scriptlet that declares `name`, core's default. */
const DEFAULT_REPLACEMENT = (name: string, keyword: "const" | "let" | "var") =>
  `declare a value with \`<${keyword === "const" ? "const" : "let"}/${name}=…/>\``;

/**
 * What to write when the statement declares no variable (a call, an
 * assignment, a class, an import, a destructuring): true on every host,
 * since `<const>` is core's and a module statement can always live outside
 * the template.
 */
const GENERIC_REPLACEMENT =
  "a template holds values, not statements: write a value with `<const/x=…/>`, or move the statement out of the template";

export type ScriptletDeclaration = {
  name: string;
  keyword: "const" | "let" | "var";
};

/** Marko's tag-variable reason: `X` is not a valid [tag variable](link); … */
const TAG_VARIABLE_REASON =
  /`[^`]*` is not a valid \[tag variable\]\([^)]*\); use a JavaScript identifier or destructuring pattern\.?/;

/**
 * The scriptlet message tail: the sentence every host shares, plus the host's
 * replacement when the statement declares exactly one variable (a host may
 * offer none, as for a mutable `let` on a host with no mutable form). A call,
 * an assignment, a class, an import or a destructuring declares no single
 * value, so the generic advice stands in.
 */
export function scriptletSentence(
  binding: ScriptletDeclaration | undefined,
  declarations?: Pick<HostDeclarations, "scriptletReplacement">,
): string {
  if (!binding) return `; ${GENERIC_REPLACEMENT}`;
  const replacement = (
    declarations?.scriptletReplacement ?? DEFAULT_REPLACEMENT
  )(binding.name, binding.keyword);
  return replacement ? `; ${replacement}` : "";
}

/**
 * The variable a `const|let|var NAME =` statement declares, when it declares
 * exactly that one (no second declarator after a top-level comma).
 */
export const declaredBinding = (
  statement: string,
): ScriptletDeclaration | undefined => {
  const found = statement.match(
    /^\s*(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=([\s\S]*)$/,
  );
  if (!found) return undefined;
  let depth = 0;
  let quote = "";
  for (const char of found[3] ?? "") {
    if (quote) {
      if (char === quote) quote = "";
    } else if ("\"'`".includes(char)) quote = char;
    else if ("([{".includes(char)) depth++;
    else if (")]}".includes(char)) depth--;
    else if (char === "," && depth === 0) return undefined;
  }
  return {
    name: found[2] as string,
    keyword: found[1] as ScriptletDeclaration["keyword"],
  };
};

/**
 * Whether `offset` sits inside a `{…}` expression of the tag or placeholder
 * being written (a multi-line attribute value, `${…}`), where a line starting
 * with `$` is expression text, not a scriptlet.
 */
function insideBraces(source: string, offset: number): boolean {
  const open = Math.max(
    source.lastIndexOf("<", offset),
    source.lastIndexOf("${", offset),
  );
  let depth = 0;
  let quote = "";
  for (const char of source.slice(Math.max(open, 0), offset)) {
    if (quote) {
      if (char === quote) quote = "";
    } else if ("\"'`".includes(char)) quote = char;
    else if (char === "{") depth++;
    else if (char === "}") depth--;
  }
  return depth > 0;
}

/** Offset of a 1-based line and 0-based column in `source`. */
function offsetOf(source: string, line: number, column: number): number {
  let start = 0;
  for (let at = 1; at < line; at++) {
    const next = source.indexOf("\n", start);
    if (next === -1) return -1;
    start = next + 1;
  }
  return start + column;
}

function hintFor(
  reason: string,
  source: string,
  at: { line: number; column: number; index?: number },
  declarations?: Pick<HostDeclarations, "scriptletReplacement">,
): string | null {
  const offset = at.index ?? offsetOf(source, at.line, at.column);
  if (offset < 0) return null;

  // `<div id= class="a">`: the next attribute's name was read as `id`'s value,
  // so the parser trips on that attribute's own `=`.
  if (reason === 'Unexpected token, expected "{"' && source[offset] === "=") {
    const missing = source
      .slice(0, offset)
      .match(/([^\s=<>"'`/]+)\s*=\s+[^\s=<>"'`/]+$/)?.[1];
    if (missing) {
      return `\`${missing}=\` has no value; write \`${missing}="…"\` or \`${missing}=expr\`, or drop the \`=\``;
    }
  }

  // A syntax error inside a `$` scriptlet line: whatever is fixed there, the
  // line is rejected next, so say so now.
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = source.indexOf("\n", offset);
  const text = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  const scriptlet = text.match(/^\s*\$\s+(\S.*)$/);
  if (scriptlet && !insideBraces(source, lineStart)) {
    return `scriptlets (\`$ …\`) are not supported${scriptletSentence(declaredBinding(scriptlet[1] ?? ""), declarations)}`;
  }
  return null;
}

/**
 * Decision 174: a shorthand part with a bracket Marko's own group reader trips
 * over (`.data-[state=open]:flex` — "Mismatched group", `.[&>*]:p-4` —
 * "Missing ending tag") dies in Marko's vocabulary before MX lowers anything.
 * When the failing tag head carries shorthand and a bracket, say what the
 * author wrote instead: the shorthand cannot hold this class; use `class="…"`.
 */
function rewriteShorthandGroup(error: Located, source: string): string | null {
  const reason = typeof error.label === "string" ? error.label : "";
  const at = error.loc?.start;
  if (!at) return null;
  if (
    !/^(Mismatched group|Missing ending|Identifier directly after number\.)/.test(
      reason,
    )
  )
    return null;
  const offset = at.index ?? offsetOf(source, at.line, at.column);
  const tagAt = source.lastIndexOf("<", offset);
  if (tagAt < 0) return null;
  // A tag-adjacent shorthand (`<div.bg-[…`, `<div.[&>*]…`); attribute-position
  // sugar dies in MX's own rewrite, never in Marko's group reader. The tag
  // head may be longer than the slice up to the failure ("Missing ending"
  // points at the tag's start), so read past it for the sigil check.
  const head = source.slice(tagAt, offset + 60);
  if (!/^<[^<>\s]*[.#]/.test(head)) return null;
  // The bracket must sit in the shorthand run itself (up to the first
  // whitespace), not in a later attribute (`<div.a x=[1]/>`).
  const bracket = head.match(/^\S*/)?.[0].match(/[[\]]/)?.[0];
  if (!bracket) return null;
  const sentence = `a class or id shorthand cannot hold an unbalanced \`${bracket}\` (a part ends at \`.\`, \`#\`, \`/\`, \`(\`, whitespace, \`=\` or \`>\`); use \`class="…"\` for this class`;
  error.label = sentence;
  setMessage(error, error.message.replace(reason, sentence));
  return sentence;
}

/**
 * Decision 174: a `/` right after a class or id shorthand followed by a
 * non-identifier (`<div.w-1/2/>`) is Marko's tag-variable read (`2` is not a
 * valid tag variable, with a link out of the template). Say what the author
 * wrote instead: the class shorthand cannot hold it; use `class="…"`.
 */
function rewriteTagVariableShorthand(error: Located, source: string): boolean {
  const reason = typeof error.label === "string" ? error.label : "";
  const at = error.loc?.start;
  if (!at || !TAG_VARIABLE_REASON.test(reason)) return false;
  const offset = at.index ?? offsetOf(source, at.line, at.column);
  // The offending token sits right after the `/` that ends the shorthand.
  if (offset < 1 || source[offset - 1] !== "/") return false;
  const head = source.slice(0, offset - 1);
  const tagAt = head.lastIndexOf("<");
  // Only when the `/` ends a tag head that carries shorthand (`.` or `#`),
  // with no whitespace before it; `/x` after a plain tag (`<const/x=1/>`), an
  // identifier (`/item`) or an attribute (`<div title="a.b" x/2/>`) keeps
  // Marko's read.
  if (tagAt < 0 || !/^<[^<>\s]*[.#][^<>\s]*$/.test(head.slice(tagAt)))
    return false;
  const token = source.slice(offset).match(/^[^\s=/>]+/)?.[0] ?? "";
  const sentence = `\`${token}\` is not more class: a \`/\` after a class or id shorthand starts a tag variable; write the class as \`class="…"\``;
  error.label = reason.replace(TAG_VARIABLE_REASON, sentence);
  setMessage(error, error.message.replace(TAG_VARIABLE_REASON, sentence));
  return true;
}

/**
 * Appends `hint` to the first not-yet-hinted line of `message` that ends with
 * `reason`, searching from the frame that names `at` (`:line:column`, 1-based)
 * when the message has one. A hinted line no longer ends with the bare reason,
 * so the entries of an aggregate land on their own frames in order, and an
 * unhinted entry with the same reason cannot take another's hint.
 */
function appendToReason(
  message: string,
  reason: string,
  hint: string,
  at?: { line: number; column: number },
) {
  const escaped = reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ending = new RegExp(`${escaped}(${SGR})(?=\\r?\\n|$)`);
  const marker = at ? message.indexOf(`:${at.line}:${at.column + 1}\n`) : -1;
  const from = Math.max(marker, 0);
  const found = ending.exec(message.slice(from));
  if (!found) return message;
  const start = from + found.index;
  return `${message.slice(0, start)}${reason}; ${hint}${found[1]}${message.slice(start + found[0].length)}`;
}

/** `CompileError.message` is an accessor whose setter can drop an assignment. */
function setMessage(error: Error, message: string): void {
  Object.defineProperty(error, "message", {
    value: message,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function hintOne(
  error: Located,
  source: string,
  declarations?: Pick<HostDeclarations, "scriptletReplacement">,
): string | null {
  const reason = typeof error.label === "string" ? error.label : null;
  const at = error.loc?.start;
  if (!reason || !at) return null;
  const hint = hintFor(reason, source, at, declarations);
  if (!hint) return null;
  setMessage(error, appendToReason(error.message, reason, hint, at));
  error.label = `${reason}; ${hint}`;
  return hint;
}

/**
 * Appends a fix hint to a recognised Marko parse error's reason, in place
 * (message and `label`, the two places a caller reads it from). An aggregate
 * error is handled entry by entry, mirroring `annotateCloseTagOpener`.
 */
export function hintParseError(
  error: unknown,
  source: string,
  declarations?: Pick<HostDeclarations, "scriptletReplacement">,
): void {
  if (!(error instanceof Error)) return;
  const aggregate = error as Located;
  rewriteShorthandGroup(aggregate, source);
  if (rewriteTagVariableShorthand(aggregate, source)) return;
  hintOne(aggregate, source, declarations);
  for (const entry of aggregate.errors ?? []) {
    if (typeof (entry as Located | null)?.message !== "string") continue;
    const reason = (entry as Located).label;
    const groupSentence = rewriteShorthandGroup(entry as Located, source);
    if (groupSentence && typeof reason === "string") {
      setMessage(aggregate, aggregate.message.replace(reason, groupSentence));
    }
    rewriteTagVariableShorthand(entry as Located, source);
    const hint = hintOne(entry as Located, source, declarations);
    if (hint && typeof reason === "string") {
      setMessage(
        aggregate,
        appendToReason(
          aggregate.message,
          reason,
          hint,
          (entry as Located).loc?.start,
        ),
      );
    }
  }
}
