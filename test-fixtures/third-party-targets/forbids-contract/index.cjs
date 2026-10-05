// A host that does not permit per-tag default tags (decision 145): a contract
// declaring defaultTag is a registration error naming the host.
module.exports = {
  descriptorVersion: 0,
  name: "fake-forbid",
  packageName: "@fake/mx-forbids-contract",
  defaultTag: "div",
  host: { name: "fake-forbid-host", allowContractDefaultTag: false },
};
