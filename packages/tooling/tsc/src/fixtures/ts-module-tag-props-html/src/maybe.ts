export interface Input {
  title: string;
}
const maybe: ((input: Input) => string) | undefined = (input) => input.title;
export default maybe;
