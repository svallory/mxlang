# Releasing an alpha of `@mxlang/core` and `@mxlang/data`

Decision 143. Two packages ship under the `@mxlang` npm scope with dist-tag
`alpha`: `@mxlang/core` first, then `@mxlang/data`. `@mxlang/data` pins
`@mxlang/core` to the exact same version, so the two are always bumped and
published together, core first. Nothing else is published (hosts, tooling and
`target-registry` stay private).

Everything below runs from the repo root of a clean checkout of `main`.

## 1. Prepare

```sh
git checkout main && git pull --ff-only
git status --short            # must print nothing
bun install --frozen-lockfile
bun run build                 # core first, then data, then the rest
```

Check the login and the scope:

```sh
npm whoami                    # your npm user
npm org ls mxlang             # you are an owner of the @mxlang org
```

`bun publish` reads the same `~/.npmrc` token. If the account has 2FA, add
`--otp=<code>` to each `bun publish` below (the code lasts about 30 s, so
publish the two packages with two fresh codes).

## 2. Pack and inspect (nothing is published)

```sh
(cd packages/core && bun pm pack --dry-run)
(cd packages/targets/data && bun pm pack --dry-run)
bun run scripts/alpha-probe.ts
```

`scripts/alpha-probe.ts` packs both with `bun pm pack`, fails unless the data
tarball's `@mxlang/core` is core's exact version (not `workspace:*`), installs
the two tarballs into a fresh temp project with npm (run by Node) and with
Bun, and runs a `parseData` probe. It must print `[alpha-probe] PASS`.

To look at the manifest that would ship:

```sh
mkdir -p "${TMPDIR:-/tmp}/alpha-tarballs"
(cd packages/targets/data && bun pm pack --destination "${TMPDIR:-/tmp}/alpha-tarballs")
tar -xzOf "${TMPDIR:-/tmp}"/alpha-tarballs/mxlang-data-*.tgz package/package.json | grep -A4 '"dependencies"'
# "@mxlang/core": "0.1.0-alpha.1"   <- not "workspace:*"
```

Use `bun publish`, never `npm publish`, from the package directories: npm does
not rewrite `workspace:*` and would ship a data tarball that cannot install.

## 3. Publish: core, then data

Dry-run first (it prints the files and the tag and sends nothing):

```sh
(cd packages/core && bun publish --tag alpha --access public --dry-run)
(cd packages/targets/data && bun publish --tag alpha --access public --dry-run)
```

Then for real, in this order:

```sh
(cd packages/core && bun publish --tag alpha --access public)
(cd packages/targets/data && bun publish --tag alpha --access public)
```

`--tag alpha` keeps `latest` off the prerelease. Without it `bun publish`
tags `latest`.

## 4. Verify

```sh
npm view @mxlang/core@alpha version         # 0.1.0-alpha.1
npm view @mxlang/data@alpha version         # 0.1.0-alpha.1
npm view @mxlang/data@alpha dependencies    # @mxlang/core: 0.1.0-alpha.1
npm view @mxlang/core dist-tags
npm view @mxlang/data dist-tags
```

Look at the dist-tags output: `alpha` must point at the new version. On the
very first publish of a package the registry may also set `latest` to it; that
is the registry's behaviour, not something these commands control. Whether to
remove it (`npm dist-tag rm @mxlang/core latest`) is your call.

Then prove an install from the registry, in a throwaway directory outside the
repo:

```sh
cd "$(mktemp -d)" && bun init -y >/dev/null && bun add @mxlang/core@alpha @mxlang/data@alpha
bun -e 'import { parseData } from "@mxlang/data"; console.log(parseData("<a/>\n", "/x.mx").tree?.children.length)'   # 1
```

## 5. Bump to the next alpha (`alpha.N`)

A version is published once and never reused. For `0.1.0-alpha.2`:

1. Set `"version": "0.1.0-alpha.2"` in `packages/core/package.json` and
   `packages/targets/data/package.json`.
2. Set the same version on the two workspace entries in `bun.lock`
   (`"packages/core"` and `"packages/targets/data"`, each has a `"version"`
   line). **This is required**: `bun pm pack` and `bun publish` rewrite
   `workspace:*` to the version recorded in `bun.lock`, and `bun install` does
   not refresh it. Skipping it ships `"@mxlang/core": "0.1.0-alpha.1"` in the
   new data tarball.
3. Add a `## 0.1.0-alpha.2` entry above the previous one in
   `packages/core/CHANGELOG.md` and `packages/targets/data/CHANGELOG.md`.
4. `bun install --frozen-lockfile && bun run build`, commit
   (`chore(core,data): release 0.1.0-alpha.2`), then repeat sections 2 to 4.

Check step 2 before publishing; this must print `0.1.0-alpha.2`:

```sh
tar -xzOf "$(cd packages/targets/data && bun pm pack --destination "${TMPDIR:-/tmp}/alpha-tarballs" --quiet)" package/package.json | grep '"@mxlang/core"'
```

## 6. What Mesh installs

```sh
bun add @mxlang/core@alpha @mxlang/data@alpha
```

Mesh pins both to the same alpha (data requires core's exact version). The API
is unstable at `0.1.0-alpha.N`; expect breaking changes between alphas.

## If a publish goes wrong

- Core published, data failed: fix the cause and publish data alone with the
  same command. Do not re-publish core.
- A bad version: `npm deprecate @mxlang/data@0.1.0-alpha.1 "<reason>"` and
  publish `alpha.2`. `npm unpublish` is only allowed for 72 hours after
  publishing and only while nothing depends on the version.
