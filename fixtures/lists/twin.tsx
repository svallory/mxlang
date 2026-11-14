import { createSignal } from "solid-js";

interface Row {
  id: number;
  label: string;
}

export function Lists() {
  // Setters are unused: the fixture exercises lowering shapes, not behavior.
  const [rows, _setRows] = createSignal<Row[]>([]);
  const [count, _setCount] = createSignal(3);
  const [meta, _setMeta] = createSignal<Record<string, string>>({});

  return (
    <div>
      {/* custom key by field name: by="id" */}
      <For each={rows()} keyed={(x) => x.id}>
        {(row, i) => (
          <li>
            {i()}: {row().label}
          </li>
        )}
      </For>
      {/* custom key by function: by=(fn) */}
      <For each={rows()} keyed={(r) => r.label}>
        {/* biome-ignore lint/correctness/noUnusedFunctionParameters: mirrors the MX `<for|row, i|>` param list */}
        {(row, i) => <li>{row().label}</li>}
      </For>
      {/* inclusive range: from=1 to=count() */}
      <Repeat count={count() - 1 + 1} from={1}>
        {(i) => <span>{i}</span>}
      </Repeat>
      {/* exclusive range with literal bounds, folded at lowering time */}
      <Repeat count={4}>{(i) => <b>{i}</b>}</Repeat>
      {/* stepped range: positive step */}
      <Repeat count={5}>{(__mxIndex0) => <em>{0 + __mxIndex0 * 2}</em>}</Repeat>
      {/* stepped range: negative step counting down */}
      <Repeat count={6}>
        {(__mxIndex1) => <em>{10 + __mxIndex1 * -2}</em>}
      </Repeat>
      {/* stepped range: until= with step= uses the exclusive bound */}
      <Repeat count={4}>{(__mxIndex2) => <em>{0 + __mxIndex2 * 3}</em>}</Repeat>
      {/* object entries, keyed by the entry key */}
      {/*
        `keyed={fn}` makes Solid pass the entry as an accessor, so the pair
        cannot be destructured in the parameter list: `([k, v]) => …` throws
        `TypeError: {} is not iterable` at render time (measured against
        `@solidjs/web`'s `renderToString`). The entry is read through the
        accessor instead, which is what MX now emits.
      */}
      <For each={Object.entries(meta() ?? {})} keyed={(e) => e[0]}>
        {(__mxEntry3) => (
          <p>
            {__mxEntry3()[0]}={__mxEntry3()[1]}
          </p>
        )}
      </For>
    </div>
  );
}
