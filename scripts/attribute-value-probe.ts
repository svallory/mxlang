/** Real render subprocess shared by the hosts' attribute-value regression tests. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const host = process.argv[2];
if (
  !host ||
  !["html", "preact", "react", "hono", "solid", "astro", "marko"].includes(host)
) {
  throw new Error(`Unknown attribute-value probe host: ${host}`);
}
const packageDir =
  host === "marko"
    ? join(root, "packages/oracle")
    : join(root, "packages", host === "html" ? "targets" : "hosts", host);
const require = createRequire(join(packageDir, "package.json"));
const scratch = mkdtempSync(join(packageDir, ".attr-value-render-"));
const values: Record<string, unknown> = {
  plain: { a: 1 },
  function: () => 1,
  symbol: Symbol("s"),
  array: [1, 2],
  nullproto: Object.create(null),
  custom: { toString: () => "custom" },
  date: new Date("2020-01-01T00:00:00Z"),
  zero: 0,
  null: null,
};
const results: {
  form: string;
  value: string;
  html?: string;
  error?: string;
}[] = [];
let serial = 0;

async function compile(
  source: string,
): Promise<(input: Record<string, unknown>) => Promise<string>> {
  const file = join(
    scratch,
    `case${serial++}.${["preact", "react", "hono"].includes(host) ? "tsx" : "ts"}`,
  );
  let code: string;
  if (host === "marko") {
    const compiler = await import(
      pathToFileURL(require.resolve("@marko/compiler")).href
    );
    const translator = await import(
      pathToFileURL(require.resolve("marko/translator")).href
    );
    const markoFile = `${file}.marko`;
    writeFileSync(markoFile, source);
    code = (
      await compiler.compileFile(markoFile, {
        translator,
        output: "html",
        modules: "esm",
        optimize: false,
      })
    ).code;
  } else if (host === "html") {
    code = (await import("../packages/targets/html/src/index.ts")).compile(
      source,
      file,
    ).code;
  } else if (host === "preact") {
    code = (
      await import("../packages/hosts/preact/src/index.ts")
    ).compilePreactMx(source, file).code;
  } else if (host === "react") {
    code = (
      await import("../packages/hosts/react/src/index.ts")
    ).compileReactMx(source, file).code;
  } else if (host === "hono") {
    code = (await import("../packages/hosts/hono/src/index.ts")).compileHonoMx(
      source,
      file,
    ).code;
  } else if (host === "solid") {
    const { compileSolidMx } = await import(
      "../packages/hosts/solid/src/index.ts"
    );
    const { transformSync } = await import("@babel/core");
    const typescript = (
      await import(
        pathToFileURL(require.resolve("@babel/preset-typescript")).href
      )
    ).default;
    const solid = (
      await import(pathToFileURL(require.resolve("@solidjs/babel-plugin")).href)
    ).default;
    const emitted = compileSolidMx(source, { filename: file });
    const jsx =
      emitted.code.startsWith("{") && emitted.code.endsWith("}")
        ? emitted.code.slice(1, -1)
        : emitted.code;
    const transformed = transformSync(
      `import { Dynamic } from "@solidjs/web"; ${emitted.hoistedImports.map((entry) => entry.code).join("\n")}\n${emitted.hoistedDefines.map((entry) => entry.code).join("\n")}\nexport function App(input) { return ${jsx}; }`,
      {
        filename: "case.tsx",
        presets: [[typescript, {}]],
        plugins: [[solid, { generate: "ssr", hydratable: false }]],
        babelrc: false,
        configFile: false,
      },
    );
    if (!transformed?.code) throw new Error("Solid compiler produced no code");
    code = transformed.code;
  } else {
    const { lowerAstroMx } = await import(
      "../packages/hosts/astro/src/astro-template.ts"
    );
    const astroRequire = createRequire(require.resolve("astro/package.json"));
    const compiler = await import(
      pathToFileURL(astroRequire.resolve("@astrojs/compiler-rs")).href
    );
    const lowered = lowerAstroMx(
      `---\nconst props = Astro.props;\n---\n${source.replace(/\binput\./g, "props.")}`,
      file,
    ).code;
    code = (await compiler.transform(lowered, { filename: file })).code
      .replace(", createMetadata as $$createMetadata", "")
      .replace(
        /export const \$\$metadata = \$\$createMetadata\([\s\S]*?\n\}\);\n/,
        "",
      );
  }
  code = code.replace(/(["'])(astro\/[^"']+)\1/g, (_match, _quote, specifier) =>
    JSON.stringify(require.resolve(specifier)),
  );
  writeFileSync(file, code);
  const module = await import(pathToFileURL(file).href);
  if (host === "marko")
    return async (input) => String(await module.default.render(input));
  if (host === "html") return async (input) => module.default(input);
  if (host === "preact") {
    const { render } = await import("preact-render-to-string");
    const { h } = await import("preact");
    return async (input) => render(h(module.default, input));
  }
  if (host === "react") {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    return async (input) =>
      renderToStaticMarkup(createElement(module.default, input));
  }
  if (host === "hono") {
    const { jsx } = await import("hono/jsx");
    return async (input) => String(await jsx(module.default, input).toString());
  }
  if (host === "solid") {
    const { renderToString } = await import("@solidjs/web");
    return async (input) => renderToString(() => module.App(input));
  }
  const { experimental_AstroContainer: AstroContainer } = await import(
    pathToFileURL(require.resolve("astro/container")).href
  );
  const container = await AstroContainer.create();
  return async (input) =>
    container.renderToString(module.default, { props: input });
}

async function probe(
  form: string,
  source: string,
  inputs: Record<string, Record<string, unknown>>,
) {
  const render = await compile(source);
  for (const [value, input] of Object.entries(inputs)) {
    try {
      results.push({ form, value, html: await render(input) });
    } catch (error) {
      results.push({
        form,
        value,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

try {
  if (process.argv[3] === "--textarea") {
    // `<textarea value=x/>` renders the value as content in Marko 6.3.51.
    const textareaValues: Record<string, unknown> = {
      zero: 0,
      empty: "",
      null: null,
      undefined: undefined,
      false: false,
      true: true,
      str: "hello",
      special: "a<b>&\"'c",
      newline: "\nx",
    };
    const inputs = Object.fromEntries(
      Object.entries(textareaValues).map(([value, v]) => [
        value,
        { v, tag: "textarea", attrs: { value: v } },
      ]),
    );
    const forms: Record<string, string> = {
      static: '<textarea value="abc"/>',
      dynamic: "<textarea value=input.v/>",
      dynamicOthers: '<textarea value=input.v class="c" name="n"/>',
      bodyOnly: "<textarea>hi &amp; <b></textarea>",
      spread: "<textarea ...input.attrs/>",
      spreadBody: "<textarea ...input.attrs>x</textarea>",
      spreadThenValue: '<textarea ...{value:"spread"} value=input.v/>',
      valueThenSpread: "<textarea value=input.v ...input.attrs/>",
      valueBetweenSpreads:
        '<textarea ...{value:"a"} value=input.v ...{title:"t"}/>',
      valueAndBody: "<textarea value=input.v>body</textarea>",
      dynamicTag: `<\${input.tag} value=input.v/>`,
      dynamicTagArgs: `<\${input.tag}(input.attrs)/>`,
    };
    for (const [form, source] of Object.entries(forms)) {
      try {
        await probe(form, source, inputs);
      } catch (error) {
        for (const value of Object.keys(textareaValues))
          results.push({
            form,
            value,
            error: error instanceof Error ? error.message : String(error),
          });
      }
    }
    // Exit from the write callback: exiting first truncates a piped stdout.
    process.stdout.write(JSON.stringify(results), () => {
      rmSync(scratch, { recursive: true, force: true });
      process.exit(0);
    });
    await new Promise(() => {});
  }
  if (process.argv[3] === "--primitives") {
    const primitives = {
      null: null,
      undefined: undefined,
      false: false,
      true: true,
      zero: 0,
      empty: "",
      NaN: NaN,
    };
    for (const name of [
      "title",
      "data-x",
      "aria-hidden",
      "is:raw",
      "disabled",
      "hidden",
      "checked",
      "class",
      "style",
    ]) {
      const tag = name === "checked" ? "input" : "div";
      const inputs = Object.fromEntries(
        Object.entries(primitives).map(([value, v]) => [
          value,
          { v, name, tag, attrs: { [name]: v } },
        ]),
      );
      const forms: Record<string, string> = {
        direct: `<${tag} ${name}=input.v/>`,
        spread: `<${tag} ...input.attrs/>`,
        folded: `<${tag} ${name}=input.v ...{}/>`,
        tail: `<${tag} ...{} ${name}=input.v/>`,
        dynamicName: `<${tag} ...{[input.name]:input.v}/>`,
        dynamic: `<\${input.tag} ${name}=input.v/>`,
        dynamicArgs: `<\${input.tag}(input.attrs)/>`,
        bound: `<${tag} ${name}:=input.v/>`,
      };
      for (const [form, source] of Object.entries(forms)) {
        try {
          await probe(`${name}/${form}`, source, inputs);
        } catch (error) {
          for (const value of Object.keys(primitives))
            results.push({
              form: `${name}/${form}`,
              value,
              error: error instanceof Error ? error.message : String(error),
            });
        }
      }
    }
    for (const form of [
      "direct",
      "spread",
      "folded",
      "tail",
      "dynamicName",
      "dynamic",
      "dynamicArgs",
      "bound",
    ]) {
      let reads = 0;
      const input = {
        tag: "div",
        name: "data-x",
        get v() {
          reads++;
          return null;
        },
        get attrs() {
          return { "data-x": this.v };
        },
      };
      const sources: Record<string, string> = {
        direct: "<div data-x=input.v/>",
        spread: "<div ...input.attrs/>",
        folded: "<div data-x=input.v ...{}/>",
        tail: "<div ...{} data-x=input.v/>",
        dynamicName: "<div ...{[input.name]:input.v}/>",
        dynamic: `<\${input.tag} data-x=input.v/>`,
        dynamicArgs: `<\${input.tag}(input.attrs)/>`,
        bound: "<div data-x:=input.v/>",
      };
      try {
        const source = sources[form];
        if (!source) throw new Error(`Missing primitive form: ${form}`);
        await probe(`once/${form}`, source, { null: input });
      } catch (error) {
        results.push({
          form: `once/${form}`,
          value: "null",
          error: String(error),
        });
      }
      results.push({
        form: `reads/${form}`,
        value: "null",
        html: String(reads),
      });
    }
  } else {
    const inputs = Object.fromEntries(
      Object.entries(values).map(([name, o]) => [
        name,
        { o, attrs: { "data-x": o }, tag: "div" },
      ]),
    );
    for (const [form, source] of Object.entries({
      direct: "<div data-x=input.o/>",
      spread: "<div ...input.attrs/>",
      folded: '<div id="test" ...input.attrs data-x=input.o/>',
      colon: "<div is:raw=input.o/>",
      foldedColon: '<div ...{"id":"test"} is:raw=input.o/>',
      inputSpread: '<input ...input.attrs type="text"/>',
    }))
      await probe(form, source, inputs);
    await probe(
      "overwritten",
      '<div data-x=input.o ...{"data-x":"safe"}/>',
      inputs,
    );
    await probe(
      "overwrittenSpread",
      '<div ...input.attrs data-x="safe"/>',
      inputs,
    );
    await probe(
      "overwrittenColon",
      '<div is:raw=input.o ...{"is:raw":"safe"}/>',
      inputs,
    );
    await probe(
      "survivingSpread",
      '<div data-x="safe" ...input.attrs/>',
      inputs,
    );
    await probe(
      "structured",
      '<div class={a:true,b:false} style={color:"red"}/>',
      { plain: { o: values.plain } },
    );
    await probe("classAcrossSpread", "<div class=input.o ...{}/>", {
      plain: { o: values.plain },
    });
    await probe("spreadStructured", "<div ...input.styled/>", {
      plain: { styled: { class: { a: true }, style: { color: "red" } } },
    });
    for (const [form, source] of Object.entries({
      checked: "<input checked=input.o/>",
      open: "<details open=input.o/>",
      selectValue: "<select value=input.o/>",
    })) {
      await probe(form, source, { plain: { o: values.plain } });
    }
    let reads = 0;
    const once = Object.defineProperty({}, "o", {
      enumerable: true,
      get: () => {
        reads++;
        return "once";
      },
    });
    await probe("once", "<div data-x=input.o/>", { getter: once });
    results.push({ form: "reads", value: "getter", html: String(reads) });
    for (const [form, source] of Object.entries({
      coercion: "<div data-x=input.o/>",
      coercionSpread: "<div ...input.attrs/>",
    })) {
      let coercions = 0;
      const o = {
        toString: () => {
          coercions++;
          return coercions === 1 ? "first" : "second";
        },
      };
      await probe(form, source, { custom: { o, attrs: { "data-x": o } } });
      results.push({
        form: `${form}Count`,
        value: "custom",
        html: String(coercions),
      });
    }
    if (host !== "astro" && host !== "marko") {
      await probe("dynamic", `<\${input.tag} data-x=input.o/>`, inputs);
      await probe("dynamicArgs", `<\${input.tag}(input.attrs)/>`, inputs);
      await probe("component", `<\${input.tag} data-x=input.o/>`, {
        plain: {
          o: values.plain,
          tag: (props: Record<string, { a: number }>) =>
            String(props["data-x"]?.a),
        },
      });
    }
    if (host !== "astro") {
      await probe(
        "dynamicDataTag",
        `<\${input.tag}><@meta data=input.o/></>`,
        inputs,
      );
    }
  }
  process.stdout.write(JSON.stringify(results));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
