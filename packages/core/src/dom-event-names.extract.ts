/**
 * Extracts the DOM event names from TypeScript's `lib.dom.d.ts` and writes the
 * generated `dom-event-names.ts`.
 *
 * The names are the property keys of every interface whose name ends in
 * `EventMap` (`HTMLElementEventMap`, `WindowEventMap`,
 * `HTMLMediaElementEventMap`, `WorkerEventMap`, ...), read with the TypeScript
 * compiler API, never with a regex over the text. The union is wider than the
 * element maps on purpose: a handler on `<body>` receives window events
 * (`devicemotion`, `orientationchange`), and media elements fire their own.
 *
 * Only the `--write` run and `dom-event-names.test.ts` import this module, so
 * the bundled `@mxlang/core` never carries `typescript`.
 *
 * Regenerate after a TypeScript bump (the drift test fails until you do):
 *
 *     bun packages/core/src/dom-event-names.extract.ts --write
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Real browser events `lib.dom.d.ts` does not declare. Each is a name a
 * shipping browser fires on an element or the document, so `on<Name>` for it
 * must not warn "not a DOM event". Kept here, next to the extraction, so the
 * generated set is the extraction plus this list and nothing else.
 */
export const DOM_EVENT_SUPPLEMENT: readonly string[] = [
  // Fired before a copy; Chromium and Safari (`onbeforecopy`).
  "beforecopy",
  // Fired before a cut; Chromium and Safari (`onbeforecut`).
  "beforecut",
  // Fired before a paste; Chromium and Safari (`onbeforepaste`).
  "beforepaste",
  // WebXR DOM overlay: fired on an overlay element before an XR select.
  "beforexrselect",
  // CSS `content-visibility: auto` state change, fired on the element.
  "contentvisibilityautostatechange",
  // CSS scroll snap: a scroll snap target was selected (scroll end).
  "scrollsnapchange",
  // CSS scroll snap: the pending scroll snap target changed (during scroll).
  "scrollsnapchanging",
];

/**
 * The sorted, de-duplicated property keys of every `*EventMap` interface in
 * the `lib.dom.d.ts` at `libDomPath`.
 */
export function extractDomEventNames(libDomPath: string): string[] {
  const source = ts.createSourceFile(
    libDomPath,
    readFileSync(libDomPath, "utf8"),
    ts.ScriptTarget.Latest,
    false,
  );
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isInterfaceDeclaration(statement)) continue;
    if (!statement.name.text.endsWith("EventMap")) continue;
    for (const member of statement.members) {
      if (!ts.isPropertySignature(member)) continue;
      const key = member.name;
      if (ts.isIdentifier(key) || ts.isStringLiteral(key)) names.add(key.text);
    }
  }
  return [...names].sort();
}

/** The extraction plus {@link DOM_EVENT_SUPPLEMENT}, sorted. */
export function domEventNames(libDomPath: string): string[] {
  return [
    ...new Set([...extractDomEventNames(libDomPath), ...DOM_EVENT_SUPPLEMENT]),
  ].sort();
}

/** The installed `typescript/lib/lib.dom.d.ts` and its package version. */
export function installedLibDom(): { path: string; version: string } {
  // Resolved and read, never `require`d: this generator is not part of the
  // bundle, and a literal require would read as a runtime dependency of core
  // to the bundled builds' dependency scan.
  const require = createRequire(import.meta.url);
  const path = require.resolve("typescript/lib/lib.dom.d.ts");
  const { version } = JSON.parse(
    readFileSync(require.resolve("typescript/package.json"), "utf8"),
  ) as { version: string };
  return { path, version };
}

function render(names: readonly string[], version: string): string {
  const lines = names.map((name) => `  ${JSON.stringify(name)},`);
  return `// Generated from \`lib.dom.d.ts\` of \`typescript@${version}\` by
// \`dom-event-names.extract.ts\` (every \`*EventMap\` interface's keys, plus its
// \`DOM_EVENT_SUPPLEMENT\`). Do not edit by hand; regenerate with
// \`bun packages/core/src/dom-event-names.extract.ts --write\`.

/** Every DOM event name: the lowercase name an \`on<Name>\` attribute must be. */
export const DOM_EVENT_NAMES: ReadonlySet<string> = new Set([
${lines.join("\n")}
]);
`;
}

if (import.meta.main && process.argv.includes("--write")) {
  const { path, version } = installedLibDom();
  const out = join(
    dirname(fileURLToPath(import.meta.url)),
    "dom-event-names.ts",
  );
  writeFileSync(out, render(domEventNames(path), version));
  console.log(`wrote ${out}`);
}
