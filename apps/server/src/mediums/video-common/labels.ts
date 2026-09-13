import { editionTag } from "./paths.ts";
import type { ProbeResult } from "./probe.ts";

const codecNames: Record<string, string> = {
  h264: "H.264",
  hevc: "HEVC",
  av1: "AV1",
  vp9: "VP9",
};

const hdrNames: Record<string, string> = {
  hdr10: "HDR10",
  "hdr10+": "HDR10+",
  hlg: "HLG",
  "dolby-vision": "Dolby Vision",
};

/** Human Version label: edition tag, quality, video codec, HDR and audio codec. */
export function videoVersionLabel(
  path: string,
  probe: Pick<ProbeResult, "streams">,
): string {
  const video = probe.streams.find(
    (stream) => stream.kind === "video" && !stream.disposition.attached_pic,
  );
  const audio =
    probe.streams.find(
      (stream) => stream.kind === "audio" && stream.disposition.default,
    ) ?? probe.streams.find((stream) => stream.kind === "audio");
  const quality =
    video?.width && video?.height
      ? video.width >= 3840 || video.height >= 2160
        ? "4K"
        : `${video.height}p`
      : null;
  const codec = video
    ? (codecNames[video.codec] ?? video.codec.toUpperCase())
    : null;
  const hdr =
    video?.hdr && video.hdr !== "sdr"
      ? (hdrNames[video.hdr] ?? video.hdr)
      : null;
  return (
    [editionTag(path), quality, codec, hdr, audio?.codec.toUpperCase()]
      .filter(Boolean)
      .join(" · ") || "Video"
  );
}
