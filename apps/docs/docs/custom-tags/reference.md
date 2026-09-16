---
title: "Custom-tag reference"
description: "The exported TypeScript contract, limits, errors, and warnings."
---

# Custom-tag reference

The declarations below reproduce the exported custom-tag types from `@mxlang/core`'s `custom-tags.ts`. Referenced IR types (`Attr`, `AttributeTag`, `Block`, `Expr`, `ForSource`, `IrNode`, and `Position`) are also exported by `@mxlang/core`.

```ts
export interface CustomTagParseOptions {
  text?: boolean;
  preserveWhitespace?: boolean;
  openTagOnly?: boolean;
}

export interface CustomTagAttribute {
  type?: "string" | "number" | "boolean" | "expression";
  required?: boolean;
  enum?: string[];
  default?: unknown;
  literalOnly?: boolean;
}

export interface CustomTagAttributeTag {
  repeatable?: boolean;
  required?: boolean;
}

export interface TagStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}

export interface AnalyzeContext {
  store: TagStore;
  fail(message: string, at?: Position): never;
}

export interface FinalizeContext {
  store: TagStore;
  build: IrBuilders;
  gensym(hint?: string): string;
}

export interface TagCall {
  name: string;
  loc: Position;
  attrs: Attr[];
  content: Block | null;
  attributeTags: AttributeTag[];
  params: string[];
  var: string | null;
}

export interface TransformContext {
  build: IrBuilders;
  gensym(hint?: string): string;
  fail(message: string, at?: Position): never;
  hoist(code: string): void;
  store: TagStore;
}

export interface CustomTag {
  parseOptions?: CustomTagParseOptions;
  attributes?: Record<string, CustomTagAttribute>;
  attributeTags?: Record<string, CustomTagAttributeTag>;
  analyze?(calls: readonly TagCall[], ctx: AnalyzeContext): void;
  transform?(call: TagCall, ctx: TransformContext): IrNode[];
  finalize?(ctx: FinalizeContext): IrNode[];
}

export interface IrBuilders {
  text(value: string): IrNode;
  interpolation(expr: Expr, escaped?: boolean): IrNode;
  element(
    name: string,
    attrs?: Attr[],
    children?: IrNode[],
    options?: { void?: boolean },
  ): IrNode;
  attr(name: string, value: string): Attr;
  dynamicAttr(name: string, value: Expr): Attr;
  booleanAttr(name: string): Attr;
  expr(code: string): Expr;
  ifChain(
    branches: Array<{ condition: Expr | null; children: IrNode[] }>,
  ): IrNode;
  forLoop(options: {
    source: ForSource;
    params: string[];
    bindings?: string[];
    key?: Expr | null;
    children: IrNode[];
  }): IrNode;
  block(children: IrNode[], params?: string[]): Block;
  hostTag(
    name: string,
    children: IrNode[],
    attributeTags: AttributeTag[],
  ): IrNode;
  template(call: TagCall): IrNode[];
}
```

The exported limits are `MAX_EXPANSION_DEPTH = 64` nested calls and `MAX_EXPANSION_NODES = 100_000` nodes from one transform or finalize result.

## Member guide

### `CustomTag`

| Member | Meaning |
| --- | --- |
| `parseOptions` | Static parser behavior that discovery reads before parsing the caller. |
| `attributes` | Closed attribute contract, validated before hooks; omit it to leave attributes open. |
| `attributeTags` | Closed `<@name>` contract with required/repeatable controls. |
| `analyze` | Non-mutating pass over every call of this tag in one file, before transforms. |
| `transform` | Expands one validated call into ordinary IR; optional only when a template exists. |
| `finalize` | Adds nodes once per file after expansion; returned nodes are prepended. |

### Parse and declaration members

| Member | Meaning |
| --- | --- |
| `text` | Parses the body as one unparsed text node. |
| `preserveWhitespace` | Keeps body whitespace. |
| `openTagOnly` | Forbids a body and closing tag. |
| `type` | Checks a scalar literal type, or requires expression syntax. |
| `required` | Requires the attribute or attribute tag. |
| `enum` | Restricts an attribute to listed string literals. |
| `default` | Supplies an omitted string, number, or boolean attribute after validation. |
| `literalOnly` | Requires a compile-time scalar, array, or object literal. |
| `repeatable` | Allows an attribute tag name to appear more than once. |

### `TagCall`

| Member | Meaning |
| --- | --- |
| `name` | Tag name as written at the call. |
| `loc` | Call-site position. |
| `attrs` | Resolved attributes in source order, with defaults appended. |
| `content` | Ordinary body block, or `null`. |
| `attributeTags` | Resolved named blocks; repeated entries remain separate. |
| `params` | Tag parameter source text. |
| `var` | `/var` binding source text, or `null`. |

### Contexts and store

| Member | Meaning |
| --- | --- |
| `build` | Position-aware constructors for the IR available in that phase. |
| `gensym` | Produces a hygienic file-unique binding, optionally using a hint. |
| `fail` | Creates a positioned `TranslateError`; always write `throw ctx.fail(...)`. |
| `hoist` | Moves code to the head of the nearest enclosing function. |
| `store` | Private per-tag, per-file state shared by `analyze`, `transform`, and `finalize`. |
| `get` | Reads one typed store key. |
| `set` | Writes one store key. |

### Builders

| Member | Meaning |
| --- | --- |
| `text` | Creates literal text. |
| `interpolation` | Creates escaped interpolation by default; `false` requests raw output. |
| `element` | Creates an element, optionally marked void. |
| `attr` | Creates a static string attribute. |
| `dynamicAttr` | Creates an expression-valued attribute. |
| `booleanAttr` | Creates a valueless boolean attribute. |
| `expr` | Parses expression source into an `Expr`. |
| `ifChain` | Creates ordered conditional/fallback branches. |
| `forLoop` | Creates an IR loop with source, params, bindings, key, and children. |
| `block` | Creates a child block and its optional params. |
| `hostTag` | Requests a primitive by name from the active host. |
| `template` | Expands this tag's adjacent L1 template with the supplied call. |

## Positioned errors

Messages begin with the relevant tag name unless the problem belongs to a discovery file. Dynamic values such as names, paths, counts, expected types, and thrown messages are inserted into the forms below.

### Registration and phase errors

| Trigger | Diagnostic form |
| --- | --- |
| A registration uses a core-owned name such as `try`. | `` `<name>` is a core-owned custom tag and cannot be shadowed by a registered custom tag of the same name `` |
| An `attributes`/`attributeTags` declaration has an unknown key (e.g. the retired `staticOnly`/`repeated`). | `Unknown key "KEY" in the "NAME" attribute declaration of tag "TAG"; allowed: …` |
| A definition declares only `finalize`. | `` `<name>`: a custom tag that defines only `finalize` has no call site and nothing to collect… `` |
| A called tag has neither a transform nor a template. | `` `<name>`: custom tag has neither a `transform` nor a template file… `` |
| Nested custom-tag calls exceed 64. | `` `<name>`: custom tag expansion exceeded 64 nested invocations `` |
| A transform does not return an array. | `` `<name>`: custom tag must return an array of IR nodes `` |
| A transform returns more than 100,000 nodes. | `` `<name>`: custom tag expansion produced N nodes, over the 100000 limit `` |
| `finalize` does not return an array. | `` `<name>`: `finalize` must return an array of IR nodes `` |
| `finalize` returns more than 100,000 nodes. | `` `<name>`: `finalize` produced N nodes, over the 100000 limit `` |
| `analyze` or `finalize` throws something other than `TranslateError`. | `` `<name>`: custom tag `<hook>` threw: message `` |
| `transform` throws something other than `TranslateError`. | `` `<name>`: custom tag threw: message `` |

### Attribute errors

| Trigger | Diagnostic form |
| --- | --- |
| A tag declaring `attributes: {}` receives any named or spread attribute. | `` `<name>`: accepts no attributes `` |
| A closed non-empty contract receives a spread. | `` `<name>`: spread attributes cannot be checked against this tag's declared attributes `` |
| An undeclared named attribute is present. | `` `<name>`: unknown attribute `x` `` |
| A `literalOnly` value is not compile-time static. | `` `<name>`: attribute `x` must be a literal `` |
| A scalar literal has the wrong declared type. | `` `<name>`: attribute `x` must be TYPE, got TYPE `` |
| `type: "expression"` receives static-string or valueless syntax. | `` `<name>`: attribute `x` must be an expression `` |
| An enum receives a non-literal expression. | `` `<name>`: attribute `x` must be a static value from … `` |
| An enum receives a non-string literal. | `` `<name>`: attribute `x` must be a string from …, got TYPE `` |
| An enum string is not a member. | `` `<name>`: attribute `x` must be one of …, got VALUE `` |
| A required attribute is absent. | `` `<name>`: missing required attribute `x` `` |
| A declared default is not a string, number, or boolean. | `` `<name>`: attribute `x` declares a `default` that … has no attribute spelling `` |

### Attribute-tag errors

| Trigger | Diagnostic form |
| --- | --- |
| A closed contract receives an undeclared attribute tag. | `` `<name>`: unknown attribute tag `<@x>` `` |
| A name repeats without `repeatable: true`. | `` `<name>`: attribute tag `<@x>` may not be repeated `` |
| A required attribute tag is absent. | `` `<name>`: missing required attribute tag `<@x>` `` |

### Builder boundary errors

| Trigger | Diagnostic form |
| --- | --- |
| `hostTag` is called from `finalize`. | `` `<name>`: `ctx.build.hostTag` is not available in `finalize` `` |
| The active host does not claim a requested primitive. | `` `<name>`: this host does not claim `<primitive>`, so a custom tag cannot emit one `` |
| `template` is called from `finalize`. | `` `<name>`: `ctx.build.template` is not available in `finalize` `` |
| `template(call)` is used without an adjacent template file. | `` `<name>`: this tag has no template file… `` |

### Template errors

| Trigger | Diagnostic form |
| --- | --- |
| Template calls form a cycle. | `` `<name>`: custom tag templates form a cycle: a.mx -> b.mx -> a.mx `` |
| A template call uses a spread attribute. | `` `<name>`: a spread attribute cannot be passed to a tag template… `` |
| A template call supplies the `content` attribute. | `` `<name>`: `content` is reserved on a template tag; it names the body slot `` |
| A template uses bare/optional/destructured/spread `input`. | `` `<name>`: `input` can only be read as `input.<name>` inside a tag template `` |
| A template import reuses a local name for a different module. | `` `<name>`: tag template `FILE` imports `BINDING` from a different module than … already did… `` |
| Lowering the template itself fails. | The underlying positioned compiler message, annotated with the template's file. |

### Discovery and sidecar errors

| Trigger | Diagnostic form |
| --- | --- |
| `mx.tags` is neither a string nor the documented array shape. | A positioned manifest error describing the required shape. |
| An entry lacks string `dir`, has non-string `prefix`, or has non-string-array `hosts`. | A positioned manifest error naming the exact entry/member. |
| `parseOptions` is not a plain object, uses an unknown key, a non-boolean value, spread, or computed key. | A positioned sidecar/manifest error naming the exact option or unreadable shape. |
| A sidecar cannot be parsed. | `FILE: could not be parsed: message` |
| A sidecar throws while loading. | `FILE: sidecar failed to load: message`, with a top-level-await or explicit-extension hint when recognized. |
| A sidecar's default export is not an object. | ``FILE: sidecar must `export default` a CustomTag object`` |
| A non-dot tag filename has an unusable basename. | `FILE: NAME is not a usable tag name…` |
| A scanned `.solid.mx` is mistaken for a tag template. | `FILE: tag templates are .mx; .solid.mx is not supported as a tag` |

## Warnings and non-fatal diagnostics

| Trigger | Warning form |
| --- | --- |
| A real transform receives attribute tags but never reads `call.attributeTags`. | `` `<name>`: custom tag transform did not read its attributeTags; authored attribute tags were dropped `` |
| An L1 caller supplies a body but the template has no content placeholder. | `` `<name>`: body content was dropped; FILE has no `<${input.content}/>` placeholder `` |
| An L1 caller supplies `<@x>` but the template has no matching placeholder. | `` `<name>`: `<@x>` was dropped; FILE has no `<${input.x.content}/>` placeholder `` |
| `mx.tags` names a missing directory. | `` `mx.tags` names a directory that does not exist: PATH `` |
| A tag file tries to redefine a core-owned name. | `` `<name>` is a core-owned custom tag and cannot be redefined by a tag file; rename this file `` |

The last two are scanner diagnostics: the bad entry is skipped and discovery continues. The language server surfaces them as warnings; build integrations warn once per distinct problem.
