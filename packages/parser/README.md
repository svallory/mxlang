# @mxlang/parser

The htmljs-parser-derived template parser (`src/template/`; provenance in
`src/template/PROVENANCE.md`). It is not used by `@mxlang/core` yet.

## The front-end handler contract

`src/frontend/parse.ts` (`FrontEnd`) implements the 28 handlers the template
parser can call — the 27 of htmljs-parser 5.18.0 plus MX's own `onAtom`
(decision 156). The contract, per handler: the event it serves, the payload
the parser hands it, and what the handler must do. The per-node detail (which
AST field each event lands in, and the exact splitting rules) is ast.md §7
(`apps/docs/docs/architecture/ast.md`); this section is the *calling*
contract.

| Handler | Payload | Handler's obligation |
|---|---|---|
| `onError` | `Error { code, message }` | Record the error as data (an `MxParseError` in `errors`); never throw. Ends the parse: no further event is delivered. |
| `onAtom` | `Value` (range: the whole atom, `value`: its name) | Push one `MxAtom` onto the enclosing container. |
| `onText` | `Range` | Push `MxText`; normalize exactly as Marko does, except in a preserving body. |
| `onPlaceholder` | `Placeholder { value, escape }` | Push `MxPlaceholder`, keeping `escape`. |
| `onComment` | `Value` | Push `MxComment`; the kind comes from the source text, as Marko's `getCommentKind`. |
| `onCDATA`, `onDeclaration`, `onDoctype` | `Value` | Push the corresponding value node (`MxCDATA` / `MxDeclaration` / `MxDoctype`) with `value` and `valueSpan`. |
| `onScriptlet` | `Scriptlet { value, block }` | Push `MxScriptlet`, keeping `block`. |
| `onOpenTagStart` | `Range` | Remember the `<` offset; a concise tag has none. |
| `onOpenTagName` | `Template` | **The one exception to fire-and-forget — see below.** |
| `onTagShorthandId` / `onTagShorthandClass` | `Template` | Append an `MxShorthand` (`position: "tag"`), splitting the value per ast.md §3.6. |
| `onTagTypeArgs` / `onTagVar` / `onTagArgs` / `onTagTypeParams` / `onTagParams` | `Value` | Attach the part to the current tag under its field (`typeArgs`, `var`, `args`, `typeParams`, `params`). |
| `onAttrName` | `Range` | Open a new attribute (`name` + `nameSpan`); a `#x`/`.x`/`:x` name is a shorthand (`position: "attribute"`); an empty range is the default-value slot (`name: null`). |
| `onAttrArgs` | `Value` | Attach `args` to the last-open attribute. |
| `onAttrValue` | `AttrValue { value, bound }` | Attach `value` and `operator` to the last-open attribute (or the shorthand's `default`). |
| `onAttrMethod` | `AttrMethod { params, body, typeParams, async }` | Build the `MxMethod` value and extend the attribute's span. |
| `onAttrSpread` | `Value` | Push `MxSpreadAttribute`. |
| `onOpenTagComment` | `Value` | Push an `MxComment` into the open tag's attributes. |
| `onOpenTagEnd` | `OpenTagEnd { selfClosed }` | Close the open tag; record `selfClosed`. A preserving body may start here. |
| `onCloseTagStart` / `onCloseTagName` / `onCloseTagEnd` | `Range` | Close the tag: record `closeTag`, the written close name (never re-checked against the open name — the parser reports `MISMATCHED_CLOSING_TAG` itself), and the tag's end. `</>` arrives as an empty range (`name: null`). |

**Fire-and-forget.** Every handler is called for its side effect on the tree
being built, and the parser discards every return value — with exactly one
exception. A handler must never throw on well-formed input for its event; a
malformed input surfaces as an `onError` event, not an exception, and the
front end turns everything (template-parser errors, internal failures,
throws out of the parser itself) into entries of `parse()`'s `errors` with
the partial tree.

**The exception: `onOpenTagName`.** It is the only handler whose return value
the template parser consumes: it returns the `TagTypeValue` that tells the
parser how to lex the tag's body (`text`, `void`, `statement`, …). The front
end computes it from the written name and its `tagShape(name)` input. This is
the seam decision 183 schedules to disappear: the type will come from a
`tagTypes` table the parser consults directly by tag name, making
`onOpenTagName` fire-and-forget like every other handler. Until then, any
new front end must keep the return-value contract for this one handler.

The Babel fork that used to live here is `@mxlang/babel` (`packages/babel`) and
the MX-in-TypeScript bridge is `@mxlang/tsx-bridge` (`packages/tsx-bridge`);
see decision 158.
