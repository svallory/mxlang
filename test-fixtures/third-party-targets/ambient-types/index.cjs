// A host declaring `host.ambientTypes`: a program that holds one of its `.amb.mx`
// files gets this package's `ambient.d.ts`, which declares `fakeAmbientGlobal`.
module.exports = {
  descriptorVersion: 0,
  name: "fake-ambient",
  packageName: "@fake/mx-ambient-types",
  defaultTag: "div",
  host: {
    name: "amb",
    fileKinds: [{ segment: "amb", diagnosticSource: "amb" }],
    ambientTypes({ rootNames, resolve }) {
      if (!rootNames.some((name) => name.endsWith(".amb.mx"))) return [];
      const file = resolve("@fake/mx-ambient-types/ambient.d.ts");
      return file ? [file] : [];
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
