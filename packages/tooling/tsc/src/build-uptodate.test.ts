import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_ERROR,
  BROKEN,
  CASE_TIMEOUT_MS,
  mxTscIn,
  refsFixture,
  SPAWN,
  scratch,
  setTemplate,
  template,
  templateErrors,
} from "./build-uptodate-support.ts";

describe("mx-tsc -b: Angular templates of up-to-date projects", () => {
  it(
    "fails the up-to-date run exactly as the first, at tsc's own position and message; a markup break is reported",
    async () => {
      const dir = scratch(refsFixture);
      const app = join(dir, "app");
      setTemplate(dir, "app", BROKEN);

      const first = await mxTscIn(app, ["-b", "."], SPAWN);
      expect(first.status).toBe(1);
      // Exact position, and tsc's own message (the one a non-build run prints).
      expect(templateErrors(first.output)).toEqual([APP_ERROR]);
      expect(first.output).toContain(
        "error TS2339: Property 'nmae' does not exist on type '{ name: string; }'.",
      );

      // tsc's build info now says everything is up to date.
      expect(existsSync(join(app, "out", "tsconfig.tsbuildinfo"))).toBe(true);
      const second = await mxTscIn(app, ["-b", "."], SPAWN);
      expect(second.status).toBe(1);
      expect(second.output).toBe(first.output);

      // A forced rebuild reports each template error exactly once.
      const forced = await mxTscIn(app, ["-b", "--force", "."], SPAWN);
      expect(forced.status).toBe(1);
      expect(templateErrors(forced.output)).toEqual([APP_ERROR]);

      // Breaking the template's own markup: the compile itself fails, and that
      // is reported by the language plugin, once, not by the template pass.
      writeFileSync(
        template(dir, "app"),
        readFileSync(template(dir, "app"), "utf8").replace("<p>", "<p"),
      );
      const markup = await mxTscIn(app, ["-b", "."], SPAWN);
      expect(markup.status).toBe(1);
      expect(markup.output).toContain("app.component.ng.mx(");
    },
    CASE_TIMEOUT_MS,
  );
});
