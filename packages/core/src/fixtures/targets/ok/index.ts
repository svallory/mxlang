import type { TargetDescriptor } from "../../../target-descriptor.ts";

/**
 * A well-formed third-party target: it compiles through the `core` the tool
 * injects into `load`, never one of its own.
 */
const descriptor: TargetDescriptor = {
  descriptorVersion: 0,
  name: "acme-jsx",
  packageName: "@acme/mx-ok",
  defaultTag: "node",
  host: {
    name: "acme",
    fileKinds: [{ segment: "acme", diagnosticSource: "acmemx" }],
  },
  load(core) {
    return {
      compileModule(source, filename) {
        if (source.includes("BOOM")) {
          throw new core.TranslateError("boom", 1, 0, filename);
        }
        return {
          code: `export default ${JSON.stringify(source)};`,
          dependencies: [],
        };
      },
    };
  },
};

export default descriptor;
