/**
 * Signature-only stand-in for `@mxlang/target-html`'s runtime surface, used as the
 * `runtime.ts` of the strict-tsc case in `translate.test.ts`. Re-exporting from
 * the real entry points would make tsc check the whole host + core graph on
 * every run. `lean-runtime.check.ts` fails the typecheck gate if any name here
 * drifts from the real one. Test-only: excluded from the build.
 */
// biome-ignore lint/suspicious/noShadowRestrictedNames: must match the real export name
export declare function escape(value: unknown): string;

export interface Out {
  write(html: string): void;
  toString(): string;
}
export interface BufferedOut extends Out {
  commit(): void;
}
export declare function createOut(): Out;
export declare function createBufferedOut(parent: Out): BufferedOut;

type AttrTagRecord<T> = T & {
  [Symbol.iterator](): Iterator<T>;
  readonly length: number;
  at(index: number): T | undefined;
  map<U>(fn: (item: T, index: number) => U): U[];
  filter(fn: (item: T, index: number) => unknown): T[];
  toArray(): T[];
};
export type AttrTag<
  // biome-ignore lint/complexity/noBannedTypes: mirrors the public AttrTag default
  T extends object = {},
> = AttrTagRecord<
  "content" extends keyof T ? T : T & { content?: () => string }
>;
