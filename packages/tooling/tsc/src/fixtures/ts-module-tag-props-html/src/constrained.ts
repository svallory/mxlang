export default function g<P extends { a: string }>(input: P): string {
  return input.a;
}
