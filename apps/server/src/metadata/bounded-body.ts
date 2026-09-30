const initialBufferBytes = 64 * 1024;

/**
 * Reads a response body into one growing buffer, throwing `tooLarge()` once it
 * passes `maxBytes`. Copying each chunk on arrival keeps memory near the body
 * size even when a server streams it in tiny pieces.
 */
export async function readBoundedBytes(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  tooLarge: () => Error,
): Promise<Uint8Array> {
  const reader = body.getReader();
  let buffer = new Uint8Array(Math.min(initialBufferBytes, maxBytes));
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return buffer.subarray(0, total);
      const needed = total + value.byteLength;
      if (needed > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      if (needed > buffer.byteLength) {
        const grown = new Uint8Array(
          Math.min(maxBytes, Math.max(buffer.byteLength * 2, needed)),
        );
        grown.set(buffer.subarray(0, total));
        buffer = grown;
      }
      buffer.set(value, total);
      total = needed;
    }
  } finally {
    reader.releaseLock();
  }
}
