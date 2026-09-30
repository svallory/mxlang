# @mxlang/angular-checker

## Unreleased

### Fixed

- **`typescript` is a declared peer dependency** (`>=5.9.0 <7`, the repo's peer policy): `dist/*.d.ts` imports `typescript` but the package declared only `@angular/compiler-cli`, so a strict consumer got `TS2307`. Caught by `scripts/pack-hygiene.test.ts` after the checker's declarations started referencing the TypeScript API.
- **The tarball ships no `.d.ts.map` files** (pkg-types-g10): `tsconfig.build.json` turns `declarationMap` off (the maps pointed at unpublished `../src/*.ts`) and excludes `src/**/fixtures/**`.
