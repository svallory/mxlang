---
packages: [tsc, typescript-plugin, language-server, vite-plugin]
kind: Changed
---
Errors and warnings in `.mx` files now show MX's own code where they showed `TS80001` (for a `.solid.mx` region error or an `.astro.mx` lowering error, which carry no code, `TS80001` remains): `mx-tsc` prints `page.mx(1,6): error MX_PARSE_MISMATCHED_CLOSING_TAG: …` where it printed `page.mx(1,6): error TS80001: …`, the TypeScript plugin gives the code in place of `80001`, and the language server sets `code`. `TS80001` and `TS80002` remain for an error or warning that has no code. If a script matches `error TS80001` in `mx-tsc` output, match `error MX_` as well.

The tools also paint the range a diagnostic covers, not one character. The editor (the language server and the TypeScript plugin) underlines the whole `<name` of a tag, the whole attribute, or the whole expression a diagnostic blames, in `.mx` and dialect files alike (except the region errors named above, which still underline one character). A diagnostic without a range, and a parse error at a single point, still underline one character. The Vite plugin's error overlay and build log draw a run of carets under that range in the code frame, to the end of the line when the range runs on.
