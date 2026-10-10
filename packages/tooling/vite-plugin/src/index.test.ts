import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import {
  type CustomTag,
  clearScanCache,
  type TargetCompiler,
} from "@mxlang/core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import mx, { MX_SUFFIX, readTemplateSource } from "./index";

/**
 * The temp directories `writeMx` makes, removed when this file is done.
 *
 * TODO `test-tmpdir-leak`: `writeMx` runs once per test across this file and
 * used to leave every directory behind in the OS temp directory.
 */
const written: string[] = [];

afterAll(() => {
  for (const dir of written.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const COUNTER = `import { createSignal } from "solid-js";

export function Counter() {
  const [count, setCount] = createSignal(0);

  return (
    <button onClick() { setCount(count() + 1) }>Count: \${count()}</button>
  );
}
`;

const BROKEN = `export function A() {
  return (
    <div><span>oops</div>
  );
}
`;

interface TransformResult {
  code: string;
  map: unknown;
}

/**
 * A stand-in for Vite's plugin context. `resolve` mimics the real resolver
 * closely enough for the hook's own logic to be exercised: relative ids are
 * joined against the importer's directory, root-relative ids against `root`,
 * and `alias` entries are applied by prefix. Anything unknown resolves to
 * null, the way a bare specifier with no match would.
 */
function makeContext(
  opts: {
    root?: string;
    alias?: Record<string, string>;
    resolvable?: (id: string) => boolean;
  } = {},
) {
  const calls: Array<{ id: string; importer?: string; skipSelf?: boolean }> =
    [];
  const context = {
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
      for (const [from, to] of Object.entries(opts.alias ?? {})) {
        if (path.startsWith(from)) {
          resolved = to + path.slice(from.length);
          break;
        }
      }
      if (resolved === null) {
        if (path.startsWith("/") && opts.root) {
          resolved = join(opts.root, path);
        } else if (path.startsWith(".")) {
          if (!importer) return null;
          resolved = resolvePath(dirname(importer), path);
        } else if (opts.resolvable?.(path)) {
          resolved = path;
        } else {
          return null;
        }
      }

      return { id: resolved + suffix };
    },
  };
  return context;
}

type Hooks = ReturnType<typeof mx>;

/** Intercept table dispatch, not a host index the plugin no longer imports. */
async function mockCompiler(
  target: string,
  compileModule: TargetCompiler["compileModule"],
) {
  const { builtinLookup } = await import("@mxlang/targets");
  const descriptor = builtinLookup().target(target);
  if (!descriptor?.load) throw new Error("missing compiler");
  const wired = descriptor as typeof descriptor & {
    load: NonNullable<typeof descriptor.load>;
  };
  return vi.spyOn(wired, "load").mockReturnValue({ compileModule });
}

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

function transformOf(plugin: Hooks) {
  const { transform } = plugin;
  if (typeof transform !== "function") throw new Error("no transform hook");
  return transform as unknown as (
    this: unknown,
    code: string,
    id: string,
  ) => Promise<TransformResult | null>;
}

/** Writes `source` to a real temp file, since `load` reads from disk. */
function writeMx(name: string, source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mx-vite-plugin-"));
  written.push(dir);
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  return path;
}

describe("mx()", () => {
  it("is a pre-enforced plugin named mx", () => {
    const plugin = mx();
    expect(plugin.name).toBe("mx");
    expect(plugin.enforce).toBe("pre");
  });

  it("throws a clear error if extensions includes .marko", () => {
    // MX only supports the MX 1.0 subset of Marko syntax, so a caller
    // cannot opt back into `.marko` through `extensions`.
    expect(() => mx({ extensions: [".mx", ".marko"] })).toThrow(
      /'\.marko' is not a supported extension/,
    );
  });

  describe("resolveId", () => {
    it("resolves a relative import from a nested importer", async () => {
      // The importer is a .tsx two directories deep; the old local path math
      // sliced the suffix length off the *importer* and landed a directory up.
      const context = makeContext();
      const resolveId = resolveIdOf(mx());

      const resolved = await resolveId.call(
        context,
        "./Counter.solid.mx",
        "/root/src/features/index.tsx",
      );

      expect(resolved).toBe(`/root/src/features/Counter.solid.mx${MX_SUFFIX}`);
    });

    describe("a .marko tag import", () => {
      it("is claimed when an MX module imports it", async () => {
        const resolveId = resolveIdOf(mx());
        const ctx = makeContext();

        expect(
          await resolveId.call(
            ctx,
            "./tags/badge.marko",
            `/root/src/page.mx${MX_SUFFIX}`,
          ),
        ).toBe(`/root/src/tags/badge.marko${MX_SUFFIX}`);
        // A tag importing another tag: its importer is itself a claimed tag.
        expect(
          await resolveId.call(
            ctx,
            "./inner.marko",
            `/root/src/tags/outer.marko${MX_SUFFIX}`,
          ),
        ).toBe(`/root/src/tags/inner.marko${MX_SUFFIX}`);
        // A `.solid.mx` page too: it emits the same import.
        expect(
          await resolveId.call(
            ctx,
            "./tags/badge.marko",
            `/root/src/Page.solid.mx${MX_SUFFIX}`,
          ),
        ).toBe(`/root/src/tags/badge.marko${MX_SUFFIX}`);
      });

      it("is left alone for any other importer, and with none", async () => {
        const resolveId = resolveIdOf(mx());
        const ctx = makeContext();

        expect(
          await resolveId.call(ctx, "./x.marko", "/root/src/main.ts"),
        ).toBeNull();
        expect(await resolveId.call(ctx, "/root/src/x.marko")).toBeNull();
        expect(ctx.calls).toHaveLength(0);
      });

      it("is not claimed when the resolver cannot find it", async () => {
        const resolveId = resolveIdOf(mx());
        expect(
          await resolveId.call(
            { resolve: async () => null },
            "./missing.marko",
            `/root/src/page.mx${MX_SUFFIX}`,
          ),
        ).toBeNull();
      });

      it("keeps the query across the rewrite", async () => {
        const resolveId = resolveIdOf(mx());
        expect(
          await resolveId.call(
            makeContext(),
            "./tags/badge.marko?t=1",
            `/root/src/page.mx${MX_SUFFIX}`,
          ),
        ).toBe(`/root/src/tags/badge.marko${MX_SUFFIX}?t=1`);
      });

      it("is still not an accepted `extensions` entry", () => {
        expect(() => mx({ extensions: [".marko"] })).toThrow(
          /'\.marko' is not a supported extension/,
        );
      });
    });

    it("delegates with skipSelf so the hook cannot recurse", async () => {
      const context = makeContext();
      const resolveId = resolveIdOf(mx());

      await resolveId.call(context, "./A.solid.mx", "/root/src/index.tsx");

      expect(context.calls).toHaveLength(1);
      expect(context.calls[0]?.skipSelf).toBe(true);
    });

    it("resolves a root-relative id against the project root", async () => {
      const context = makeContext({ root: "/root" });
      const resolveId = resolveIdOf(mx());

      const resolved = await resolveId.call(
        context,
        "/src/Counter.solid.mx",
        "/root/src/index.tsx",
      );

      expect(resolved).toBe(`/root/src/Counter.solid.mx${MX_SUFFIX}`);
    });

    it("resolves an aliased id", async () => {
      const context = makeContext({ alias: { "@/": "/root/src/" } });
      const resolveId = resolveIdOf(mx());

      const resolved = await resolveId.call(
        context,
        "@/Counter.solid.mx",
        "/root/src/index.tsx",
      );

      expect(resolved).toBe(`/root/src/Counter.solid.mx${MX_SUFFIX}`);
    });

    it("resolves a bare specifier into a workspace package", async () => {
      const context = makeContext({
        resolvable: (id) => id === "@acme/ui/Card.solid.mx",
      });
      const resolveId = resolveIdOf(mx());

      const resolved = await resolveId.call(
        context,
        "@acme/ui/Card.solid.mx",
        "/root/src/index.tsx",
      );

      expect(resolved).toBe(`@acme/ui/Card.solid.mx${MX_SUFFIX}`);
    });

    it("keeps the query string on the rewritten id", async () => {
      const context = makeContext();
      const resolveId = resolveIdOf(mx());

      // Vite appends `?t=` on an HMR re-fetch; dropping it would serve a
      // stale module.
      const resolved = await resolveId.call(
        context,
        "./A.solid.mx?t=1712345",
        "/root/src/index.tsx",
      );

      expect(resolved).toBe(`/root/src/A.solid.mx${MX_SUFFIX}?t=1712345`);
    });

    it("declines ?raw, ?url and worker queries", async () => {
      // These ask for the file itself, not the module MX would print, so Vite
      // must serve the real `.solid.mx` rather than a virtual `.tsx` path that
      // does not exist on disk.
      const context = makeContext();
      const resolveId = resolveIdOf(mx());
      const importer = "/root/src/index.tsx";

      for (const query of ["?raw", "?url", "?worker", "?sharedworker"]) {
        expect(
          await resolveId.call(context, `./A.solid.mx${query}`, importer),
        ).toBeNull();
      }
      expect(context.calls).toHaveLength(0);
    });

    it("returns an already-rewritten id unchanged, query included", async () => {
      const context = makeContext();
      const resolveId = resolveIdOf(mx());
      const id = `/root/src/A.solid.mx${MX_SUFFIX}?t=1`;

      expect(await resolveId.call(context, id, undefined)).toBe(id);
      // No delegation needed for an id we already own.
      expect(context.calls).toHaveLength(0);
    });

    it("returns null when the resolver finds nothing", async () => {
      const context = makeContext();
      const resolveId = resolveIdOf(mx());

      expect(
        await resolveId.call(context, "./missing.solid.mx", undefined),
      ).toBeNull();
    });

    it("leaves AstroMX's .astro.mx alone: a different host's extension", async () => {
      // `.astro.mx` (decision 134) belongs to `@mxlang/host-astro`'s own plugin,
      // which lowers it to Astro template syntax. It ends in `.mx`, so the
      // plain `endsWith` match would claim it without the foreign-extension
      // guard — this pins that, since the two plugins run in the same Vite
      // instance.
      const context = makeContext();
      const resolveId = resolveIdOf(mx());

      expect(
        await resolveId.call(context, "./Base.astro.mx", "/root/src/index.tsx"),
      ).toBeNull();
      expect(context.calls).toHaveLength(0);
    });

    it("declines a multi-dot extension owned by another host", async () => {
      // The collision the foreign-extension guard defends against is a
      // property of the `endsWith` matching rule rather than of any one
      // extension: a registered `.mx` matches `Base.any.mx` just as readily
      // as `Base.mx`. Registering the longer extension is what makes the
      // longest-first sort pick it, which is the same mechanism that keeps
      // `.solid.mx` from being compiled as `.mx`.
      const context = makeContext();
      const resolveId = resolveIdOf(mx({ extensions: [".other.mx", ".mx"] }));

      expect(
        await resolveId.call(context, "./Base.other.mx", "/root/src/index.tsx"),
      ).toBe("/root/src/Base.other.mx.tsx");
    });

    it("leaves ids it does not handle alone", async () => {
      const context = makeContext();
      const resolveId = resolveIdOf(mx());
      const importer = "/root/src/index.tsx";

      expect(await resolveId.call(context, "./main.tsx", importer)).toBeNull();
      expect(await resolveId.call(context, "solid-js", importer)).toBeNull();
      expect(context.calls).toHaveLength(0);
    });
  });

  describe("load", () => {
    it("reads the real .solid.mx file behind the suffixed id", () => {
      const path = writeMx("Counter.solid.mx", COUNTER);
      const load = loadOf(mx());

      expect(load.call({}, path + MX_SUFFIX)).toBe(COUNTER);
      expect(load.call({}, "/app/src/main.tsx")).toBeNull();
    });

    it("does not shadow a real .solid.mx.tsx file on disk", () => {
      // Foo.solid.mx.tsx exists but Foo.solid.mx does not: the id belongs to
      // the real file, so the hook must decline and let Vite read it.
      const real = writeMx(
        `Shadow.solid.mx${MX_SUFFIX}`,
        "export const a = 1;",
      );
      const load = loadOf(mx());

      expect(load.call({}, real)).toBeNull();
    });
  });

  describe("readTemplateSource", () => {
    it("returns the file's text via the default reader", () => {
      const path = writeMx("Card.mx", "hi\n");
      expect(readTemplateSource(path)).toBe("hi\n");
    });

    it("returns undefined, not a thrown error, when the injected reader fails", () => {
      // The template a `TranslateError.file` names may have been deleted
      // or become unreadable between the original compile's own read and
      // this one — that failure must cost only the Vite overlay's frame,
      // never replace the diagnostic with a raw ENOENT. Inject a reader
      // instead of touching the real filesystem or the module's default
      // `readFileSync`, since forcing an actual read failure at exactly
      // this call site (and not the compile's own earlier read of the same
      // file) can't be done through real files without racing a delete.
      const throwingReader = () => {
        throw Object.assign(new Error("ENOENT: no such file"), {
          code: "ENOENT",
        });
      };
      expect(
        readTemplateSource("/nonexistent.mx", throwingReader),
      ).toBeUndefined();
    });
  });

  describe("transform", () => {
    it("loads the Solid Input reader before compiling a .mx caller", async () => {
      const solid = `export interface Input {
  item?: AttrTag<{ as: "renderable" }>;
}
export default () => <div />;
`;
      const solidPath = writeMx("Card.solid.mx", solid);
      const callerPath = join(dirname(solidPath), "caller.mx");
      const caller = `import Card from "./Card.solid.mx"
<Card><@item/><@item/></Card>
`;
      writeFileSync(callerPath, caller);

      await expect(
        transformOf(mx()).call({}, caller, callerPath + MX_SUFFIX),
      ).rejects.toThrow("`<@item>` may appear at most once");
    }, 20_000);

    it("prints a .solid.mx module to JSX text plus a map", async () => {
      const path = writeMx("Counter.solid.mx", COUNTER);
      const transform = transformOf(mx());

      const result = await transform.call({}, COUNTER, path + MX_SUFFIX);

      expect(result).not.toBeNull();
      expect(result?.code).toContain("<button");
      expect(result?.code).toContain("onClick={");
      // The MX placeholder must have become a JSX expression child.
      expect(result?.code).toContain("{count()}");
      expect(result?.code).not.toContain(`\${count()}`);
      expect(result?.map).toMatchObject({ version: 3 });
    });

    it("names the .solid.mx file, not the .tsx id, in the source map", async () => {
      const path = writeMx("Counter.solid.mx", COUNTER);
      const transform = transformOf(mx());

      const result = await transform.call({}, COUNTER, path + MX_SUFFIX);
      const map = result?.map as { sources: string[] };

      expect(map.sources).toContain(path);
    });

    it("strips a query string before matching the id", async () => {
      const path = writeMx("Counter.solid.mx", COUNTER);
      const transform = transformOf(mx());

      const result = await transform.call(
        {},
        COUNTER,
        `${path}${MX_SUFFIX}?t=1712345`,
      );

      expect(result).not.toBeNull();
      expect(result?.code).toContain("<button");
    });

    it("returns null for ids it does not handle", async () => {
      const transform = transformOf(mx());
      const code = "export const a = 1;";

      expect(await transform.call({}, code, "/src/main.tsx")).toBeNull();
      expect(await transform.call({}, code, "/src/main.ts")).toBeNull();
      expect(await transform.call({}, "body {}", "/src/app.css")).toBeNull();
    });

    it("throws a Vite-shaped error with loc, a frame, and no (l:c) suffix", async () => {
      const path = writeMx("Broken.solid.mx", BROKEN);
      const transform = transformOf(mx());

      let caught: unknown;
      try {
        await transform.call({}, BROKEN, path + MX_SUFFIX);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      const error = caught as Error & {
        loc?: { file: string; line: number; column: number };
        frame?: string;
      };

      // The overlay must point at the .solid.mx source, not the internal id.
      expect(error.loc?.file).toBe(path);
      // The mismatched closing tag is on line 3 of BROKEN.
      expect(error.loc?.line).toBe(3);
      expect(typeof error.loc?.column).toBe("number");

      // Babel's own 1-based "(line:column)" must not survive alongside the
      // 0-based loc.column, or the reader sees two different columns.
      expect(error.message).not.toMatch(/\(\d+:\d+\)\s*$/);

      expect(error.frame).toContain("<div><span>oops</div>");
      expect(error.frame).toContain("^");
    });
  });

  describe("stock .mx (not .solid.mx)", () => {
    const GREETING = `export interface Input { name: string }
<h1>Hello, \${input.name}</h1>
`;

    it("resolves a .mx id to the same .tsx suffix every extension gets", async () => {
      const context = makeContext();
      const resolveId = resolveIdOf(mx());

      const resolved = await resolveId.call(
        context,
        "./greeting.mx",
        "/root/src/index.tsx",
      );

      // One suffix for every handled extension: `resolveId` holds the real
      // path and `isMxModule` holds only the suffixed one, so a host-dependent
      // suffix could not be derived identically in both (see `suffixFor`).
      expect(resolved).toBe(`/root/src/greeting.mx${MX_SUFFIX}`);
    });

    // The 20s timeout below: this is the only test in the file that reaches
    // the `.mx` branch, so it pays for the dynamic
    // `import("@mxlang/target-html")` and, through it, the cold load of
    // `@marko/compiler` — measured at **1145ms idle**, and at **6117ms**
    // inside a full `bun run verify` (20 vitest projects in parallel, ~34s of
    // transform), which overruns vitest's 5000ms default.
    //
    // 20s is a little over 3x the worst measured time rather than 4x the idle
    // one: 4 x 1145ms is 4.6s, still under the default that already fails, so
    // it would fix nothing. Scoped to this test rather than raised globally,
    // so a genuinely hung test elsewhere still fails fast.
    it("compiles a .mx module to a string-returning function, unaffected by .solid.mx handling", async () => {
      const path = writeMx("greeting.mx", GREETING);
      const transform = transformOf(mx());

      const result = await transform.call({}, GREETING, path + MX_SUFFIX);

      expect(result).not.toBeNull();
      expect(result?.code).toContain("export default Greeting as ");
      expect(result?.code).toContain("__mxEscape(input.name)");
      // No real map yet for this path (see the plugin's own doc comment).
      expect(result?.map).toBeNull();
    }, 20_000);

    it("passes `strict` through to the translator's strictPolicy", async () => {
      // The seam `@mxlang/host-astro` needs: a host with no reactive target selects
      // `strictPolicy`, so a reactive construct is a compile error naming the
      // construct rather than markup that renders once and never updates. The
      // flag is a passthrough — no policy logic lives in this plugin.
      const STATEFUL = `export interface Input {}
<let/count=0/>
<p>\${count}</p>
`;
      const path = writeMx("stateful.mx", STATEFUL);
      const transform = transformOf(mx({ strict: true }));

      await expect(
        transform.call({}, STATEFUL, path + MX_SUFFIX),
      ).rejects.toThrow(/`<let>` is reactive state/);
    });

    it("expands a registered custom tag inside a .solid.mx file", async () => {
      // `.solid.mx` reaches its host through `print()`, a different boundary
      // from the `.mx` branch's `compile()`. A tag registered here has to
      // cross that boundary too, or it stays unknown in exactly the file kind
      // this plugin exists to handle.
      const BADGE: CustomTag = {
        attributes: { label: { type: "string", required: true } },
        transform(call, ctx) {
          const label = call.attrs.find(
            (attr) => attr.kind === "static" && attr.name === "label",
          );
          if (label?.kind !== "static") throw ctx.fail("needs a static label");
          return [
            ctx.build.element(
              "span",
              [ctx.build.attr("class", "badge")],
              [ctx.build.text(label.value)],
            ),
          ];
        },
      };
      const SOURCE = `export function A() {
  return (
    <div><badge label="new"/></div>
  );
}
`;
      const path = writeMx("Badge.solid.mx", SOURCE);
      const transform = transformOf(mx({ customTags: { badge: BADGE } }));

      const result = await transform.call({}, SOURCE, path + MX_SUFFIX);

      expect(result?.code).toContain('<span class="badge">new</span>');
      expect(result?.code).not.toContain("<badge");
    });

    it("renders <let>'s initial value when `strict` is not set", async () => {
      // The default policy is unchanged by the option's existence: decision 65
      // renders what Marko's own server render emits.
      const STATEFUL = `export interface Input {}
<let/count=0/>
<p>\${count}</p>
`;
      const path = writeMx("stateful-default.mx", STATEFUL);
      const transform = transformOf(mx());

      const result = await transform.call({}, STATEFUL, path + MX_SUFFIX);

      expect(result?.code).toContain("const count = 0;");
    });

    it("routes a .mx file to the host its package.json names", async () => {
      // The routing failure this guards is silent: compiled through the wrong
      // host a template still succeeds, just to the other target's module —
      // so both branches are asserted on what they actually emitted.
      const path = writeMx("greeting.mx", GREETING);
      writeFileSync(
        join(dirname(path), "package.json"),
        JSON.stringify({ name: "app", mx: { host: "preact" } }),
      );
      const transform = transformOf(mx());

      const result = await transform.call({}, GREETING, path + MX_SUFFIX);

      expect(result?.code).toContain("/** @jsxImportSource preact */");
      expect(result?.code).toContain("<h1>Hello, {input.name}</h1>");
      expect(result?.code).not.toContain("let out =");
    }, 20_000);

    it("routes a .mx file to the React host", async () => {
      const path = writeMx("greeting.mx", GREETING);
      writeFileSync(
        join(dirname(path), "package.json"),
        JSON.stringify({ name: "app", mx: { host: "react" } }),
      );
      const transform = transformOf(mx());

      const result = await transform.call({}, GREETING, path + MX_SUFFIX);

      expect(result?.code).toContain("/** @jsxImportSource react */");
      expect(result?.code).toContain("<h1>Hello, {input.name}</h1>");
      expect(result?.code).not.toContain("let out =");
    }, 20_000);

    it("still handles .solid.mx exactly as before when both extensions are enabled", async () => {
      const path = writeMx("Counter.solid.mx", COUNTER);
      const transform = transformOf(mx());

      const result = await transform.call({}, COUNTER, path + MX_SUFFIX);

      expect(result?.code).toContain("<button");
    });

    it.each([
      [".foo", ".solid.foo"],
      [".solid.foo", ".foo"],
    ])(
      "routes a longer extension correctly regardless of extensions order (given %j)",
      async (...order) => {
        // ".foo" is a genuine string suffix of the synthetic ".solid.foo"
        // here, and `suffixFor` only special-cases the literal string ".mx"
        // (-> .ts; everything else -> the JSX suffix), so misrouting is
        // directly observable in the resolved id's own suffix.
        //
        // Removing the `.sort(...)` at index.ts:177-179 makes the
        // `[".foo", ".solid.foo"]` order in this test fail: `matchExt`
        // would then return the caller's first array match, ".foo", for
        // "./Counter.solid.foo" (a string ending in ".solid.foo" also
        // ends in ".foo"), and `suffixFor(".foo")` is the generic JSX
        // suffix regardless — so this collision is only observable through
        // which registered extension `matchExt` picks, not through
        // `suffixFor`'s output. Verified directly: temporarily replacing the
        // sorted `extensions` assignment with the unsorted
        // `[...(options.extensions ?? DEFAULT_EXTENSIONS)]` makes exactly
        // the `[".foo", ".solid.foo"]` case of this test fail (matching the
        // shorter ".foo" instead of the longer ".solid.foo"), while the
        // `[".solid.foo", ".foo"]` case still passes — proving the sort,
        // not incidental array order, is what this test depends on.
        const plugin = mx({ extensions: order });

        const resolveId = resolveIdOf(plugin);
        const resolved = await resolveId.call(
          makeContext(),
          "./Counter.solid.foo",
          "/root/src/index.tsx",
        );
        // The generic JSX suffix, not the ".mx"-specific one — proves the
        // longer ".solid.foo" extension won regardless of extensions order.
        expect(resolved).toBe(`/root/src/Counter.solid.foo${MX_SUFFIX}`);
      },
    );

    it.each([
      [".solid.mx", ".mx"],
      [".mx", ".solid.mx"],
    ])(
      "routes .solid.mx correctly regardless of extensions order, with .mx in the mix (given %j)",
      async (...order) => {
        // ".mx" is a real string suffix of ".solid.mx" — this is the live
        // collision the longest-first sort at index.ts:177-179 exists for,
        // not a synthetic stand-in.
        const plugin = mx({ extensions: order });

        const resolveId = resolveIdOf(plugin);
        const resolvedSolidMx = await resolveId.call(
          makeContext(),
          "./Counter.solid.mx",
          "/root/src/index.tsx",
        );
        // Resolved through the ".solid.mx" branch regardless of extensions
        // order; the suffix itself is the same for every handled extension.
        expect(resolvedSolidMx).toBe("/root/src/Counter.solid.mx.tsx");

        const resolvedMx = await resolveId.call(
          makeContext(),
          "./greeting.mx",
          "/root/src/index.tsx",
        );
        // Same suffix as `.solid.mx`: what this asserts is that a `.mx` id is
        // resolved at all (so ".solid.mx" did not swallow it), not which
        // compiler it routes to — that is the host policy's answer now.
        expect(resolvedMx).toBe(`/root/src/greeting.mx${MX_SUFFIX}`);
      },
    );
  });

  describe("custom tag discovery", () => {
    const scratches: string[] = [];

    afterEach(() => {
      clearScanCache();
      for (const dir of scratches.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    /** A project with one discovered tag, and the paths to drive it with. */
    function project(body: string) {
      const dir = mkdtempSync(join(tmpdir(), "mx-vite-tags-"));
      scratches.push(dir);
      writeFileSync(
        join(dir, "package.json"),
        '{"name":"v","mx":{"host":"html"}}',
      );
      mkdirSync(join(dir, "tags"), { recursive: true });
      const tagFile = join(dir, "tags", "marker.tag.ts");
      writeFileSync(tagFile, body);
      const caller = join(dir, "caller.mx");
      writeFileSync(caller, "<marker/>\n");
      return { dir, tagFile, caller };
    }

    const transformOf = (plugin: ReturnType<typeof mx>) =>
      plugin.transform as unknown as (
        this: unknown,
        code: string,
        id: string,
      ) => Promise<{ code: string } | null>;

    it("compiles a tag found in a sibling tags/ directory, with no import", async () => {
      const { caller } = project(
        "export default { transform: (_c, ctx) => [ctx.build.text('found')] };\n",
      );

      const result = await transformOf(mx()).call(
        {},
        "<marker/>\n",
        `${caller}${MX_SUFFIX}`,
      );

      expect(result?.code).toContain("found");
    });

    it("does not resolve an mx.tags entry whose hosts excludes this host", async () => {
      // `resolveTargetPolicy(file).host` (`"html"`, from this fixture's
      // package.json) is passed into `scanCached`; an entry restricted to
      // `hosts: ["solid"]` must stay invisible to the html scan —
      // decision 110(a).
      const dir = mkdtempSync(join(tmpdir(), "mx-vite-hosts-"));
      scratches.push(dir);
      mkdirSync(join(dir, "widgets"), { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "v",
          mx: {
            host: "html",
            tags: [{ dir: "widgets", hosts: ["solid"] }],
          },
        }),
      );
      writeFileSync(
        join(dir, "widgets", "marker.tag.ts"),
        "export default { transform: (_c, ctx) => [ctx.build.text('found')] };\n",
      );
      const caller = join(dir, "caller.mx");
      writeFileSync(caller, "<marker/>\n");

      const result = await transformOf(mx()).call(
        {},
        "<marker/>\n",
        `${caller}${MX_SUFFIX}`,
      );

      // The excluded tag's own transform must never run: no "found" text
      // in the compiled output.
      expect(result?.code).not.toContain("found");
    });

    it("throws a Vite-shaped error pointing at a broken *template* tag, not the caller", async () => {
      // Round 2 fix: a `TranslateError` raised while compiling a discovered
      // *template* tag (`tags/broken.mx`, as opposed to a `.tag.ts` sidecar
      // above) carries `.file` naming the template, never `.loc` — so it
      // used to fall through `isSyntaxError` entirely and reach Vite raw,
      // with no position at all.
      const dir = mkdtempSync(join(tmpdir(), "mx-vite-tags-"));
      scratches.push(dir);
      writeFileSync(
        join(dir, "package.json"),
        '{"name":"v","mx":{"host":"html"}}',
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
      const caller = join(dir, "caller.mx");
      writeFileSync(caller, '<broken name="star"/>\n');

      let caught: unknown;
      try {
        await transformOf(mx()).call(
          {},
          '<broken name="star"/>\n',
          `${caller}${MX_SUFFIX}`,
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      const error = caught as Error & {
        id?: string;
        loc?: { file: string; line: number; column: number };
        frame?: string;
      };

      // The overlay must point at the template, not the caller.
      expect(error.id).toBe(templateFile);
      expect(error.loc?.file).toBe(templateFile);
      // The orphan `<else>` is on line 3 of `tags/broken.mx`.
      expect(error.loc?.line).toBe(3);
      expect(error.frame).toContain("<else/>");
      expect(error.message).toMatch(/`<else>`/);
    });

    it("hoists a discovered tag's import into a .solid.mx module", async () => {
      // The integration layer for B1: a `.solid.mx` region calls a tag it
      // never imported, and the module this plugin hands Vite must carry the
      // import that makes the call resolve. A region is an expression, so the
      // import can only live in the surrounding TypeScript module.
      const dir = mkdtempSync(join(tmpdir(), "mx-vite-solid-tags-"));
      scratches.push(dir);
      writeFileSync(
        join(dir, "package.json"),
        '{"name":"v","mx":{"host":"solid"}}',
      );
      mkdirSync(join(dir, "tags"), { recursive: true });
      writeFileSync(
        join(dir, "tags", "icon.mx"),
        '<span class="icon">${input.name}</span>\n',
      );
      const source = `const a = <div><icon name="star"/></div>;\n`;
      const caller = join(dir, "page.solid.mx");
      writeFileSync(caller, source);

      const result = await transformOf(mx()).call(
        {},
        source,
        `${caller}${MX_SUFFIX}`,
      );

      expect(result?.code).toMatch(
        /import \$mx_Icon\d+ from "\.\/tags\/icon\.mx"/,
      );
      const binding = result?.code.match(/import (\$mx_Icon\d+)/)?.[1];
      expect(result?.code).toContain(`<${binding}`);
      // The lowercase author-facing name is never what the module references.
      expect(result?.code).not.toContain("<icon");
    });

    it("rescans a caller after its tag file is edited", async () => {
      const { tagFile, caller } = project(
        "export default { transform: (_c, ctx) => [ctx.build.text('first')] };\n",
      );
      const transform = transformOf(mx());
      const id = `${caller}${MX_SUFFIX}`;

      expect((await transform.call({}, "<marker/>\n", id))?.code).toContain(
        "first",
      );

      // The caller's own text does not change; only the tag does. Adding a
      // second tag makes the edit observable *here*: whether the rebuilt
      // sidecar's hooks are the new ones cannot be asserted under Vitest,
      // whose module runner keeps its own registry behind `require.cache`, so
      // a deleted key does not make `require` re-evaluate the file (measured;
      // both Bun and Node do re-evaluate, which is what ships). What this
      // asserts is the part that is this plugin's own: an edited tag
      // directory is rescanned rather than served from the scan cache.
      writeFileSync(
        join(dirname(tagFile), "extra.mx"),
        "<em>a second tag</em>\n",
      );
      const when = new Date(Date.now() + 10_000);
      utimesSync(tagFile, when, when);

      // The new tag is discovered, so the compile succeeds and the caller
      // imports it. Under the unit model (decision 95) the tag's own markup
      // stays in its own module, so what proves the rescan is the injected
      // import naming the newly discovered template — not inlined markup.
      const rescanned = await transform.call({}, "<marker/><extra/>\n", id);
      expect(rescanned?.code).toMatch(
        /import\s+\$mx_\w+\s+from\s+"[^"]*extra\.mx"/,
      );

      // The negative half the old assertion carried: a name the rescan did
      // *not* find is still an error, so the success above is discovery
      // working rather than unknown tags being waved through.
      await expect(
        transform.call({}, "<marker/><absent/>\n", id),
      ).rejects.toThrow(/absent/);
    });

    it("warns once about a misconfigured mx.tags", async () => {
      const dir = mkdtempSync(join(tmpdir(), "mx-vite-badtags-"));
      scratches.push(dir);
      writeFileSync(
        join(dir, "package.json"),
        '{"name":"b","mx":{"host":"html","tags":"does-not-exist"}}',
      );
      mkdirSync(join(dir, "tags"), { recursive: true });
      writeFileSync(
        join(dir, "tags", "marker.tag.ts"),
        "export default { transform: (_c, ctx) => [ctx.build.text('still works')] };\n",
      );
      const caller = join(dir, "caller.mx");
      writeFileSync(caller, "<marker/>\n");

      const warnings: string[] = [];
      const plugin = mx();
      const transform = plugin.transform as unknown as (
        this: unknown,
        code: string,
        id: string,
      ) => Promise<{ code: string } | null>;
      const context = { warn: (message: string) => warnings.push(message) };

      const first = await transform.call(
        context,
        "<marker/>\n",
        `${caller}${MX_SUFFIX}`,
      );

      // The typo is reported...
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("package.json");
      expect(warnings[0]).toContain("does-not-exist");
      // ...and the local `tags/` directory still resolves, which is why this
      // is a warning rather than a build failure.
      expect(first?.code).toContain("still works");

      // Once per problem, not once per compiled file: every file in the
      // package re-reads the same `package.json`.
      await transform.call(context, "<marker/>\n", `${caller}${MX_SUFFIX}`);
      expect(warnings).toHaveLength(1);
    });

    it("warns once about a malformed package.json and unknown mx.host, and still compiles", async () => {
      const broken = mkdtempSync(join(tmpdir(), "mx-vite-hostpolicy-"));
      scratches.push(broken);
      writeFileSync(join(broken, "package.json"), "{ not json");
      const typo = mkdtempSync(join(tmpdir(), "mx-vite-hostpolicy-"));
      scratches.push(typo);
      writeFileSync(
        join(typo, "package.json"),
        '{"name":"t","mx":{"host":"htmll"}}',
      );

      const warnings: string[] = [];
      const plugin = mx();
      const transform = plugin.transform as unknown as (
        this: unknown,
        code: string,
        id: string,
      ) => Promise<{ code: string } | null>;
      const context = { warn: (message: string) => warnings.push(message) };

      for (const dir of [broken, typo]) {
        const caller = join(dir, "caller.mx");
        writeFileSync(caller, "<p>hi</p>\n");
        const compile = () =>
          transform.call(context, "<p>hi</p>\n", `${caller}${MX_SUFFIX}`);
        // A warning, never a failure: the file compiles under the fallback.
        // (Marko's compile also loaded a Babel config, which read the broken
        // package.json and threw "Error while parsing JSON"; the MX front end
        // loads none since port PR 5, so the broken file compiles too.)
        expect((await compile())?.code).toContain("hi");
        // Once per problem, not once per compiled file.
        await compile();
      }

      // (The scan reports the same broken file in its own words; only the
      // host-policy message says which host the files fell back to.)
      expect(warnings.filter((w) => w.includes("using the default"))).toEqual([
        expect.stringContaining(join(broken, "package.json")),
      ]);
      expect(
        warnings.filter((w) => w.includes('unknown mx.host "htmll"')),
      ).toEqual([expect.stringContaining('Did you mean "html"?')]);
      // Positioned at the package.json: `<file>:<line>:<column>: message`.
      expect(
        warnings
          .filter(
            (w) =>
              w.includes("using the default") || w.includes("unknown mx.host"),
          )
          .every((w) => /package\.json:\d+:\d+: /.test(w)),
      ).toBe(true);
    });

    it("invalidates callers when a tag file is newly created", async () => {
      const { dir, caller } = project(
        "export default { transform: (_c, ctx) => [ctx.build.text('x')] };\n",
      );
      const plugin = mx();
      await transformOf(plugin).call(
        {},
        "<marker/>\n",
        `${caller}${MX_SUFFIX}`,
      );

      // A file that did not exist when the scan ran is in no scan's file
      // list, so keying only by file matched nothing here — and the hook then
      // fell through to `matchExt`, which is undefined for `.tag.ts`, leaving
      // callers serving stale output until a restart. The directory entry is
      // what connects a *creation* to the callers that scanned there.
      const created = join(dir, "tags", "brandnew.tag.ts");
      writeFileSync(
        created,
        "export default { transform: (_c, ctx) => [ctx.build.text('new')] };\n",
      );

      const mod = { id: `${caller}${MX_SUFFIX}`, url: caller };
      const invalidated: unknown[] = [];
      const handle = plugin.handleHotUpdate as unknown as (
        this: unknown,
        ctx: unknown,
      ) => unknown[] | undefined;

      const updated = handle.call(
        {},
        {
          file: created,
          modules: [],
          server: {
            moduleGraph: {
              getModuleById: (id: string) =>
                id === `${caller}${MX_SUFFIX}` ? mod : undefined,
              invalidateModule: (target: unknown) => invalidated.push(target),
            },
          },
        },
      );

      expect(invalidated).toContain(mod);
      expect(updated).toContain(mod);
    });

    it("invalidates the callers of an edited tag file", async () => {
      const { tagFile, caller } = project(
        "export default { transform: (_c, ctx) => [ctx.build.text('x')] };\n",
      );
      const plugin = mx();
      // Transform once so the plugin records which tag files this caller read.
      await transformOf(plugin).call(
        {},
        "<marker/>\n",
        `${caller}${MX_SUFFIX}`,
      );

      // A stand-in module graph: the hook reads only these two methods, and a
      // real dev server would have to be started to provide more.
      const mod = { id: `${caller}${MX_SUFFIX}`, url: caller };
      const invalidated: unknown[] = [];
      const handle = plugin.handleHotUpdate as unknown as (
        this: unknown,
        ctx: unknown,
      ) => unknown[] | undefined;

      const updated = handle.call(
        {},
        {
          file: tagFile,
          modules: [],
          server: {
            moduleGraph: {
              getModuleById: (id: string) =>
                id === `${caller}${MX_SUFFIX}` ? mod : undefined,
              invalidateModule: (target: unknown) => invalidated.push(target),
            },
          },
        },
      );

      // The edited file is not itself a module, so nothing in Vite's own graph
      // points at the caller: without this edge the page would serve stale
      // output until a manual restart.
      expect(invalidated).toContain(mod);
      expect(updated).toContain(mod);
    });

    it("invalidates callers when a compile dependency changes", async () => {
      const { dir, caller } = project(
        "export default { transform: (_c, ctx) => [ctx.build.text('x')] };\n",
      );
      const dependency = join(dir, "Card.tsx");
      writeFileSync(dependency, "export interface Input {}\n");

      vi.resetModules();
      const compiler = await mockCompiler("html", () => ({
        code: "export default () => '';",
        dependencies: [dependency],
      }));
      try {
        const fresh = await import("./index.ts");
        const plugin = fresh.default();
        const transform = plugin.transform as unknown as (
          this: unknown,
          code: string,
          id: string,
        ) => Promise<{ code: string } | null>;
        await transform.call({}, "<div/>\n", `${caller}${fresh.MX_SUFFIX}`);

        const mod = { id: `${caller}${fresh.MX_SUFFIX}`, url: caller };
        const invalidated: unknown[] = [];
        const handle = plugin.handleHotUpdate as unknown as (
          this: unknown,
          ctx: unknown,
        ) => unknown[] | undefined;
        const updated = handle.call(
          {},
          {
            file: dependency,
            modules: [],
            server: {
              moduleGraph: {
                getModuleById: (id: string) =>
                  id === `${caller}${fresh.MX_SUFFIX}` ? mod : undefined,
                invalidateModule: (target: unknown) => invalidated.push(target),
              },
            },
          },
        );

        expect(invalidated).toEqual([mod]);
        expect(updated).toEqual([mod]);
      } finally {
        compiler.mockRestore();
        vi.resetModules();
      }
    });

    it("invalidates a .solid.mx caller when a region dependency changes", async () => {
      const dir = mkdtempSync(join(tmpdir(), "mx-vite-solid-deps-"));
      scratches.push(dir);
      writeFileSync(
        join(dir, "package.json"),
        '{"name":"v","mx":{"host":"solid"}}',
      );
      const caller = join(dir, "caller.solid.mx");
      const dependency = join(dir, "Card.tsx");
      writeFileSync(caller, "export const view = <Card/>;\n");
      writeFileSync(dependency, "export interface Input {}\n");

      vi.resetModules();
      // The descriptor's own file kind: dispatch reads the lookup's descriptors.
      const { builtinTargets } = await import("@mxlang/targets");
      const kind = builtinTargets
        .flatMap((target) => target.host?.fileKinds ?? [])
        .find((kind) => kind.compileRegion);
      if (!kind?.compileRegion) throw new Error("missing region compiler");
      const wired = kind as typeof kind & {
        compileRegion: NonNullable<typeof kind.compileRegion>;
      };
      const compiler = vi.spyOn(wired, "compileRegion").mockReturnValue({
        code: "<Card />",
        dependencies: [dependency],
        hoistedImports: [],
        returnVars: [],
      });
      try {
        const fresh = await import("./index.ts");
        const plugin = fresh.default();
        await transformOf(plugin).call(
          {},
          "export const view = <Card/>;\n",
          `${caller}${fresh.MX_SUFFIX}`,
        );

        const mod = { id: `${caller}${fresh.MX_SUFFIX}`, url: caller };
        const invalidated: unknown[] = [];
        const updated = (
          plugin.handleHotUpdate as unknown as (
            this: unknown,
            ctx: unknown,
          ) => unknown[] | undefined
        ).call(
          {},
          {
            file: dependency,
            modules: [],
            server: {
              moduleGraph: {
                getModuleById: (id: string) =>
                  id === `${caller}${fresh.MX_SUFFIX}` ? mod : undefined,
                invalidateModule: (target: unknown) => invalidated.push(target),
              },
            },
          },
        );

        expect(invalidated).toEqual([mod]);
        expect(updated).toEqual([mod]);
      } finally {
        compiler.mockRestore();
        vi.resetModules();
      }
    });

    it("invalidates a whole-file Solid .mx caller when an imported callee's Input changes (decision 115)", async () => {
      // The vite-plugin's own `host === "solid"` branch (decision 115) must
      // route through `compileSolidUnit`, and must union its
      // `dependencies` into the reverse map the same way
      // `loadSolidRegionCompile` already does for `.solid.mx` regions —
      // otherwise an imported `.mx` component's `Input` changing would
      // never invalidate a whole-file Solid page that calls it.
      const dir = mkdtempSync(join(tmpdir(), "mx-vite-solid-whole-file-deps-"));
      scratches.push(dir);
      writeFileSync(
        join(dir, "package.json"),
        '{"name":"v","mx":{"host":"solid"}}',
      );
      const caller = join(dir, "caller.mx");
      const dependency = join(dir, "Card.mx");
      writeFileSync(caller, 'import Card from "./Card.mx"\n<Card/>\n');
      writeFileSync(dependency, "export interface Input {}\n<div/>\n");

      vi.resetModules();
      const compiler = await mockCompiler("solid-jsx", () => ({
        code: "export default function Caller(input) { return <><Card /></>; }",
        dependencies: [dependency],
      }));
      try {
        const fresh = await import("./index.ts");
        const plugin = fresh.default();
        await transformOf(plugin).call(
          {},
          'import Card from "./Card.mx"\n<Card/>\n',
          `${caller}${fresh.MX_SUFFIX}`,
        );

        const mod = { id: `${caller}${fresh.MX_SUFFIX}`, url: caller };
        const invalidated: unknown[] = [];
        const updated = (
          plugin.handleHotUpdate as unknown as (
            this: unknown,
            ctx: unknown,
          ) => unknown[] | undefined
        ).call(
          {},
          {
            file: dependency,
            modules: [],
            server: {
              moduleGraph: {
                getModuleById: (id: string) =>
                  id === `${caller}${fresh.MX_SUFFIX}` ? mod : undefined,
                invalidateModule: (target: unknown) => invalidated.push(target),
              },
            },
          },
        );

        expect(invalidated).toEqual([mod]);
        expect(updated).toEqual([mod]);
      } finally {
        compiler.mockRestore();
        vi.resetModules();
      }
    });

    it("records a real compileSolidMx dependency for a .solid.mx caller", async () => {
      const dir = mkdtempSync(join(tmpdir(), "mx-vite-solid-real-deps-"));
      scratches.push(dir);
      writeFileSync(
        join(dir, "package.json"),
        '{"name":"v","mx":{"host":"solid"}}',
      );
      const caller = join(dir, "caller.solid.mx");
      const dependency = join(dir, "Card.tsx");
      const source =
        'import Card from "./Card.tsx";\nexport const view = <Card><@item>x</@item></Card>;\n';
      writeFileSync(caller, source);
      writeFileSync(
        dependency,
        'import type { AttrTag } from "@mxlang/host-solid";\nexport interface Input { item: AttrTag<{ as: "renderable" }> }\nexport default function Card() { return null; }\n',
      );

      vi.resetModules();
      const fresh = await import("./index.ts");
      const plugin = fresh.default();
      await transformOf(plugin).call({}, source, `${caller}${fresh.MX_SUFFIX}`);

      const mod = { id: `${caller}${fresh.MX_SUFFIX}`, url: caller };
      const invalidated: unknown[] = [];
      const updated = (
        plugin.handleHotUpdate as unknown as (
          this: unknown,
          ctx: unknown,
        ) => unknown[] | undefined
      ).call(
        {},
        {
          file: dependency,
          modules: [],
          server: {
            moduleGraph: {
              getModuleById: (id: string) =>
                id === `${caller}${fresh.MX_SUFFIX}` ? mod : undefined,
              invalidateModule: (target: unknown) => invalidated.push(target),
            },
          },
        },
      );

      expect(invalidated).toEqual([mod]);
      expect(updated).toEqual([mod]);
      vi.resetModules();
    });

    it("compiles a whole-file Solid .mx through the real Solid host, not the html string emitter (decision 115)", async () => {
      // Before decision 115's wiring, `compileMarko`'s `host === "solid"`
      // check had no branch at all and fell through to the `@mxlang/target-html`
      // branch: a real `vite build` of a page meant for Solid silently
      // compiled it to the vanilla string emitter instead — plausible
      // output, wrong host, no error. Asserting real Solid JSX output
      // (rather than mocking the host, the way the other tests above do)
      // is what actually catches that regression.
      const dir = mkdtempSync(join(tmpdir(), "mx-vite-solid-real-compile-"));
      scratches.push(dir);
      writeFileSync(
        join(dir, "package.json"),
        '{"name":"v","mx":{"host":"solid"}}',
      );
      const source = 'export interface Input { }\n<p class="x">${input}</p>\n';
      const caller = join(dir, "page.mx");
      writeFileSync(caller, source);

      vi.resetModules();
      const fresh = await import("./index.ts");
      const plugin = fresh.default();
      const result = await transformOf(plugin).call(
        {},
        source,
        `${caller}${fresh.MX_SUFFIX}`,
      );

      // The html string emitter would produce `__mxOut.write(...)` sink
      // writes (decision 155) and a runtime import; the Solid host emits JSX
      // text and a `<p>` element with no such helper. Asserting the reserved
      // name keeps the negative meaningful — a bare `out +=` would pass
      // vacuously.
      expect(result?.code).toContain('<p class="x">');
      expect(result?.code).not.toContain("__mxOut.write(");
      expect(result?.code).not.toContain('from "@mxlang/target-html"');
      vi.resetModules();
    });

    it("prunes compile dependencies a caller no longer reads", async () => {
      const { dir, caller } = project(
        "export default { transform: (_c, ctx) => [ctx.build.text('x')] };\n",
      );
      const dependency = join(dir, "Old.ts");
      writeFileSync(dependency, "export interface Input {}\n");
      let dependencies = [dependency];
      vi.resetModules();
      const compiler = await mockCompiler("html", () => ({
        code: "export default () => '';",
        dependencies,
      }));
      try {
        const fresh = await import("./index.ts");
        const plugin = fresh.default();
        await transformOf(plugin).call(
          {},
          "<div/>\n",
          `${caller}${fresh.MX_SUFFIX}`,
        );
        dependencies = [];
        await transformOf(plugin).call(
          {},
          "<div/>\n",
          `${caller}${fresh.MX_SUFFIX}`,
        );
        const invalidated: unknown[] = [];
        const updated = (
          plugin.handleHotUpdate as unknown as (
            this: unknown,
            ctx: unknown,
          ) => unknown[] | undefined
        ).call(
          {},
          {
            file: dependency,
            modules: [],
            server: {
              moduleGraph: {
                getModuleById: () => ({ id: caller }),
                invalidateModule: (target: unknown) => invalidated.push(target),
              },
            },
          },
        );
        expect(invalidated).toEqual([]);
        expect(updated).toBeUndefined();
      } finally {
        compiler.mockRestore();
        vi.resetModules();
      }
    });

    it("forgets compile dependencies when their caller is deleted", async () => {
      const { dir, caller } = project(
        "export default { transform: (_c, ctx) => [ctx.build.text('x')] };\n",
      );
      const dependency = join(dir, "Card.ts");
      writeFileSync(dependency, "export interface Input {}\n");
      vi.resetModules();
      const compiler = await mockCompiler("html", () => ({
        code: "export default () => '';",
        dependencies: [dependency],
      }));
      try {
        const fresh = await import("./index.ts");
        const plugin = fresh.default();
        await transformOf(plugin).call(
          {},
          "<div/>\n",
          `${caller}${fresh.MX_SUFFIX}`,
        );
        rmSync(caller);
        const invalidated: unknown[] = [];
        const handle = plugin.handleHotUpdate as unknown as (
          this: unknown,
          ctx: unknown,
        ) => unknown[] | undefined;
        const graph = {
          getModuleById: () => undefined,
          invalidateModule: (target: unknown) => invalidated.push(target),
        };
        handle.call(
          {},
          {
            file: caller,
            modules: [],
            server: { moduleGraph: graph },
          },
        );
        const updated = handle.call(
          {},
          {
            file: dependency,
            modules: [],
            server: { moduleGraph: graph },
          },
        );
        expect(invalidated).toEqual([]);
        expect(updated).toBeUndefined();
      } finally {
        compiler.mockRestore();
        vi.resetModules();
      }
    });

    it("passes no resolver to the host when Vite has no aliases", async () => {
      const { caller } = project(
        "export default { transform: (_c, ctx) => [ctx.build.text('x')] };\n",
      );
      let received: unknown = "unset";
      vi.resetModules();
      const compiler = await mockCompiler(
        "html",
        (_source, _filename, options) => {
          received = options.resolveImport;
          return { code: "export default () => '';", dependencies: [] };
        },
      );
      try {
        const fresh = await import("./index.ts");
        const plugin = fresh.default();
        (plugin.configResolved as (config: unknown) => void)({
          resolve: { alias: [] },
        });
        await transformOf(plugin).call(
          {},
          "<div/>\n",
          `${caller}${fresh.MX_SUFFIX}`,
        );
        expect(received).toBeUndefined();
      } finally {
        compiler.mockRestore();
        vi.resetModules();
      }
    });

    it("passes a synchronous resolver built from Vite aliases, including bare replacements, to the host", async () => {
      const { dir, caller } = project(
        "export default { transform: (_c, ctx) => [ctx.build.text('x')] };\n",
      );
      let resolved: Array<string | undefined> = [];
      vi.resetModules();
      const compiler = await mockCompiler(
        "html",
        (_source, filename, options) => {
          resolved = [
            options.resolveImport?.("@/Card", filename),
            options.resolveImport?.("react", filename),
          ];
          return { code: "export default () => '';", dependencies: [] };
        },
      );
      try {
        const fresh = await import("./index.ts");
        const plugin = fresh.default();
        const configResolved = plugin.configResolved as unknown as (
          config: unknown,
        ) => void;
        configResolved({
          resolve: {
            alias: [
              { find: "@", replacement: `${dir}/src` },
              { find: "react", replacement: "preact/compat" },
            ],
          },
        });
        await transformOf(plugin).call(
          {},
          "<div/>\n",
          `${caller}${fresh.MX_SUFFIX}`,
        );
        expect(resolved).toEqual([`${dir}/src/Card`, "preact/compat"]);
      } finally {
        compiler.mockRestore();
        vi.resetModules();
      }
    });
  });
  describe("compile errors are compact and located (audit items 11, 19)", () => {
    // Error text is asserted ANSI-stripped: CI colorizes Babel frames.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape
    const ANSI = /\u001b\[[0-9;]*m/g;
    const STACK_FRAME = /^\s+at\s/m;

    type Wrapped = Error & {
      id?: string;
      frame?: string;
      loc?: { file: string; line: number; column: number };
    };

    async function transformError(
      plugin: Hooks,
      code: string,
      path: string,
    ): Promise<Wrapped> {
      let caught: unknown;
      try {
        await transformOf(plugin).call({}, code, path + MX_SUFFIX);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      return caught as Wrapped;
    }

    function writeHtmlMx(name: string, source: string): string {
      const path = writeMx(name, source);
      writeFileSync(
        join(dirname(path), "package.json"),
        '{"name":"v","mx":{"host":"html"}}',
      );
      return path;
    }

    /** What a build log shows for the error: stack, message and frame. */
    const rendered = (error: Wrapped): string =>
      `${error.stack ?? ""}\n${error.message}\n${error.frame ?? ""}`.replace(
        ANSI,
        "",
      );

    const MISMATCH = `export interface Input { name: string }
<div>
  <p>\${input.name}
</div>
`;

    it("a Marko CompileError carries the authored line:col, no stack, no .tsx", async () => {
      const path = writeHtmlMx("page.mx", MISMATCH);
      const error = await transformError(mx(), MISMATCH, path);

      expect(error.name).toBe("CompileError");
      // `</div>` is on line 4; `loc.column` is 0-based like every other
      // `loc` this plugin raises.
      expect(error.loc?.line).toBe(4);
      expect(error.loc?.column).toBe(0);
      expect(error.loc?.file).toBe(path);
      expect(error.id).toBe(path);
      expect(rendered(error)).not.toMatch(STACK_FRAME);
      expect(rendered(error)).not.toContain(".mx.tsx");
      // The message is the reason alone: Marko's embedded `at ../../x:4:1`
      // path and duplicate code frame are replaced by `loc` + `frame`.
      expect(error.message).toBe(
        'The closing "div" tag does not match the corresponding opening "p" tag at 3:3',
      );
      expect(error.frame).toContain("</div>");
    });

    it("positions a Marko CompileError from the message, not err.loc", async () => {
      // `err.loc` is `{ file }` only (no line or column): the position is in
      // the message's `at <path>:L:C` line.
      const SCRIPTLET = `export interface Input { name: string }
$ const x = ;
<div/>
`;
      const path = writeHtmlMx("scriptlet.mx", SCRIPTLET);
      const error = await transformError(mx(), SCRIPTLET, path);

      expect(error.loc?.line).toBe(2);
      expect(error.loc?.column).toBe(12);
      // The fix hint (audit item 14, h12) rides on the reason, same position.
      expect(error.message).toBe(
        "Unexpected token; scriptlets (`$ …`) are not supported; declare a value with `<const/x=…/>`",
      );
      expect(rendered(error)).not.toMatch(STACK_FRAME);
      expect(rendered(error)).not.toContain("undefined");
    });

    it("positions a coloured Marko CompileError (kleur header under FORCE_COLOR)", async () => {
      // Under FORCE_COLOR=1 kleur colourises the `at <path>:L:C` header —
      // path, line and column each wrapped in their own SGR runs — and the
      // `label` too, so the position regex missed the header (printing
      // `page.mx.tsx:undefined:undefined`) and the message kept its ANSI.
      // The SGR runs are stripped before the position is parsed and before
      // the label becomes the message.
      const COLORED = Object.assign(
        new Error(
          "\n    at \u001b[36m../../x.mx\u001b[39m:\u001b[33m4\u001b[39m:\u001b[33m1\u001b[39m\n    \u001b[0m \u001b[90m 3 |\u001b[39m <div>\n",
        ),
        {
          name: "CompileError",
          label:
            '\u001b[31m\u001b[1mThe closing "div" tag does not match the corresponding opening "p" tag at 3:3\u001b[22m\u001b[39m',
          loc: { file: undefined },
        },
      );
      const SOURCE = "export function A() {\n  return <div/>;\n}\n";
      const path = writeMx("Colored.solid.mx", SOURCE);
      const transform = transformOf(
        mx({
          customTags: new Proxy(
            {},
            {
              ownKeys() {
                throw COLORED;
              },
            },
          ),
        }),
      );

      const caught = (await transform
        .call({}, SOURCE, path + MX_SUFFIX)
        .catch((err: unknown) => err)) as Wrapped;

      // `locate` reshapes the error in place: same identity, but `loc`, a
      // stripped `message`, a one-line stack and no ANSI anywhere.
      expect(caught.loc?.line).toBe(4);
      expect(caught.loc?.column).toBe(0);
      expect(caught.message).toBe(
        'The closing "div" tag does not match the corresponding opening "p" tag at 3:3',
      );
      expect(caught.message).not.toContain("\u001b[");
      expect(rendered(caught)).not.toMatch(STACK_FRAME);
    });

    it("a TranslateError drops its stack and keeps its position", async () => {
      const FOR = `export interface Input { name: string }
<for|x|>
</for>
`;
      const path = writeHtmlMx("for.mx", FOR);
      const error = await transformError(mx(), FOR, path);

      expect(error.name).toBe("TranslateError");
      expect(error.loc?.line).toBe(2);
      expect(error.id).toBe(path);
      expect(rendered(error)).not.toMatch(STACK_FRAME);
      expect(error.message).toMatch(/`<for>` requires/);
    });

    it("a Babel syntax error in .solid.mx drops its stack and keeps loc", async () => {
      const path = writeMx("Broken.solid.mx", BROKEN);
      const error = await transformError(mx(), BROKEN, path);

      expect(error.loc?.line).toBe(3);
      expect(error.loc?.file).toBe(path);
      expect(rendered(error)).not.toMatch(STACK_FRAME);
    });

    it("a plain Error that merely has a loc keeps its stack", async () => {
      // `"loc" in err` used to be the whole test for "a parse error", so an
      // mx bug on generated output that happened to carry a `loc` lost its
      // stack. Only a SyntaxError with a Babel-shaped loc is user-facing.
      const BUG = Object.assign(new Error("bug with a loc"), {
        loc: { line: 3, column: 4 },
      });
      const SOURCE = "export function A() {\n  return <div/>;\n}\n";
      const path = writeMx("Loc.solid.mx", SOURCE);
      const transform = transformOf(
        mx({
          customTags: new Proxy(
            {},
            {
              ownKeys() {
                throw BUG;
              },
            },
          ),
        }),
      );

      const caught = await transform
        .call({}, SOURCE, path + MX_SUFFIX)
        .catch((err: unknown) => err);

      expect(caught).toBe(BUG);
      expect((caught as Error).stack).toMatch(STACK_FRAME);
      expect((caught as Wrapped).id).toBeUndefined();
    });

    it("an internal error keeps its stack and its identity", async () => {
      // A bug in mx itself, not in the authored source: injected where the
      // plugin spreads the caller's `customTags`, so the throw happens inside
      // the same `try` a compile error does but is no TranslateError,
      // CompileError or parse error. (A throwing tag `transform` is not
      // usable here: core wraps it into a located `SyntaxError`.)
      const BOOM = new TypeError("boom: a bug in mx, not in the source");
      const SOURCE = `export function A() {
  return <div/>;
}
`;
      const path = writeMx("Boom.solid.mx", SOURCE);
      const transform = transformOf(
        mx({
          customTags: new Proxy(
            {},
            {
              ownKeys() {
                throw BOOM;
              },
            },
          ),
        }),
      );

      const caught = await transform
        .call({}, SOURCE, path + MX_SUFFIX)
        .catch((err: unknown) => err);

      expect(caught).toBe(BOOM);
      expect((caught as Error).stack).toMatch(STACK_FRAME);
    });
  });
});
