// A host whose declarations permit the contract rung (decision 145): no registration error and the compile honours the contract.
// Its compile reports the element names it lowered, so a test can see which rung answered.
const declarations = {
  tags: {},
  isElement: () => true,
  isComponent: () => false,
};

module.exports = {
  descriptorVersion: 0,
  name: "fake-permits",
  packageName: "@fake/mx-permits-host",
  defaultTag: "div",
  declarations: { default: declarations },
  host: { name: "fake-permits-host" },
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
