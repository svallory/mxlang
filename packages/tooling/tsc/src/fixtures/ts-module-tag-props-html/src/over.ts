export default function over(input: { a: string }): string;
export default function over(input: { b: number }): string;
export default function over(input: { a?: string; b?: number }): string {
  return String(input.a ?? input.b);
}
