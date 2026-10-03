import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "astro";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNoAstroMxPages,
  astroMxPagesMessage,
  findAstroMxPages,
} from "./pages-guard.ts";

const dirs: string[] = [];

/** A project `src/` with the given files (contents are irrelevant). */
function project(files: string[]): { srcDir: URL; pagesDir: string } {
  const root = mkdtempSync(join(tmpdir(), "mx-astro-pages-guard-"));
  dirs.push(root);
  for (const file of files) {
    const path = join(root, "src", file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "---\n---\n<p/>\n");
  }
  mkdirSync(join(root, "src", "pages"), { recursive: true });
  return {
    srcDir: pathToFileURL(join(root, "src") + "/"),
    pagesDir: join(root, "src", "pages"),
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("findAstroMxPages", () => {
  it("finds .astro.mx files at any depth, sorted", () => {
    const { pagesDir } = project([
      "pages/about.astro.mx",
      "pages/blog/[slug].astro.mx",
      "pages/blog/index.astro.mx",
      "pages/index.astro",
    ]);
    expect(findAstroMxPages(pagesDir)).toEqual([
      join(pagesDir, "about.astro.mx"),
      join(pagesDir, "blog", "[slug].astro.mx"),
      join(pagesDir, "blog", "index.astro.mx"),
    ]);
  });

  it("leaves .mx and .astro pages alone", () => {
    const { pagesDir } = project([
      "pages/index.mx",
      "pages/about.astro",
      "pages/card.solid.mx",
    ]);
    expect(findAstroMxPages(pagesDir)).toEqual([]);
  });

  it("skips _ and . prefixed files and directories, which Astro never routes", () => {
    const { pagesDir } = project([
      "pages/_partial.astro.mx",
      "pages/_private/deep.astro.mx",
      "pages/.hidden.astro.mx",
    ]);
    expect(findAstroMxPages(pagesDir)).toEqual([]);
  });

  it("walks into .well-known, the one dot-name Astro routes (create-manifest.js:88-96)", () => {
    const { pagesDir } = project([
      "pages/.well-known/wk.astro.mx",
      "pages/.other/skipped.astro.mx",
    ]);
    expect(findAstroMxPages(pagesDir)).toEqual([
      join(pagesDir, ".well-known", "wk.astro.mx"),
    ]);
  });

  it("follows a symlinked directory, as Astro's statSync does", () => {
    const { pagesDir, srcDir } = project(["shared/Card.astro.mx"]);
    symlinkSync(
      join(fileURLToPath(srcDir), "shared"),
      join(pagesDir, "linked"),
      "dir",
    );
    expect(findAstroMxPages(pagesDir)).toEqual([
      join(pagesDir, "linked", "Card.astro.mx"),
    ]);
  });

  it("terminates on a symlink cycle", () => {
    const { pagesDir } = project(["pages/a/page.astro.mx"]);
    symlinkSync(pagesDir, join(pagesDir, "a", "back"), "dir");
    expect(findAstroMxPages(pagesDir)).toEqual([
      join(pagesDir, "a", "page.astro.mx"),
    ]);
  });

  it("skips a dangling symlink instead of throwing", () => {
    const { pagesDir } = project([]);
    symlinkSync(join(pagesDir, "nowhere"), join(pagesDir, "dangling"), "dir");
    expect(findAstroMxPages(pagesDir)).toEqual([]);
  });

  it("ignores components and layouts outside the pages directory", () => {
    const { pagesDir } = project([
      "components/Card.astro.mx",
      "layouts/Base.astro.mx",
    ]);
    expect(findAstroMxPages(pagesDir)).toEqual([]);
  });

  it("returns nothing for a missing pages directory", () => {
    expect(findAstroMxPages(join(tmpdir(), "mx-no-such-pages-dir"))).toEqual(
      [],
    );
  });
});

describe("assertNoAstroMxPages", () => {
  it("does not throw for a project of .mx pages", () => {
    const { srcDir } = project(["pages/index.mx", "components/Card.astro.mx"]);
    expect(() => assertNoAstroMxPages(srcDir)).not.toThrow();
  });

  it("lists every offending file, positioned, with the why and the fix", () => {
    const { srcDir, pagesDir } = project([
      "pages/about.astro.mx",
      "pages/blog/[slug].astro.mx",
    ]);
    let message = "";
    try {
      assertNoAstroMxPages(srcDir);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain(`${join(pagesDir, "about.astro.mx")}:1:1:`);
    expect(message).toContain(
      `${join(pagesDir, "blog", "[slug].astro.mx")}:1:1:`,
    );
    expect(message).toContain("2 `.astro.mx` files under the pages directory");
    // Why: the wrong route Astro derives.
    expect(message).toContain("Astro routes it to /about.astro, not /about");
    // The fix, both ways.
    expect(message).toContain(
      "Write `about.astro` and import the `.astro.mx` component from it, or write the page as `about.mx`.",
    );
    expect(message).toContain("write `[slug].astro`");
  });
});

describe("astroMxPagesMessage wording", () => {
  const message = (page: string) =>
    astroMxPagesMessage([`/p/pages/${page}`], "/p/pages");

  it("contrasts index.astro.mx with the directory route, not /index", () => {
    const root = message("index.astro.mx");
    expect(root).toContain("Astro routes it to /index.astro, not /.");
    expect(root).not.toContain("not /index");
    const nested = message("blog/index.astro.mx");
    expect(nested).toContain(
      "Astro routes it to /blog/index.astro, not /blog.",
    );
    expect(nested).toContain("write the page as `index.mx`");
  });

  it("explains a dynamic segment: Astro reads it as dynamic and wants getStaticPaths", () => {
    for (const page of ["blog/[slug].astro.mx", "[...rest].astro.mx"]) {
      const text = message(page);
      const base = page.split("/").pop()!.slice(0, -".astro.mx".length);
      expect(text).toContain(
        `Astro reads it as a dynamic route ending in \`.astro\` and then requires \`getStaticPaths()\``,
      );
      // Leads with the `.mx` fix.
      expect(text.indexOf(`Write the page as \`${base}.mx\``)).toBeGreaterThan(
        -1,
      );
      expect(text.indexOf(`Write the page as \`${base}.mx\``)).toBeLessThan(
        text.indexOf(`write \`${base}.astro\``),
      );
    }
  });

  it("leaves a static segment's wording alone", () => {
    expect(message("about.astro.mx")).not.toContain("getStaticPaths");
  });
});

describe("astroMxPagesMessage", () => {
  it("uses the singular for one file", () => {
    expect(astroMxPagesMessage(["/p/pages/a.astro.mx"], "/p/pages")).toContain(
      "1 `.astro.mx` file under the pages directory",
    );
  });
});

describe("agreement with Astro's own route collection", () => {
  it("reports exactly the .astro.mx files Astro makes routes of", async () => {
    const { srcDir, pagesDir } = project([
      "pages/index.astro",
      "pages/about.astro.mx",
      "pages/blog/[slug].astro.mx",
      "pages/blog/index.astro.mx",
      "pages/.well-known/wk.astro.mx",
      "pages/.hidden/h.astro.mx",
      "pages/_private/p.astro.mx",
      "pages/_skipped.astro.mx",
      "pages/.dot.astro.mx",
      "shared/Card.astro.mx",
      "components/Card.astro.mx",
    ]);
    symlinkSync(
      join(fileURLToPath(srcDir), "shared"),
      join(pagesDir, "linked"),
      "dir",
    );
    const root = fileURLToPath(new URL("..", srcDir));

    // Only a recorder: no MX integration, so the guard does not throw and
    // Astro builds its route list over the same tree, `.mx` registered as a
    // page extension as the real integration does.
    const routes: string[] = [];
    const recorder = {
      name: "route-recorder",
      hooks: {
        // biome-ignore lint/suspicious/noExplicitAny: Astro hook params
        "astro:config:setup": ({ addPageExtension }: any) => {
          addPageExtension(".mx");
        },
        // biome-ignore lint/suspicious/noExplicitAny: Astro hook params
        "astro:routes:resolved": ({ routes: resolved }: any) => {
          for (const route of resolved) {
            if (route.entrypoint) routes.push(join(root, route.entrypoint));
          }
        },
      },
    };
    try {
      await build({ root, integrations: [recorder], logLevel: "silent" });
    } catch {
      // The build may fail rendering an unparseable page; the hook has fired.
    }

    const astroRoutes = routes.filter((file) => file.endsWith(".astro.mx"));
    expect(astroRoutes.length).toBeGreaterThan(0);
    expect(findAstroMxPages(pagesDir).sort()).toEqual(
      [...new Set(astroRoutes)].sort(),
    );
  }, 60_000);
});
