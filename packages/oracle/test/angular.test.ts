import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@mxlang/angular";
import { describe, expect, it } from "vitest";
import { isDerivedFrom, runAngularTable } from "../src/report-angular";

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, "..", "fixtures", "angular", "__golden__");

/**
 * Runs the same 59-fixture set `bun run oracle:angular` runs, through the
 * same `runAngularTable` function, so `bun run test` (and therefore
 * `bun run verify`) exercises it in CI rather than only the standalone
 * `oracle:angular` script a developer has to remember to run by hand.
 */
describe("oracle:angular fixtures", () => {
  // Compiles every fixture, parses each emitted template through
  // `@angular/compiler`, and now also `tsc`-es each emitted tag module. That
  // last pass is what moved the cost: measured at **31s** here, not the ~3s
  // this gate took when it only parsed templates. vitest's 5s default is a
  // machine-load timeout, not a budget for the work, and it reddened
  // `bun run verify` intermittently before this was set. 120s rather than the
  // 60s the parse-only gate used, since 60s is only ~2x the measured runtime
  // on exactly the loaded box that motivated the timeout in the first place.
  // Same reasoning as `src/custom-tags.test.ts`.
  it("every fixture passes", { timeout: 120_000 }, () => {
    const { rows, failed } = runAngularTable(false);
    const failures = rows.filter((r) => r.verdict === "fail");
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
    expect(failed).toBe(false);
  });

  it("the AST golden's span-stripping keeps semantic fields like a template reference's name (round 2, R1)", () => {
    // A prior version of the runner's SPAN_KEY strip list explicitly
    // dropped `references` (a real semantic field — `<ng-template #Empty>`'s
    // reference variable name), so `define-no-params`'s golden was
    // identical whether the source read `#Empty`, `#TOTALLY_WRONG`, or no
    // reference at all. This reads the committed golden directly and
    // asserts the reference name survived stripping.
    const golden = readFileSync(
      join(goldenDir, "define-no-params.ast.json"),
      "utf8",
    );
    expect(golden).toContain("Empty");
    const parsed = JSON.parse(golden);
    expect(parsed[0]?.references?.[0]?.name).toBe("Empty");
  });
});

describe("isDerivedFrom (the mapping assertion's derivation list)", () => {
  it("checks the DOM event name, not only the source's shape", () => {
    // The derivation is real: `onClick` -> `click`, lowercased exactly as
    // written — no aliases (decision 101 (c)), so `dblclick` is NOT it.
    expect(isDerivedFrom("click", "onClick", "event")).toBe(true);
    expect(isDerivedFrom("doubleclick", "onDoubleClick", "event")).toBe(true);
    expect(isDerivedFrom("dblclick", "onDoubleClick", "event")).toBe(false);
    // The hole this closes: any generated text used to pass beside an
    // `onX` source, so a misaligned event mapping could not fail.
    expect(isDerivedFrom("banana", "onClick", "event")).toBe(false);
  });

  it("derives `on-<exact>` and a native element's lowercase `onclick`", () => {
    expect(isDerivedFrom("my-event", "on-my-event", "event")).toBe(true);
    expect(isDerivedFrom("click", "onclick", "event")).toBe(true);
    expect(isDerivedFrom("onclick", "onclick", "event")).toBe(false);
  });

  it("scopes the containment hatch to a `by=` arrow's body", () => {
    // The one place a contained-but-not-equal run is real: `by=(p => p.id)`
    // tracks the arrow's body, sliced out of the source.
    expect(isDerivedFrom("p.id", "(p => p.id)", "track", "p")).toBe(true);
    expect(isDerivedFrom("p.id", "p => p.id", "track")).toBe(true);
    // Anywhere else containment proves nothing: `name` appearing inside
    // `user.name` does not make one a derivation of the other.
    expect(isDerivedFrom("name", "user.name", "track")).toBe(false);
    expect(isDerivedFrom("id", "(p => p.id)", "track")).toBe(false);
  });

  it("accepts a define-pattern only for `let-<context>` over a `{` pattern", () => {
    const dp = (g: string, src: string, ctx?: string) =>
      isDerivedFrom(g, src, "define-pattern", ctx);
    expect(dp("let-__mxArg", "{ a, b }", "__mxArg")).toBe(true);
    expect(dp("let-__mxArg2", " { a }", "__mxArg2")).toBe(true);
    // Not an object pattern, a context that is not the emitter's, or a
    // generated run that is not `let-<context>`.
    expect(dp("let-__mxArg", "a", "__mxArg")).toBe(false);
    expect(dp("let-x", "{ a }", "x")).toBe(false);
    expect(dp("let-__mxArg", "{ a }", "__mxArg2")).toBe(false);
    expect(dp("__mxArg", "{ a }", "__mxArg")).toBe(false);
    expect(dp("let-__mxArg", "{ a }")).toBe(false);
  });

  it("requires an exact `<prefix><kebab(source)>` for a selector", () => {
    const sel = (g: string, src: string, prefix?: string) =>
      isDerivedFrom(g, src, "selector", prefix);
    expect(sel("mx-user-card", "UserCard", "mx-")).toBe(true);
    expect(sel("mx-user-card", "user-card", "mx-")).toBe(true);
    // The old branch admitted any `<anything>-<kebab(source)>`.
    expect(sel("mx-foo-user-card", "UserCard", "mx-")).toBe(false);
    expect(sel("other-user-card", "UserCard", "mx-")).toBe(false);
    expect(sel("user-card", "UserCard", "mx-")).toBe(false);
    // The prefix is the emitter's actual `tagSelectorPrefix`, not a constant.
    expect(sel("acme-user-card", "UserCard", "acme-")).toBe(true);
    expect(sel("mx-user-card", "UserCard", "acme-")).toBe(false);
    // A selector mapping that names no prefix cannot be checked: reject.
    expect(sel("mx-user-card", "UserCard")).toBe(false);
  });

  it("requires a resolved selector to equal the emitter's exact selector", () => {
    const r = (g: string, ctx?: string, src = "Badge") =>
      isDerivedFrom(g, src, "resolved-selector", ctx);
    expect(r("liuna-badge", "liuna-badge")).toBe(true);
    // No hyphen requirement: a hyphenless prefix or a bare override is exact.
    expect(r("appbadge", "appbadge")).toBe(true);
    expect(r("Badge", "Badge")).toBe(true);
    // A wrong string is rejected, hyphenated or not.
    expect(r("mx-badge", "liuna-badge")).toBe(false);
    expect(r("other-thing", "liuna-badge")).toBe(false);
    // The source span must be a tag-name token.
    expect(r("liuna-badge", "liuna-badge", "a b")).toBe(false);
    expect(r("liuna-badge", "liuna-badge", '"x"')).toBe(false);
    // No carried selector: cannot be checked, reject.
    expect(r("liuna-badge")).toBe(false);
    expect(isDerivedFrom("liuna-badge", "Badge")).toBe(false);
  });

  it("checks `<prefix>` and tag-module selectors end to end from the emitter", () => {
    const strict = (code: string, tagSelectorPrefix?: string) => {
      const r = compile(code, "x.mx", { tagSelectorPrefix, warnings: [] });
      const m = r.mappings.find((x) => x.derive === "selector");
      return { r, m };
    };
    const { r, m } = strict("<const/UserCard=() => 1/><UserCard/>", "acme-");
    expect(m?.deriveContext).toBe("acme-");
    expect(
      isDerivedFrom(
        r.code.slice(m?.generatedStart, m?.generatedEnd),
        "UserCard",
        m?.derive,
        m?.deriveContext,
      ),
    ).toBe(true);
  });

  it("requires the `track` provenance for every `by=` branch", () => {
    // Without the tag a dotted run beside a bare source used to pass
    // (`endsWith(".id")`), whatever emitted it.
    expect(isDerivedFrom("row.id", "id")).toBe(false);
    expect(isDerivedFrom("row.id", "id", "selector")).toBe(false);
    expect(isDerivedFrom("row.id", "id", "track", "row")).toBe(true);
    expect(isDerivedFrom("row.id", '"id"', "track", "row")).toBe(true);
    // `by=identity` tracks the loop variable: the emitter's own row alias,
    // carried on the mapping — not merely any identifier.
    expect(isDerivedFrom("row", "identity", "track", "row")).toBe(true);
    expect(isDerivedFrom("banana", "identity", "track", "row")).toBe(false);
    expect(isDerivedFrom("row", "identity", "track")).toBe(false);
    expect(isDerivedFrom("COMPLETELY-UNRELATED", "identity")).toBe(false);
    expect(
      isDerivedFrom("COMPLETELY-UNRELATED", "identity", "track", "row"),
    ).toBe(false);
  });
  it("lists the define-param and directive derivations explicitly", () => {
    expect(isDerivedFrom("let-x", "x", "define-param")).toBe(true);
    expect(isDerivedFrom("let-y", "x", "define-param")).toBe(false);
    expect(isDerivedFrom("let-x", "x")).toBe(false);
    expect(isDerivedFrom("ngClass", "class", "directive")).toBe(true);
    expect(isDerivedFrom("ngStyle", "style", "directive")).toBe(true);
    expect(isDerivedFrom("ngStyle", "class", "directive")).toBe(false);
    expect(isDerivedFrom("ngClass", "class")).toBe(false);
  });
});
