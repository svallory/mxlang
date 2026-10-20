import type { CustomTag } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { compileHonoMx, compileHonoRegion } from "./index.ts";

/**
 * Wiring smoke only: Hono compiles through `@mxlang/host-preact`'s shared
 * emitter, so the colon-tag matrix (every name shape, `mx.tags` prefix
 * discovery, hint-fix round-trips) is pinned once in
 * `packages/hosts/preact/src/colon-tag.test.ts`. This file proves the same
 * rejection, positions and declared-tag transform reach both Hono doors.
 */
const UNRESOLVED = (name: string) =>
  `Unable to find entry point for custom tag \`<${name}>\`.`;
const FIX =
  ' A colon belongs to the tag name: write the name without the colon, or declare it from an `mx.tags` directory with `prefix: "uuid:"`.';

describe("Hono host: an undeclared colon tag name", () => {
  it("is rejected at the tag, whole file and region", () => {
    let whole:
      | { message: string; line: number; column: number; end: unknown }
      | undefined;
    try {
      compileHonoMx("<uuid:id/>", "/tmp/a.mx");
    } catch (error) {
      const e = error as Error & { line: number; column: number; end: unknown };
      whole = {
        message: e.message,
        line: e.line,
        column: e.column,
        end: e.end,
      };
    }
    expect(whole).toEqual({
      message: UNRESOLVED("uuid:id") + FIX,
      line: 1,
      column: 0,
      end: { line: 1, column: 8 },
    });

    let region: { message: string; line: number; column: number } | undefined;
    try {
      compileHonoRegion("<uuid:id/>", {
        filename: "/tmp/Panel.hono.mx",
        baseOffset: 40,
        baseLine: 2,
        baseColumn: 4,
      });
    } catch (error) {
      region = error as { message: string; line: number; column: number };
    }
    expect(region).toMatchObject({
      message: UNRESOLVED("uuid:id") + FIX,
      line: 3,
      column: 4,
      end: { line: 3, column: 12 },
    });
  });

  it("calls a declared colon tag through both doors", () => {
    const customTags: Record<string, CustomTag> = {
      "uuid:id": { transform: (call) => call.content?.children ?? [] },
    };
    const whole = compileHonoMx("<uuid:id>hi</uuid:id>", "/tmp/a.mx", {
      customTags,
    }).code;
    const region = compileHonoRegion("<uuid:id>hi</uuid:id>", {
      filename: "/tmp/Panel.hono.mx",
      customTags,
    }).code;
    for (const code of [whole, region]) {
      expect(code).toContain("hi");
      expect(code).not.toContain("uuid:id");
    }
  });
});
