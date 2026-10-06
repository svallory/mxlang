import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "./index.ts";

/**
 * A `.marko` file is not an MX input (decision 172): a tag Marko's lookup
 * resolves to one is a single positioned error naming the file and saying to
 * convert it to `.mx`, whatever the shape, and never an emitted import.
 */
const root = mkdtempSync(join(tmpdir(), "mxlang-html-marko-tags-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function write(rel: string, source: string): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  return path;
}

function emit(dir: string, page: string): string {
  return compile(page, join(root, dir, "page.mx")).code;
}

const MARKO = "<i>${input.label}</i>";
const one = (message: string) => expect.objectContaining({ message });

describe("a .marko tag is one error", () => {
  test("tags/x.marko", () => {
    write("flat/tags/badge.marko", MARKO);
    expect(() => emit("flat", '<div>\n  <badge label="a"/>\n</div>')).toThrow(
      expect.objectContaining({
        message:
          "`<badge>` resolves to `tags/badge.marko`, a `.marko` file, and MX does not compile `.marko` files. Convert it to `.mx` (`tags/badge.mx`).",
        line: 2,
      }),
    );
  });

  test("tags/x/index.marko", () => {
    write("dir/tags/im/index.marko", MARKO);
    expect(() => emit("dir", "<im/>")).toThrow(
      one(
        "`<im>` resolves to `tags/im/index.marko`, a `.marko` file, and MX does not compile `.marko` files. Convert it to `.mx` (`tags/im/index.mx`).",
      ),
    );
  });

  test("a hyphenated tag, and a tag from a parent directory", () => {
    write("par/tags/fancy-btn.marko", MARKO);
    expect(() =>
      compile("<fancy-btn/>", join(root, "par", "sub", "page.mx")),
    ).toThrow("`<fancy-btn>` resolves to `../tags/fancy-btn.marko`");
  });

  test("an authored import of a .marko file used as a tag", () => {
    write("imp/panel.marko", MARKO);
    expect(() =>
      emit("imp", 'import Panel from "./panel.marko"\n<Panel/>'),
    ).toThrow("`<Panel>` resolves to `panel.marko`, a `.marko` file");
  });

  test("a .marko import used as a direct dynamic tag is the same error", () => {
    write("dyn/panel.marko", MARKO);
    expect(() =>
      emit(
        "dyn",
        'import Panel from "./panel.marko"\n<div>\n  <${Panel}/>\n</div>',
      ),
    ).toThrow(
      expect.objectContaining({
        message: expect.stringContaining(
          "`<${Panel}>` resolves to `panel.marko`",
        ),
        line: 3,
      }),
    );
  });

  test("an unused .marko import and an indirect dynamic use stay clean", () => {
    write("ind/panel.marko", MARKO);
    expect(() =>
      emit("ind", 'import Panel from "./panel.marko"\n<div>hi</div>'),
    ).not.toThrow();
    expect(() =>
      emit(
        "ind",
        'import Panel from "./panel.marko"\nstatic const P = Panel\n<div><${P}/></div>',
      ),
    ).not.toThrow();
  });

  test("tags/x/x.marko and a renderer-only taglib tag are errors, never imports", () => {
    write("xx/tags/x/x.marko", MARKO);
    expect(() => emit("xx", "<x/>")).toThrow("resolves to `tags/x/x.marko`");
    write("rend/package.json", "{}");
    write("rend/marko.json", JSON.stringify({ "<x>": { renderer: "./x.js" } }));
    write("rend/x.js", "module.exports = () => {}");
    expect(() => emit("rend", "<x/>")).toThrow("no template");
  });

  test("never emits an import of a .marko file", () => {
    write("ok/tags/other.mx", "<b/>");
    const code = emit("ok", "<div>hi</div>");
    expect(code).not.toContain(".marko");
  });
});

describe("tags/<name>/index.mx", () => {
  test("is a positioned error, not a call to an unbound name", () => {
    write("idx/tags/ix/index.mx", "<i/>");
    expect(() => emit("idx", "<div>\n  <ix/>\n</div>")).toThrow(
      expect.objectContaining({
        message: expect.stringContaining("matches `tags/ix/index.mx`"),
        line: 2,
      }),
    );
  });
});

/**
 * A tag a `marko.json` maps to an `.mx` template is imported the way Marko
 * imports a discovered tag: a default import, extension kept, the path
 * relative to the page, named `_` plus the camelCased tag name (numeric suffix
 * on a collision), once per module.
 */
describe("marko.json tags with an .mx template", () => {
  write(
    "mj/marko.json",
    JSON.stringify({
      "<badge>": { template: "./impl/badge.mx" },
      "<fancy-btn>": { template: "./impl/fancy-btn.mx" },
    }),
  );
  write("mj/package.json", "{}");
  write("mj/impl/badge.mx", "<i>${input.label}</i>");
  write("mj/impl/fancy-btn.mx", "<b>${input.label}</b>");
  const page = (name: string, source: string) =>
    compile(source, join(root, "mj", name)).code;

  test("default import, extension kept, relative to the page", () => {
    const code = page("page.mx", '<badge label="a"/>');
    expect(code).toContain('import _badge from "./impl/badge.mx"');
    expect(code).toContain("_badge.render({");
  });

  test("a hyphenated tag gets a camelCased identifier", () => {
    const code = page("page.mx", '<fancy-btn label="a"/>');
    expect(code).toContain('import _fancyBtn from "./impl/fancy-btn.mx"');
    expect(code).toContain("_fancyBtn.render({");
  });

  test("a tag called twice is imported once", () => {
    const code = page("page.mx", '<badge label="a"/><badge label="b"/>');
    expect(code.match(/impl\/badge\.mx/g)).toHaveLength(1);
    expect(code.match(/_badge\.render\(/g)).toHaveLength(2);
  });

  test("an identifier already in the source is not reused", () => {
    const code = page("page.mx", '<badge label="a"/>${"_badge"}');
    expect(code).toContain('import _badge2 from "./impl/badge.mx"');
  });

  test("the path is relative to the page from a nested directory", () => {
    mkdirSync(join(root, "mj", "sub", "deep"), { recursive: true });
    const code = page("sub/deep/page.mx", '<badge label="a"/>');
    expect(code).toContain('import _badge from "../../impl/badge.mx"');
  });
});
