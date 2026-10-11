/**
 * The two name rules every tag source shares: what a tag name may be
 * (`TAG_NAME_RE`) and the names core keeps for itself (`RESERVED_NAMES`).
 * A leaf module, so the scan, dialect manifests and the entry point read one
 * copy without importing each other.
 */

/**
 * What a tag file's basename may be, and therefore what a call name may be.
 *
 * The rule: a letter, digit or underscore to start, then letters, digits,
 * underscores, hyphens and dots. It is Marko's own tag-name vocabulary, minus
 * the shapes that break the compiler rather than merely looking odd.
 *
 * This is a guard with teeth, not tidiness. `tags/.mx` has an empty basename,
 * and an empty tag name makes `@marko/compiler` throw `Error while applying
 * option of "<>". Cause: "tag.name" is required` — which fails *every* file in
 * the package, not just the one that would have called it. Dotfiles are the
 * same class from the other side: `.DS_Store.mx` would register a tag named
 * `.DS_Store`, and a `tags/` directory is an ordinary directory that collects
 * ordinary junk.
 *
 * Case is preserved: `tags/Icon.tag.ts` is `<Icon>`, not `<icon>`. A tag name
 * is the filename, and the filename is the author's.
 */
export const TAG_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** The names no tag may use under the entry point (decision 131 addendum, item 2). */
export const RESERVED_NAMES = [
  "if",
  "else",
  "else-if",
  "for",
  "const",
  "define",
  "return",
  "import",
  "export",
  "static",
  "try",
] as const;

/** The reserved-name message, for a name used as a tag. */
export function reservedNameMessage(name: string): string {
  return `\`<${name}>\` cannot name a data tag: it is reserved — core consumes the structural names (\`if\`, \`else\`, \`else-if\`, \`for\`, \`const\`, \`define\`, \`return\`, \`import\`, \`export\`, \`static\`) and \`<try>\` before a target sees them`;
}

/**
 * The message for a definition of a name only a dialect may define:
 * "`<entity>` cannot be defined by a tag file: Mesh reserves it". `source`
 * names what defined it (`a tag file`, `an \`mx.tags\` directory`,
 * `\`mx.contracts\``, `\`customTags\``).
 */
export function dialectReservedMessage(
  name: string,
  source: string,
  dialectName: string,
): string {
  return `\`<${name}>\` cannot be defined by ${source}: ${dialectName} reserves it`;
}
