import type { MxWarning } from "@mxlang/core";
import { SOLID_BUILTIN_TAGS, sourceBindings } from "@mxlang/tsx-bridge";

/**
 * Appends an import for every Solid JSX built-in (`SOLID_BUILTIN_TAGS`,
 * `@mxlang/tsx-bridge`) the generated text uses as a bare tag and the source
 * does not already bind (`sourceBindings`, same package) — so a caller who
 * genuinely wrote `import { Show } from "./my-show.ts"` is left alone rather
 * than getting a colliding second `Show`. `@mxlang/solid`'s emitter prints
 * these built-ins (`<Show>`, `<For>`, …) as bare tags because the *runtime*
 * build pipeline gets them for free — `@solidjs/vite-plugin`'s compiler
 * stage (native or Babel) auto-imports every built-in it sees, per
 * `@mxlang/solid`'s own `AGENTS.md` — and that compiler stage never runs
 * inside the type-check projection: the TypeScript plugin's
 * `createVirtualCode` only prints JSX text and hands it straight to
 * `tsc`/tsserver, so without this, every
 * `<Show>` (from `<if>`/`<if|u|>`), `<For>`/`<Repeat>` (from `<for>`),
 * `<Switch>`/`<Match>` (from a 3+-branch `<if>`), `<Errored>`/`<Loading>`
 * (from `<try>`) and `<Dynamic>` (from a dynamic tag) is an unresolved
 * identifier (TS2304), which drowns every real diagnostic inside that JSX in
 * noise (`@mxlang/typescript-plugin`'s negative tests guard this).
 *
 * This is Solid's `completeTypecheckModule` (`./descriptor.ts`): the plugin
 * calls it through the registry, never by name.
 *
 * Appended at the end of the file, after every mapping is computed from the
 * unmodified generated text, so no existing line or offset shifts: an
 * appended, unmapped import cannot mis-position an earlier diagnostic.
 *
 * **`generated` failing to parse would mean the printer itself emitted
 * invalid TSX** — a bug in the printer, not an author mistake, since
 * `generated` is our own emitted output rather than authored source (see
 * `source-bindings-silent-parse-failure`). On that failure every built-in is
 * appended unconditionally rather than silently treating it as "nothing
 * bound" — over-importing risks at worst a redundant import TypeScript
 * already tolerates; under-importing (the old behavior, if `sourceBindings`
 * happened to swallow a real binding) risks hiding every real diagnostic
 * inside the JSX behind TS2304 noise, which is exactly the failure class
 * this function exists to prevent. The failure is reported through the same
 * `warning` channel every other non-fatal diagnostic of the TypeScript plugin
 * uses (`compile-deps-cap-warning`'s cap warning is the precedent: positioned at
 * the file's own start, line 1 column 1, since there is no more specific
 * author-facing position for a printer-internal failure) rather than only a
 * `console.warn`, which an editor user would never see.
 */
export function appendSolidBuiltinImport(generated: string): {
  code: string;
  warning?: MxWarning;
} {
  const { bindings: bound, error } = sourceBindings(generated);
  const warning: MxWarning | undefined = error
    ? {
        message:
          "the printed .solid.mx module could not be parsed while checking " +
          "Solid built-in imports, so they were added conservatively " +
          `(${error.message})`,
        line: 1,
        column: 0,
      }
    : undefined;
  const needed = SOLID_BUILTIN_TAGS.filter(
    ({ name }) =>
      new RegExp(`<${name}[\\s/>]`).test(generated) &&
      (error || !bound.has(name)),
  );
  if (needed.length === 0) return { code: generated, warning };

  const byModule = new Map<string, string[]>();
  for (const { name, from } of needed) {
    const names = byModule.get(from) ?? [];
    names.push(name);
    byModule.set(from, names);
  }
  const imports = [...byModule.entries()]
    .map(([from, names]) => `import { ${names.join(", ")} } from "${from}";`)
    .join("\n");
  return { code: `${generated}\n${imports}\n`, warning };
}
