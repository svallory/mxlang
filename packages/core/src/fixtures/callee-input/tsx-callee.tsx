interface Draft {
  discarded?: AttrTag;
}

export interface Input {
  header?: AttrTag<{ as: "renderable" }>;
}

export function Card(props: Input) {
  return <section>{props.title}</section>;
}
