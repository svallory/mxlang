/**
 * A host that declares `<script>` unsupported refuses the tag, and that
 * refusal is the tag's only diagnostic: the body is not parsed, and the head
 * and placeholder checks do not run. A host without the row keeps every
 * body error as it was.
 */
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import type { TranslateError } from "./core.ts";
import type { HostDeclarations } from "./declarations.ts";
import { lookup } from "./test-targets.ts";

const host = (script?: HostDeclarations["tags"][string]): HostDeclarations => ({
  name: "fixture-host",
  attrTags: 2,
  tags: script ? { script } : {},
  isElement: () => true,
  isComponent: () => false,
  isBuiltinTag: () => false,
  isDelegatedTag: () => false,
  resolveDelegatedTag: () => ({}),
  resolveAttributeMethod: () => true,
});

function attempt(
  source: string,
  declarations: HostDeclarations,
): TranslateError | undefined {
  try {
    compileSource(source, "/page.mx", declarations, {
      targets: lookup,
      emitIr: () => "",
    } as never);
  } catch (error) {
    return error as TranslateError;
  }
  return undefined;
}

const refusing = host({ kind: "unsupported", hint: "Write it elsewhere." });
const supporting = host();

const BAD_BODY = "<script>const = 1;</script>";

describe("a host that declares <script> unsupported", () => {
  it.each([
    ["a body that does not parse", BAD_BODY],
    ["a body that parses", "<script>go()</script>"],
    ["a head the tag has no use for", "<script(x)>go()</script>"],
    ["a placeholder in the body", "<script>go(${x})</script>"],
    ["a concise body that does not parse", "script\n  --\n  const = 1;\n  --"],
  ])("%s: the host refusal is the only error", (_name, source) => {
    const error = attempt(source, refusing);
    expect(error?.diagnosticCode).toBe("MX_UNSUPPORTED_CONSTRUCT");
    expect(error?.message).toBe(
      "`<script>` is not supported in embedded MX. Write it elsewhere.",
    );
    expect([error?.line, error?.column]).toEqual([1, 0]);
  });

  it("a nested script with a bad body", () => {
    const error = attempt(`<div>\n  ${BAD_BODY}\n</div>`, refusing);
    expect(error?.diagnosticCode).toBe("MX_UNSUPPORTED_CONSTRUCT");
    expect([error?.line, error?.column]).toEqual([2, 2]);
  });
});

describe("a host without the unsupported row", () => {
  it("keeps the body error of a body that does not parse", () => {
    const error = attempt(BAD_BODY, supporting);
    expect(error?.diagnosticCode).not.toBe("MX_UNSUPPORTED_CONSTRUCT");
    expect(error?.message).toContain("Unexpected token");
    expect([error?.line, error?.column]).toEqual([1, 14]);
  });

  it("keeps the head error", () => {
    const error = attempt("<script(x)>go()</script>", supporting);
    expect(error?.diagnosticCode).not.toBe("MX_UNSUPPORTED_CONSTRUCT");
  });

  it("accepts a valid body", () => {
    expect(attempt("<script>go()</script>", supporting)).toBeUndefined();
  });
});
