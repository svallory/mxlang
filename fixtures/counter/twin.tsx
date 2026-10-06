import { createSignal } from "solid-js";

export function Counter() {
  const [count, setCount] = createSignal(0);

  return (
    <button
      onClick={function () {
        setCount(count() + 1);
      }}
    >
      {count()}
    </button>
  );
}
