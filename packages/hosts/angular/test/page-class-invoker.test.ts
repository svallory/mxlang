import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { build } from "../src/build.ts";
import { inspectPageClass } from "../src/page-class.ts";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "mx-angular-page-class-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

const RT = "@mxlang/angular/runtime";

function readHtml(): string {
  return readFileSync(join(projectDir, "src/page.html"), "utf8");
}

function write(files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const path = join(projectDir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

/** Builds a one-page project; returns the invoker warnings the build printed. */
function invokerWarnings(
  cls?: string,
  template = "<button onClick=go>x</button>",
) {
  write({
    "package.json": JSON.stringify({
      mx: { host: "angular", angular: { include: ["src/**/*.mx"] } },
    }),
    "src/page.mx": template,
    ...(cls === undefined ? {} : { "src/page.ts": cls }),
  });
  const result = build(projectDir);
  expect(result.errors).toEqual([]);
  return result.warnings.filter((w) =>
    w.message.includes("binds an event handler"),
  );
}

const component = (head: string, body = "") =>
  `${head}\n@Component({ selector: "p", templateUrl: "./page.html" })\nexport class PageComponent${body}`;

const MEMBERS =
  "{\n  __mxOn = (h: any, r: any, e: any) => h?.call(r, e);\n  __mxOnAt = (o: any, k: any, e: any) => o[k]?.call(o, e);\n}";

describe("page invoker warning vs the page's own class", () => {
  it("is silent for `extends MxHandlers`", () => {
    expect(
      invokerWarnings(
        component(
          `import { MxHandlers } from "${RT}";`,
          " extends MxHandlers {}",
        ),
      ),
    ).toEqual([]);
  });

  it("is silent for an aliased import", () => {
    expect(
      invokerWarnings(
        component(`import { MxHandlers as H } from "${RT}";`, " extends H {}"),
      ),
    ).toEqual([]);
  });

  it("is silent for `extends MxHandlersMixin(Base)`", () => {
    expect(
      invokerWarnings(
        component(
          `import { MxHandlersMixin } from "${RT}";\nclass Base {}`,
          " extends MxHandlersMixin(Base) {}",
        ),
      ),
    ).toEqual([]);
  });

  it("is silent for a namespace import of the runtime", () => {
    expect(
      invokerWarnings(
        component(`import * as rt from "${RT}";`, " extends rt.MxHandlers {}"),
      ),
    ).toEqual([]);
  });

  it("is silent when both members are hand-declared (property or method)", () => {
    expect(invokerWarnings(component("", ` ${MEMBERS}`))).toEqual([]);
    expect(
      invokerWarnings(
        component(
          "",
          " {\n  __mxOn(h: any, r: any, e: any) { return h?.call(r, e); }\n  __mxOnAt(o: any, k: any, e: any) { return o[k]?.call(o, e); }\n}",
        ),
      ),
    ).toEqual([]);
  });

  it("is silent when a same-file base provides the members", () => {
    expect(
      invokerWarnings(
        component(
          `import { MxHandlers } from "${RT}";\nclass Mid extends MxHandlers {}`,
          " extends Mid {}",
        ),
      ),
    ).toEqual([]);
  });

  it("keeps the warning and names the missing member when one is absent", () => {
    const warnings = invokerWarnings(
      component("", " {\n  __mxOn = (h: any) => h;\n}"),
    );
    expect(warnings).toHaveLength(1);
    const message = warnings[0]?.message ?? "";
    expect(message).toContain("PageComponent");
    expect(message).toContain("page.ts");
    expect(message).toContain("is missing `__mxOnAt`");
    expect(message).not.toContain("is missing `__mxOn`,");
  });

  it("names the class and file when it extends something else and has neither", () => {
    const warnings = invokerWarnings(
      component("class Other {}", " extends Other {}"),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("PageComponent");
    expect(warnings[0]?.message).toContain("page.ts");
  });

  it("keeps the warning for an extends of an unrelated local named MxHandlers", () => {
    expect(
      invokerWarnings(
        component("class MxHandlers {}", " extends MxHandlers {}"),
      ),
    ).toHaveLength(1);
  });

  // A base the file cannot show: the ORIGINAL warning, never "is missing".
  describe.each([
    [
      "an imported base",
      component('import { Base } from "./base";', " extends Base {}"),
    ],
    [
      "a wrapper around an imported base",
      component(
        'import { Base } from "./base";\nconst O = (b: any) => b;',
        " extends O(Base) {}",
      ),
    ],
    [
      "a const class expression base",
      component(
        `import { MxHandlers } from "${RT}";\nconst B = class extends MxHandlers {};`,
        " extends B {}",
      ),
    ],
    [
      "a wrapper with no runtime inside",
      component("const O = (b: any) => b;\nclass B {}", " extends O(B) {}"),
    ],
  ])("%s", (_name, source) => {
    it("keeps the original warning text, claims nothing missing, keeps the paste line", () => {
      const warnings = invokerWarnings(source);
      expect(warnings).toHaveLength(1);
      const message = warnings[0]?.message ?? "";
      expect(message).not.toContain("is missing");
      expect(message).not.toContain("page.ts:");
      expect(message).toMatch(
        /^this template binds an event handler; add these members/,
      );
      expect(readHtml()).toContain("Add to the component class");
    });
  });

  it("is silent for a chained mixin that reaches the runtime", () => {
    expect(
      invokerWarnings(
        component(
          `import { MxHandlersMixin } from "${RT}";\nconst O = (b: any) => b;\nclass B {}`,
          " extends O(MxHandlersMixin(B)) {}",
        ),
      ),
    ).toEqual([]);
  });

  it("keeps the declared members when the chain is unseen but both are declared", () => {
    expect(
      invokerWarnings(
        component('import { Base } from "./base";', ` extends Base ${MEMBERS}`),
      ),
    ).toEqual([]);
  });

  it("does not count `import type { MxHandlers }`", () => {
    expect(
      invokerWarnings(
        component(
          `import type { MxHandlers } from "${RT}";`,
          " extends MxHandlers {}",
        ),
      ),
    ).toHaveLength(1);
    expect(
      invokerWarnings(
        component(
          `import { type MxHandlers } from "${RT}";`,
          " extends MxHandlers {}",
        ),
      ),
    ).toHaveLength(1);
  });

  // Members that type-check but do not exist on the instance at run time.
  describe.each([
    ["declare", "{\n  declare __mxOn: any;\n  declare __mxOnAt: any;\n}"],
    [
      "definite-assignment, no value",
      "{\n  __mxOn!: any;\n  __mxOnAt!: any;\n}",
    ],
    [
      "static",
      "{\n  static __mxOn = (h: any) => h;\n  static __mxOnAt = (h: any) => h;\n}",
    ],
    ["bodiless methods", "{\n  __mxOn(): void;\n  __mxOnAt(): void;\n}"],
    ["abstract", "{\n  abstract __mxOn: any;\n  abstract __mxOnAt: any;\n}"],
  ])("type-only members (%s)", (_name, body) => {
    it("do not count as provided", () => {
      const source = component("", ` ${body}`);
      const warnings = invokerWarnings(
        body.includes("abstract")
          ? source.replace("export class", "export abstract class")
          : source,
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toContain(
        "`PageComponent` is missing `__mxOn` and `__mxOnAt`",
      );
    });
  });

  // The most likely real-world false negative: a bare field to silence TS2339.
  describe.each([
    ["bare `: any`", "{\n  __mxOn: any;\n  __mxOnAt: any;\n}", ""],
    ["optional `?:`", "{\n  __mxOn?: any;\n  __mxOnAt?: any;\n}", ""],
    [
      "bare field under implements",
      "implements Foo {\n  __mxOn: any;\n  __mxOnAt: any;\n}",
      "interface Foo {}",
    ],
    [
      "setter-only accessors",
      "{\n  set __mxOn(v: any) {}\n  set __mxOnAt(v: any) {}\n}",
      "",
    ],
  ])("valueless members (%s)", (_name, body, head) => {
    it("do not count as provided", () => {
      const warnings = invokerWarnings(component(head, ` ${body}`));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toContain(
        "`PageComponent` is missing `__mxOn` and `__mxOnAt`",
      );
    });
  });

  it("counts an arrow-function field and a getter", () => {
    expect(
      invokerWarnings(
        component(
          "",
          " {\n  __mxOn = (h: any) => h;\n  get __mxOnAt() { return (o: any) => o; }\n}",
        ),
      ),
    ).toEqual([]);
  });

  it("treats a same-file `declare class` base as unseen: original text, no claim", () => {
    const warnings = invokerWarnings(
      component("declare class Base {}", " extends Base {}"),
    );
    expect(warnings).toHaveLength(1);
    const message = warnings[0]?.message ?? "";
    expect(message).not.toContain("is missing");
    expect(message).toMatch(
      /^this template binds an event handler; add these members/,
    );
  });

  it("does not follow a mixin that takes the base in a later argument", () => {
    const warnings = invokerWarnings(
      component(
        `import { MxHandlersMixin } from "${RT}";\nconst O = (a: any, b: any) => b;\nclass B {}`,
        " extends O(1, MxHandlersMixin(B)) {}",
      ),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).not.toContain("is missing");
  });

  it("counts a definite property that has an initializer", () => {
    expect(
      invokerWarnings(
        component(
          "",
          " {\n  __mxOn!: any = (h: any) => h;\n  __mxOnAt = (h: any) => h;\n}",
        ),
      ),
    ).toEqual([]);
  });

  it("ignores a nested class that shadows the base name", () => {
    expect(
      invokerWarnings(
        component(
          `import { MxHandlers } from "${RT}";\nfunction f() { class Base extends MxHandlers {} return Base; }\nclass Base {}`,
          " extends Base {}",
        ),
      ),
    ).toHaveLength(1);
  });

  it("keeps the warning when the class file does not exist", () => {
    expect(invokerWarnings(undefined)).toHaveLength(1);
  });

  it("keeps the warning when the class file does not parse", () => {
    expect(invokerWarnings("export class {{{ @@")).toHaveLength(1);
  });

  it("keeps the warning when the file declares no component class", () => {
    expect(invokerWarnings("export const x = 1;")).toHaveLength(1);
  });

  it("emits no warning for a page that binds no handler", () => {
    expect(invokerWarnings("export class A {}", "<div>x</div>")).toEqual([]);
  });

  it("drops the header's paste advice when the class provides the invoker", () => {
    invokerWarnings(
      component(
        `import { MxHandlers } from "${RT}";`,
        " extends MxHandlers {}",
      ),
    );
    expect(readHtml()).not.toContain("Add to the component class");
  });
});

describe("inspectPageClass", () => {
  it("never throws on a directory or unreadable path", () => {
    expect(inspectPageClass(projectDir)).toEqual({ status: "unknown" });
    expect(inspectPageClass(join(projectDir, "nope.ts"))).toEqual({
      status: "unknown",
    });
  });
});
