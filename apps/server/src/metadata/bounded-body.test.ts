import { describe, expect, test } from "bun:test";
import { readBoundedBytes } from "./bounded-body.ts";

function streamOf(bytes: Uint8Array, chunkBytes: number) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.byteLength; at += chunkBytes)
        controller.enqueue(bytes.subarray(at, at + chunkBytes));
      controller.close();
    },
  });
}

describe("readBoundedBytes", () => {
  test("joins many small chunks past the initial buffer", async () => {
    const bytes = new Uint8Array(200_000).map((_, index) => index % 251);
    const read = await readBoundedBytes(
      streamOf(bytes, 7),
      bytes.byteLength,
      () => new Error("too large"),
    );
    expect(read).toEqual(bytes);
  });

  test("rejects once the body passes the limit", async () => {
    await expect(
      readBoundedBytes(
        streamOf(new Uint8Array(1_001), 100),
        1_000,
        () => new Error("too large"),
      ),
    ).rejects.toThrow("too large");
  });
});
