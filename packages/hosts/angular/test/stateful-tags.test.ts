import { describe, expect, it } from "vitest";
import { emit } from "./helpers.ts";

// Spec §11, §13.3 bug 1: this host used to declare only `try`, so every
// other Marko stateful tag fell through `isElement`'s bare case test and
// became a literal lowercase element (the S8 silent-wrong-render class).
// Each of these is now a positioned error, same wording family as
// `@mxlang/host-preact`'s `statefulErrors`/`@mxlang/host-solid`'s `STATEFUL_ERRORS`,
// adapted to name an Angular equivalent.
describe("stateful tags: positioned errors, not literal elements", () => {
  it("rejects <let> even with no /var", () => {
    expect(() => emit("<let x=1/>")).toThrow(
      "`<let>` is not supported in embedded MX on Angular. Use Angular's `signal`/`WritableSignal` in the component class, or a `@Input()`.",
    );
  });

  it("rejects <let> with a /var", () => {
    expect(() => emit("<let/x=1/>")).toThrow(
      "`<let>` is not supported in embedded MX on Angular. Use Angular's `signal`/`WritableSignal` in the component class, or a `@Input()`.",
    );
  });

  it("rejects <effect>", () => {
    expect(() => emit("<effect><div>x</div></effect>")).toThrow(
      "`<effect>` is not supported in embedded MX on Angular.",
    );
  });

  it("keeps its own <effect> error, never a target's", () => {
    for (const source of ["<effect/>", "<effect() { go() }/>"]) {
      expect(() => emit(source)).toThrow(
        "`<effect>` is not supported in embedded MX on Angular.",
      );
      expect(() => emit(source)).not.toThrow(/Use `<script>`/);
    }
  });

  it("rejects <lifecycle>", () => {
    expect(() => emit("<lifecycle/>")).toThrow(
      "`<lifecycle>` is not supported in embedded MX on Angular. Use Angular's own lifecycle hooks (`ngOnInit`, etc.) in the component class.",
    );
  });

  it("rejects <script>", () => {
    expect(() => emit("<script>console.log(1)</script>")).toThrow(
      "`<script>` is not supported in embedded MX on Angular. Write client code in the component class.",
    );
  });

  it("rejects <log>", () => {
    expect(() => emit("<log=1/>")).toThrow(
      "`<log>` is not supported in embedded MX on Angular. Call `console.log` from the component class.",
    );
  });

  it("rejects <debug>", () => {
    expect(() => emit("<debug/>")).toThrow(
      "`<debug>` is not supported in embedded MX on Angular. Use the component class instead.",
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
      "`<id>` is not supported in embedded MX on Angular. Use Angular's own `inject(...)`-based id generation or a static string.",
    );
  });

  it("rejects <await>", () => {
    expect(() => emit("<await>y</await>")).toThrow(
      "`<await>` is not supported in embedded MX on Angular. Use `@defer` with an `@placeholder`/`@loading` block instead.",
    );
  });
});

// Spec §13.3 bug 8: `<return>` used to compile clean and emit nothing at the
// page level (`compileTagModule`'s own guard did not cover `compile()`).
describe("<return> in a page template", () => {
  it("is a positioned error, not a silent drop", () => {
    expect(() => emit("<return value=42/>\n<span>hi</span>\n")).toThrow(
      "`<return>` is not supported in embedded MX on Angular. Declare the value as a `@Input()`/class member, or expose it as a `static`/`export`.",
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
