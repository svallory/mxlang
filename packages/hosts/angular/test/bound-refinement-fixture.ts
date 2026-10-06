import { compile } from "../src/index.ts";

// Run by `bound-refinement-render.test.ts` in a plain Bun process: the MX
// compiler needs Node's module resolution, which jsdom's environment replaces.
const sources = ["<div appPick v:fn:=q/>", "<div appPick v:=q/>"];
console.log(JSON.stringify(sources.map((s) => compile(s, "x.mx").code)));
