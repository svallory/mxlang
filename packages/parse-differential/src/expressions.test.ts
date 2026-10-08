/** Unit pins for `compareExpressions`' two directions and the period ruling. */
import { describe, expect, it } from "vitest";
import { parse as parseMx } from "../../parser/src/frontend/parse.ts";
import { SIX } from "../../parser/src/frontend/test-support/options.ts";
import {
  compareExpressions,
  type MxEntry,
  mxExpressions,
  type TodayEntry,
  todayExpressions,
} from "./expressions.ts";
import { markoTagShape, projectMarko } from "./marko.ts";
import { lineStartsOf } from "./rules.ts";

const mx = (over: Partial<MxEntry> = {}): MxEntry => ({
  kind: "expression",
  start: 0,
  end: 3,
  node: { type: "Identifier", name: "a", start: 1, end: 2 },
  error: null,
  ...over,
});

const today = (over: Partial<TodayEntry> = {}): TodayEntry => ({
  kind: "expression",
  nodes: [{ type: "Identifier", name: "a", start: 1, end: 2 }],
  start: 0,
  end: 3,
  ...over,
});

describe("compareExpressions", () => {
  it("pairs a container on both sides", () => {
    const outcome = compareExpressions([mx()], [today()], "<x=${a}/>");
    expect(outcome.compared).toBe(1);
    expect(outcome.differences).toEqual([]);
  });

  it("reports a container today has that MX lacks (failing-first: dropping one MX container goes red)", () => {
    const pair = today({ start: 5, end: 8 });
    const outcome = compareExpressions(
      [mx()],
      [today(), pair],
      "<x=${a} ${b}/>",
    );
    expect(outcome.differences).toEqual([
      expect.stringContaining("no MX counterpart: today's expression [5,8)"),
    ]);
  });

  it("compares a dynamic shorthand value's ${\u2026} containers (failing-first: MX dropping the `x` of `<a.c-${x}/>` goes red)", () => {
    const source = "<a.c-${x}/>";
    const document = parseMx(source, {
      statementKeywords: SIX,
      tagShape: markoTagShape,
    });
    const marko = projectMarko(source);
    expect(marko.crash).toBeUndefined();
    const today = todayExpressions(marko.ast, source, lineStartsOf(source));
    // Today's tree really carries the `${x}` container at its position.
    const todayX = today.find(
      (entry) =>
        entry.kind === "expression" &&
        source.slice(entry.start, entry.end) === "x",
    );
    expect(todayX).toBeDefined();

    const skips: [number, number][] = [];
    const entries = mxExpressions(document, skips);
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: "expression",
        start: todayX?.start,
        end: todayX?.end,
      }),
    );
    const full = compareExpressions(entries, today, source, skips);
    expect(full.differences).toEqual([]);

    // MX's side lacks the container: the reverse check must flag today's.
    const dropped = entries.filter(
      (entry) =>
        entry !==
        entries.find(
          (candidate) =>
            candidate.kind === "expression" &&
            candidate.start === todayX?.start &&
            candidate.end === todayX?.end,
        ),
    );
    const outcome = compareExpressions(dropped, today, source, skips);
    expect(outcome.differences).toEqual([
      expect.stringContaining(
        `no MX counterpart: today's expression [${todayX?.start},${todayX?.end})`,
      ),
    ]);
  });

  it("reports an MX container today lacks", () => {
    const outcome = compareExpressions(
      [mx(), mx({ start: 5, end: 8 })],
      [today()],
      "<x=${a} ${b}/>",
    );
    expect(outcome.differences).toEqual([
      expect.stringContaining("no counterpart in today's tree"),
    ]);
  });

  it("accepts the trailing period only on the named comma message", () => {
    const failed = (message: string) =>
      mx({ node: null, error: { message, start: 1, end: 2 } });
    const todayFailed = (label: string) =>
      today({ error: { label, start: 1, end: 2 } });

    // The named message: the period is the accepted difference.
    const comma = compareExpressions(
      [failed('Unexpected token, expected ",".')],
      [todayFailed('Unexpected token, expected ","')],
      "<x=${a b}/>",
    );
    expect(comma.differences).toEqual([]);

    // Any other message: a period-only difference is reported.
    const other = compareExpressions(
      [failed("Unexpected token.")],
      [todayFailed("Unexpected token")],
      "<x=${a b}/>",
    );
    expect(other.differences).toHaveLength(1);
    expect(other.differences[0]).toContain("Unexpected token");
  });
});
