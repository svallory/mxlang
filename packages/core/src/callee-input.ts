/**
 * The syntactic reader of a callee component's `Input` (decisions 106/107).
 *
 * A caller with attribute tags needs to know, per declared name, the
 * cardinality (`x?:` / `x:` / `x: …[]`), the shape (`as: "data"` renders
 * `{ ...attrs, content }`; `as: "renderable"` renders the body itself), and
 * whether the tag takes `attrs`/`params` — plus, one level down, the same
 * facts for `AttrTag` members of an `attrs` config (decision 107). Marko
 * reads this through a TS program; MX reads it *syntactically*, Vue
 * `defineProps<T>()` style: only type literals and aliases resolvable without
 * a program count, and anything that needs evaluation is a positioned error
 * ("declare this attribute tag's config literally").
 *
 * This module is the 1a half of phase 1: it resolves the callee file and
 * reads its `Input`, but nothing calls it yet — task 1b wires it into
 * `lowerComponent`, and until then a compile records no dependencies.
 *
 * Everything here is synchronous and cached by `path + mtimeMs + source`,
 * the same discipline as the template-metadata cache (`template-tag.ts`), so
 * an editor, a `tsc` run and a build read one callee identically. Every file
 * read is returned as a dependency so the Vite plugin can invalidate callers
 * when a callee's `Input` changes.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { parse } from "@babel/parser";
import type { Ctx, Node } from "./core.ts";
import type { ComponentTarget } from "./ir.ts";
import type { SourceSpan } from "./mapping.ts";
import { metadataForTemplate, touchAndEvict } from "./template-tag.ts";

const require = createRequire(import.meta.url);

/**
 * One declared attribute tag, read from the callee's `Input`.
 *
 * The shared contract between 1a (this reader) and 1b (the lowering rules):
 * 1b codes against these exact field names.
 */
export interface AttrTagDecl {
  cardinality: "optional" | "required" | "array";
  as: "data" | "renderable";
  hasAttrs: boolean;
  hasParams: boolean;
  /** `AttrTag` members of the `attrs` config, scanned recursively (107). */
  nested: Map<string, AttrTagDecl>;
  /** The `attrs` config is not a closed literal: unknown nested names allowed. */
  nestedOpen: boolean;
  /** Position in the callee's `Input` text, for messages. */
  span: SourceSpan;
}

/**
 * The callee's `Input`, one of four shapes.
 *
 * - `declared`: an `Input` was read and every attribute-tag property is a
 *   literal or resolvable alias. `open` is true when the `Input` has an
 *   unresolvable `extends` or an index signature — attribute tags the reader
 *   could not see may exist, so a caller-side unknown name is not an error.
 * - `none`: no `Input` to read (a JS callee, a `Props` export, a dynamic or
 *   local `<define>` target). The caller uses the syntactic fallback.
 * - `unresolved`: an explicit import whose specifier cannot be resolved.
 *   The caller uses the fallback and warns (decision 107) so an alias can't
 *   cause a silent shape flip.
 * - `invalid`: the `Input` declares an attribute tag whose config the reader
 *   cannot read literally. `errors` is keyed by property path — top-level
 *   names plain, nested attribute tags dotted (`"tabs.icon"`) — each with a
 *   callee span for the message.
 */
export type CalleeInput =
  | {
      kind: "declared";
      path: string;
      attrTags: Map<string, AttrTagDecl>;
      otherProps: Set<string>;
      open: boolean;
    }
  | { kind: "none"; path?: string }
  | { kind: "unresolved"; specifier: string }
  | {
      kind: "invalid";
      path: string;
      errors: Map<string, { message: string; span: SourceSpan }>;
    };

/**
 * What the reader needs to know about the file doing the calling.
 *
 * `imports` maps a local binding to the import specifier as written (lower's
 * `ctx.imports` only holds names, so 1b builds this map from the `Import`
 * IR nodes); `discovered` maps a discovered template tag's call name to its
 * resolved absolute path. `ctx` is the lowering `Ctx`, used only for `.mx`
 * callees so the read rides the template-metadata compile/cache.
 */
export interface ResolveContext {
  /** The file making the call, for relative resolution and `require.resolve`. */
  importer: string;
  /** A tool-supplied resolver (tsconfig paths, vite alias), tried first. */
  resolveImport?: (specifier: string, importer: string) => string | undefined;
  /** Local binding -> import specifier, for explicit-import targets. */
  imports?: ReadonlyMap<string, string>;
  /** Discovered tag name -> resolved absolute template path. */
  discovered?: ReadonlyMap<string, string>;
  /** The lowering Ctx; required when the callee is a `.mx` template. */
  ctx?: Ctx;
}

export interface CalleeInputResult {
  input: CalleeInput;
  /** Every file read to produce `input`, this callee included. */
  dependencies: string[];
}

const MAX_ALIAS_DEPTH = 4;
const MAX_CACHED_CALLEES = 256;

const calleeCache = new Map<
  string,
  {
    mtimeMs: number | undefined;
    source: string;
    result: CalleeInputResult;
    dependencySnapshots: Map<
      string,
      { mtimeMs: number | undefined; source: string }
    >;
  }
>();

/** Clears the callee-input cache. Test-only: production reads are mtime-keyed. */
export function resetCalleeInputCache(): void {
  calleeCache.clear();
}

/**
 * Reads the callee component's `Input` for one call target.
 *
 * The result is cached by resolved path + mtime + source, bounded like the
 * template-metadata cache. Every file read — the callee itself and any
 * followed `import type` target — is recorded in `ctx.dependencies` when a
 * lowering `Ctx` is present, and returned either way.
 */
export function readCalleeInput(
  target: ComponentTarget,
  context: ResolveContext,
): CalleeInputResult {
  const resolved = resolveTarget(target, context);
  if (resolved.kind !== "path")
    return { input: resolved.input, dependencies: [] };

  let mtimeMs: number | undefined;
  let source: string;
  try {
    mtimeMs = statSync(resolved.path).mtimeMs;
    source = readFileSync(resolved.path, "utf8");
  } catch {
    return { input: { kind: "none", path: resolved.path }, dependencies: [] };
  }

  const cached = calleeCache.get(resolved.path);
  if (
    cached &&
    cached.mtimeMs === mtimeMs &&
    cached.source === source &&
    snapshotsMatch(cached.dependencySnapshots)
  ) {
    recordDependencies(context.ctx, cached.result.dependencies);
    return cached.result;
  }

  const result = readInputAt(resolved.path, source, mtimeMs, context);
  touchAndEvict(
    calleeCache,
    resolved.path,
    {
      mtimeMs,
      source,
      result,
      dependencySnapshots: snapshotDependencies(result.dependencies),
    },
    MAX_CACHED_CALLEES,
  );
  recordDependencies(context.ctx, result.dependencies);
  return result;
}

function recordDependencies(
  ctx: Ctx | undefined,
  dependencies: string[],
): void {
  if (!ctx) return;
  ctx.dependencies ??= new Set();
  for (const dependency of dependencies) ctx.dependencies.add(dependency);
}

function snapshotDependencies(
  dependencies: string[],
): Map<string, { mtimeMs: number | undefined; source: string }> {
  const snapshots = new Map<
    string,
    { mtimeMs: number | undefined; source: string }
  >();
  for (const dependency of dependencies) {
    try {
      snapshots.set(dependency, {
        mtimeMs: statSync(dependency).mtimeMs,
        source: readFileSync(dependency, "utf8"),
      });
    } catch {
      // A file that disappears after the read makes the next lookup miss.
      snapshots.set(dependency, { mtimeMs: undefined, source: "" });
    }
  }
  return snapshots;
}

function snapshotsMatch(
  snapshots: ReadonlyMap<
    string,
    { mtimeMs: number | undefined; source: string }
  >,
): boolean {
  for (const [path, snapshot] of snapshots) {
    try {
      if (
        statSync(path).mtimeMs !== snapshot.mtimeMs ||
        readFileSync(path, "utf8") !== snapshot.source
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

type ResolvedTarget =
  | { kind: "path"; path: string }
  | { kind: "input"; input: CalleeInput };

function resolveTarget(
  target: ComponentTarget,
  context: ResolveContext,
): ResolvedTarget {
  // A dynamic `<${expr}>` target and a local `<define>` have no file to
  // read; both take the syntactic fallback like an untyped callee.
  if (target.kind !== "name") return { kind: "input", input: { kind: "none" } };

  const discovered = context.discovered?.get(target.name);
  if (discovered) return { kind: "path", path: discovered };

  const specifier = context.imports?.get(target.name);
  if (!specifier) {
    // An unbound name is not a callee file this reader can open.
    return { kind: "input", input: { kind: "none" } };
  }
  const path = resolveSpecifier(specifier, context);
  if (!path) return { kind: "input", input: { kind: "unresolved", specifier } };
  return { kind: "path", path };
}

/** Extension probes, in the order the brief pins (literal path first). */
const EXTENSION_PROBES = [".mx", ".solid.mx", ".tsx", ".ts", ".jsx", ".js"];

function probeFile(base: string): string | undefined {
  for (const candidate of [
    base,
    ...EXTENSION_PROBES.map((ext) => base + ext),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolves one import specifier to an absolute file, synchronously.
 *
 * A tool's `resolveImport` is tried first (decision 107), then a relative or
 * absolute specifier is probed against the importing file's directory with
 * the MX extension list, then a bare specifier goes through
 * `require.resolve` from that directory, the way `scan.ts` resolves sidecar
 * imports. `importer` names the file the specifier was written in — a type
 * import inside a callee resolves against the callee's directory, not the
 * caller's.
 */
export function resolveSpecifier(
  specifier: string,
  context: ResolveContext,
  importer = context.importer,
): string | undefined {
  if (context.resolveImport) {
    const aliased = context.resolveImport(specifier, importer);
    if (typeof aliased === "string") {
      const probed = probeFile(
        isAbsolute(aliased) ? aliased : resolvePath(dirname(importer), aliased),
      );
      if (probed) return probed;
    }
  }
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    isAbsolute(specifier)
  ) {
    return probeFile(resolvePath(dirname(importer), specifier));
  }
  try {
    return require.resolve(specifier, { paths: [dirname(importer)] });
  } catch {
    return undefined;
  }
}

function readInputAt(
  path: string,
  source: string,
  mtimeMs: number | undefined,
  context: ResolveContext,
): CalleeInputResult {
  if (path.endsWith(".mx")) {
    if (!context.ctx) {
      // A `.mx` callee's Input is read through the template-metadata cache,
      // whose compile callback needs a real lowering Ctx. 1b always has one;
      // a bare-tool call without it gets a clear error rather than a guess.
      throw new Error(
        `@mxlang/core: reading the Input of a .mx callee (${path}) requires ResolveContext.ctx, the lowering Ctx the template-metadata cache compiles through`,
      );
    }
    const metadata = metadataForTemplate(context.ctx, {
      filename: path,
      source,
      mtimeMs,
    });
    const dependencies = [path];
    const input = readInputFromText(
      path,
      metadata.inputCode,
      metadata.inputAuxCode,
      true,
      dependencies,
      context,
    );
    return { input, dependencies };
  }

  const dependencies = [path];
  const input = readInputFromText(
    path,
    source,
    undefined,
    false,
    dependencies,
    context,
  );
  return { input, dependencies };
}

/**
 * Reads one `Input` from source text. `allowStaticInput` is true for `.mx`
 * callees, where a `<static>`-block `type Input`/`interface Input` counts
 * alongside an `export interface Input`; a `.ts`/`.tsx`/`.js(x)` callee only
 * exports count (decision 107 — a `Props` export is "no Input").
 *
 * `auxCode` is the `.mx` metadata's static-block and authored-import text:
 * the same-file alias and `import type` sources for the resolver.
 */
function readInputFromText(
  path: string,
  inputCode: string | undefined,
  auxCode: string | undefined,
  allowStaticInput: boolean,
  dependencies: string[],
  context: ResolveContext,
): CalleeInput {
  const analyzer = new InputAnalyzer(path, dependencies, context);
  if (auxCode !== undefined) analyzer.addAux(auxCode);
  if (inputCode !== undefined) analyzer.addProgram(inputCode);

  const inputDecl = analyzer.findInput(allowStaticInput);
  if (!inputDecl) return { kind: "none", path };
  return analyzer.analyzeInput(inputDecl);
}

/**
 * The per-read state: parsed declaration sources, the alias/import-type
 * tables, and the attribute-tag recognition rules.
 */
class InputAnalyzer {
  /** Combined top-level nodes of every parsed source for this read. */
  private readonly program: Node[] = [];
  /** Same-file type/interface declarations by name (latest wins). */
  private readonly declarations = new Map<string, Node>();
  /** Same-file value declarations, so a locally shadowed `AttrTag` is not ambient. */
  private readonly localValues = new Set<string>();
  /** `import type` bindings: local name -> specifier, imported name, and the file that declares the import. */
  private readonly typeImports = new Map<
    string,
    { specifier: string; imported: string; fromPath: string }
  >();
  /** Files already read, so a type-import cycle terminates. */
  private readonly readFiles = new Set<string>();
  /** Non-mx `AttrTag` imports disqualify the identifier entirely. */
  private attrTagDisallowed = false;

  constructor(
    private readonly path: string,
    private readonly dependencies: string[],
    private readonly context: ResolveContext,
  ) {}

  /** Parses one declaration source and merges its top-level nodes in. */
  addProgram(code: string): void {
    for (const node of parseDeclarationModule(code) ?? []) {
      this.addNode(node, this.path);
    }
  }

  /**
   * Parses the `.mx` aux text (static blocks plus authored imports). A static
   * `Input` is declared there without `export`, which is exactly the form
   * `allowStaticInput` accepts.
   */
  addAux(code: string): void {
    this.addProgram(code);
  }

  private addNode(node: Node, fromPath: string): void {
    this.program.push({ node, fromPath });
    switch (node.type) {
      case "ExportNamedDeclaration": {
        const declaration = node.declaration;
        if (
          declaration?.type === "TSInterfaceDeclaration" ||
          declaration?.type === "TSTypeAliasDeclaration"
        ) {
          this.declarations.set(declaration.id.name as string, {
            node: declaration,
            fromPath,
          });
        } else if (declaration?.type === "VariableDeclaration") {
          for (const item of declaration.declarations ?? []) {
            this.localValues.add(item.id.name as string);
          }
        } else if (declaration?.type === "FunctionDeclaration") {
          if (declaration.id?.name) this.localValues.add(declaration.id.name);
        }
        break;
      }
      case "ImportDeclaration": {
        const specifier = node.source.value as string;
        const mxAttrTagSource = /^@mxlang\//.test(specifier);
        for (const specifierNode of node.specifiers ?? []) {
          const local = specifierNode.local.name as string;
          const imported =
            specifierNode.type === "ImportDefaultSpecifier"
              ? "default"
              : (specifierNode.imported?.name ?? local);
          if (local === "AttrTag" && !mxAttrTagSource) {
            this.attrTagDisallowed = true;
          }
          if (
            node.importKind === "type" ||
            specifierNode.importKind === "type"
          ) {
            this.typeImports.set(local, { specifier, imported, fromPath });
          } else if (local === "AttrTag") {
            // A runtime AttrTag import binds the name even from @mxlang — it
            // is recognised, just not as ambient.
            this.localValues.add(local);
          }
        }
        break;
      }
      case "TSInterfaceDeclaration":
      case "TSTypeAliasDeclaration":
        this.declarations.set(node.id.name as string, {
          node,
          fromPath,
        });
        break;
      case "VariableDeclaration":
        for (const declaration of node.declarations ?? []) {
          this.localValues.add(declaration.id.name as string);
        }
        break;
      case "FunctionDeclaration":
      case "TSModuleDeclaration":
        if (node.id?.name) this.localValues.add(node.id.name as string);
        break;
    }
  }

  /** Finds the `Input` declaration: exported first, static-block when allowed. */
  findInput(allowStatic: boolean): Node | undefined {
    for (const entry of this.program) {
      const node = entry.node;
      if (
        (node.type === "ExportNamedDeclaration" &&
          node.declaration?.type === "TSInterfaceDeclaration") ||
        (node.type === "ExportNamedDeclaration" &&
          node.declaration?.type === "TSTypeAliasDeclaration")
      ) {
        if (node.declaration.id.name === "Input") {
          return { node: node.declaration, fromPath: entry.fromPath };
        }
      }
    }
    if (!allowStatic) return undefined;
    for (const entry of this.program) {
      const node = entry.node;
      if (
        (node.type === "TSInterfaceDeclaration" ||
          node.type === "TSTypeAliasDeclaration") &&
        node.id.name === "Input"
      ) {
        return { node, fromPath: entry.fromPath };
      }
    }
    return undefined;
  }

  /** Whether `AttrTag` may name an attribute-tag type in this callee. */
  private attrTagRecognized(): boolean {
    if (this.attrTagDisallowed) return false;
    // A local non-import declaration shadows the ambient type.
    if (this.localValues.has("AttrTag") && !this.typeImports.has("AttrTag")) {
      for (const entry of this.program) {
        const node = entry.node;
        if (
          node.type !== "ImportDeclaration" ||
          !node.specifiers?.some((s: Node) => s.local.name === "AttrTag")
        ) {
          continue;
        }
        return true;
      }
      return false;
    }
    return true;
  }

  /**
   * Resolves a named type to its declaration across same-file declarations
   * and `import type`, depth ≤ 4 with a cycle guard (the brief's rules).
   */
  private resolveNamedType(
    name: string,
    seen: Set<string>,
    depth: number,
  ): { node: Node; fromPath: string } | undefined {
    const key = `${this.path}::${name}`;
    if (seen.has(key) || depth > MAX_ALIAS_DEPTH) return undefined;
    seen.add(key);

    const local = this.declarations.get(name);
    if (local) return local;

    const typeImport = this.typeImports.get(name);
    if (!typeImport) return undefined;
    const resolved = resolveSpecifier(
      typeImport.specifier,
      this.context,
      typeImport.fromPath,
    );
    if (!resolved || this.readFiles.has(resolved)) return undefined;
    // The brief pins .ts and .mx targets for followed type imports; a
    // component's types never come from a runtime module.
    if (!/\.(?:tsx?|jsx?|mx)$/.test(resolved)) return undefined;

    let source: string;
    try {
      source = readFileSync(resolved, "utf8");
    } catch {
      return undefined;
    }
    this.readFiles.add(resolved);
    this.dependencies.push(resolved);

    const imported = this.importedDeclaration(
      resolved,
      source,
      typeImport.imported,
    );
    if (!imported) return undefined;
    // Merge the file's own aliases so a chain (A -> B -> C) keeps resolving.
    for (const node of imported.program) this.addNode(node, resolved);
    return imported.declaration;
  }

  /**
   * Reads one declaration by name from a followed type-import file. A `.mx`
   * file is Marko rather than a TS module, so it goes through the same
   * template-metadata compile/cache as a callee; the metadata exposes its
   * authored imports, exports, static declarations, and `Input` as TS text.
   */
  private importedDeclaration(
    resolved: string,
    source: string,
    imported: string,
  ):
    | { declaration: { node: Node; fromPath: string }; program: Node[] }
    | undefined {
    let code = source;
    if (resolved.endsWith(".mx")) {
      if (!this.context.ctx) return undefined;
      let mtimeMs: number | undefined;
      try {
        mtimeMs = statSync(resolved).mtimeMs;
      } catch {
        return undefined;
      }
      const metadata = metadataForTemplate(this.context.ctx, {
        filename: resolved,
        source,
        mtimeMs,
      });
      code = [metadata.inputAuxCode, metadata.inputCode]
        .filter((part): part is string => part !== undefined)
        .join("\n");
    }
    if (code.trim() === "") return undefined;
    const program = parseDeclarationModule(code);
    if (!program) return undefined;
    for (const node of program) {
      const declaration =
        node.type === "ExportNamedDeclaration" ? node.declaration : node;
      if (
        declaration?.type === "TSInterfaceDeclaration" ||
        declaration?.type === "TSTypeAliasDeclaration"
      ) {
        if (declaration.id.name === imported) {
          return {
            declaration: { node: declaration, fromPath: resolved },
            program,
          };
        }
      }
    }
    return undefined;
  }

  /**
   * Reads the `Input` declaration into the four-kind result. Members are
   * classified per property: an attribute-tag-typed property becomes an
   * `AttrTagDecl`, everything else an `otherProps` entry.
   */
  analyzeInput(inputDecl: { node: Node; fromPath: string }): CalleeInput {
    const errors = new Map<string, { message: string; span: SourceSpan }>();
    const attrTags = new Map<string, AttrTagDecl>();
    const otherProps = new Set<string>();
    let open = false;

    const members = this.inputMembers(inputDecl.node, new Set(), 0, errors, "");
    for (const member of members) {
      if (member.kind === "index") {
        open = true;
        continue;
      }
      const analyzed = this.analyzeAttrTagType(
        member.type,
        new Set(),
        0,
        errors,
        member.name,
      );
      if (analyzed === undefined) {
        otherProps.add(member.name);
      } else if ("message" in analyzed) {
        errors.set(member.name, {
          message: analyzed.message,
          span: analyzed.span,
        });
      } else {
        // `x?:` marks the property, not the type. An array stays an array —
        // `x?: AttrTag[]` accepts any number, absent when not provided.
        if (member.optional && analyzed.cardinality === "required") {
          analyzed.cardinality = "optional";
        }
        attrTags.set(member.name, analyzed);
      }
    }

    if (errors.size > 0) return { kind: "invalid", path: this.path, errors };
    return { kind: "declared", path: this.path, attrTags, otherProps, open };
  }

  /**
   * Flattens an `Input`'s members, following `extends` clauses. An
   * unresolvable heritage identifier sets `open` (unknown attribute tags may
   * hide in the missing base) rather than erroring — the brief pins exactly
   * that rule.
   */
  private inputMembers(
    inputDecl: Node,
    seen: Set<string>,
    depth: number,
    errors: Map<string, { message: string; span: SourceSpan }>,
    _path: string,
  ): Array<
    | {
        kind: "prop";
        name: string;
        type: Node;
        span: SourceSpan;
        optional: boolean;
      }
    | { kind: "index"; span: SourceSpan }
  > {
    const result: Array<
      | {
          kind: "prop";
          name: string;
          type: Node;
          span: SourceSpan;
          optional: boolean;
        }
      | { kind: "index"; span: SourceSpan }
    > = [];
    const declaration = inputDecl.node ?? inputDecl;
    const body =
      declaration.type === "TSInterfaceDeclaration"
        ? declaration.body?.body
        : declaration.typeAnnotation?.type === "TSTypeLiteral"
          ? declaration.typeAnnotation.members
          : undefined;

    if (body) {
      for (const member of body) {
        if (member.type === "TSIndexSignature") {
          result.push({ kind: "index", span: spanOf(member) });
          continue;
        }
        if (member.type !== "TSPropertySignature") continue;
        const name = propertyName(member.key);
        if (name === undefined) continue;
        result.push({
          kind: "prop",
          name,
          type: member.typeAnnotation?.typeAnnotation,
          span: spanOf(member),
          optional: member.optional === true,
        });
      }
    } else if (declaration.type === "TSTypeAliasDeclaration") {
      // A type alias Input that is not an object literal (conditional,
      // mapped, intersection, ...) has members this reader cannot see: the
      // Input is open rather than wrong.
      return result;
    }

    // `interface Input extends Base` — resolvable bases are flattened in,
    // unresolvable ones make the Input open. The flag travels through the
    // shared `errors`-free return: encode it as an index member the caller
    // treats as `open`.
    if (declaration.extends) {
      for (const heritage of declaration.extends) {
        const baseName =
          heritage.expression?.type === "Identifier"
            ? heritage.expression.name
            : heritage.id?.type === "Identifier"
              ? heritage.id.name
              : undefined;
        if (!baseName) continue;
        const base = this.resolveNamedType(baseName, seen, depth + 1);
        if (!base) {
          result.push({ kind: "index", span: spanOf(heritage) });
          continue;
        }
        result.push(...this.inputMembers(base, seen, depth + 1, errors, _path));
      }
    }
    return result;
  }

  /**
   * Classifies one property's type. Returns a full `AttrTagDecl` when the
   * type is an attribute-tag form, `{ message }` when it is an attribute-tag
   * form whose config cannot be read literally, or undefined when the
   * property is not an attribute tag at all.
   */
  private analyzeAttrTagType(
    type: Node,
    seen: Set<string>,
    depth: number,
    errors: Map<string, { message: string; span: SourceSpan }>,
    propPath: string,
  ): AttrTagDecl | { message: string; span: SourceSpan } | undefined {
    if (!type) return undefined;
    let node = type;
    let cardinality: "optional" | "required" | "array" = "required";

    if (node.type === "TSOptionalType") node = node.typeAnnotation;

    const unwrap = (n: Node): { node: Node; array: boolean } => {
      if (n.type === "TSTypeOperator" && n.operator === "readonly") {
        return unwrap(n.typeAnnotation);
      }
      if (n.type === "TSArrayType") return { node: n.elementType, array: true };
      if (
        n.type === "TSTypeReference" &&
        (n.typeName.name === "Array" || n.typeName.name === "ReadonlyArray") &&
        n.typeParameters?.params?.length === 1
      ) {
        return { node: n.typeParameters.params[0], array: true };
      }
      return { node: n, array: false };
    };

    let unwrapped = unwrap(node);
    if (unwrapped.array) cardinality = "array";
    node = unwrapped.node;

    // Alias chains: an identifier whose declaration resolves to an
    // attribute-tag form counts, same as the literal.
    while (
      node.type === "TSTypeReference" &&
      node.typeName.type === "Identifier" &&
      node.typeName.name !== "AttrTag"
    ) {
      const resolved = this.resolveNamedType(
        node.typeName.name,
        seen,
        depth + 1,
      );
      if (!resolved) return undefined; // An unresolvable reference is an ordinary prop.
      const aliasDecl = resolved.node;
      const aliasType =
        aliasDecl.type === "TSTypeAliasDeclaration"
          ? aliasDecl.typeAnnotation
          : aliasDecl.body?.type === "TSTypeLiteral"
            ? aliasDecl.body
            : undefined;
      if (!aliasType) return undefined;
      unwrapped = unwrap(aliasType);
      if (unwrapped.array) cardinality = "array";
      node = unwrapped.node;
    }

    if (
      node.type !== "TSTypeReference" ||
      node.typeName.type !== "Identifier" ||
      node.typeName.name !== "AttrTag"
    ) {
      return undefined;
    }
    if (!this.attrTagRecognized()) return undefined;

    const config = node.typeParameters?.params?.[0];
    const decl: AttrTagDecl = {
      cardinality,
      as: "data",
      hasAttrs: false,
      hasParams: false,
      nested: new Map(),
      nestedOpen: false,
      span: spanOf(node),
    };
    if (!config) return decl;

    let configLiteral = config;
    let configDepth = 0;
    while (
      configLiteral.type === "TSTypeReference" &&
      configLiteral.typeName.type === "Identifier"
    ) {
      const resolved = this.resolveNamedType(
        configLiteral.typeName.name,
        seen,
        configDepth + 1,
      );
      const aliasDecl = resolved?.node;
      const aliasType =
        aliasDecl?.type === "TSTypeAliasDeclaration"
          ? aliasDecl.typeAnnotation
          : aliasDecl?.body?.type === "TSTypeLiteral"
            ? aliasDecl.body
            : undefined;
      if (!aliasType) break;
      configLiteral = aliasType;
      configDepth++;
    }
    if (configLiteral.type !== "TSTypeLiteral") {
      return {
        message: "declare this attribute tag's config literally",
        span: spanOf(node),
      };
    }

    for (const member of configLiteral.members ?? []) {
      if (member.type === "TSIndexSignature") {
        decl.nestedOpen = true;
        continue;
      }
      if (member.type !== "TSPropertySignature") continue;
      const name = propertyName(member.key);
      if (name === undefined) continue;
      const memberType = member.typeAnnotation?.typeAnnotation;
      switch (name) {
        case "as": {
          if (
            memberType?.type === "TSLiteralType" &&
            memberType.literal.type === "StringLiteral" &&
            (memberType.literal.value === "data" ||
              memberType.literal.value === "renderable")
          ) {
            decl.as = memberType.literal.value;
          } else {
            return {
              message: "declare this attribute tag's config literally",
              span: spanOf(node),
            };
          }
          break;
        }
        case "attrs": {
          decl.hasAttrs = true;
          this.scanAttrs(memberType, decl, new Set(seen), 0, errors, propPath);
          break;
        }
        case "params": {
          decl.hasParams = true;
          const paramsType =
            memberType?.type === "TSTypeOperator" &&
            memberType.operator === "readonly"
              ? memberType.typeAnnotation
              : memberType;
          if (paramsType?.type !== "TSTupleType") {
            return {
              message: "attribute tag params must be a tuple type",
              span: spanOf(node),
            };
          }
          break;
        }
        default:
          break;
      }
    }

    if (decl.as === "renderable" && decl.hasAttrs) {
      return {
        message:
          'renderable attribute tags can\'t take attributes; declare as: "data"',
        span: spanOf(node),
      };
    }
    return decl;
  }

  /**
   * Scans an `attrs` config recursively (decision 107): `AttrTag` members
   * become `nested` declarations, non-`AttrTag` members are plain attrs and
   * are not interpreted, and a non-closed `attrs` type sets `nestedOpen`.
   */
  private scanAttrs(
    attrsType: Node,
    decl: AttrTagDecl,
    seen: Set<string>,
    depth: number,
    errors: Map<string, { message: string; span: SourceSpan }>,
    propPath: string,
  ): void {
    let literal = attrsType;
    if (
      literal?.type === "TSTypeReference" &&
      literal.typeName.type === "Identifier"
    ) {
      const resolved = this.resolveNamedType(
        literal.typeName.name,
        seen,
        depth + 1,
      );
      const aliasDecl = resolved?.node;
      const aliasType =
        aliasDecl?.type === "TSTypeAliasDeclaration"
          ? aliasDecl.typeAnnotation
          : aliasDecl?.body?.type === "TSTypeLiteral"
            ? aliasDecl.body
            : undefined;
      if (aliasType) literal = aliasType;
    }
    if (literal?.type !== "TSTypeLiteral") {
      // `attrs` is not a closed literal (a mapped type, an unresolvable
      // alias, `object`): nested attribute tags may exist that this reader
      // cannot name.
      decl.nestedOpen = true;
      return;
    }
    for (const member of literal.members ?? []) {
      if (member.type === "TSIndexSignature") {
        decl.nestedOpen = true;
        continue;
      }
      if (member.type !== "TSPropertySignature") continue;
      const name = propertyName(member.key);
      if (name === undefined) continue;
      const nested = this.analyzeAttrTagType(
        member.typeAnnotation?.typeAnnotation,
        new Set(seen),
        0,
        errors,
        `${propPath}.${name}`,
      );
      if (nested === undefined) continue; // A plain attr.
      if ("message" in nested) {
        errors.set(`${propPath}.${name}`, {
          message: nested.message,
          span: nested.span,
        });
        continue;
      }
      // Same rule as the top level: `?` marks the member; an array stays an
      // array.
      if (member.optional && nested.cardinality === "required") {
        nested.cardinality = "optional";
      }
      decl.nested.set(name, nested);
    }
  }
}

/** Babel's numeric offsets are the callee-relative span the messages use. */
function spanOf(node: Node): SourceSpan {
  return { sourceStart: node.start ?? 0, sourceEnd: node.end ?? 0 };
}

function propertyName(key: Node | undefined): string | undefined {
  if (!key) return undefined;
  if (key.type === "Identifier") return key.name as string;
  if (key.type === "StringLiteral") return key.value as string;
  return undefined;
}

/**
 * Parses source text into top-level module nodes with Babel's real TypeScript
 * and JSX parser. The complete module is always parsed: declarations are not
 * scraped out of TSX text, so offsets and syntax are the callee's real AST.
 */
function parseDeclarationModule(code: string): Node[] | undefined {
  try {
    return parse(code, {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
    }).program.body as Node[];
  } catch {
    return undefined;
  }
}
