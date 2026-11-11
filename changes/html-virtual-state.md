---
packages: [html]
kind: Fixed
---
`mx()` and `loadMx()` no longer depend on what ran before them in the process: the virtual-module version counter, module text, URL map and compile caches belong to a loader instance (`createLoader()` in `helpers.ts`, one default instance behind the exported `mx`/`loadMx`), and each `mx-virtual:` URL carries its loader's process-unique id (`#i<id>v<n>`). The Node hook is still registered once per process and finds the owning loader through one registry on `globalThis`, so a second copy of the module no longer restarts at `#v0` and collides in the runtime's module cache.
