// A target whose host overrides the target's built-in defaultTag (decision 145).
// Its compile echoes the default tag it was handed, so a test can see the ladder.
module.exports = {
  descriptorVersion: 0,
  name: "fake-override",
  packageName: "@fake/mx-host-override",
  defaultTag: "div",
  host: { name: "fake-override-host", defaultTag: "section" },
  load() {
    return {
      compileModule(_source, _filename, options) {
        return { code: `default-tag:${options.defaultTag}`, dependencies: [] };
      },
    };
  },
};
