// A host whose `ambientTypes` misbehaves on demand: a root file named
// `<mode>.ts` picks what it does. `throw.ts` throws; `number.ts`, `object.ts`,
// `undefined.ts` and `string.ts` return a value that is no iterable of files;
// `generator.ts` returns a generator that throws while it is read;
// `undefined-entry.ts` returns `[resolve(<a file the package lacks>)]`, which is
// `[undefined]`, and `number-entry.ts` returns `[42]`. A program with none of
// them gets `[]`.
const MODES = {
  throw() {
    throw new Error("asked to throw");
  },
  number: () => 42,
  object: () => ({}),
  undefined: () => undefined,
  string: () => "ambient.d.ts",
  "undefined-entry": ({ resolve }) => [
    resolve("@fake/mx-ambient-types-misbehaves/not-there.d.ts"),
  ],
  "number-entry": () => [42],
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
    ambientTypes(program) {
      for (const name of program.rootNames) {
        const mode = name.split("/").pop().replace(/\.ts$/, "");
        if (Object.hasOwn(MODES, mode)) return MODES[mode](program);
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
