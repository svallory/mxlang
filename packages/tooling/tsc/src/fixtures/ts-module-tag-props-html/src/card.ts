export interface Input {
  title: string;
}
export default function card(input: Input): string {
  return `<h1>${input.title}</h1>`;
}
