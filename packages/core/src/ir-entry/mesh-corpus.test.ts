/**
 * Mesh's golden parse corpus (decision 183 addendum 6; Mesh's review of
 * PR 460, F2): every entity file in Mesh's repository and every `mx` block
 * in its docs, copied with attribution into
 * `packages/core/src/fixtures/syntax/mesh-corpus/` (see its README), lowered
 * exactly as Mesh's compiler parses them (`parseEntitySource`: Mesh's closed
 * contracts, `tagRules: "none"`, `structural: "reject"`,
 * `unknownTags: "reject"`, `imports: "pass"`) with the reference module `@mxlang/core/syntax/mesh`,
 * `productName: "Mesh"`. The whole `LowerSourceResult` (the IR with its tags,
 * attributes, atoms, members, imports and spans, the Babel nodes reduced to
 * their shape and marks (see `snapshot`), and diagnostics) is compared with
 * the checked-in `__golden__/golden.json`.
 *
 * Slice c (the built-ins' deletion) must pass this file's golden test
 * unchanged. Until then, the second test shows the golden is the built-in
 * path's IR too (`syntax/member` plus core's built-in atoms and sugars,
 * Mesh's module before alpha.15), except for the ruled deltas listed in
 * `BUILT_IN_DELTAS`. That test leaves with the built-ins.
 *
 *   MESH_CORPUS_UPDATE=1 bun x vitest run packages/core/src/ir-entry/mesh-corpus.test.ts
 *
 * rewrites `__golden__/golden.json`; review its diff like any other change.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import type { CustomTag } from "../custom-tags.ts";
import type { SyntaxModule } from "../syntax-table.ts";
import { type LowerSourceResult, lowerSource } from "./index.ts";

const CORPUS = join(import.meta.dirname, "../fixtures/syntax/mesh-corpus");
const GOLDEN = join(CORPUS, "__golden__/golden.json");

// Through Node's strip-only `require`, as a manifest's `mx.syntax` loads a
// module (and so the copied contracts stay out of this program).
const load = createRequire(import.meta.url);
const meshSyntax = (
  load(join(import.meta.dirname, "../syntax/mesh.ts")) as {
    default: SyntaxModule;
  }
).default;
const memberSyntax = (
  load(join(import.meta.dirname, "../syntax/member.ts")) as {
    default: SyntaxModule;
  }
).default;
const contracts = (
  load(join(CORPUS, "contracts.ts")) as {
    default: Record<string, CustomTag>;
  }
).default;

/** Mesh's `MESH_SYNTAX` on the alpha.15 pin. */
const MESH_SYNTAX: SyntaxModule = { ...meshSyntax, productName: "Mesh" };
/** Mesh's `MESH_SYNTAX` before it (alpha.14): members only, core's built-in atoms. */
const MEMBER_SYNTAX: SyntaxModule = { ...memberSyntax, productName: "Mesh" };

/** Mesh's `parseEntitySource` (`packages/compiler/src/build.ts`), with the syntax as a parameter. */
function parseEntity(
  source: string,
  file: string,
  syntax: SyntaxModule,
): LowerSourceResult {
  return lowerSource(source, file, {
    syntax,
    customTags: contracts,
    // Mesh states its tag rules; the default is strict (decision 212 item 8).
    tagRules: "none",
    structural: "reject",
    unknownTags: "reject",
    imports: "pass",
  });
}

/** Every `.mesh.mx` file under the corpus, by its path relative to it, sorted. */
function corpusFiles(dir = CORPUS): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...corpusFiles(path));
    else if (entry.name.endsWith(".mesh.mx")) {
      files.push(relative(CORPUS, path));
    }
  }
  return files.sort();
}

const FILES = corpusFiles();

/** The IR keys that hold a parser (Babel) node, or a list of them. */
const NODE_KEYS = new Set(["node", "paramNodes", "declaration"]);

/**
 * A Babel node as the golden holds it: its shape (`type` and every semantic
 * field: names, values, operators, children) and the `mx*` marks a syntax
 * module sets on `extra` (`mxAtom`, `mxMember`, `mxTrigger`), without the
 * node's positions (`start`, `end`, `loc`, `range`) or the rest of `extra`
 * (`raw`, `parenthesized`, ...). The positions go because the IR already
 * carries them where Mesh reads them (`Expr.span`, the marks' own spans, the
 * attribute and tag spans), and a node's offsets restated for every
 * sub-expression made the golden mostly noise; the shape stays so a change
 * in what a module builds (`&status` as `self.status`, an atom as a marked
 * `StringLiteral`) still shows.
 */
function babelNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(babelNode);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "start" || key === "end" || key === "loc" || key === "range") {
      continue;
    }
    if (key === "extra") {
      const marks = Object.entries(child as object).filter(([name]) =>
        name.startsWith("mx"),
      );
      if (marks.length > 0) out.extra = Object.fromEntries(marks);
      continue;
    }
    out[key] = babelNode(child);
  }
  return out;
}

/**
 * A file's lowering, as plain JSON. Each file is lowered under a stable
 * virtual path, so the golden names no machine's directory. Parser nodes are
 * reduced by `babelNode`. The IR's `loc` (a node's start as line and column)
 * is dropped: it restates the node's `span`, which stays; a statement's `end`
 * position stays, for the few kinds that carry one.
 */
function snapshot(rel: string, syntax: SyntaxModule): unknown {
  const source = readFileSync(join(CORPUS, rel), "utf8");
  const result = parseEntity(source, `/mesh-corpus/${rel}`, syntax);
  return JSON.parse(
    JSON.stringify(result, (key, value) =>
      key === "loc" ? undefined : NODE_KEYS.has(key) ? babelNode(value) : value,
    ),
  );
}

/**
 * Where the built-in path's IR differs from the golden, each with its
 * ruling. A difference not listed here, or a listed one that is gone,
 * fails the second test.
 */
const BUILT_IN_DELTAS: Record<
  string,
  { ruling: string; diagnostics: unknown }
> = {
  // single-atom-default (decision 182 addendum 1, item 3; decision 183
  // addendum 6: Mesh does not need `kind=:X :x`): v3's
  // `belongs-to=:List :list` is refused on both paths, at the value's
  // end on the module path (column 21) rather than as the unknown
  // `value` attribute (column 14).
  "entities/packages/compiler/test/fixtures/negative/old-relationship.mesh.mx":
    {
      ruling: "single-atom-default",
      diagnostics: [
        {
          severity: "error",
          message: "`<belongs-to>`: unknown attribute `value`",
          line: 5,
          column: 14,
          offset: 81,
        },
      ],
    },
};

describe("Mesh's golden parse corpus (decision 183 addendum 6)", () => {
  it("holds Mesh's 41 entity files and 22 doc blocks", () => {
    expect(FILES.filter((rel) => rel.startsWith("entities/"))).toHaveLength(41);
    expect(FILES.filter((rel) => rel.startsWith("docs/"))).toHaveLength(22);
  });

  it("every file lowers to the golden IR through `@mxlang/core/syntax/mesh`", () => {
    const actual = Object.fromEntries(
      FILES.map((rel) => [rel, snapshot(rel, MESH_SYNTAX)]),
    );
    if (process.env.MESH_CORPUS_UPDATE === "1") {
      writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 1)}\n`);
    }
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    expect(Object.keys(golden)).toEqual(FILES);
    for (const rel of FILES) {
      expect(actual[rel], rel).toEqual(golden[rel]);
    }
  });

  it("the built-in path (deleted by slice c) gives the golden IR too, but for the ruled deltas", () => {
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    const differing: string[] = [];
    for (const rel of FILES) {
      const builtIn = snapshot(rel, MEMBER_SYNTAX) as {
        diagnostics: unknown;
        ir?: unknown;
      };
      const delta = BUILT_IN_DELTAS[rel];
      if (delta) {
        expect(builtIn.diagnostics, rel).toEqual(delta.diagnostics);
        expect(builtIn.ir, rel).toBeUndefined();
      }
      try {
        expect(builtIn).toEqual(golden[rel]);
      } catch {
        differing.push(rel);
      }
    }
    expect(differing).toEqual(Object.keys(BUILT_IN_DELTAS));
  });

  it("the old-relationship fixture is the ruled column-21 refusal (Mesh's `MESH_SYNTAX` 5:21)", () => {
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    expect(
      golden[
        "entities/packages/compiler/test/fixtures/negative/old-relationship.mesh.mx"
      ],
    ).toEqual({
      diagnostics: [
        {
          severity: "error",
          message: "Expected a single expression, but found `:` after it.",
          line: 5,
          column: 21,
          offset: 88,
        },
      ],
    });
  });
});

describe("`async` before a `:name` method under Mesh's contracts (review 460 F1)", () => {
  const SOURCE =
    'entity :T\n  computed\n    string async :l() { return "x" }\n';

  it("the module path refuses it at `:l`, naming the form", () => {
    expect(parseEntity(SOURCE, "/v/x.mesh.mx", MESH_SYNTAX)).toEqual({
      diagnostics: [
        {
          severity: "error",
          message:
            "`async :l(…) { … }` is not supported: a `:name` method value cannot be async; remove `async`",
          line: 3,
          column: 17,
          offset: 38,
        },
      ],
    });
  });

  it("the built-in path keeps alpha.14's unknown attribute `async`", () => {
    expect(parseEntity(SOURCE, "/v/x.mesh.mx", MEMBER_SYNTAX)).toEqual({
      diagnostics: [
        {
          severity: "error",
          message: "`<string>`: unknown attribute `async`",
          line: 3,
          column: 11,
          offset: 32,
        },
      ],
    });
  });

  it.each([
    ["built-in atoms and sugars", undefined],
    ["`syntax/member`", MEMBER_SYNTAX],
    ["`syntax/mesh`", MESH_SYNTAX],
  ])(
    "%s: `async` with no method after it is a plain boolean attribute",
    (_, syntax) => {
      const source = "<a async/>\n<b async x=1/>\nc async\n";
      const { ir, diagnostics } = lowerSource(
        source,
        "/v/y.mx",
        syntax ? { syntax } : {},
      );
      expect(diagnostics).toEqual([]);
      const tags = (ir?.body ?? []).flatMap((node) =>
        node.kind === "DelegatedTag" ? [node.tag] : [],
      );
      expect(tags.map((tag) => tag.attrs[0])).toMatchObject(
        [3, 14, 28].map((at) => ({
          kind: "boolean",
          name: "async",
          nameSpan: { sourceStart: at, sourceEnd: at + 5 },
        })),
      );
    },
  );
});
