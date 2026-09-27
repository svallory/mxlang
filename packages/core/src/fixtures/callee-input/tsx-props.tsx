export interface Props {
  header?: AttrTag;
}

// biome-ignore lint/correctness/noUnusedFunctionParameters: only the exported type matters to this fixture
export function Card(props: Props) {
  return <section />;
}
