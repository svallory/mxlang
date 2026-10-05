// A well-formed descriptor whose own defaultTag names no tag its target has.
module.exports = {
  descriptorVersion: 0,
  name: "fake-bad-default",
  packageName: "@fake/mx-bad-default-tag",
  defaultTag: "nonexistent",
  host: { name: "fake-bad-default-host" },
};
