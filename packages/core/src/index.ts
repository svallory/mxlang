/**
 * `@mxlang/core` — the MX AST consumer every MX host is built on.
 *
 * See `README.md` for what belongs here and what belongs in a host. The two
 * front doors are `compileSource` (a whole file, parsed with the MX front end
 * and lowered) and `parseFragment` (a substring of a larger file, positions
 * in the file's offsets).
 */

export {
  type DestructuredName,
  destructuredNames,
  type ReadRewrite,
  rewriteAccessorReads,
  rewriteReadsInCode,
} from "./accessor-reads.ts";
export {
  type AtomCandidate,
  type AtomFacts,
  atomCandidates,
} from "./atom-contracts.ts";
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
export { cloneIr } from "./clone-ir.ts";
export {
  type CompileResult,
  compileSource,
  createTranslator,
  type HostOptions,
  parseMxDocument,
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
  firstAttributeTag,
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
  otherErrorsText,
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
export { CORE_TAGLIB, withStatementTags } from "./core-taglib.ts";
export type {
  AnalyzeContext,
  BuildFrom,
  ChildNode,
  ContractDeclaration,
  ContractMap,
  CustomTag,
  CustomTagAttribute,
  CustomTagAttributeTag,
  CustomTagAttributeTags,
  CustomTagChild,
  CustomTagChildren,
  CustomTagParseOptions,
  FinalizeContext,
  IrBuilders,
  TagCall,
  TagStore,
  TransformContext,
  WildcardAttributeTagEntry,
  WildcardAttributeTags,
  WildcardChildEntry,
  WildcardChildren,
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
  Member,
  MxAtomMark,
  MxMemberMark,
  Position,
  TagAlias,
  TagTrigger,
} from "./ir.ts";
export { expressionShape, lower, lowerChildren } from "./lower.ts";
export type {
  ContractAncestor,
  ContractAttr,
  ContractAttributeTag,
  ContractCall,
  ContractData,
  DeclaredName,
  LoweredUnit,
  LoweredUnitFailOptions,
} from "./lowered-unit.ts";
export {
  concatMapped,
  type GeneratedMapping,
  type MappedCode,
  mapped,
  mappedExpr,
  mappedMethod,
  mappedRewrite,
  replaceMapped,
  type SourceSpan,
} from "./mapping.ts";
/**
 * Marko's taglib lookup, the one instance core builds it with (decision 159:
 * in core's dist, `@marko/compiler` bundled with MX's own template parser).
 * Every package that needs it asks here, so one compiler loads per process.
 * Removed with the lookup (decision 197, PR 6 slice S3b).
 */
export { type MarkoCompiler, markoCompiler } from "./marko-frontend.ts";
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
  getCustomTags,
  liveTagMapCount,
  reportScanDiagnostics,
  scanCached,
} from "./scan-cache.ts";
export {
  type ContractCheckContext,
  type ContractFields,
  defaultSyntax,
  normalizeMxSyntax,
  resolveSyntax,
  type StandIn,
  type SyntaxBuildContext,
  type SyntaxDiagnostic,
  type SyntaxModule,
  type SyntaxTable,
  syntaxHash,
  type Trigger,
  type TriggerAttribute,
  type TriggerAttributeOptions,
  type TriggerAttributeValue,
  type TriggerChild,
  type TriggerContext,
  type TriggerExpression,
  type TriggerFailOptions,
  type TriggerMethod,
  type TriggerNode,
  type TriggerResult,
  type TriggerShorthand,
  type TriggerUse,
  type TriggerValueForm,
} from "./syntax-table.ts";
/**
 * Core's tag table (decision 197): a translator's taglibs over a target's
 * native elements, what `parseMx` and lowering read tag names through.
 *
 * @unstable for the tools that lower outside `compileSource` (the TS plugin's
 * mapping pass).
 */
export {
  type NativeBodyMode,
  type NativeTag,
  type NativeTags,
  type TagEntry,
  type TagParseOptions,
  type TagTable,
  tagTable,
} from "./tag-table.ts";
export {
  type AmbientTypesProgram,
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
export { markoFileTagMessage } from "./uncalled-tag-file.ts";
export {
  type ContractScope,
  matchWildcardChild,
  scopeForChildren,
  type WildcardContext,
  type WildcardMatch,
} from "./wildcard-resolve.ts";
