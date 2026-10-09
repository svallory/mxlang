---
packages: [core, tsc, typescript-plugin]
kind: Fixed
---
A host's `ambientTypes` is now asked through each root file's own lookup (the nearest `package.json` above the file, as every other host operation resolves it), then the tsconfig directory's, and its package files resolve from that file's directory first, so a package below a monorepo's root tsconfig, or one whose host is installed only beside its files, gets its ambient types. A host whose `ambientTypes` returns no iterable of files (a number, `undefined`, an object without an iterator, a string), or a generator that throws while read, is one `TS80004` error naming the package instead of a crash, in `mx-tsc` and the editor. `mx-tsc -w` reports a throwing host on every build while it throws, counted in that build's summary (the first build's summary no longer says "Found 0 errors" above it), and resets the exit code once a rebuild is clean.
