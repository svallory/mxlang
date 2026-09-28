function Empty() {
  return <>no args</>;
}

function Row(item: number, i: number) {
  return (
    <li>
      {item}-{i}
    </li>
  );
}

function Card(title: string, head: () => unknown) {
  return (
    <section>
      <h1>{title}</h1>
      {head()}
    </section>
  );
}

export function DefineHoist() {
  return (
    <div>
      {Empty()}
      {Row(1, 0)}
      {Card("Hi", () => "tagged")}
    </div>
  );
}
