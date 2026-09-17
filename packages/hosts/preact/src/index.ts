/**
 * `@mxlang/preact` — MX's Preact host, the fourth emitter on `@mxlang/core`'s
 * IR (decisions 71, 79, 81, 82).
 *
 * A `.mx` template becomes a Preact component module: a JSX file
 * carrying its own `@jsxImportSource` pragma, the author's imports and `static`
 * blocks at module scope, their `export interface Input` as the component's
 * props type, and one default-exported function returning JSX.
 *
 * Everything generic — parsing Marko, resolving to the IR, the
 * `config.translator` seam — is `@mxlang/core`'s. This package supplies the
 * declarations (`emitter.ts`), the lowering, and the one small runtime `<try>`
 * needs (`runtime.ts`).
 *
 * ## Emitted module shape
 *
 * ```tsx
 * \/** @jsxImportSource preact *\/
 * import { Fragment } from "preact";
 * <the author's own imports and static blocks>
 *
 * export interface Input { … }
 *
 * export default function <Name>(props: Input) {
 *   const input = { ...props, content: props.content ?? props.children };
 *   <const> and <define> bindings, in source order
 *   return (<jsx/>);
 * }
 * ```
 *
 * `<Name>` is derived from the file (`card.mx` -> `Card`), never anonymous:
 * a tag whose template calls its own name resolves to that declaration, so
 * self-recursion needs no self-import (design invariant §7.5-7).
 *
 * The template's own expressions read `input`, because that is the name MX
 * templates already use (`${input.title}`) and renaming it at the boundary
 * would make every one of them wrong. The JSX parameter is `props`, and the
 * first line bridges the two: Marko spells a component's ordinary children
 * `content` while JSX spells the same slot `children`, and this host emits
 * calls the JSX way so that a hand-written Preact component can be called
 * from MX. Without the bridge, `<Card><p/></Card>` compiled cleanly and
 * rendered an empty card.
 *
 * ## Hooks
 *
 * A hook call belongs in the *component body*, which is what `<const>` lowers
 * to — `<const/count=useState(0)/>` emits `const count = useState(0);` inside
 * the function, where the rules of hooks are satisfied. A `static` block is
 * module scope and runs once per module, so a hook there would be a rules-of-
 * hooks violation; that is a property of the target, and the README says so
 * rather than this file trying to detect it.
 */

import { readFileSync } from "node:fs";
import {
  type CompileResult,
  type CustomTag,
  compileSource,
  concatMapped,
  createTranslator,
  drive,
  type GeneratedMapping,
  type HostDeclarations,
  type Ir,
  type IrNode,
  type MappedCode,
  moduleExportName,
  type RawSourceMap,
} from "@mxlang/core";
import {
  componentAlias,
  createEmitter,
  preactDeclarations,
} from "./emitter.ts";
import { preactTarget, type Target } from "./target.ts";

// Re-exported for the hosts built on this emitter (`@mxlang/react`,
// `@mxlang/hono`), which depend on this package rather than on the core
// directly. Their Bun loaders need tag discovery, and a second dependency
// edge only to reach one function would contradict that arrangement.
export { getCustomTags, TranslateError } from "@mxlang/core";
export {
  createEmitter,
  createJsxDeclarations,
  emitPreact,
  PreactEmitter,
  preactDeclarations,
} from "./emitter.ts";
export { MxErrorBoundary, MxPlaceholder, mxClass } from "./runtime.ts";
export { preactTarget, type Target } from "./target.ts";
export type { CompileResult, RawSourceMap };

const host = {
  /**
   * Marko's own convention: `@marko/compiler`'s `scanTagsDir` only
   * auto-discovers files whose extension is literally `.marko` (measured in
   * 5.42.5's `loadTaglibFromDir.js`, `ext === ".marko"`), so a `tags/*.marko`
   * file is callable as a tag with no import. A `.mx` file in `tags/` is not
   * discovered. Kept because this is a host for stock Marko syntax, the same
   * as `@mxlang/html`.
   */
  tagDiscoveryDirs: ["tags"],
};

/** The Marko translator object, for a caller driving `@marko/compiler` itself. */
export const translator = createTranslator(host);

export interface CompilePreactOptions {
  /** Custom tags already discovered and loaded by the calling integration. */
  customTags?: Record<string, CustomTag>;
  /**
   * The JSX target to emit for. Defaults to Preact; a React package passes its
   * own so it can reuse this emitter rather than fork it.
   */
  target?: Target;
  /** Resolve-time declarations paired with a custom JSX target. */
  declarations?: HostDeclarations;
}

/**
 * Which of the emitted module's top-level bindings each import supplies.
 *
 * `Fragment` comes from the JSX runtime's own package, the `<try>` helpers
 * from this package's runtime entry — two different modules, so the emitter's
 * collected set is partitioned here rather than at the point of use.
 */
function importLines(names: Set<string>, target: Target): string[] {
  const lines: string[] = [];
  if (names.has("Fragment")) {
    lines.push(`import { Fragment } from "${target.fragmentModule}";`);
  }
  const boundary = [target.errorBoundaryName, target.suspenseName].filter(
    (name) => names.has(name),
  );
  if (boundary.length > 0) {
    lines.push(
      `import { ${boundary.join(", ")} } from "${target.errorBoundaryModule}";`,
    );
  }
  if (names.has("mxClass")) {
    const mxClassModule = target.mxClassModule ?? target.errorBoundaryModule;
    lines.push(`import { mxClass } from "${mxClassModule}";`);
  }
  return lines;
}

/**
 * Builds the emitted component module for one resolved template.
 *
 * `<const>` and `<define>` are lifted out of the body first: both are
 * *statements* in the emitted function, and JSX has no statement position, so
 * they are emitted above the `return` in the order the author wrote them. A
 * `<const>` deeper in the tree stays an error (see the emitter), because
 * lifting one out of a `<for>` body would change which values it closes over.
 */
export function emitModuleWithMappings(
  ir: Ir,
  target: Target = preactTarget,
): MappedCode {
  const emitter = createEmitter(target);

  // Statements first, markup second. Splitting on the top level only: a
  // nested one is refused by the emitter rather than silently relocated.
  const statements: MappedCode[] = [];
  const markup: IrNode[] = [];
  for (const node of ir.body) {
    if (node.kind === "Const") {
      statements.push(concatMapped(`const ${node.name} = ${node.init.code};`));
    } else if (node.kind === "Define") {
      const body = createEmitter(target);
      drive(body, node.children);
      const rendered = body.result();
      for (const name of body.runtimeImports) {
        emitter.runtimeImports.add(name);
      }
      statements.push(
        concatMapped(
          `const ${node.name} = (${node.params.join(", ")}) => (<>`,
          rendered,
          "</>);",
        ),
      );
    } else {
      markup.push(node);
    }
  }

  drive(emitter, markup);
  const body = emitter.result();

  const lines: string[] = [`/** @jsxImportSource ${target.jsxImportSource} */`];
  const imports = importLines(emitter.runtimeImports, target);
  if (imports.length > 0) lines.push(...imports);

  const importedNames = new Set(ir.imports.flatMap((node) => node.bindings));
  const hoisted = [
    ...ir.imports.map((node) => node.code),
    ...ir.hoisted.map((node) => node.code),
    // A component whose Marko name JSX would read as an element is called
    // under a capitalized alias. Where the author imported the name, the
    // alias is a local binding; where Marko *discovered* it from a `tags/`
    // directory there is no import at all — that is the point of discovery —
    // so one is synthesized against Marko's own convention. The synthesized
    // path is always `.marko`, never `.mx`: `@marko/compiler`'s own
    // `scanTagsDir` only discovers files whose extension is literally
    // `.marko` (see the `tagDiscoveryDirs` doc comment above), so a
    // discovered tag can only ever be a real `.marko` file on disk.
    ...[...emitter.aliases].map((name) =>
      importedNames.has(name)
        ? `const ${componentAlias(name)} = ${name};`
        : `import ${componentAlias(name)} from "./tags/${name}.marko";`,
    ),
  ];
  if (hoisted.length > 0) lines.push("", ...hoisted);

  lines.push(
    "",
    ir.inputInterface?.code ?? "export interface Input {}",
    "",
    // Named after the file, never anonymous: a tag whose template calls its
    // own name resolves to this declaration, so self-recursion needs no
    // self-import (design invariant §7.5-7).
    `export default function ${moduleExportName(ir, "@mxlang/preact")}(props: Input) {`,
  );
  // Marko names a component's ordinary children `content`, and a template
  // reads them as `${input.content}`. JSX has its own name for the same slot —
  // a caller writes `<Card><p/></Card>` and the callee receives
  // `props.children` — and this host emits calls that way, because a
  // hand-written Preact component called from MX must work too. So a template
  // that reads `input.content` gets the alias, and one that does not is
  // emitted unchanged: without it, `<Card><p/></Card>` compiled cleanly and
  // rendered an empty card, which is the S8 silent-drop class.
  lines.push(
    "  const input: Input & { content?: unknown } = {",
    "    ...props,",
    "    content:",
    "      (props as { content?: unknown }).content ??",
    "      (props as { children?: unknown }).children,",
    "  };",
  );
  // A statement lifted by the core's own hoist hook precedes the author's, so
  // a binding it introduces is in scope for everything that follows.
  for (const node of ir.prelude) lines.push(`  ${node.code}`);
  const prefix = `${lines.join("\n")}\n`;
  const statementCode = concatMapped(
    ...statements.flatMap((statement) => ["  ", statement, "\n"]),
  );
  return concatMapped(
    prefix,
    statementCode,
    "  return (<>",
    body,
    "</>);\n}\n",
  );
}

export function emitModule(ir: Ir, target: Target = preactTarget): string {
  return emitModuleWithMappings(ir, target).code;
}

export interface CompilePreactResult extends CompileResult {
  mappings: GeneratedMapping[];
}

/**
 * Compiles a `.mx` template to a Preact component module.
 *
 * The returned map is a placeholder identity map, as `@mxlang/html`'s is: the
 * emitter builds text rather than printing a Babel AST, so there are no node
 * positions to derive real mappings from yet. `@mxlang/typescript-plugin`
 * maps from the IR's own node locations instead.
 */
export function compilePreactMx(
  source: string,
  filename: string,
  options: CompilePreactOptions = {},
): CompilePreactResult {
  const target = options.target ?? preactTarget;
  let mappings: GeneratedMapping[] = [];
  const result = compileSource(
    source,
    filename,
    options.declarations ?? preactDeclarations,
    {
      ...host,
      customTags: options.customTags,
      emitIr: (ir) => {
        const emitted = emitModuleWithMappings(ir, target);
        mappings = emitted.mappings;
        return emitted.code;
      },
    },
  );
  return { ...result, mappings };
}

/** `compilePreactMx()` over a file on disk. */
export function compilePreactFile(
  filename: string,
  options: CompilePreactOptions = {},
): CompileResult {
  return compilePreactMx(readFileSync(filename, "utf8"), filename, options);
}
