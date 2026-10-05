import { useState } from "react";

export interface Input {
  label: string;
  names: { id: number; text: string }[];
}

export default function Greeter({ label, names }: Input) {
  const [count, setCount] = useState(0);
  return (
    <section>
      <h1>{label}</h1>
      <button onClick={() => setCount(count + 1)}>clicked {count}</button>
      {count > 2 && <p>That is plenty.</p>}
      <ul>
        {names.map((name) => (
          <li key={name.id}>{name.text}</li>
        ))}
      </ul>
    </section>
  );
}
