import mx from "@mxlang/host-astro";
import { defineConfig } from "astro/config";

// `output: "static"` is Astro's default and is written out here only to make
// the point of the example explicit: every page is prerendered at build time,
// and an MX component never reaches a browser. The integration registers a
// renderer with no client entrypoint, so `client:*` on an MX component is
// Astro's own `NoClientEntrypoint` build error — `e2e/client-error.spec.ts`
// pins that.
export default defineConfig({
  output: "static",
  integrations: [mx()],
});
