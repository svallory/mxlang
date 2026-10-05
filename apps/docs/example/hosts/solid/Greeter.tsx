import { createSignal, For, Show } from "solid-js";

export function Greeter(props: {
  label: string;
  names: { id: number; text: string }[];
}) {
  const [count, setCount] = createSignal(0);

  return (
    <section>
      <h1>{props.label}</h1>
      <button onClick={() => setCount(count() + 1)}>clicked {count()}</button>
      <Show when={count() > 2}>
        <p>That is plenty.</p>
      </Show>
      <ul>
        <For each={props.names}>{(name) => <li>{name.text}</li>}</For>
      </ul>
    </section>
  );
}
