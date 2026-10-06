import { describe, expect, it } from "vitest";
import descriptor from "./descriptor.ts";

/**
 * What a tool adds to a program holding Astro's files: the types Astro's
 * language server injects (`addAstroTypes`), so `Fragment` and
 * `astro/jsx-runtime` resolve without `types: ["astro/env"]`.
 */
const ambientTypes = descriptor.host?.ambientTypes;
const installed =
  (missing: (file: string) => boolean) =>
  (file: string): string | undefined =>
    missing(file) ? undefined : `/abs/${file}`;
const program = (
  rootNames: readonly string[],
  missing: (file: string) => boolean = () => false,
) => ({ rootNames, resolve: installed(missing) });

describe("the astro host's ambient types", () => {
  it("are astro's own env and JSX declarations when astro is installed", () => {
    expect(ambientTypes?.(program(["/p/src/Page.astro.mx"]))).toEqual([
      "/abs/astro/env.d.ts",
      "/abs/astro/astro-jsx.d.ts",
    ]);
  });

  it("are added for a program holding a plain .astro page and no .astro.mx", () => {
    expect(ambientTypes?.(program(["/p/src/pages/index.astro"]))).toEqual([
      "/abs/astro/env.d.ts",
      "/abs/astro/astro-jsx.d.ts",
    ]);
  });

  it("are none for a program holding no Astro file", () => {
    expect(ambientTypes?.(program(["/p/src/page.mx", "/p/src/a.ts"]))).toEqual(
      [],
    );
  });

  it("fall back to the language server's copies without an astro install", () => {
    expect(
      ambientTypes?.(
        program(["/p/a.astro.mx"], (file) => file.startsWith("astro/")),
      ),
    ).toEqual([
      "/abs/@astrojs/language-server/types/env.d.ts",
      "/abs/@astrojs/language-server/types/astro-jsx.d.ts",
      "/abs/@astrojs/language-server/types/jsx-runtime-fallback.d.ts",
    ]);
  });

  it("are none when neither is installed", () => {
    expect(ambientTypes?.(program(["/p/a.astro.mx"], () => true))).toEqual([]);
  });
});
