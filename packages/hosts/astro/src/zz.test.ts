import { it } from "vitest";
import { lowerAstroMx } from "./astro-template.ts";
it("m", () => {
  try { console.log("MEASURE astro-template: " + lowerAstroMx('---\n---\n<sl-card class="a">x</sl-card>', "/tmp/zz/a.astro.mx").code.slice(0, 160)); } catch (e) { console.log("MEASURE astro-template ERR " + (e as Error).message.split("\n")[0].slice(0, 140)); }
});
