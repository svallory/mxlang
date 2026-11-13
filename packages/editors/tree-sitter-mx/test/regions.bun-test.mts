// MX's own: the region host grammars (`.solid.mx`, `.ng.mx`, `.react.mx`,
// `.preact.mx`, `.hono.mx`, all on packages/editors/tree-sitter-solid) give an
// MX region one opaque `mx_element` token, and the Zed extension injects the
// `MX` language into it (packages/editors/zed/base/*/injections.scm). Zed
// then parses the region's text alone with this grammar, so each region must
// parse on its own: one top-level element, no ERROR or MISSING node.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMx } from "../__tests__/util/language.mts";

const REGIONS: [string, string][] = [
  [
    "name sugars in attribute position",
    `<input type="email" :email #main .big/>`,
  ],
  ["tag shorthand and a placeholder", "<div.card>${x}</div>"],
  ["nested control flow", "<if=a><b/></if>"],
  // Copied from packages/editors/tree-sitter-solid/fixtures/control-flow/input.solid.mx.
  [
    "solid fixture: control flow",
    `<div>
      <if=user()><p>\${user().name}</p></if>
      <else if=loading()><Spin/></else>
      <else><Login/></else>
      <for|item, i| of=items()><li>\${item().name}</li></for>
      <for|item, i| of=items() by="id"><li>\${item().name}</li></for>
      <for|i| from=0 to=10><span>\${i}</span></for>
      <for|k, v| in=obj()><p>\${k}=\${v()}</p></for>
      <try>
        <@placeholder>Loading</@placeholder>
        <@catch|e, reset|>Error: \${e}</@catch>
      </try>
    </div>`,
  ],
  // Copied from packages/editors/tree-sitter-solid/fixtures/attributes/input.solid.mx.
  [
    "solid fixture: attributes",
    `<div
      id="panel"
      data-count=color()
      disabled
      ...props.extra
      class={active: active()}
      style={color: color()}
      ref=el
      onScroll(_e) { setActive(true) }
      prop:value=color()
      a="q>q"
      b=x/2
    >
      <p.badge.big#lead class={on: active()}>shorthand</p>
      <Card title="x"/>
      <button onClick() { return <em>nested</em> }>click</button>
    </div>`,
  ],
];

describe("an MX region parses on its own", () => {
  for (const [name, source] of REGIONS) {
    it(name, () => {
      const tree = parseMx(source);
      if (!tree) throw new Error("parse timed out");
      const root = tree.rootNode;
      assert.ok(!root.hasError, root.toString());
      assert.deepStrictEqual(
        root.namedChildren.map((n) => n?.type),
        ["element"],
        root.toString(),
      );
      tree.delete();
    });
  }
});

describe("the Zed region hosts inject MX", () => {
  // packages/editors/zed/languages, beside this package.
  const EDITORS = path.dirname(
    path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  );
  const LANGUAGES = path.join(EDITORS, "zed", "languages");
  const read = (...parts: string[]) =>
    fs.readFileSync(path.join(LANGUAGES, ...parts), "utf8");

  // Zed resolves an injection by language name, so "MX" must be the name of
  // the extension's own MX language.
  it('languages/mx/config.toml names the language "MX"', () => {
    const name = read("mx", "config.toml").match(/^name\s*=\s*"([^"]*)"/m);
    assert.strictEqual(name?.[1], "MX");
  });

  for (const host of ["solid", "ngmx", "reactmx", "preactmx", "honomx"]) {
    it(`languages/${host}/injections.scm injects MX into mx_element`, () => {
      const scm = read(host, "injections.scm");
      assert.match(
        scm,
        /\(\(mx_element\) @injection\.content\s*\(#set! injection\.language "MX"\)\)/,
      );
      // The positive match allows a second, Marko injection beside it.
      assert.ok(!scm.includes('injection.language "marko"'), scm);
    });
  }
});
