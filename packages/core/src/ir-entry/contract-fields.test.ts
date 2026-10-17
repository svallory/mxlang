/**
 * A dialect's own contract key (`Dialect.contractFields`): core passes a
 * claimed key through registration instead of refusing it as unknown, and
 * hands the unit to the dialect's `afterLower`, whose `fail` is a positioned,
 * coded diagnostic. The dialect is a test fixture: the atom fixture's rows
 * (sigil `~`) without its contract keys.
 */
import { describe, expect, it } from "vitest";
import type { CustomTag } from "../custom-tags.ts";
import atomSyntax from "../fixtures/syntax/atom-fixture.ts";
import type { Dialect } from "../syntax-table.ts";
import { lowerSource } from "./index.ts";

/** The atom fixture's rows and nothing else: only the hooks a test sets. */
const fixture: Dialect = {
  id: atomSyntax.id,
  name: "Fixture",
  table: atomSyntax.table,
  nodeTypes: atomSyntax.nodeTypes,
  lowerTrigger: atomSyntax.lowerTrigger,
};

describe("a module's own contract key", () => {
  it("passes through registration and reaches its `afterLower`, whose `fail` is a positioned, coded diagnostic", () => {
    const source = "entity name=~invoice\n  index on=~title\n";
    const tags: Record<string, CustomTag> = {
      entity: { attributes: { name: { type: "atom:Atom" } } },
      index: {
        attributes: { on: { type: "atom:Atom", unique: true } as never },
        relations: "many",
      } as CustomTag,
    };
    // Without a module that claims them, both keys are unknown: the tag-level
    // `relations` is refused first, then `unique` once that one is gone.
    expect(
      lowerSource(source, "/v/x.mx", { customTags: tags, dialect: fixture })
        .diagnostics[0]?.message,
    ).toMatch(/Unknown key "relations" in the declaration of tag "index"/);
    const { relations: _relations, ...withoutRelations } =
      tags.index as CustomTag & {
        relations?: string;
      };
    expect(
      lowerSource(source, "/v/x.mx", {
        customTags: { ...tags, index: withoutRelations },
        dialect: fixture,
      }).diagnostics[0]?.message,
    ).toMatch(/Unknown key "unique"/);

    const seen: unknown[] = [];
    const module: Dialect = {
      ...fixture,
      contractFields: { attribute: ["unique"], tag: ["relations"] },
      afterLower(unit) {
        for (const call of unit.calls) {
          if (call.tag !== "index") continue;
          seen.push([call.tag, call.contract.relations]);
          const on = call.attrs.find(
            (attr) => !("spread" in attr) && attr.name === "on",
          );
          const value = on && !("spread" in on) ? on.value : null;
          if (
            value?.type === "atom:Atom" &&
            call.contract.attributes?.on?.unique
          ) {
            unit.fail(
              `\`~${(value as unknown as { name: string }).name}\` is not unique`,
              {
                at: value.span,
                code: "FIXTURE_UNIQUE",
              },
            );
          }
        }
      },
    };
    const { diagnostics } = lowerSource(source, "/v/x.mx", {
      customTags: tags,
      dialect: module,
    });
    expect(seen).toEqual([["index", "many"]]);
    expect(diagnostics).toEqual([
      {
        severity: "error",
        message: "`~title` is not unique",
        line: 2,
        column: 11,
        offset: source.indexOf("~title"),
        code: "FIXTURE_UNIQUE",
      },
    ]);
  });
});
