---
packages: [core, vite-plugin, targets]
kind: Changed
---
Each `mx()` Vite plugin instance now owns its tag-scan cache, so two instances in one process no longer share scan results or diagnostics. Core adds `createScanCache()` (a `ScanCache` with `scan`, `getCustomTags`, `clear`); the module-level `scanCached`, `getCustomTags` and `clearScanCache` stay as a shared default instance. `@mxlang/targets`' `scanCached` accepts an optional `cache`.
