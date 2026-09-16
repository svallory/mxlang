import type {
  CustomTag,
  IrNode,
  TagCall,
  TransformContext,
} from "@mxlang/core";

const PATHS: Record<string, string[]> = {
  check: ["M20 6 9 17l-5-5"],
  x: ["M18 6 6 18", "M6 6l12 12"],
  plus: ["M12 5v14", "M5 12h14"],
};

function transform(call: TagCall, ctx: TransformContext): IrNode[] {
  const name = call.attrs.find(
    (attr) => attr.kind !== "spread" && attr.name === "name",
  );
  if (name?.kind !== "static") throw ctx.fail("requires a static `name`");

  // No fallback here: `size` declares `default: 24`, so the core supplies the
  // attribute when the call omits it. A fallback would hide a broken default.
  const size = call.attrs.find(
    (attr) => attr.kind !== "spread" && attr.name === "size",
  );
  if (size?.kind !== "dynamic" || size.value.node?.type !== "NumericLiteral") {
    throw ctx.fail("expected `size` to resolve to a numeric literal");
  }
  const pixels = size.value.code;
  const passthrough = call.attrs.filter(
    (attr) =>
      attr.kind === "spread" || (attr.name !== "name" && attr.name !== "size"),
  );

  return [
    ctx.build.element(
      "svg",
      [
        ctx.build.attr("xmlns", "http://www.w3.org/2000/svg"),
        ctx.build.attr("width", pixels),
        ctx.build.attr("height", pixels),
        ctx.build.attr("viewBox", "0 0 24 24"),
        ctx.build.attr("fill", "none"),
        ctx.build.attr("stroke", "currentColor"),
        ctx.build.attr("stroke-width", "2"),
        ...passthrough,
      ],
      [
        ctx.build.element("title", [], [ctx.build.text(name.value)]),
        ...PATHS[name.value].map((d) =>
          ctx.build.element("path", [ctx.build.attr("d", d)]),
        ),
      ],
    ),
  ];
}

const icon: CustomTag = {
  attributes: {
    name: {
      type: "string",
      required: true,
      literalOnly: true,
      enum: Object.keys(PATHS),
    },
    size: { type: "number", literalOnly: true, default: 24 },
    class: { type: "string" },
  },
  transform,
};

export default icon;
