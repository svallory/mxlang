/**
 * Ambient typing for `import page from "./page.mx"` under either loader
 * (`@mxlang/html/bun` or `@mxlang/vite-plugin`'s `.mx` handling).
 *
 * `any` rather than each file's real `Input` interface: per-file typing needs
 * a virtual-file projection of the compiled module, which is the phase-3
 * language server's job (see `@mxlang/typescript-plugin`'s equivalent role for
 * `.solid.mx`), not something this ambient declaration can derive on its own.
 *
 * `.marko` has no declaration here: `.mx` is the only extension either loader
 * accepts, since MX only supports the MX 1.0 subset of Marko syntax.
 */
declare module "*.mx" {
  const render: (input: unknown) => string;
  export default render;
}
