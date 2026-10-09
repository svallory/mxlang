// A host whose `ambientTypes` throws for every program. The type-check tools
// must report one diagnostic naming this package and go on without its files.
module.exports = {
  descriptorVersion: 0,
  name: "fake-ambient-throws",
  packageName: "@fake/mx-ambient-types-throws",
  defaultTag: "div",
  host: {
    name: "ambthrow",
    fileKinds: [{ segment: "ambthrow", diagnosticSource: "ambthrow" }],
    ambientTypes() {
      throw new Error("cannot find astro install");
    },
  },
  load() {
    return {
      compileModule(source) {
        return {
          code:
            "export default function Page(): string {\n  return " +
            JSON.stringify(source) +
            ";\n}\n",
          dependencies: [],
        };
      },
    };
  },
};
