import { compile } from "../src/index.ts";

// Run by `bound-refinement-render.test.ts` in a plain Bun process: the MX
// compiler needs Node's module resolution, which jsdom's environment replaces.
const sources = JSON.parse(process.argv[2] ?? "[]") as string[];
console.log(JSON.stringify(sources.map((s) => compile(s, "x.mx").code)));
