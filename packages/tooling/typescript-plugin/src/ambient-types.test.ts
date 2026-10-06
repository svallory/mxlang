import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ambientTypeFiles } from "./ambient-types.ts";

// `packages/hosts/astro` has `astro` installed, as an Astro project does.
const astroProject = join(import.meta.dirname, "../../../hosts/astro");

describe("ambientTypeFiles", () => {
  it("adds a host's ambient types to a program holding one of its file kinds", () => {
    const files = ambientTypeFiles(["/p/src/page.astro.mx"], astroProject);

    expect(files.map((file) => file.split("/").slice(-2).join("/"))).toEqual([
      "astro/env.d.ts",
      "astro/astro-jsx.d.ts",
    ]);
    for (const file of files) expect(existsSync(file)).toBe(true);
  });

  it("matches the file kind case-insensitively, as file recognition does", () => {
    expect(ambientTypeFiles(["/p/Page.ASTRO.MX"], astroProject)).toHaveLength(
      2,
    );
  });

  it("adds nothing to a program without a file of that kind", () => {
    expect(
      ambientTypeFiles(["/p/src/page.mx", "/p/src/a.ts"], astroProject),
    ).toEqual([]);
  });

  it("never adds a file that is already a root file", () => {
    const [env, jsx] = ambientTypeFiles(["/p/a.astro.mx"], astroProject);

    expect(
      ambientTypeFiles(["/p/a.astro.mx", env as string], astroProject),
    ).toEqual([jsx]);
  });
});
