import type {
  CustomTag,
  IrNode,
  TagCall,
  TransformContext,
} from "@mxlang/core";

/**
 * The same `<icon>` the six-host fixture uses, reached here with no import at
 * all: it is discovered because it sits in this project's `tags/` directory.
 */
const PATHS: Record<string, string[]> = {
  check: ["M20 6 9 17l-5-5"],
  x: ["M18 6 6 18", "M6 6l12 12"],
};

function transform(call: TagCall, ctx: TransformContext): IrNode[] {
  const name = call.attrs.find(
    (attr) => attr.kind !== "spread" && attr.name === "name",
  );
  if (name?.kind !== "static") throw ctx.fail("requires a static `name`");

  return [
    ctx.build.element(
      "svg",
      [
        ctx.build.attr("xmlns", "http://www.w3.org/2000/svg"),
        ctx.build.attr("viewBox", "0 0 24 24"),
      ],
      [
        ctx.build.element("title", [], [ctx.build.text(name.value)]),
        ...(PATHS[name.value] ?? []).map((d) =>
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
  },
  transform,
};

export default icon;
