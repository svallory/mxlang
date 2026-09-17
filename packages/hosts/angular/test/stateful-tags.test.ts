import { describe, expect, it } from "vitest";
import { emit } from "./helpers.ts";

// Spec §11, §13.3 bug 1: this host used to declare only `try`, so every
// other Marko stateful tag fell through `isElement`'s bare case test and
// became a literal lowercase element (the S8 silent-wrong-render class).
// Each of these is now a positioned error, same wording family as
// `@mxlang/preact`'s `statefulErrors`/`@mxlang/solid`'s `STATEFUL_ERRORS`,
// adapted to name an Angular equivalent.
describe("stateful tags: positioned errors, not literal elements", () => {
  it("rejects <let> even with no /var", () => {
    expect(() => emit("<let x=1/>")).toThrow(/`<let>` is Marko reactive state/);
  });

  it("rejects <let> with a /var", () => {
    expect(() => emit("<let/x=1/>")).toThrow(/`<let>` is Marko reactive state/);
  });

  it("rejects <effect>", () => {
    expect(() => emit("<effect><div>x</div></effect>")).toThrow(
      /`<effect>` is a Marko reactive effect/,
    );
  });

  it("rejects <lifecycle>", () => {
    expect(() => emit("<lifecycle/>")).toThrow(
      /`<lifecycle>` is a Marko lifecycle hook/,
    );
  });

  it("rejects <script>", () => {
    expect(() => emit("<script>console.log(1)</script>")).toThrow(
      /`<script>` is a Marko client-runtime tag/,
    );
  });

  it("rejects <log>", () => {
    expect(() => emit("<log=1/>")).toThrow(/`<log>` is a Marko debug tag/);
  });

  it("rejects <debug>", () => {
    expect(() => emit("<debug/>")).toThrow(
      /`<debug>` is a Marko debugger hook/,
    );
  });

  it("rejects a client block", () => {
    expect(() => emit("client { const x = 1; }")).toThrow(
      /a `client` block is Marko's client-runtime split/,
    );
  });

  it("rejects a server block", () => {
    expect(() => emit("server { const x = 1; }")).toThrow(
      /a `server` block runs only during a server render/,
    );
  });

  it("rejects <id>", () => {
    expect(() => emit("<id/x/>")).toThrow(
      /`<id>` allocates an identifier for Marko's reactive runtime/,
    );
  });

  it("rejects <await>", () => {
    expect(() => emit("<await>y</await>")).toThrow(
      /`<await>` needs Marko's suspense/,
    );
  });
});

// Spec §13.3 bug 8: `<return>` used to compile clean and emit nothing at the
// page level (`compileTagModule`'s own guard did not cover `compile()`).
describe("<return> in a page template", () => {
  it("is a positioned error, not a silent drop", () => {
    expect(() => emit("<return value=42/>\n<span>hi</span>\n")).toThrow(
      "`<return>` is not supported on Angular",
    );
  });

  it("positions the error at the <return> tag, not the file start", () => {
    try {
      emit("<span>hi</span>\n<return value=42/>\n");
      throw new Error("expected compile() to throw");
    } catch (err) {
      expect((err as { line?: number }).line).toBe(2);
    }
  });
});
