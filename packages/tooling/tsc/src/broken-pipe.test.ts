import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { guardBrokenPipe } from "./broken-pipe.ts";

/**
 * `mx-tsc --help | head -1` crashed with an uncaught `EPIPE` where plain `tsc`
 * exits 0: Bun throws the closed pipe from the write, Node emits it as the
 * stream's `error` event a tick later. A fake stream plays both, so no process
 * or pipe is needed.
 */
const epipe = () =>
  Object.assign(new Error("write EPIPE"), { code: "EPIPE", errno: -32 });

class FakeStream extends EventEmitter {
  readonly written: unknown[] = [];
  /** What `write` throws (Bun's closed pipe), when set. */
  throws?: Error;
  write = (chunk: unknown, ..._rest: unknown[]): boolean => {
    if (this.throws) throw this.throws;
    this.written.push(chunk);
    return true;
  };
}

/** An interceptor installed over the guard and removed again, as mx-tsc's are. */
function interceptAndStop(stream: FakeStream): void {
  const inner = stream.write;
  stream.write = (chunk, ...rest) => inner(chunk, ...rest);
  stream.write = inner;
}

describe("guardBrokenPipe", () => {
  it("drops every write from a thrown EPIPE on (Bun), after an interceptor stopped too", async () => {
    const stream = new FakeStream();
    guardBrokenPipe(stream);
    expect(stream.write("tsc: The TypeScript Compiler\n")).toBe(true);
    stream.throws = epipe();
    expect(() => stream.write("COMMON COMMANDS\n")).not.toThrow();
    interceptAndStop(stream);
    stream.throws = new Error("must not be reached");
    const failed = new Promise((resolve) =>
      stream.write("dry run report\n", resolve),
    );
    expect(stream.written).toEqual(["tsc: The TypeScript Compiler\n"]);
    // A caller waiting on the write's callback is answered with the EPIPE.
    expect(await failed).toMatchObject({ code: "EPIPE" });
  });

  it("swallows an EPIPE error event (Node) and drops the writes after it", () => {
    const stream = new FakeStream();
    guardBrokenPipe(stream);
    // With no listener, `emit("error")` throws: Node's uncaught exception.
    expect(() => stream.emit("error", epipe())).not.toThrow();
    guardBrokenPipe(stream);
    stream.write("dropped\n");
    expect(stream.written).toEqual([]);
    expect(() => stream.emit("error", epipe())).not.toThrow();
  });

  it("leaves any other write error as it was", () => {
    const stream = new FakeStream();
    guardBrokenPipe(stream);
    stream.throws = Object.assign(new Error("write EIO"), { code: "EIO" });
    expect(() => stream.write("x\n")).toThrow("write EIO");
    const eio = Object.assign(new Error("EIO event"), { code: "EIO" });
    expect(() => stream.emit("error", eio)).toThrow("EIO event");
  });
});
