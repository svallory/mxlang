/**
 * Decision 163 addendum 8 item 3: the union of all containers' atoms equals
 * the template parser's `onAtom` events, each once, over every grammar
 * corpus input, every tracked `.mx` source and a seeded fuzz sample. An
 * atom may be missing only where the parse lost its construct (after a
 * template error, or past the parser's last event at a silent end of input).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROBES } from "../template/grammar-spec.cases.ts";
import { atomLoss } from "./test-support/atoms.ts";
import { characters, tokens } from "./test-support/fuzz.ts";
import { OPTIONS } from "./test-support/options.ts";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

const check = (inputs: { id: string; source: string }[]) =>
  inputs.flatMap(({ id, source }) =>
    atomLoss(source, OPTIONS.statementKeywords, OPTIONS.tagShape).map(
      (problem) => `${id} ${JSON.stringify(source.slice(0, 80))}: ${problem}`,
    ),
  );

describe("every announced atom is in exactly one container", () => {
  it("over the grammar corpus", () => {
    expect(check(PROBES.map((p) => ({ id: p.id, source: p.input })))).toEqual(
      [],
    );
  });

  it("over every tracked .mx source", () => {
    const paths = execFileSync("git", ["ls-files", "*.mx"], {
      cwd: REPO,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    expect(paths.length).toBeGreaterThan(400);
    const inputs = paths.map((path) => ({
      id: path,
      source: readFileSync(`${REPO}${path}`, "utf8"),
    }));
    expect(check(inputs)).toEqual([]);
  });

  it("over a seeded fuzz sample (2,000 inputs per generator, seed 1)", () => {
    const inputs = [];
    for (let seed = 1; seed <= 2000; seed++) {
      inputs.push({ id: `characters#${seed}`, source: characters(seed, 40) });
      inputs.push({ id: `tokens#${seed}`, source: tokens(seed) });
    }
    expect(check(inputs)).toEqual([]);
  });

  it("an atom in the arguments after a sugar is kept (review B1)", () => {
    expect(
      atomLoss("<div .c(:a)/>", OPTIONS.statementKeywords, OPTIONS.tagShape),
    ).toEqual([]);
  });
});
