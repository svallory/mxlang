/** Shared helpers live in a `.ts` module — a `.mx` file compiles to a template. */
export function money(amount: number, currency: string): string {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
  }).format(amount);
}
