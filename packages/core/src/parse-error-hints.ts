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

// With colours on (CI, FORCE_COLOR) Marko wraps the reason in escape codes that
// run to the end of the line, so allow SGR sequences after the reason.
const SGR = "(?:\\u001b\\[[0-9;]*m)*";

type Located = Error & {
  loc?: { start?: { line: number; column: number; index?: number } };
  label?: unknown;
  errors?: unknown[];
};

/** The scriptlet rule, shared with the lowering error for a *valid* `$` line. */
export function scriptletFix(name?: string): string {
  return `declare a value with \`<const/${name ?? "x"}=…/>\``;
}

/** The variable a `const|let|var NAME =` statement line declares. */
export const declaredName = (statement: string): string | undefined =>
  statement.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/)?.[1];

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
  if (scriptlet) {
    return `scriptlets (\`$ …\`) are not supported; ${scriptletFix(declaredName(scriptlet[1] ?? ""))}`;
  }
  return null;
}

/** Appends `hint` to the last line of `message` that ends with `reason`. */
function appendToReason(message: string, reason: string, hint: string) {
  const escaped = reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ending = new RegExp(`${escaped}(${SGR})(?=\\r?\\n|$)`, "g");
  let last: RegExpExecArray | undefined;
  for (let found = ending.exec(message); found; found = ending.exec(message)) {
    last = found;
  }
  if (!last) return message;
  return `${message.slice(0, last.index)}${reason}; ${hint}${last[1]}${message.slice(last.index + last[0].length)}`;
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

function hintOne(error: Located, source: string): string | null {
  const reason = typeof error.label === "string" ? error.label : null;
  const at = error.loc?.start;
  if (!reason || !at) return null;
  const hint = hintFor(reason, source, at);
  if (!hint) return null;
  setMessage(error, appendToReason(error.message, reason, hint));
  error.label = `${reason}; ${hint}`;
  return hint;
}

/**
 * Appends a fix hint to a recognised Marko parse error's reason, in place
 * (message and `label`, the two places a caller reads it from). An aggregate
 * error is handled entry by entry, mirroring `annotateCloseTagOpener`.
 */
export function hintParseError(error: unknown, source: string): void {
  if (!(error instanceof Error)) return;
  const aggregate = error as Located;
  hintOne(aggregate, source);
  for (const entry of aggregate.errors ?? []) {
    if (typeof (entry as Located | null)?.message !== "string") continue;
    const reason = (entry as Located).label;
    const hint = hintOne(entry as Located, source);
    if (hint && typeof reason === "string") {
      setMessage(aggregate, appendToReason(aggregate.message, reason, hint));
    }
  }
}
