export interface Input {
  label: string;
  names: { id: number; text: string }[];
}

export default function Greeter({ label, names }: Input) {
  return (
    <section>
      <h1>{label}</h1>
      {names.length > 2 && <p>That is plenty.</p>}
      <ul>
        {names.map((name) => (
          <li key={name.id}>{name.text}</li>
        ))}
      </ul>
    </section>
  );
}
