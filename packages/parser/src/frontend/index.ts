/**
 * The MX front end's module surface. Internal until PR 3: the package index
 * (`src/template/index.ts`) does not re-export it and `package.json` has no
 * subpath for it (`frontend/exposure.test.ts` pins both).
 */
export { lineColumnAt } from "./line-column.ts";
export { type ParseOptions, parse } from "./parse.ts";
