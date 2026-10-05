---
title: "ADR 147: wildcard children and tag aliases"
description: "How a parent contract accepts unknown child tag names, validates them by another tag's contract, keeps the authored name as an alias in the IR, and why contracts stay declarative."
---

# ADR 147: wildcard children and tag aliases

**Status:** accepted 2026-10-04 (decision 147 in the decisions log; the IR alias and the "no code in contracts" rule were settled in the same discussion). **Depends on:** contract extension E2 (`children`), ADR 145 (`defaultTag`), ADR 146 (`:name`). **Implementation:** one core PR, one data/docs PR.

## Context

What happens to a tag name nobody declared:

- On the HTML-emitting targets, Marko's rule: a name that is neither a custom tag nor a builtin is a native element (`<foo>` renders `<foo>`; dashed names are custom elements). Never an error.
- On the data target, `unknownTags: "allow"` (the library default) passes it through with no contract; `"reject"` (what `mx-tsc` uses) is a positioned error with a suggestion. Independently, a parent whose `children` record is closed rejects it (E2).

A vocabulary often wants the middle ground: "any child name is fine here, and every one of them is an *attribute*". Writing

```marko
<attributes>
  <title type="string" required/>
  <body type="string"/>
</attributes>
```

should be legal under a parent that says so, with `title` and `body` checked exactly like `<attribute>`.

## Decision

`children` gains a `"*"` entry: one object or a list, first match in declaration order. Each entry has an optional `pattern` and either a `contract` reference or an inline contract:

```ts
children: {
  attribute: { ... },                                   // explicit entries win
  "*": [
    { pattern: "^[a-z][a-z0-9_]*$", contract: "attribute" },
    { pattern: "^on_(?<event>[a-z]+)$", contract: "hook" },
    { attributes: { ... } }                             // no pattern: catch-all, inline
  ]
}
```

- `pattern` is a JavaScript regex source matched against the whole tag name; MX anchors it, so authors never escape `^`/`$` in JSON. A name that matches no entry is a positioned error that lists the patterns and the explicit names.
- `contract: "<tag>"` validates the child with that tag's whole contract: attributes, attribute tags, children, `defaultTag`. Inline contracts have the same shape as any declaration.
- **The child keeps its authored tag name.** `<title>` is the tag `title` in the tree, checked like `attribute`. Only `<:title>` (ADR 146) produces `<attribute name="title">`.
- In the IR the tag's `name` is the resolved (canonical) contract tag and a new `alias` field carries the authored spelling, its span, and the pattern's named capture groups. Every existing consumer keys on `name`; the data tree exposes both (`tag: "title"`, `contract: "attribute"`).
- Explicit entries win over `"*"`. With a `"*"` present, matched children are not "unknown" for `unknownTags: "reject"`.
- "Unknown" is target-neutral: no builtin, no custom tag, no sidecar or `mx.contracts` entry. On an HTML-emitting target the wildcard can only fire inside a contract parent, so native elements outside one are untouched.
- Guard: a wildcard child whose name is within did-you-mean distance of an explicit child of the same parent gets a warning (an error under `mx-tsc`'s strict defaults).
- Registration errors: invalid regex; `contract` naming an unreachable tag; a reference the resolver cannot terminate.

## What the alias opens

The alias is cheap now and forces the canonical-versus-authored decision early. Doors it opens, in order of value:

1. **Names as data.** Capture groups make tag names a grammar: `^on_(?<event>[a-z]+)$` turns `<on_click>` into `hook` with `event: "click"`; likewise `^h(?<level>[1-6])$`, `^col-(?<span>\d+)$`. No new syntax, but the grammar lives in regexes, so diagnostics must print the match (`<on_click>` matched `hook` by `^on_…`).
2. **Keyed collections.** `<env><PORT>3000</PORT></env>` is `var` with alias `PORT`; the alias is the map key. Data targets get maps and records from plain nesting.
3. **Vocabulary evolution.** Renames become aliases with a deprecation warning; domain or localized spellings map to one canonical tag; migrations rewrite by alias.
4. **Target-neutral authored names.** The same authored name can resolve to a different canonical tag per target through each target's contracts, while core, diagnostics and the language server reason about one name.
5. **Opt-in bridge to ADR 146.** A contract may later declare `aliasAttribute: "name"`, making `<title>` and `<:title>` the same tree. Off by default: the alias is an IR fact, never a silent attribute.

## Alternatives considered

| option | rejected because |
|---|---|
| an `as` entry that *renames* the child (`<title>` becomes `<attribute name="title">`) | conflates tag names with the `name` attribute; two spellings produce one tree with no trace of which was written; ADR 146 already covers the explicit form |
| open `children` plus `unknownTags: "allow"` | no validation of the unknown children at all; the typo at the top of the file passes, which is the failure the tooling exists to prevent |
| a mapping function in the tag declaration | see below |
| keep the status quo (explicit `<attribute name=…>` everywhere) | the cost falls on every data vocabulary and every agent writing it; the sugar is where the language earns its keep |

## Why contracts stay declarative

A mapping or processing function in a tag declaration was considered and rejected. Contracts are read, diffed, documented and explained by the language server, `mx-tsc`, Vite, the data check and every target without executing anything. A function turns the declaration into a black box that must run inside every tool, in every target's process, deterministically, with positions preserved; the first vocabulary to use it loses did-you-mean, hover and "names must match …" messages. It would also be the first place core executes vocabulary code at compile time on hosts.

Processing already has a home by kind:

1. **Validation beyond the declarative set** (conditional required, one-of, cross-references): the sidecar `analyze` hook, which reports positioned errors and which `mx.contracts` modules can export.
2. **Tree rewriting** (synthesize attributes, reorder, turn `<on_click>` into something else): transform tags, the tag kind that exists for it and takes `children` contracts like any other tag. The rewrite is visible as a tag, not hidden in configuration.
3. **Semantics** (what `alias`, `groups` and `name` mean): the target consumer, for example Mesh's compiler reading the data tree. Core's job ends at a faithful, annotated tree.

When a need recurs across vocabularies, the answer is a declarative key (`aliasAttribute`, a groups-to-attributes mapping), never a hook.

## Consequences

- One identity per tag: `parents`, `children`, duplicate rules, did-you-mean and `unknownTags` key on the canonical name; the alias is never a second identity. Messages print both: `<title>` (as `attribute`).
- Contextual grammar is accepted here because it is per-vocabulary opt-in, in the same category as contracts, and never applies to native elements outside a contract parent.
- HTML-emitting targets receive the canonical name and ignore the alias unless a host opts in; every existing golden is byte-identical.
- Marko has no children contracts, so this is an mx-only extension of E2, recorded under E2's row in `divergences.md`.
