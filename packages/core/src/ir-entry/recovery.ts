/** Private, synchronous handoff from lowering to the opt-in IR entry call. */
import type { Ctx } from "../core.ts";
import type { HostDeclarations } from "../declarations.ts";
import type { Ir } from "../ir.ts";
import type { TemplateMetadata, TemplateTag } from "../template-tag.ts";

export type Recovery = {
  declarations: HostDeclarations;
  receive: (ir: Ir) => void;
  root?: Ctx;
  failedChildren?: WeakSet<object>;
  failedAnalyze?: Set<string>;
  analyzeContexts?: WeakSet<Ctx>;
  analyzeMetadata?: Map<
    string,
    Omit<TemplateTag, "filename"> & { metadata: TemplateMetadata }
  >;
};
let active: Recovery | undefined;

export function withPartialIr<T>(
  declarations: HostDeclarations,
  receive: (ir: Ir) => void,
  run: () => T,
): T {
  const previous = active;
  active = { declarations, receive };
  try {
    return run();
  } finally {
    active = previous;
  }
}

/** Bind only the entry's root; nested template units retain normal lowering. */
export function beginPartialIr(ctx: Ctx): void {
  if (active?.declarations === ctx.declarations) active.root ??= ctx;
}

export function keepsPartialIr(ctx: Ctx): boolean {
  return active?.root === ctx;
}

/** A scratch walk shares the root's recovery rules, not its output channel. */
export function withPartialScratch<T>(ctx: Ctx, scratch: Ctx, run: () => T): T {
  const scope = active;
  if (scope?.root !== ctx) return run();
  scope.root = scratch;
  try {
    return run();
  } finally {
    scope.root = ctx;
  }
}

/** Context-free AST readers only filter failures in the active root's scope. */
export function partialFailedChildren(): WeakSet<object> | undefined {
  return active?.failedChildren;
}

export function omitPartialChild(
  ctx: Ctx,
  child: { readonly type: string },
): void {
  if (active?.root !== ctx) return;
  active.failedChildren ??= new WeakSet();
  active.failedChildren.add(child);
}

/** A failed analyze makes only its own tag's calls ineligible to lower. */
export function failPartialAnalyze(ctx: Ctx, name: string): void {
  if (active?.root !== ctx) return;
  active.failedAnalyze ??= new Set();
  active.failedAnalyze.add(name);
}

/** Metadata units share failed-analyze eligibility, never the root's stores. */
export function hasPartialAnalyzeScope(ctx: Ctx): boolean {
  return (
    active?.failedAnalyze !== undefined &&
    (active.root === ctx || active.analyzeContexts?.has(ctx) === true)
  );
}

/** Only metadata compiled with this scope's omissions belongs to it. */
export function partialAnalyzeScope(ctx: Ctx): Recovery | undefined {
  return hasPartialAnalyzeScope(ctx) ? active : undefined;
}

export function inheritPartialAnalyzeScope(template: Ctx): void {
  if (!active?.failedAnalyze) return;
  active.analyzeContexts ??= new WeakSet();
  active.analyzeContexts.add(template);
}

export function partialAnalyzeFailed(ctx: Ctx, name: string): boolean {
  return (
    hasPartialAnalyzeScope(ctx) && active?.failedAnalyze?.has(name) === true
  );
}

/** Roll back output and hook eligibility, not hook-private stores. */
export function partialRollback(ctx: Ctx): (() => void) | undefined {
  if (!keepsPartialIr(ctx)) return undefined;
  const prelude = ctx.prelude;
  const preludeLength = prelude.length;
  const derived = ctx.contractDerived;
  const derivedLength = derived?.length ?? 0;
  const used = ctx.customTagsUsed;
  const usedSize = used?.size ?? 0;
  const imports = ctx.customTagImports;
  const importsSize = imports?.size ?? 0;
  const importNodes = ctx.customTagImportNodes;
  const importCount = importNodes?.length;
  const calls = ctx.customTagAnalyzePass?.calls;
  // These collections are append-only during a subtree's walk. Save lengths,
  // not every earlier call; only a failed walk scans the sets/maps to trim.
  const callLengths =
    calls &&
    new Map([...calls].map(([name, entries]) => [name, entries.length]));
  return () => {
    ctx.prelude = prelude;
    prelude.length = preludeLength;
    ctx.contractDerived = derived;
    if (derived) derived.length = derivedLength;
    ctx.customTagsUsed = used;
    if (used && used.size > usedSize) {
      let index = 0;
      for (const name of used) if (index++ >= usedSize) used.delete(name);
    }
    ctx.customTagImports = imports;
    if (imports && imports.size > importsSize) {
      let index = 0;
      for (const path of imports.keys())
        if (index++ >= importsSize) imports.delete(path);
    }
    ctx.customTagImportNodes = importNodes;
    if (importNodes) importNodes.length = importCount!;
    if (calls && callLengths) {
      for (const [name, entries] of calls) {
        const length = callLengths.get(name);
        if (length === undefined) calls.delete(name);
        else entries.length = length;
      }
    }
  };
}

export function publishPartialIr(ctx: Ctx, ir: Ir): void {
  if (active?.root === ctx) active.receive(ir);
}
