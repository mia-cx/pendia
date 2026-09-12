import { type VideoStream, videoPasses } from "./decisions.ts";
import {
  type ClientProfile,
  effectiveCap,
  type PlaybackCaps,
} from "./policy.ts";
import { isTimelineAligned } from "./timeline.ts";

/** The derived segment boundaries of one Item cut. */
export type SegmentTimeline = {
  id: string;
  itemId: string;
  boundariesSeconds: readonly number[];
};

/** A normalized Version summary with origin-specific alignment evidence. */
export type PlaybackVersion = {
  id: string;
  itemId: string;
  segmentTimelineId: string | null;
  durationSeconds: number;
  video: VideoStream;
} & (
  | { origin: "imported"; keyframesSeconds: readonly number[] }
  | { origin: "stored"; complete: boolean; timelineAligned: boolean }
);

/** Returns the best codec family and sorted variants, or one live source when nothing passes. */
export function selectAdaptiveGroup(
  versions: readonly PlaybackVersion[],
  timeline: SegmentTimeline,
  client: ClientProfile,
  caps: PlaybackCaps,
) {
  const cap = effectiveCap(caps);
  const sources = versions.filter(
    (version) =>
      version.itemId === timeline.itemId &&
      version.segmentTimelineId === timeline.id &&
      version.durationSeconds === timeline.boundariesSeconds.at(-1) &&
      (version.origin === "imported" || version.complete),
  );
  const playable = sources.filter(
    (version) =>
      (version.origin === "stored"
        ? version.timelineAligned
        : isTimelineAligned(
            timeline.boundariesSeconds,
            version.keyframesSeconds,
            version.durationSeconds,
          )) && videoPasses(version.video, client, cap),
  );
  for (const candidate of client.videoCodecs) {
    const variants = playable
      .filter((version) => version.video.codec === candidate.codec)
      .toSorted((a, b) => a.video.bitrate - b.video.bitrate);
    if (variants.length > 0) {
      return { codec: candidate.codec, variants, liveSource: null };
    }
  }
  const variants: PlaybackVersion[] = [];
  const liveSource =
    sources.toSorted((a, b) => b.video.bitrate - a.video.bitrate)[0] ?? null;
  return { codec: null, variants, liveSource };
}
