// A third-party target that imports its **own** @mxlang/core and ignores the injected
// one. It pins the brand check: the TranslateError it throws is another copy's class.
const own = require("@mxlang/core");

module.exports = {
  descriptorVersion: 0,
  name: "fake-own-core",
  packageName: "@fake/mx-own-core",
  host: { name: "fake-own" },
  load() {
    const core = own;
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
