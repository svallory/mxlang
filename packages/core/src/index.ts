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
export type {
  AttrTag,
  AttrTagAttrs,
  AttrTagConfig,
  AttrTagOf,
  AttrTagParams,
} from "./attr-tag.ts";
export {
  ATTRIBUTE_SPREAD_EXPRESSION,
  ATTRIBUTE_VALUE_EXPRESSION,
} from "./attribute-value.ts";
export {
  type AttrTagDecl,
  type CalleeInput,
  type CalleeInputReader,
  type CalleeInputResult,
  type ResolveContext,
  readCalleeInput,
  readOwnInput,
  registerCalleeInputReader,
  resetCalleeInputCache,
  resolveSpecifier,
  withCalleeInputSources,
} from "./callee-input.ts";
export {
  buildMarkoLookup,
  type CompileResult,
  compileSource,
  createTranslator,
  type HostOptions,
  type Lookup,
  printExpression,
  type RawSourceMap,
  type Translator,
  type TranslatorOptions,
} from "./compile.ts";
export {
  type ContractDefaultTagInput,
  contractDefaultTag,
  contractDefaultTagDiagnostics,
} from "./contract-default-tag.ts";
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
  isFunctionLikeValue,
  isMarkoOrMxSpecifier,
  isTranslateError,
  type MxWarning,
  type Node,
  newCtx,
  propKey,
  quote,
  rejectUnsupportedFields,
  sliceLoc,
  TranslateError,
  type UnresolvedTagOptions,
  unresolvedCustomTagMessage,
  VOID_TAGS,
  warn,
} from "./core.ts";
export { CORE_TAGLIB } from "./core-taglib.ts";
export type {
  AnalyzeContext,
  ChildNode,
  ContractMap,
  CustomTag,
  CustomTagAttribute,
  CustomTagAttributeTag,
  CustomTagChild,
  CustomTagParseOptions,
  FinalizeContext,
  IrBuilders,
  TagCall,
  TagStore,
  TransformContext,
} from "./custom-tags.ts";
export type {
  DefaultTagContext,
  DefaultTagParent,
  HostDeclarations,
  Policy,
} from "./declarations.ts";
export {
  type CheckedDefaultTag,
  checkConfiguredDefaultTag,
  type DefaultTagScopeInput,
  type DefaultTagScopeSource,
  defaultTagDiagnostic,
  defaultTagScopeFor,
  type OwnDefaultTagInput,
  ownDefaultTag,
} from "./default-tag-check.ts";
export {
  type DefaultTagLookup,
  type DefaultTagScope,
  validateDefaultTag,
} from "./default-tag-validate.ts";
export { nearestName } from "./did-you-mean.ts";
export { drive, type Emitter, emit } from "./emit.ts";
export { escape } from "./escape.ts";
export { exportNameFor, moduleExportName } from "./export-name.ts";
export {
  type FragmentBase,
  type FragmentResult,
  type PositionedRegion,
  parseFragment,
  parseFragmentNative,
  positionRegionSource,
  type RegionPosition,
} from "./fragment.ts";
export {
  type DefaultTagConfig,
  type PolicyLocation,
  readTargetDefaultTag,
  resolveTargetPolicy,
  resolveTargetPolicyDetailed,
  type TargetPolicy,
  type TargetPolicyDiagnostic,
  type TargetPolicyDiagnosticCode,
  type TargetPolicyResolution,
} from "./host-policy.ts";
export type {
  Atom,
  Attr,
  AttributeTag,
  AttributeTagNode,
  AttrTagProp,
  Block,
  Branch,
  ComponentTarget,
  DelegatedTag,
  Expr,
  ExprShape,
  ForHead,
  ForSource,
  Ir,
  IrNode,
  MxAtomMark,
  Position,
} from "./ir.ts";
export { expressionShape, lower, lowerChildren } from "./lower.ts";
export {
  concatMapped,
  type GeneratedMapping,
  type MappedCode,
  mapped,
  mappedExpr,
  replaceMapped,
  type SourceSpan,
} from "./mapping.ts";
/**
 * Marko's parse layer, the one instance core compiles with (decision 159: in
 * core's dist, `@marko/compiler` bundled with MX's own template parser). Every
 * package that needs the compiler, its Babel or its parser asks here, so one
 * compiler loads per process.
 */
export {
  type HtmljsParser,
  type MarkoBabel,
  type MarkoCompiler,
  markoBabel,
  markoCompiler,
  markoHtmljsParser,
} from "./marko-frontend.ts";
export { sugarTagName } from "./name-sugar.ts";
export { dropOwnParserPosition } from "./parse-error-position.ts";
export {
  checkReservedBindings,
  checkReservedSource,
  reservedBindingMessage,
} from "./reserved-bindings.ts";
export {
  checkParseOptions,
  type DiscoveredTag,
  type DiscoverProjectTagsOptions,
  discoverProjectTags,
  type HostRestriction,
  hostModuleSegment,
  hostRestrictionDiagnostics,
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
  reportScanDiagnostics,
  scanCached,
} from "./scan-cache.ts";
export {
  createTargetLookup,
  type HostFileKind,
  type HostRegionInput,
  type HostRegionResult,
  type TargetCompileOptions,
  type TargetCompileResult,
  type TargetCompiler,
  type TargetDescriptor,
  TargetDescriptorError,
  type TargetHost,
  type TargetLookup,
  TargetLookupError,
  type TargetLookupRule,
  validateDescriptor,
} from "./target-descriptor.ts";
export {
  clearTargetDescriptorCache,
  loadTargetDescriptor,
  TargetLoadError,
  type TargetLoadErrorCode,
} from "./target-loader.ts";
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
