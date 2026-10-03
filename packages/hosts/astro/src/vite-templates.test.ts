import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { clearScanCache } from "@mxlang/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASTRO_MX_EXT,
  ASTRO_SUFFIX,
  mxTemplates,
  readTemplateSource,
} from "./vite-templates.ts";

const COMPONENT = `---
const title = "hi";
---
<h1>\${title}</h1>
`;

/**
 * A stand-in for Vite's plugin context, mirroring
 * `packages/tooling/vite-plugin/src/index.test.ts`'s: relative ids resolve against
 * the importer's directory, root-relative ids against `root`.
 */
function makeContext(opts: { root?: string } = {}) {
  const calls: Array<{ id: string; importer?: string; skipSelf?: boolean }> =
    [];
  return {
    calls,
    async resolve(
      id: string,
      importer?: string,
      options?: { skipSelf?: boolean },
    ) {
      calls.push({ id, importer, skipSelf: options?.skipSelf });

      const queryIndex = id.search(/[?#]/);
      const path = queryIndex === -1 ? id : id.slice(0, queryIndex);
      const suffix = queryIndex === -1 ? "" : id.slice(queryIndex);

      let resolved: string | null = null;
      if (path.startsWith("/") && opts.root) {
        resolved = join(opts.root, path);
      } else if (path.startsWith(".")) {
        if (!importer) return null;
        resolved = resolvePath(dirname(importer), path);
      } else {
        return null;
      }
      return { id: resolved + suffix };
    },
  };
}

type Hooks = ReturnType<typeof mxTemplates>;

function resolveIdOf(plugin: Hooks) {
  const { resolveId } = plugin;
  if (typeof resolveId !== "function") throw new Error("no resolveId hook");
  return resolveId as unknown as (
    this: unknown,
    id: string,
    importer?: string,
  ) => Promise<string | null>;
}

function loadOf(plugin: Hooks) {
  const { load } = plugin;
  if (typeof load !== "function") throw new Error("no load hook");
  return load as unknown as (this: unknown, id: string) => string | null;
}

interface FakeModule {
  id: string;
}

function handleHotUpdateOf(plugin: Hooks) {
  const hook = plugin.handleHotUpdate;
  if (typeof hook !== "function") throw new Error("no handleHotUpdate hook");
  return hook as unknown as (ctx: {
    file: string;
    modules: FakeModule[];
    server: {
      moduleGraph: {
        getModuleById(id: string): FakeModule | undefined;
        invalidateModule(mod: FakeModule): void;
      };
    };
  }) => FakeModule[] | undefined;
}

/**
 * A fake Vite module graph holding exactly the ids given.
 *
 * `astro dev` is never started: the hook's whole contract is "map the changed
 * file to its virtual id, invalidate that module, return it", and a fake
 * graph exercises all three without a dev server.
 */
function makeGraph(ids: string[]) {
  const modules = new Map<string, FakeModule>(
    ids.map((id) => [id, { id }] as const),
  );
  const invalidated: FakeModule[] = [];
  return {
    invalidated,
    getModuleById: (id: string) => modules.get(id),
    invalidateModule: (mod: FakeModule) => {
      invalidated.push(mod);
    },
  };
}

/** Writes `source` to a real temp file, since `load` reads from disk. */
function writeAmx(name: string, source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mx-astro-templates-"));
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  return path;
}

describe("readTemplateSource", () => {
  it("returns the file's text via the default reader", () => {
    const path = writeAmx("Card.astro.mx", "---\n---\n<p>hi</p>\n");
    expect(readTemplateSource(path)).toBe("---\n---\n<p>hi</p>\n");
  });

  it("returns undefined, not a thrown error, when the injected reader fails", () => {
    // The template an `AstroTemplateError.file` names may have been deleted
    // or become unreadable between the original compile's own read and
    // this one — that failure must cost only the Vite overlay's frame,
    // never replace the diagnostic with a raw ENOENT. Inject a reader
    // instead of touching the real filesystem or the module's default
    // `readFileSync`, since forcing an actual read failure at exactly this
    // call site (and not the compile's own earlier read of the same file)
    // can't be done through real files without racing a delete.
    const throwingReader = () => {
      throw Object.assign(new Error("ENOENT: no such file"), {
        code: "ENOENT",
      });
    };
    expect(
      readTemplateSource("/nonexistent.astro.mx", throwingReader),
    ).toBeUndefined();
  });
});

describe("mxTemplates()", () => {
  it("is a pre-enforced plugin", () => {
    const plugin = mxTemplates();
    expect(plugin.name).toBe("mx-astro-templates");
    expect(plugin.enforce).toBe("pre");
  });

  describe("resolveId", () => {
    it("rewrites a relative .astro.mx import to the virtual .astro id", async () => {
      const context = makeContext();
      const resolveId = resolveIdOf(mxTemplates());

      const resolved = await resolveId.call(
        context,
        "./Base.astro.mx",
        "/root/src/pages/index.astro",
      );

      expect(resolved).toBe(
        `/root/src/pages/Base${ASTRO_MX_EXT}${ASTRO_SUFFIX}`,
      );
    });

    it("keeps the query string on the rewritten id", async () => {
      const context = makeContext();
      const resolveId = resolveIdOf(mxTemplates());

      const resolved = await resolveId.call(
        context,
        "./A.astro.mx?t=1712345",
        "/root/src/index.astro",
      );

      expect(resolved).toBe(`/root/src/A.astro.mx${ASTRO_SUFFIX}?t=1712345`);
    });

    it("returns an already-rewritten id unchanged", async () => {
      const context = makeContext();
      const resolveId = resolveIdOf(mxTemplates());
      const id = `/root/src/A.astro.mx${ASTRO_SUFFIX}`;

      expect(await resolveId.call(context, id, undefined)).toBe(id);
      expect(context.calls).toHaveLength(0);
    });

    it("declines ?raw and ?url so Vite serves the real file", async () => {
      const context = makeContext();
      const resolveId = resolveIdOf(mxTemplates());

      for (const query of ["?raw", "?url"]) {
        expect(
          await resolveId.call(
            context,
            `./A.astro.mx${query}`,
            "/root/src/index.astro",
          ),
        ).toBeNull();
      }
    });

    it("leaves ids it does not handle alone", async () => {
      const context = makeContext();
      const resolveId = resolveIdOf(mxTemplates());

      expect(
        await resolveId.call(context, "./page.astro", "/root/src/index.astro"),
      ).toBeNull();
      expect(
        await resolveId.call(context, "./card.mx", "/root/src/index.astro"),
      ).toBeNull();
      expect(context.calls).toHaveLength(0);
    });
  });

  describe("load", () => {
    it("lowers the real .astro.mx file behind the virtual id", () => {
      const path = writeAmx("Base.astro.mx", COMPONENT);
      const load = loadOf(mxTemplates());

      const code = load.call({}, path + ASTRO_SUFFIX);

      // The fence survives byte for byte; the template is lowered.
      expect(code).toContain('const title = "hi";');
      expect(code).toContain("<h1>{title}</h1>");
    });

    it("passes registered custom tags into .astro.mx lowering", () => {
      const path = writeAmx("Custom.astro.mx", "<icon/>");
      const load = loadOf(
        mxTemplates({
          icon: {
            transform: (_call, ctx) => [ctx.build.element("svg")],
          },
        }),
      );

      expect(load.call({}, path + ASTRO_SUFFIX)).toBe("<svg></svg>");
    });

    it("does not shadow a real .astro.mx.astro file on disk", () => {
      // `Shadow.astro.mx.astro` exists but `Shadow.astro.mx` does not: the id belongs to
      // the real file, so the hook must decline and let Vite read it.
      const real = writeAmx(
        `Shadow.astro.mx${ASTRO_SUFFIX}`,
        "---\n---\n<p>x</p>",
      );
      const load = loadOf(mxTemplates());

      expect(load.call({}, real)).toBeNull();
    });

    it("raises a lowering error with a Vite-shaped loc and frame", () => {
      const path = writeAmx(
        "Bad.astro.mx",
        "---\nconst a = 1;\n---\n<let/n=1/>",
      );
      const load = loadOf(mxTemplates());

      try {
        load.call({}, path + ASTRO_SUFFIX);
        throw new Error("expected the load hook to throw");
      } catch (error) {
        const wrapped = error as {
          message: string;
          id?: string;
          loc?: { file: string; line: number; column: number };
          frame?: string;
        };
        expect(wrapped.message).toMatch(
          /reactive state and requires a runtime/,
        );
        // The position names the real `.astro.mx` file, past the fence.
        expect(wrapped.id).toBe(path);
        expect(wrapped.loc?.file).toBe(path);
        expect(wrapped.loc?.line).toBe(4);
        expect(wrapped.frame).toContain("<let/n=1/>");
      }
    });
  });

  describe("handleHotUpdate", () => {
    // Vite keys its module graph by the *resolved* id (`X.astro.mx.astro`), which
    // does not exist on disk. An edit fires with the real `.astro.mx` path, so
    // without this hook nothing in the graph matches and `astro dev` sends no
    // update at all. No dev server is started here: a fake graph exercises the
    // whole contract.

    it("invalidates the virtual module when the real .astro.mx file changes", () => {
      const file = "/root/src/components/Panel.astro.mx";
      const virtualId = file + ASTRO_SUFFIX;
      const graph = makeGraph([virtualId]);
      const existing = { id: "/root/src/pages/index.astro" };

      const result = handleHotUpdateOf(mxTemplates())({
        file,
        modules: [existing],
        server: { moduleGraph: graph },
      });

      expect(graph.invalidated.map((m) => m.id)).toEqual([virtualId]);
      // The changed module is returned alongside whatever Vite already had,
      // so the update propagates rather than replacing Vite's own list.
      expect(result?.map((m) => m.id)).toEqual([existing.id, virtualId]);
    });

    it("ignores a file that is not .astro.mx", () => {
      const graph = makeGraph(["/root/src/card.mx.ts"]);

      const result = handleHotUpdateOf(mxTemplates())({
        file: "/root/src/card.mx",
        modules: [],
        server: { moduleGraph: graph },
      });

      expect(result).toBeUndefined();
      expect(graph.invalidated).toHaveLength(0);
    });

    it("returns undefined when the virtual module is not in the graph", () => {
      // An `.astro.mx` file nothing has imported yet: there is no module to
      // invalidate, and returning an empty list would claim otherwise.
      const graph = makeGraph([]);

      const result = handleHotUpdateOf(mxTemplates())({
        file: "/root/src/Unused.astro.mx",
        modules: [],
        server: { moduleGraph: graph },
      });

      expect(result).toBeUndefined();
      expect(graph.invalidated).toHaveLength(0);
    });
  });

  describe("custom tag discovery", () => {
    afterEach(() => {
      clearScanCache();
    });

    it("resolves a tag from a sibling tags/ directory with no import", () => {
      // The `.mx` half of this host reaches discovery through `mx()` inside
      // `@mxlang/vite-plugin`; `.astro.mx` has its own `load`, so without the scan
      // wired in here it would be the one file kind where a `tags/` directory
      // is invisible.
      const dir = mkdtempSync(join(tmpdir(), "mx-amx-tags-"));
      writeFileSync(
        join(dir, "package.json"),
        '{"name":"a","mx":{"host":"astro"}}',
      );
      mkdirSync(join(dir, "tags"), { recursive: true });
      writeFileSync(
        join(dir, "tags", "stamp.tag.ts"),
        "export default { transform: (_c, ctx) => [ctx.build.text('stamped')] };\n",
      );
      const amx = join(dir, `page${ASTRO_MX_EXT}`);
      writeFileSync(amx, "---\n---\n<stamp/>\n");

      const plugin = mxTemplates();
      const load = plugin.load as (id: string) => string | null;
      const lowered = load.call({}, amx + ASTRO_SUFFIX);

      expect(lowered).toContain("stamped");
    });

    it("leaves an unmatched mx.tags host unresolved under its own-only lookup", () => {
      // PR 3 round-2 ruling: own-only lookups cannot validate peer names.
      const dir = mkdtempSync(join(tmpdir(), "mx-amx-hosts-warning-"));
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "a",
          mx: {
            host: "astro",
            tags: [{ dir: "widgets", hosts: ["bogus"] }],
          },
        }),
      );
      mkdirSync(join(dir, "widgets"), { recursive: true });
      writeFileSync(join(dir, "widgets", "gizmo.mx"), "<span>gizmo</span>\n");
      const amx = join(dir, `page${ASTRO_MX_EXT}`);
      writeFileSync(amx, "---\n---\n<div>no call</div>\n");

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const load = loadOf(mxTemplates());
        load.call({}, amx + ASTRO_SUFFIX);
        expect(
          warn.mock.calls.some((call) => String(call[0]).includes("bogus")),
        ).toBe(false);
      } finally {
        warn.mockRestore();
      }
    });

    it("raises a Vite-shaped error pointing at a broken *template* tag, not the .astro.mx caller", () => {
      // Round 2 fix: a TranslateError raised inside a discovered *template*
      // tag (tags/broken.mx) carried no `.file` through `AstroTemplateError`,
      // and the frame was built from the .astro.mx caller's own source — so the
      // error used to be reported at the template's line/column measured
      // against the wrong file's text.
      const dir = mkdtempSync(join(tmpdir(), "mx-amx-tags-"));
      writeFileSync(
        join(dir, "package.json"),
        '{"name":"a","mx":{"host":"astro"}}',
      );
      mkdirSync(join(dir, "tags"), { recursive: true });
      const templateFile = join(dir, "tags", "broken.mx");
      writeFileSync(
        templateFile,
        [
          "export interface Input { name: string }",
          '<span class="icon">${input.name}</span>',
          "<else/>",
          "",
        ].join("\n"),
      );
      const amx = join(dir, `page${ASTRO_MX_EXT}`);
      writeFileSync(amx, '---\n---\n<broken name="star"/>\n');

      const load = loadOf(mxTemplates());

      try {
        load.call({}, amx + ASTRO_SUFFIX);
        throw new Error("expected the load hook to throw");
      } catch (error) {
        const wrapped = error as {
          message: string;
          id?: string;
          loc?: { file: string; line: number; column: number };
          frame?: string;
        };
        expect(wrapped.message).toMatch(/`<else>`/);
        expect(wrapped.id).toBe(templateFile);
        expect(wrapped.loc?.file).toBe(templateFile);
        expect(wrapped.loc?.line).toBe(3);
        expect(wrapped.frame).toContain("<else/>");
      }
    });
  });
});
