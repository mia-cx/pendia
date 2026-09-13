import { type FileHandle, open } from "node:fs/promises";

/** Hard cap on bytes a single index read may consume. */
export const INDEX_READ_BUDGET = 2_000_000;

/** Malformed, unsupported or over-budget index metadata. */
export class InvalidIndex extends Error {
  override name = "InvalidIndex";
}

/** Minimal random-access byte source for index parsers. */
export interface IndexReader {
  size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

/** An {@link IndexReader} over a real file that counts actual bytes read. */
export class FileIndexReader implements IndexReader {
  bytesRead = 0;

  private constructor(
    private readonly handle: FileHandle,
    public readonly size: number,
  ) {}

  /** Open `path` read-only and stat its size. */
  static async open(path: string): Promise<FileIndexReader> {
    const handle = await open(path, "r");
    try {
      const stat = await handle.stat();
      if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
        throw new InvalidIndex("file size is not a safe integer");
      }
      return new FileIndexReader(handle, stat.size);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async read(offset: number, length: number): Promise<Buffer> {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset > this.size
    ) {
      throw new InvalidIndex("index read out of bounds");
    }
    const wanted = Math.min(length, this.size - offset);
    if (wanted > INDEX_READ_BUDGET - this.bytesRead) {
      throw new InvalidIndex("index read budget exceeded");
    }
    const buffer = Buffer.alloc(wanted);
    let filled = 0;
    while (filled < wanted) {
      const { bytesRead } = await this.handle.read(
        buffer,
        filled,
        wanted - filled,
        offset + filled,
      );
      if (bytesRead === 0) {
        break;
      }
      filled += bytesRead;
      this.bytesRead += bytesRead;
    }
    return buffer.subarray(0, filled);
  }

  /** Close the underlying file handle. */
  async close(): Promise<void> {
    await this.handle.close();
  }
}
