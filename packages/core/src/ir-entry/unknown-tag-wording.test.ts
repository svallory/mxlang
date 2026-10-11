/**
 * `MX_UNKNOWN_TAG` names where the file's vocabulary comes from, and only
 * what is known at the call. A file of a dialect names the dialect (its id):
 * its contracts, its tag directories and the caller's `customTags` are all
 * its vocabulary, and the tag is in none of them. Any other file names no
 * source, because `lowerSource` is handed its contracts and cannot tell where
 * the caller found them.
 *
 * Every row pins the whole diagnostic (message, code, line, column) for one
 * way a file reaches the check: the success path (the IR is checked) and the
 * failure path (the lowering threw on a closed parent and the scan reports
 * the tag instead).
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CustomTag } from "../custom-tags.ts";
import { clearScanCache, scanCached } from "../scan-cache.ts";
import { type Dialect, resolveSyntaxOf } from "../syntax-table.ts";
import { dialectProject } from "../test-dialect-project.ts";
import { testTargetLookup } from "../test-targets.ts";
import { type LowerSourceResult, lowerSource } from "./index.ts";

const targets = testTargetLookup();

/** `box` closes its children to `item`; `entity` and `field` are open. */
const CONTRACTS: Record<string, CustomTag> = {
  entity: {},
  field: { parents: ["entity"] },
  box: { children: { item: {} } },
  item: {},
};

/** An unknown tag in an open parent: the IR lowers, the check reports it. */
const OPEN = "<entity>\n  <field/>\n</entity>\n<widget/>\n";
/** An unknown tag in a closed parent: the lowering throws, the scan reports it. */
const CLOSED = "<box>\n  <widget/>\n</box>\n";
/** A typo of a declared tag. */
const TYPO = "<entty/>\n";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-unknown-wording-")));
  clearScanCache();
});
afterEach(() => {
  clearScanCache();
  rmSync(dir, { recursive: true, force: true });
});

const brief = (result: LowerSourceResult) =>
  result.diagnostics.map(({ message, line, column, code }) => ({
    message,
    line,
    column,
    code,
  }));

const unknown = (
  name: string,
  where: string,
  line: number,
  column: number,
  rest = "",
) => ({
  message: `\`<${name}>\` is not a known tag${where}${rest}`,
  line,
  column,
  code: "MX_UNKNOWN_TAG",
});

/** The wording of a file that is no dialect's. */
const GIVEN = ": no contract for it was given";
/** The wording of a file of the dialect `id`. */
const IN = (id: string) => ` in the \`${id}\` dialect`;

/** A routed dialect `kit` over `.kit.mx`, with `fields` as module source. */
function kit(fields: string) {
  dialectProject(dir, {
    manifest: { id: "kit", name: "Kit", extensions: [".kit.mx"] },
    module: `export default { table: {}, tagRules: "none", unknownTags: "reject", ${fields} };`,
  });
}

/** Writes `tags/<name>.tag.ts` for each of `CONTRACTS`, as sidecars. */
function writeTagsDir() {
  mkdirSync(join(dir, "tags"), { recursive: true });
  const text: Record<string, string> = {
    entity: "{}",
    field: '{ parents: ["entity"] }',
    box: "{ children: { item: {} } }",
    item: "{}",
  };
  for (const [name, contract] of Object.entries(text)) {
    writeFileSync(
      join(dir, "tags", `${name}.tag.ts`),
      `export default ${contract};\n`,
    );
  }
}

/** The fixture dialect as an object, for the `dialect` option. */
const explicit = (fields: Partial<Dialect> = {}): Dialect =>
  ({
    id: "obj",
    name: "Obj",
    table: {},
    tagRules: "none",
    unknownTags: "reject",
    ...fields,
  }) as Dialect;

describe("a file that is no dialect's", () => {
  const mx = () => join(dir, "a.mx");
  const options = { unknownTags: "reject", tagRules: "none" } as const;

  it("with `customTags` passed, the tag is named and no source is", () => {
    expect(
      brief(lowerSource(OPEN, mx(), { ...options, customTags: CONTRACTS })),
    ).toEqual([unknown("widget", GIVEN, 4, 0)]);
  });

  it("with no `customTags` at all, every tag is unknown and the same wording holds", () => {
    expect(brief(lowerSource(OPEN, mx(), options))).toEqual([
      unknown("entity", GIVEN, 1, 0),
      unknown(
        "field",
        GIVEN,
        2,
        2,
        " (inside the unknown tag `<entity>`; may resolve once it is declared)",
      ),
      unknown("widget", GIVEN, 4, 0),
    ]);
  });

  it("with the project's scan passed as `customTags`, the tag is named and no source is", () => {
    writeTagsDir();
    const { customTags } = scanCached(mx(), { targets });
    expect(brief(lowerSource(OPEN, mx(), { ...options, customTags }))).toEqual([
      unknown("widget", GIVEN, 4, 0),
    ]);
  });

  it("keeps the `did you mean` hint", () => {
    expect(
      brief(lowerSource(TYPO, mx(), { ...options, customTags: CONTRACTS })),
    ).toEqual([unknown("entty", GIVEN, 1, 0, "; did you mean `<entity>`?")]);
  });

  it("in a closed parent, the failure path says the same", () => {
    expect(
      brief(lowerSource(CLOSED, mx(), { ...options, customTags: CONTRACTS })),
    ).toEqual([unknown("widget", GIVEN, 2, 2)]);
  });

  it("an explicit bare table is no dialect: the same wording", () => {
    const bare = resolveSyntaxOf(mx()).table;
    expect(
      brief(
        lowerSource(OPEN, mx(), {
          ...options,
          dialect: bare,
          customTags: CONTRACTS,
        }),
      ),
    ).toEqual([unknown("widget", GIVEN, 4, 0)]);
  });
});

describe("a file of a routed dialect", () => {
  const file = () => join(dir, "a.kit.mx");

  it("whose vocabulary is `Dialect.contracts`, names the dialect", () => {
    kit(`contracts: ${JSON.stringify(CONTRACTS)}`);
    expect(brief(lowerSource(OPEN, file()))).toEqual([
      unknown("widget", IN("kit"), 4, 0),
    ]);
  });

  it("whose vocabulary is its tag directory (the scan), names the dialect", () => {
    kit("");
    writeTagsDir();
    const { customTags } = scanCached(file(), { targets });
    expect(Object.keys(customTags).sort()).toEqual([
      "box",
      "entity",
      "field",
      "item",
    ]);
    expect(brief(lowerSource(OPEN, file(), { customTags }))).toEqual([
      unknown("widget", IN("kit"), 4, 0),
    ]);
  });

  it("whose vocabulary is the caller's `customTags`, names the dialect", () => {
    kit("");
    expect(brief(lowerSource(OPEN, file(), { customTags: CONTRACTS }))).toEqual(
      [unknown("widget", IN("kit"), 4, 0)],
    );
  });

  it("with no vocabulary at all, still names the dialect", () => {
    kit("");
    expect(brief(lowerSource("<widget/>\n", file()))).toEqual([
      unknown("widget", IN("kit"), 1, 0),
    ]);
  });

  it("keeps the `did you mean` hint and the labelled suffix", () => {
    kit(`contracts: ${JSON.stringify(CONTRACTS)}`);
    expect(brief(lowerSource(TYPO, file()))).toEqual([
      unknown("entty", IN("kit"), 1, 0, "; did you mean `<entity>`?"),
    ]);
    expect(
      brief(lowerSource("<widget>\n  <bogus/>\n</widget>\n", file())),
    ).toEqual([
      unknown("widget", IN("kit"), 1, 0),
      unknown(
        "bogus",
        IN("kit"),
        2,
        2,
        " (inside the unknown tag `<widget>`; may resolve once it is declared)",
      ),
    ]);
  });

  it("in a closed parent, the failure path names the dialect", () => {
    kit(`contracts: ${JSON.stringify(CONTRACTS)}`);
    expect(brief(lowerSource(CLOSED, file()))).toEqual([
      unknown("widget", IN("kit"), 2, 2),
    ]);
  });

  it("in a closed parent, the failure path keeps the parent's guidance after the dialect", () => {
    kit(
      `contracts: ${JSON.stringify({ wild: { children: { "*": { pattern: "^T[a-z]+$" } } } })}`,
    );
    expect(brief(lowerSource("<wild>\n  <t1/>\n</wild>\n", file()))).toEqual([
      unknown(
        "t1",
        IN("kit"),
        2,
        2,
        "; inside `<wild>`: names must match `^T[a-z]+$`",
      ),
    ]);
  });

  it("a `.mx` file in the same project is still no dialect's", () => {
    kit(`contracts: ${JSON.stringify(CONTRACTS)}`);
    expect(
      brief(
        lowerSource(OPEN, join(dir, "a.mx"), {
          unknownTags: "reject",
          tagRules: "none",
          customTags: CONTRACTS,
        }),
      ),
    ).toEqual([unknown("widget", GIVEN, 4, 0)]);
  });
});

describe("a file under an explicit `dialect`", () => {
  const file = () => join(dir, "a.x");

  it("whose vocabulary is `Dialect.contracts`, names the dialect", () => {
    expect(
      brief(
        lowerSource(OPEN, file(), {
          dialect: explicit({ contracts: CONTRACTS }),
        }),
      ),
    ).toEqual([unknown("widget", IN("obj"), 4, 0)]);
  });

  it("whose vocabulary is the caller's `customTags`, names the dialect", () => {
    expect(
      brief(
        lowerSource(OPEN, file(), {
          dialect: explicit(),
          customTags: CONTRACTS,
        }),
      ),
    ).toEqual([unknown("widget", IN("obj"), 4, 0)]);
  });

  it("in a closed parent, the failure path names the dialect", () => {
    expect(
      brief(
        lowerSource(CLOSED, file(), {
          dialect: explicit({ contracts: CONTRACTS }),
        }),
      ),
    ).toEqual([unknown("widget", IN("obj"), 2, 2)]);
  });

  it("names the explicit dialect, not the one the file routes to", () => {
    kit(`contracts: ${JSON.stringify(CONTRACTS)}`);
    expect(
      brief(
        lowerSource(OPEN, join(dir, "a.kit.mx"), {
          dialect: explicit({ contracts: CONTRACTS }),
        }),
      ),
    ).toEqual([unknown("widget", IN("obj"), 4, 0)]);
  });
});
