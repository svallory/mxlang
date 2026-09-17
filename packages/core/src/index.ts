/**
 * `@mxlang/core` — the Marko-node consumer every MX host is built on.
 *
 * See `README.md` for what belongs here and what belongs in a host. The two
 * front doors are `compileSource` (a whole file, through
 * `@marko/compiler`'s `config.translator` seam) and `parseFragment` (a
 * substring of a larger file, positions shifted to the file).
 */

export {
  type DestructuredName,
  destructuredNames,
  type ReadRewrite,
  rewriteAccessorReads,
  rewriteReadsInCode,
} from "./accessor-reads.ts";
export {
  type CompileResult,
  compileSource,
  createTranslator,
  type HostOptions,
  type Lookup,
  printExpression,
  type RawSourceMap,
  type TranslatorOptions,
} from "./compile.ts";
export {
  attrByName,
  type BindingRegistry,
  type BindingRewrite,
  type Ctx,
  type Disposition,
  DYNAMIC_TAG,
  declName,
  expr,
  fail,
  hasContent,
  type ImportedName,
  importBindings,
  importedNames,
  type MxWarning,
  type Node,
  newCtx,
  propKey,
  quote,
  rejectUnsupportedFields,
  sliceLoc,
  TranslateError,
  VOID_TAGS,
  warn,
} from "./core.ts";
export type {
  AnalyzeContext,
  CustomTag,
  CustomTagAttribute,
  CustomTagAttributeTag,
  CustomTagParseOptions,
  FinalizeContext,
  IrBuilders,
  TagCall,
  TagStore,
  TransformContext,
} from "./custom-tags.ts";
export type { HostDeclarations, Policy } from "./declarations.ts";
export { drive, type Emitter, emit } from "./emit.ts";
export { escape } from "./escape.ts";
export { exportNameFor, moduleExportName } from "./export-name.ts";
export {
  type FragmentBase,
  type FragmentResult,
  parseFragment,
  parseFragmentNative,
} from "./fragment.ts";
export { type HostPolicy, resolveHostPolicy } from "./host-policy.ts";
export type {
  Attr,
  AttributeTag,
  Block,
  Branch,
  ComponentTarget,
  Expr,
  ExprShape,
  ForSource,
  HostTag,
  Ir,
  IrNode,
  Position,
} from "./ir.ts";
export { expressionShape, lower, lowerChildren } from "./lower.ts";
export {
  concatMapped,
  type GeneratedMapping,
  type MappedCode,
  mapped,
  replaceMapped,
  type SourceSpan,
} from "./mapping.ts";
export {
  checkParseOptions,
  type DiscoveredTag,
  type DiscoverProjectTagsOptions,
  discoverProjectTags,
  HOST_MODULE_SEGMENTS,
  hostModuleSegment,
  loadSidecar,
  type MxTagsEntry,
  normalizeMxTags,
  readParseOptions,
  type ScanDiagnostic,
  type ScanOptions,
  type ScanResult,
  scanCustomTags,
} from "./scan.ts";
export {
  clearScanCache,
  evictTaglibCaches,
  getCustomTags,
  liveTagMapCount,
  scanCached,
} from "./scan-cache.ts";
export {
  hasTemplate,
  metadataForTemplate,
  peekTemplateMetadata,
  resetTemplateCache,
  type TemplateBackedTag,
  type TemplateMetadata,
  type TemplateTag,
  templateCompileCount,
} from "./template-tag.ts";
