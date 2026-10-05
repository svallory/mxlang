// A target with no host whose declarations forbid the contract rung (decision 145): registration must say so, naming the target, and the compile must agree.
// Its compile reports the element names it lowered, so a test can see which rung answered.
const declarations = {
  tags: {},
  isElement: () => true,
  isComponent: () => false,
  allowContractDefaultTag: false,
};

module.exports = {
  descriptorVersion: 0,
  name: "fake-nohost",
  packageName: "@fake/mx-forbids-nohost",
  defaultTag: "div",
  declarations: { default: declarations },
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
