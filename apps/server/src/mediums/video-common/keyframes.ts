import { readMatroskaKeyframes } from "./keyframes/matroska.ts";
import { readMp4Keyframes } from "./keyframes/mp4.ts";
import { FileIndexReader, InvalidIndex } from "./keyframes/reader.ts";

/** A container-only keyframe read and its byte cost. */
export type KeyframeIndex = {
  keyframesSeconds: number[] | null;
  bytesRead: number;
};

const EBML_SIGNATURE = 0x1a45dfa3;
const FTYP = Buffer.from("ftyp");

/** Read a container's video keyframes without reading media packets. */
export async function readKeyframeIndex(path: string): Promise<KeyframeIndex> {
  const reader = await FileIndexReader.open(path);
  try {
    const signature = await reader.read(0, 16);
    const container =
      signature.length >= 4 && signature.readUInt32BE(0) === EBML_SIGNATURE
        ? "matroska"
        : signature.length >= 8 && signature.subarray(4, 8).equals(FTYP)
          ? "mp4"
          : null;
    const keyframesSeconds =
      container === "matroska"
        ? await readMatroskaKeyframes(reader)
        : container === "mp4"
          ? await readMp4Keyframes(reader)
          : null;
    return { keyframesSeconds, bytesRead: reader.bytesRead };
  } catch (error) {
    if (error instanceof InvalidIndex) {
      return { keyframesSeconds: null, bytesRead: reader.bytesRead };
    }
    throw error;
  } finally {
    await reader.close();
  }
}
