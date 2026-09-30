// Makes `dist/index.cjs`'s `module.exports` the plugin factory itself.
//
// tsserver loads a plugin with a plain `require()` and proceeds only when the
// result is a function (`Project.enableProxy`: "did not expose a proper factory
// function"); it never unwraps `.default`. `bun build --format cjs` exports the
// ES module namespace as an object, so tsserver skipped this plugin entirely.
// `Object.assign(factory, namespace)` keeps every export (`default`, which then
// points at the factory, and each named one) and adds no new one.
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

const ENTRY = path.resolve(import.meta.dirname, "../dist/index.cjs");
// The `typeof` guard is for loaders that evaluate the bundle under a shimmed
// `module` (vite-node, which `@mxlang/tsc`'s tests use): there `.default` is
// not the function and the assign would throw. Under Node, where tsserver runs,
// it always is, and src/cjs-factory.test.ts holds that.
const FOOTER = `
if (typeof module.exports.default === "function")
  module.exports = Object.assign(module.exports.default, module.exports);
`;

const code = readFileSync(ENTRY, "utf8");
if (!code.includes("module.exports")) {
  throw new Error(`${ENTRY} has no CJS module.exports to wrap`);
}
if (code.endsWith(FOOTER)) {
  throw new Error(`${ENTRY} already carries the factory footer`);
}
appendFileSync(ENTRY, FOOTER);
