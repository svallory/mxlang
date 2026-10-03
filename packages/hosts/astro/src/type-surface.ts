/**
 * Astro passes template children as JSX's `children` attribute, then the MX
 * renderer turns that slot into `input.content` at runtime. Present that call
 * shape to TypeScript without changing the compiled function body.
 *
 * `children` is offered only to a component whose `Input` actually declares
 * `content`. A component with no content slot accepts no slot content at
 * runtime, so bolting `children?: unknown` onto it would let
 * `<Card>anything</Card>` type-check against a component that silently drops
 * it. The choice is made by a conditional type rather than by inspecting the
 * emitted interface text, so it stays correct however the author formatted
 * their `Input` — and `Omit` still removes `content` itself, which is the
 * renderer's own parameter name and never something an Astro caller passes.
 *
 * The descriptor supplies this function to tooling as `typeSurface`.
 * `@mxlang/typescript-plugin` keeps its historical compatibility export,
 * forwarding to this descriptor-owned implementation.
 */
export function createAstroTypeSurface(code: string): string {
  // The export is named after the file (`card.mx` -> `Card`), so this matches
  // the statement's shape and reads the name back rather than pinning a fixed
  // `render`.
  const match = code.match(/export default ([A-Za-z_$][\w$]*);/);
  if (!match?.[1]) {
    throw new Error(
      "@mxlang/typescript-plugin: the Astro host could not find the compiled MX default export.",
    );
  }
  const name = match[1];
  return code.replace(
    match[0],
    [
      'type MxAstroInput = "content" extends keyof Input',
      '  ? Omit<Input, "content"> & { children?: unknown }',
      "  : Input;",
      `const mxAstroRender = ${name} as unknown as (input: MxAstroInput) => string;`,
      "export default mxAstroRender;",
    ].join("\n"),
  );
}
