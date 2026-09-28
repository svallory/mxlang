import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Isolated in its own file because `vi.mock("node:fs", ...)` is hoisted and
 * module-scoped: every `node:fs` consumer this test file's module graph
 * pulls in (`@marko/compiler`, `@mxlang/core`'s scan) shares the mock, so
 * mixing it into `index.test.ts` would affect that file's other,
 * real-filesystem tests too.
 *
 * Round 3 fix: `readFileSync(err.file, ...)` (the wrapping code added for
 * `custom-tags-template-error-positions` round 2) can itself throw — the
 * template file named by a `TranslateError.file` may have been deleted or
 * become unreadable between the original compile's own read and this
 * second, independent one. That read failure must not replace the real
 * diagnostic with a raw ENOENT: the message, `id`/`loc.file` and
 * `line`/`column` must survive, with only `frame` omitted. There is no way
 * to force that exact race through the real filesystem (deleting the file
 * before the *first* read makes the original compile fail before a
 * `TranslateError.file` is ever set at all — a different, unrelated
 * failure — see the round-3 report), so the second read is mocked to fail
 * while the first succeeds.
 */
describe("a template file that vanishes between the compile's own read and the wrapper's re-read", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it("keeps the message, id and position; only the frame is dropped", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const dir = actualFs.mkdtempSync(join(tmpdir(), "mx-vite-vanish-"));
    actualFs.writeFileSync(
      join(dir, "package.json"),
      '{"name":"v","mx":{"host":"html"}}',
    );
    actualFs.mkdirSync(join(dir, "tags"), { recursive: true });
    const templateFile = join(dir, "tags", "broken.mx");
    const brokenTemplate = [
      "export interface Input { name: string }",
      "<span>oops</span>",
      "<else/>",
      "",
    ].join("\n");
    actualFs.writeFileSync(templateFile, brokenTemplate);
    const caller = join(dir, "caller.mx");
    actualFs.writeFileSync(caller, '<broken name="star"/>\n');

    let templateReads = 0;
    let wrapperReads = 0;
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        readFileSync: (path: unknown, ...rest: unknown[]) => {
          if (path === templateFile) {
            templateReads++;
            // Distinguish the compile's own read (`@mxlang/core`'s lazy
            // `template` getter, `packages/core/src/scan.ts`, reached
            // through this package's `compileMarko`) from the round-2
            // wrapping code's independent re-read (the `transform` hook's
            // own `catch`, once `compileMarko` has already returned by
            // throwing) by whether `compileMarko` is still a live stack
            // frame — not by a magic read count, which would silently stop
            // meaning anything the moment core's internals read the
            // template a different number of times.
            const stack = new Error().stack ?? "";
            const fromWrapper = !stack.includes("at compileMarko ");
            if (fromWrapper) {
              wrapperReads++;
              throw Object.assign(new Error(`ENOENT: ${path}`), {
                code: "ENOENT",
              });
            }
            return brokenTemplate;
          }
          return (actual.readFileSync as (...a: unknown[]) => unknown)(
            path,
            ...rest,
          );
        },
      };
    });

    const { default: mx, MX_SUFFIX } = await import("./index.ts");

    let caught: unknown;
    try {
      await (
        mx().transform as (
          this: unknown,
          code: string,
          id: string,
        ) => Promise<unknown>
      ).call({}, '<broken name="star"/>\n', `${caller}${MX_SUFFIX}`);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error & {
      id?: string;
      loc?: { file: string; line: number; column: number };
      frame?: string;
    };

    expect(templateReads).toBeGreaterThan(0);
    expect(wrapperReads).toBeGreaterThan(0);
    expect(error.message).toMatch(/`<else>`/);
    expect(error.id).toBe(templateFile);
    expect(error.loc?.file).toBe(templateFile);
    expect(error.loc?.line).toBe(3);
    // The frame could not be built from a file that failed to read back —
    // it must be omitted, not present with garbage content, and above all
    // the error must not have been replaced by a raw ENOENT.
    expect(error.frame).toBeUndefined();
  });
});
