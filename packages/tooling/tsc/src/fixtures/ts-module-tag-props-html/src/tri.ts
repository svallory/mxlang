export default function tri(input: { z: string }): string;
export default function tri(input: { a: string }): string;
export default function tri(input: { a: string }, n?: number): string;
export default function tri(input: {
  z?: string;
  a?: string;
  b?: number;
}): string {
  return String(input.z ?? input.a ?? input.b);
}
