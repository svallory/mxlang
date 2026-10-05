// A host that does not permit per-tag default tags (decision 145): a contract
// declaring defaultTag is a registration error naming the host, and a compile
// never resolves the unnamed tag through the contract. Its compile reports the
// element names it lowered, so a test can see which rung answered.
const declarations = {
  tags: {},
  isElement: () => true,
  isComponent: () => false,
  allowContractDefaultTag: false,
};

module.exports = {
  descriptorVersion: 0,
  name: "fake-forbid",
  packageName: "@fake/mx-forbids-contract",
  defaultTag: "div",
  declarations: { default: declarations },
  host: { name: "fake-forbid-host", allowContractDefaultTag: false },
  load(core) {
    declarations.resolveDefaultTag = (_node, parents, context) =>
      core.contractDefaultTag(parents, context, ["div"]) ??
      context.configured ??
      "div";
    return {
      compileModule(source, filename, options) {
        let names = [];
        const walk = (nodes) => {
          for (const node of nodes) {
            if (node.kind === "Element") names.push(node.name);
            if (node.children) walk(node.children);
          }
        };
        core.compileSource(source, filename, declarations, {
          targets: options.targets,
          customTags: options.customTags,
          defaultTag: options.defaultTag,
          taglibs: [],
          tagDiscoveryDirs: [],
          emitIr(ir) {
            walk(ir.body);
            return "";
          },
        });
        return { code: `elements:${names.join(",")}`, dependencies: [] };
      },
    };
  },
};
