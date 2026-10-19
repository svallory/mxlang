---
packages: [tsc]
kind: Fixed
---

`mx-tsc` now runs under Bun as well as Node. Volar's `runTsc` installs its patches by monkey-patching `fs.readFileSync` around a `require` of TypeScript's `tsc.js`; Bun's CommonJS loader reads module sources natively, so the patch never fired and the stock `tsc.js` ran — a `.mx`-only project failed with `TS18003: No inputs were found in config file`, and a `.mx` beside a `.ts` was silently never loaded. `mx-tsc` now applies Volar's own `transformTscContent` to the source and evaluates the result itself, the same on both runtimes.
