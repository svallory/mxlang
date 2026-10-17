import { createSignal } from "solid-js";

export function Attrs(props: { extra?: Record<string, unknown> }) {
  const [active, setActive] = createSignal(false);
  const [color, setColor] = createSignal("red");
  let el: HTMLDivElement | undefined;

  return (
    <div
      id="panel"
      data-count={color()}
      disabled={true}
      {...props.extra}
      class={{ active: active() }}
      style={{ color: color() }}
      ref={el}
      onScroll={(_e) => {
        setActive(true);
        setColor("blue");
      }}
      prop:value={color()}
    >
      {/* The MX source writes `static` on its own indented line before this
          element. Under the line-based whitespace rule the
          indentation is dropped, not collapsed to a space, so the twin says
          `static` with nothing after it. */}
      static
      <p class={["badge big", { on: active() }]}>shorthand plus object</p>
    </div>
  );
}
