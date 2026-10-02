import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("keeps the warning when the base is imported from elsewhere (cannot be seen)", () => {
    expect(
      invokerWarnings(
        component('import { Base } from "./base";', " extends Base {}"),
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
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const html = readFileSync(join(projectDir, "src/page.html"), "utf8");
    expect(html).not.toContain("Add to the component class");
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
