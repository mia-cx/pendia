import {
  decidePlayback,
  type PlaybackDecision,
  type PlaybackSource,
} from "./decisions.ts";
import {
  type CapabilityTable,
  type ClientProfile,
  cpuCapabilities,
  ladder,
  type PlaybackCaps,
} from "./policy.ts";

/** A ladder rung's menu name: its `name`, else its height as `1080p`. */
export function rungName(rung: { height: number; name?: string }) {
  return rung.name ?? `${rung.height}p`;
}

/** The ladder deduplicated by rung name, keeping the first (highest-bitrate) of each. */
export function qualityLadder() {
  const seen = new Set<string>();
  return ladder.filter((rung) => {
    const name = rungName(rung);
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

/** The deduplicated rung with `name`, else undefined. */
export function findRung(name: string) {
  return qualityLadder().find((rung) => rungName(rung) === name);
}

/** The deduplicated rungs whose box does not upscale a source of this frame size. */
export function sourceRungs(video: { width: number; height: number }) {
  return qualityLadder().filter(
    (rung) => rung.width <= video.width || rung.height <= video.height,
  );
}

/** The client profile with every codec's frame box lowered to the rung's, so pass and scale rules respect the resolution, not only the bitrate. */
export function boxProfile(
  profile: ClientProfile,
  rung: { width: number; height: number },
): ClientProfile {
  return {
    ...profile,
    videoCodecs: profile.videoCodecs.map((entry) => ({
      ...entry,
      maxWidth: Math.min(entry.maxWidth ?? Infinity, rung.width),
      maxHeight: Math.min(entry.maxHeight ?? Infinity, rung.height),
    })),
  };
}

/** How a quality option plays: a stored rung, another Version, or a live transcode. */
export type QualitySource = "stored" | "version" | "transcode";

/** One pickable rung of the quality menu. */
export type QualityRung = {
  name: string;
  width: number;
  height: number;
  /** Video bitrate of what this option plays. */
  bitrate: number;
  source: QualitySource;
  /** The Version to open, for source "version"; else null. */
  versionId: string | null;
  /** Stored variants within the rung, for source "stored"; else []. */
  storedVariantIds: string[];
  /** False when the server can't make this rung in real time. */
  available: boolean;
};

/** The plan's quality output: the original file option and the rung menu. */
export type QualityOptions = {
  /** Null when the source File can't direct play or remux here. */
  original: {
    name: string;
    width: number;
    height: number;
    bitrate: number;
  } | null;
  rungs: QualityRung[];
};

/** Another imported Version of the Item, considered for a rung. */
export type QualityCandidate = {
  id: string;
  durationSeconds: number | null;
  /** Its keyframes sit on the Item's segment timeline, so HLS can serve it. */
  timelineAligned: boolean;
  source: PlaybackSource;
};

export type QualityOptionsInput = {
  /** The played Version's source, selection included. */
  source: PlaybackSource;
  profile: ClientProfile;
  /** The caps before quality; `sessionRequest` holds the caller's own cap. */
  caps: PlaybackCaps;
  capabilities?: CapabilityTable;
  /** Whether CPU transcoders may run rungs above 1080p. */
  allowCpu4k?: boolean;
  /** The played Version's length and HLS readiness. */
  current: { durationSeconds: number | null; timelineAligned: boolean };
  /** Picks stored rungs under a boxed profile and cap; absent when stored can't serve this session. */
  pickStored?: (
    profile: ClientProfile,
    caps: PlaybackCaps,
    liveMethod: PlaybackDecision["method"] | null,
  ) => { variantIds: string[]; bitrate: number | null };
  /** Other imported Versions of the Item. */
  versions?: readonly QualityCandidate[];
};

/** How far a Version's length may differ from the played one's and still stand in for a rung. */
export const versionDurationToleranceSeconds = 5;

// A direct play always streams; remux and transcode need a progressive
// profile or an aligned timeline for HLS.
const canStream = (
  method: PlaybackDecision["method"],
  aligned: boolean,
  profile: ClientProfile,
) => method === "direct-play" || profile.progressive === true || aligned;

/** Builds the quality menu's options: the source File, then each fitting rung resolved stored-first. */
export function qualityOptions(input: QualityOptionsInput): QualityOptions {
  const { source, profile, current } = input;
  const capabilities = input.capabilities ?? cpuCapabilities;
  const decide = (
    video: PlaybackSource,
    client: ClientProfile,
    caps: PlaybackCaps,
  ) => {
    try {
      return decidePlayback(
        video,
        client,
        caps,
        capabilities,
        input.allowCpu4k ?? false,
      );
    } catch {
      return null;
    }
  };
  const rungs: QualityRung[] = [];
  for (const rung of sourceRungs(source.video)) {
    const rungProfile = boxProfile(profile, rung);
    const live = decide(source, rungProfile, input.caps);
    // The current File already plays as is at this rung; Original covers it.
    if (live !== null && live.method !== "transcode") continue;
    const picked = input.pickStored?.(
      rungProfile,
      input.caps,
      live?.method ?? null,
    );
    if (picked !== undefined && picked.variantIds.length > 0) {
      rungs.push({
        name: rungName(rung),
        width: rung.width,
        height: rung.height,
        bitrate: picked.bitrate ?? rung.bitrate,
        source: "stored",
        versionId: null,
        storedVariantIds: picked.variantIds,
        available: true,
      });
      continue;
    }
    const best = (input.versions ?? [])
      .flatMap((version) => {
        if (
          version.durationSeconds === null ||
          current.durationSeconds === null ||
          Math.abs(version.durationSeconds - current.durationSeconds) >
            versionDurationToleranceSeconds
        )
          return [];
        const decision = decide(version.source, rungProfile, input.caps);
        if (
          decision === null ||
          decision.method === "transcode" ||
          !canStream(decision.method, version.timelineAligned, rungProfile)
        )
          return [];
        return [{ id: version.id, bitrate: version.source.video.bitrate }];
      })
      .toSorted((a, b) => b.bitrate - a.bitrate)[0];
    if (best !== undefined) {
      rungs.push({
        name: rungName(rung),
        width: rung.width,
        height: rung.height,
        bitrate: best.bitrate,
        source: "version",
        versionId: best.id,
        storedVariantIds: [],
        available: true,
      });
      continue;
    }
    rungs.push({
      name: rungName(rung),
      width: rung.width,
      height: rung.height,
      // The decision's bitrate already counts codec and frame-rate factors.
      bitrate:
        live !== null && live.video.action === "transcode"
          ? live.video.bitrate
          : rung.bitrate,
      source: "transcode",
      versionId: null,
      storedVariantIds: [],
      // A planner that fails or falls to a lower rung disables the option.
      available:
        live !== null &&
        live.video.action === "transcode" &&
        rungName(live.video.rung) === rungName(rung),
    });
  }
  const live = decide(source, profile, input.caps);
  const video = source.video;
  const box = qualityLadder().findLast(
    (rung) => rung.width >= video.width && rung.height >= video.height,
  );
  const original =
    live !== null &&
    live.method !== "transcode" &&
    canStream(live.method, current.timelineAligned, profile)
      ? {
          name: box === undefined ? `${video.height}p` : rungName(box),
          width: video.width,
          height: video.height,
          bitrate: video.bitrate,
        }
      : null;
  return { original, rungs };
}
