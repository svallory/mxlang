import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  fixtures,
  mxTsc,
  repoRoot,
  run,
  SPAWN_TIMEOUT_MS,
} from "./test-support.ts";

/**
 * Decision 140 (audit item 3): on the three hosts that share the JSX emitter
 * (preact, react, hono) a native element's event handler is type-checked
 * against the host's own handler type, through a type-check-only
 * `(fn) satisfies Handler<tag, event>` wrapper in the tooling's virtual code.
 *
 * The sources are shared (`fixtures/handler-typing/src`) and copied into one
 * throwaway project per host: the host and `jsxImportSource` differ, nothing
 * else does. The project lives under `fixtures/` so `preact`, `react` and
 * `hono` resolve from the repo's `node_modules`.
 */
const HOSTS = [
  { host: "preact", jsxImportSource: "preact" },
  { host: "react", jsxImportSource: "react" },
  { host: "hono", jsxImportSource: "hono/jsx" },
] as const;
type HostName = (typeof HOSTS)[number]["host"];

interface Diagnostic {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}

function parseDiagnostics(output: string): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const match of output.matchAll(
    /(?:^|\n)\S*?([A-Za-z0-9]+)\.mx\((\d+),(\d+)\): error (TS\d+): ([^\n]*)/g,
  )) {
    found.push({
      file: match[1] ?? "",
      line: Number(match[2]),
      column: Number(match[3]),
      code: match[4] ?? "",
      message: match[5] ?? "",
    });
  }
  return found;
}

const sources = join(fixtures, "handler-typing", "src");
const roots: string[] = [];
const results = new Map<HostName, Diagnostic[]>();

beforeAll(() => {
  for (const { host, jsxImportSource } of HOSTS) {
    const root = mkdtempSync(join(fixtures, `.handler-typing-${host}-`));
    roots.push(root);
    cpSync(sources, join(root, "src"), { recursive: true });
    // Hono types handlers with the DOM's own events (`currentTarget` is
    // nullable, `onDoubleClick` is the only spelling, svg declares none), so
    // its valid matrix is written for those types.
    if (host === "hono") {
      cpSync(join(fixtures, "handler-typing", "hono"), join(root, "src"), {
        recursive: true,
      });
    }
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ mx: { host } }, null, 2),
    );
    // Preact and React have no catch-all for custom tags (hono does): declare
    // `<my-el>` as a consumer would, since plain TSX needs the same.
    if (host !== "hono") {
      writeFileSync(
        join(root, "src", "custom.d.ts"),
        `import "${host}"; declare module "${host}" { namespace JSX { interface IntrinsicElements { "my-el": Record<string, unknown>; } } }\n`,
      );
    }
    const hostDir = (name: string) =>
      join(repoRoot, "packages", "hosts", name, "src", "index.ts");
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            noEmit: true,
            strict: true,
            module: "esnext",
            moduleResolution: "bundler",
            target: "esnext",
            lib: ["esnext", "dom"],
            jsx: "preserve",
            jsxImportSource,
            types: [],
            allowImportingTsExtensions: true,
            baseUrl: ".",
            paths: {
              "@mxlang/host-preact": [hostDir("preact")],
              "@mxlang/host-react": [hostDir("react")],
              "@mxlang/host-hono": [hostDir("hono")],
              "@mxlang/core": [
                join(repoRoot, "packages", "core", "src", "index.ts"),
              ],
            },
            ignoreDeprecations: "6.0",
          },
          include: ["src"],
        },
        null,
        2,
      ),
    );
    results.set(
      host,
      parseDiagnostics(run(mxTsc, ["--noEmit", "-p", root]).output),
    );
  }
}, SPAWN_TIMEOUT_MS * HOSTS.length);

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function errorsIn(host: HostName, file: string): Diagnostic[] {
  // A run that produced nothing at all would make every "stays clean" test
  // pass vacuously; the fixture always contains errors on purpose.
  expect(results.get(host)?.length).toBeGreaterThan(0);
  return (results.get(host) ?? []).filter((d) => d.file === file);
}

describe.each(HOSTS)(
  "mx-tsc handler typing on $host (decision 140)",
  ({ host }) => {
    afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

    it("reports a mistyped shorthand handler at the authored handler (p01)", () => {
      // `<button onClick(a: string, b: string)`: the shorthand has no source
      // span of its own, so the error lands on the attribute name.
      const found = errorsIn(host, "P01");
      expect(found.map((d) => [d.line, d.column, d.code])).toEqual([
        [1, 9, "TS1360"],
      ]);
    });

    it("reports a mistyped arrow handler at the authored arrow (p12)", () => {
      const found = errorsIn(host, "P12");
      expect(found.map((d) => [d.line, d.column, d.code])).toEqual([
        [1, 18, "TS1360"],
      ]);
    });

    it("keeps the valid-handler matrix clean, including the strict `(e)` cases", () => {
      // Before: every camelCase name decision 101 recomposed to the runtime
      // spelling (`onKeydown`, `onMousedown`, …) had no contextual type, so
      // `(e) => …` was an implicit-any error (TS7006).
      expect(errorsIn(host, "Valid")).toEqual([]);
    });

    it("type-checks the body of a shorthand handler", () => {
      const found = errorsIn(host, "ShorthandBody");
      // The body maps to the authored body (decision 167), so the error
      // lands on `nope` exactly: `<button onClick(e) { e.nope(); }>`, column 24.
      expect(found.map((d) => [d.line, d.column, d.code])).toEqual([
        [1, 24, "TS2339"],
      ]);
      expect(found[0]?.message).toContain("nope");
    });

    it("reports an error in an arrow handler's body at main's exact column", () => {
      // `<button onClick=((e) => e.nope())>`: `nope` is column 27 (the same
      // column without the wrapper). The wrapper's generated parentheses
      // must not shift positions inside the handler.
      const found = errorsIn(host, "BodyArrow");
      expect(found.map((d) => [d.line, d.column, d.code])).toEqual([
        [1, 27, "TS2339"],
      ]);
    });

    it("accepts forwarding an optional callback and an explicit undefined", () => {
      // The host's prop type allows `undefined`; the check must too.
      expect(errorsIn(host, "OptionalForward")).toEqual([]);
      expect(errorsIn(host, "ExplicitUndefined")).toEqual([]);
    });

    it("still rejects a non-function handler value", () => {
      const found = errorsIn(host, "NonFunction");
      expect(found.map((d) => [d.line, d.column, d.code])).toEqual([
        [1, 18, "TS1360"],
      ]);
    });

    it("keeps the annotations of a shorthand handler and checks them", () => {
      const found = errorsIn(host, "ShorthandTyped");
      expect(found.map((d) => [d.line, d.column, d.code])).toEqual([
        [1, 9, "TS1360"],
      ]);
    });

    it("allocates preamble names that collide with no user binding", () => {
      // `static const __MxH`, `static const __MxJSX` and `type __MxM` are the
      // preamble's base names; its own identifiers move aside.
      expect(errorsIn(host, "Collision")).toEqual([]);
    });

    it("leaves custom elements and dynamic tags unchecked", () => {
      expect(errorsIn(host, "Unchecked")).toEqual([]);
    });

    // Hono's svg types declare no handlers at all, so there is nothing to
    // check against (the same silence plain TSX has).
    it.skipIf(host === "hono")(
      "checks an svg handler against the svg element",
      () => {
        expect(errorsIn(host, "Svg")).toEqual([]);
        const bad = errorsIn(host, "SvgBad");
        expect(bad.map((d) => d.code)).toEqual(["TS2339"]);
        expect(bad[0]?.message).toContain("value");
      },
    );
  },
);

describe("mx-tsc DOM-typed handlers (decision 140 (a))", () => {
  afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

  it.each(["preact", "hono"] as const)(
    "accepts a DOM-typed `(e: Event)` and `(e: MouseEvent)` handler on %s",
    (host) => {
      expect(errorsIn(host, "ValidDomEvent")).toEqual([]);
      expect(errorsIn(host, "DomTyped")).toEqual([]);
    },
  );

  it("rejects a DOM-typed `(e: MouseEvent)` handler on react, as plain TSX does", () => {
    // React's synthetic `MouseEvent<…>` is not the DOM's `MouseEvent`.
    const found = errorsIn("react", "DomTyped");
    expect(found.map((d) => [d.line, d.column, d.code])).toEqual([
      [1, 18, "TS1360"],
    ]);
    expect(errorsIn("react", "ValidDomEvent").map((d) => d.code)).toEqual([
      "TS1360",
    ]);
  });
});
