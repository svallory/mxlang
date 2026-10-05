# parser — agent instructions

`packages/parser` holds only `src/template/`, the htmljs-parser-derived template
parser and its tests. It is private and has no build; the entry is
`src/template/index.ts`. The Babel fork is `packages/babel` and the bridge is
`packages/tsx-bridge`; neither depends on this package.
`@mxlang/babel` is a devDependency only for `src/template/mx-atoms.test.ts`,
which checks atom claims against Babel's `parseExpression`.

Biome **ignores** `src/template/` wholesale
(`packages/parser/src/template/{core,states,util,__tests__}`, plus
`index.ts` and `internal.ts`, in `biome.json`'s `files.includes`), to keep the
vendored copy byte-comparable with upstream. `biome check` on those paths
reports them as ignored and checks nothing, so "lint clean" is vacuous there:
match the repo's formatting by hand or via
`biome format --stdin-file-path=x.ts < <file>`.

`.pi-lens.json` at the repo root exempts `packages/parser/src/template/**` from
pi-lens's SAFETY-comment rule for `as unknown as`, for the same reason: the
directory is copied upstream source kept byte-identical except the two patched
state files and MX's own patches, so the rule asks every editor to change lines
that are outside their task and that upstream owns. The exemption was requested
by the repo's lead, who owns the tooling.
