import { describe, expect, it } from "vitest";
import descriptor from "./descriptor.ts";

/**
 * What `mx-tsc --astro` adds to a program holding an `.astro.mx` file: the
 * types Astro's language server injects (`addAstroTypes`), so `Fragment` and
 * `astro/jsx-runtime` resolve without `types: ["astro/env"]`.
 */
const ambientTypes = descriptor.host?.ambientTypes;
const installed =
  (missing: (file: string) => boolean) =>
  (file: string): string | undefined =>
    missing(file) ? undefined : `/abs/${file}`;

describe("the astro host's ambient types", () => {
  it("are astro's own env and JSX declarations when astro is installed", () => {
    expect(ambientTypes?.(installed(() => false))).toEqual([
      "/abs/astro/env.d.ts",
      "/abs/astro/astro-jsx.d.ts",
    ]);
  });

  it("fall back to the language server's copies without an astro install", () => {
    expect(
      ambientTypes?.(installed((file) => file.startsWith("astro/"))),
    ).toEqual([
      "/abs/@astrojs/language-server/types/env.d.ts",
      "/abs/@astrojs/language-server/types/astro-jsx.d.ts",
      "/abs/@astrojs/language-server/types/jsx-runtime-fallback.d.ts",
    ]);
  });

  it("are none when neither is installed", () => {
    expect(ambientTypes?.(installed(() => true))).toEqual([]);
  });
});
