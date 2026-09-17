/**
 * Angular directives an emitted template may need in its component's
 * `imports:` array.
 *
 * Shared by both module-emitting paths — `compileTagModule` (a `tags/*.mx`
 * unit) and `compileNgMx` (a `.ng.mx` component) — so the two cannot
 * disagree about which construct obliges which import.
 */

/** Each entry pairs text the emitter writes with the symbol Angular needs. */
export const DIRECTIVE_IMPORTS = [
  // Detected from the emitted template rather than tracked through the
  // emitter, so a construct that starts emitting one of these can never
  // forget to declare it.
  { marker: "[ngClass]", symbol: "NgClass" },
  { marker: "[ngStyle]", symbol: "NgStyle" },
  { marker: "| keyvalue", symbol: "KeyValuePipe" },
  { marker: "[ngComponentOutlet]", symbol: "NgComponentOutlet" },
  { marker: "[ngTemplateOutlet]", symbol: "NgTemplateOutlet" },
] as const;

/** The `@angular/common` symbols a given emitted template obliges. */
export function directivesFor(template: string): string[] {
  return DIRECTIVE_IMPORTS.filter(({ marker }) =>
    template.includes(marker),
  ).map(({ symbol }) => symbol);
}
