// A third-party target that uses the **injected** core (OQ10): it imports nothing.
// `core` is the tool's own @mxlang/core, so errors it throws are the tool's class.
module.exports = {
  descriptorVersion: 0,
  name: "fake-ok",
  packageName: "@fake/mx-ok",
  host: { name: "fake-host" },
  load(core) {
    if (typeof core.TranslateError !== "function") {
      throw new Error("the injected core has no TranslateError");
    }
    return {
      compileModule(source, filename, options) {
        const at = source.indexOf("FAIL");
        if (at >= 0) {
          throw new core.TranslateError("fake target rejects FAIL", 1, at);
        }
        options.warnings?.push({
          message: "fake target compiled " + filename.split("/").pop(),
          line: 1,
          column: 0,
        });
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
