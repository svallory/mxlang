import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { type CustomTag, clearScanCache } from "@mxlang/core";
import { afterEach, describe, expect, it } from "vitest";
import mx, { MX_SUFFIX } from "./index";

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

    it("leaves AstroMX's .amx alone: a different host's extension", async () => {
      // `.amx` (decision 78) belongs to `@mxlang/astro`'s own plugin, which
      // lowers it to Astro template syntax. Its last extension segment differs
      // from `.mx`, so the plain `endsWith` match never claims it — this pins
      // that, since the two plugins run in the same Vite instance.
      const context = makeContext();
      const resolveId = resolveIdOf(mx());

      expect(
        await resolveId.call(context, "./Base.amx", "/root/src/index.tsx"),
      ).toBeNull();
      expect(context.calls).toHaveLength(0);
    });

    it("declines a multi-dot extension owned by another host", async () => {
      // The foreign-extension guard is empty today, but the collision it
      // defends against is a property of the `endsWith` matching rule rather
      // than of any one extension: a registered `.mx` matches `Base.any.mx`
      // just as readily as `Base.mx`. Registering the longer extension is what
      // makes the longest-first sort pick it, which is the same mechanism that
      // keeps `.solid.mx` from being compiled as `.mx`.
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

  describe("transform", () => {
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
    // `import("@mxlang/html")` and, through it, the cold load of
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
      expect(result?.code).toContain("export default render;");
      expect(result?.code).toContain("escape(input.name)");
      // No real map yet for this path (see the plugin's own doc comment).
      expect(result?.map).toBeNull();
    }, 20_000);

    it("passes `strict` through to the translator's strictPolicy", async () => {
      // The seam `@mxlang/astro` needs: a host with no reactive target selects
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
  });
});
