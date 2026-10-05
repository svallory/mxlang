---
title: "ADR 145: the unnamed tag and `defaultTag`"
description: "Why `<#id>` and `<.class>` no longer hard-code `div`, how the name is resolved per target, host, package and parent contract, and what was rejected."
---

# ADR 145: the unnamed tag and `defaultTag`

**Status:** accepted 2026-10-04 (decision 145 and its two addenda in the decisions log). **Followed by:** ADR 146 (`:name`), ADR 147 (wildcard children).

## Context

Marko's parser writes `div` into the AST for a tag that has only a shorthand: `<#main>`, `<.card>`, concise `#main`. The literal lives in `@marko/compiler` (`tagName.value ||= "div"` in the parser) because Marko has one host and `div` is HTML's generic container. MX has many targets, including `data`, where `div` means nothing.

Seen as a language, the construct is "an unnamed tag carrying an id or class shorthand", and `div` is HTML's answer, not the language's. Someone has to resolve the name; the question was who.

## Decision

The unnamed tag is resolved through `defaultTag`, in this order:

1. the parent's contract: `defaultTag` declared alongside `children` (sidecar or `mx.contracts`), honoured only when the host permits per-tag override (a flag on the host descriptor; data permits, HTML-emitting hosts default to permit);
2. the package's user override, `package.json#mx.<target>.defaultTag`;
3. the host's optional override on its descriptor;
4. the target's built-in, required on every target descriptor: `div` for the html target (so every HTML-emitting host and every existing template is byte-identical), `object` for the data target.

`object` is a built-in tag of the data target: the anonymous node, carrying the shorthand's `id`/`class`, open contract, always known. It is never an unknown-tag error and needs no declaration. A closed parent `children` that lists neither `object` nor a `defaultTag` yields the ordinary E2 error.

`#x` still becomes `id="x"` and `.a.b` still becomes `class="a b"`, as in Marko. After resolution the tag is ordinary: the parent's closed `children`, its own `attributes` contract (`<.x>` under a tag whose closed attributes lack `class` is an E1 error), attribute tags and everything else apply unchanged.

From the user's point of view there is one error, at the declaration, never at the use site: an invalid `defaultTag` value, meaning a name that is not a builtin or a custom tag reachable from that package, or a builtin whose parse shape is not plain (`input`, `script`, `textarea`, `pre`).

## Why post-parse

Marko has no hook that fires before `div` is written: taglib `migrate`, `transform` and `parseOptions` all run after `onOpenTagName`. A pre-parse source rewrite was rejected: it shifts every span and cannot see the parent, which the resolution needs. The name node Marko leaves has an empty source span, which no named tag has; that is the reliable mark. Core detects it in lowering, where the parent chain is known, and asks a generic resolver; the ladder above lives in the registry and the targets, so core stays host-agnostic (no `div` literal in `@mxlang/core`). MX never runs Marko's translator, so the parser's `div` leaks nowhere; its only parse-time use is the parse options of `div`, which is why a `defaultTag` must be a plain-parsing tag.

## Alternatives considered

| option | rejected because |
|---|---|
| keep `div` everywhere | arbitrary on a data target; the choice belonged to HTML, not to the language |
| wildcard attribute tags (`<@title type="string"/>`) for named members | forces a parent to re-express a tag contract as attribute tags, which lack some tag capabilities; also what ADR 146 and 147 now cover properly |
| per-parent default only, no target/host/package levels | `<#x>` at the top of a data file would have had no answer; the ladder gives every position an answer |
| error when data has no configured default (an earlier draft) | replaced by the built-in `object` tag, so the shorthand always resolves |

## Consequences

- Divergence row: Marko always resolves the unnamed tag to `div`; MX resolves it by vocabulary.
- Target descriptors gain a required `defaultTag`; host descriptors an optional override and a permit flag; contracts a `defaultTag` key next to `children`; the registry refuses a target descriptor without one, third-party targets included.
- With ADR 146, `<:title type="string"/>` under `attributes` that declares `defaultTag: "attribute"` is `<attribute name="title" type="string"/>`.
