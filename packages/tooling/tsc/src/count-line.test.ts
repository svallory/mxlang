import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { watchForCountLine } from "./count-line.ts";

/**
 * `mx-tsc --help | head -1` crashed with an uncaught `EPIPE` from this
 * interceptor, where plain `tsc` exits 0: Bun throws the closed pipe from the
 * write, Node emits it as the stream's `error` event a tick later. A fake
 * stream plays both, so no process or pipe is needed.
 */
const epipe = () =>
  Object.assign(new Error("write EPIPE"), { code: "EPIPE", errno: -32 });

class FakeStream extends EventEmitter {
  readonly written: unknown[] = [];
  /** What `write` throws (Bun's closed pipe), when set. */
  throws?: Error;
  write = (chunk: unknown): boolean => {
    if (this.throws) throw this.throws;
    this.written.push(chunk);
    return true;
  };
}

describe("watchForCountLine on a stream whose reader went away", () => {
  it("drops the write instead of throwing when the write throws EPIPE (Bun)", () => {
    const stream = new FakeStream();
    const count = watchForCountLine(stream);
    try {
      expect(stream.write("tsc: The TypeScript Compiler\n")).toBe(true);
      stream.throws = epipe();
      expect(stream.write("COMMON COMMANDS\n")).toBe(false);
      // Later writes are dropped without reaching the closed pipe again.
      stream.throws = new Error("must not be reached");
      expect(stream.write("Found 1 error in a.ts:1\n")).toBe(false);
      expect(count.seen()).toBe(true);
      expect(stream.written).toEqual(["tsc: The TypeScript Compiler\n"]);
    } finally {
      count.stop();
    }
  });

  it("swallows an EPIPE error event (Node), even after the interceptor stopped", () => {
    const stream = new FakeStream();
    const count = watchForCountLine(stream);
    count.stop();
    // With no listener, `emit("error")` throws: Node's uncaught exception.
    expect(() => stream.emit("error", epipe())).not.toThrow();
    const again = watchForCountLine(stream);
    try {
      expect(stream.listenerCount("error")).toBe(1);
      expect(stream.write("dropped\n")).toBe(false);
      expect(stream.written).toEqual([]);
    } finally {
      again.stop();
    }
  });

  it("leaves any other write error as it was", () => {
    const stream = new FakeStream();
    const count = watchForCountLine(stream);
    try {
      stream.throws = Object.assign(new Error("write EIO"), { code: "EIO" });
      expect(() => stream.write("x\n")).toThrow("write EIO");
      const eio = Object.assign(new Error("EIO event"), { code: "EIO" });
      expect(() => stream.emit("error", eio)).toThrow("EIO event");
    } finally {
      count.stop();
    }
  });
});
