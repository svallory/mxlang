// A host whose `ambientTypes` misbehaves on demand: a root file named
// `<mode>.ts` picks what it does. `throw.ts` throws; `number.ts`, `object.ts`,
// `undefined.ts` and `string.ts` return a value that is no iterable of files;
// `generator.ts` returns a generator that throws while it is read. A program
// with none of them gets `[]`.
const MODES = {
  throw() {
    throw new Error("asked to throw");
  },
  number: () => 42,
  object: () => ({}),
  undefined: () => undefined,
  string: () => "ambient.d.ts",
  generator: () =>
    (function* files() {
      yield* [];
      throw new Error("generator failed");
    })(),
};

module.exports = {
  descriptorVersion: 0,
  name: "fake-ambient-misbehaves",
  packageName: "@fake/mx-ambient-types-misbehaves",
  defaultTag: "div",
  host: {
    name: "ambmis",
    fileKinds: [{ segment: "ambmis", diagnosticSource: "ambmis" }],
    ambientTypes({ rootNames }) {
      for (const name of rootNames) {
        const mode = name.split("/").pop().replace(/\.ts$/, "");
        if (Object.hasOwn(MODES, mode)) return MODES[mode]();
      }
      return [];
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
