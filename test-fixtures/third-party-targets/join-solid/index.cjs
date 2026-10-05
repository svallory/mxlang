// A target naming a built-in host: loaded targets cannot join it yet.
// `core` is the tool's own @mxlang/core, so errors it throws are the tool's class.
module.exports = {
  descriptorVersion: 0,
  name: "fake-join-solid",
  packageName: "@fake/mx-join-solid",
  defaultTag: "div",
  host: { name: "solid" },
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
