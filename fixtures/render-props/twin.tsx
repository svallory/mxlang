import { createSignal, type JSX } from "solid-js";

interface User {
  name: string;
}

function Layout(props: {
  header: { content: () => JSX.Element };
  footer: { content: (year: number) => () => JSX.Element };
  children: JSX.Element;
}) {
  // Each slot is wrapped in an element rather than sitting as a bare
  // placeholder run: MX drops the whitespace-only lines between siblings
  // where JSX keeps one space each, and the formatter insists on breaking
  // this body across lines. With real element boundaries the two agree.
  // See `fixtures/README.md`, "Whitespace in a twin".
  return (
    <section>
      <header>{props.header.content}</header>
      <main>{props.children}</main>
      <footer>{props.footer.content(2026)}</footer>
    </section>
  );
}

export function RenderProps() {
  // Setters are unused: the fixture exercises lowering shapes, not behavior.
  const [items, _setItems] = createSignal<string[]>([]);
  const [user, _setUser] = createSignal<User | null>(null);
  const errorFallback = (e: Error, _reset: () => void) => <p>{e.message}</p>;
  const loadingFallback = <p>Loading…</p>;

  return (
    <div>
      {/* params on Solid's own For */}
      <For each={items()}>
        {(item, i) => (
          <li>
            {i()}: {item()}
          </li>
        )}
      </For>
      {/* params on Show, with an attribute tag for its fallback */}
      <Show when={user()} fallback="Anonymous">
        {(u) => <b>{u().name}</b>}
      </Show>
      {/* attribute tag with params: Errored's fallback takes (e, reset) */}
      <Errored fallback={errorFallback}>
        <Risky />
      </Errored>
      {/* attribute tag without params: Loading's fallback is a body */}
      <Loading fallback={loadingFallback}>
        <Slow />
      </Loading>
      {/* a user component taking two attribute tags plus ordinary children */}
      <Layout
        header={{ content: () => <h1>Title</h1> }}
        footer={{ content: (year) => () => <small>{year}</small> }}
      >
        <p>body</p>
      </Layout>
    </div>
  );
}

function Risky() {
  return <span>risky</span>;
}

function Slow() {
  return <span>slow</span>;
}
