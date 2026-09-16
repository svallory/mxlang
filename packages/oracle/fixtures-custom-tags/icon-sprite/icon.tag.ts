/**
 * The sprite-sheet `<icon>`: the tag `transform` alone cannot express.
 *
 * `analyze` sees every `<icon>` in the file before any of them expands and
 * records the distinct names; `transform` emits a five-byte `<use>` per call;
 * `finalize` prepends one hidden `<svg>` holding exactly one `<symbol>` per
 * distinct name. The saving is the point — N calls of M distinct icons emit M
 * path definitions rather than N, whatever order the calls appear in — and it
 * is only reachable because a hook can see the whole file.
 *
 * Note there is no hand validation: `attributes` declares `name` as a required
 * static member of the enum, so a missing or misspelled name is a positioned
 * compile error before either hook runs.
 */
import type {
  CustomTag,
  FinalizeContext,
  IrNode,
  TagCall,
  TransformContext,
} from "@mxlang/core";

const PATHS: Record<string, string[]> = {
  check: ["M20 6 9 17l-5-5"],
  x: ["M18 6 6 18", "M6 6l12 12"],
  plus: ["M12 5v14", "M5 12h14"],
};

const USED = "used";

function staticName(call: TagCall): string | null {
  const attr = call.attrs.find(
    (candidate) => candidate.kind !== "spread" && candidate.name === "name",
  );
  return attr?.kind === "static" ? attr.value : null;
}

const icon: CustomTag = {
  attributes: {
    name: {
      type: "string",
      required: true,
      literalOnly: true,
      enum: Object.keys(PATHS),
    },
    size: { type: "number", literalOnly: true, default: 24 },
    class: { type: "string" },
  },

  analyze(calls, ctx) {
    const used = ctx.store.get<Set<string>>(USED) ?? new Set<string>();
    for (const call of calls) {
      const name = staticName(call);
      // `attributes` already rejected anything else, so a null here would be a
      // core bug rather than an author mistake; skipping keeps `analyze`
      // non-failing, which is what lets a diagnostic be reported once, by the
      // matching `transform`, at its own call site.
      if (name) used.add(name);
    }
    ctx.store.set(USED, used);
  },

  transform(call: TagCall, ctx: TransformContext): IrNode[] {
    const name = staticName(call);
    if (!name) throw ctx.fail("requires a static `name`");

    const size = call.attrs.find(
      (attr) => attr.kind !== "spread" && attr.name === "size",
    );
    if (
      size?.kind !== "dynamic" ||
      size.value.node?.type !== "NumericLiteral"
    ) {
      throw ctx.fail("expected `size` to resolve to a numeric literal");
    }
    const pixels = size.value.code;
    const passthrough = call.attrs.filter(
      (attr) =>
        attr.kind === "spread" ||
        (attr.name !== "name" && attr.name !== "size"),
    );

    return [
      ctx.build.element(
        "svg",
        [
          ctx.build.attr("width", pixels),
          ctx.build.attr("height", pixels),
          ...passthrough,
        ],
        [
          // A `<title>` per call site rather than one on the sheet: the sheet
          // is `aria-hidden`, so a name declared there would reach nothing,
          // and each `<use>` is the element a reader actually encounters.
          ctx.build.element("title", [], [ctx.build.text(name)]),
          ctx.build.element("use", [ctx.build.attr("href", `#icon-${name}`)]),
        ],
      ),
    ];
  },

  finalize(ctx: FinalizeContext): IrNode[] {
    const used = ctx.store.get<Set<string>>(USED);
    if (!used || used.size === 0) return [];
    // Sorted, so the sheet is byte-identical however the calls were ordered in
    // the source — the determinism half of the acceptance criteria.
    const symbols = [...used].sort().map((name) =>
      ctx.build.element(
        "symbol",
        [
          ctx.build.attr("id", `icon-${name}`),
          ctx.build.attr("viewBox", "0 0 24 24"),
          ctx.build.attr("fill", "none"),
          ctx.build.attr("stroke", "currentColor"),
          ctx.build.attr("stroke-width", "2"),
        ],
        (PATHS[name] ?? []).map((d) =>
          ctx.build.element("path", [ctx.build.attr("d", d)]),
        ),
      ),
    );
    return [
      ctx.build.element(
        "svg",
        [
          ctx.build.attr("xmlns", "http://www.w3.org/2000/svg"),
          // Two per-host serialization traps avoided at once, both measured
          // against this fixture rather than assumed. A string `style` prop
          // (`style="display:none"`) throws outright under React, and a
          // *boolean* attribute (`hidden`) serializes as bare `hidden` from
          // the string host and as `hidden=""` from React and Hono — same
          // meaning, different bytes, and this gate compares bytes. A plain
          // valued attribute spells the same on all six, which is what a tag
          // meant to work everywhere should reach for.
          ctx.build.attr("aria-hidden", "true"),
        ],
        symbols,
      ),
    ];
  },
};

export default icon;
