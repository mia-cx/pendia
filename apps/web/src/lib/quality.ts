import type { ThaliaClient } from "./api.ts";

/** The plan's quality menu: the original file option and the rungs. */
export type Quality = Awaited<
  ReturnType<ThaliaClient["playback"]["plan"]>
>["quality"];

/** `Normal` at 1×, else `1.5×`. */
export function speedLabel(rate: number) {
  return rate === 1 ? "Normal" : `${rate}×`;
}

/** `Off`, else the extra gain as `+200%`. */
export function boostLabel(level: number) {
  return level === 0 ? "Off" : `+${Math.round(level * 100)}%`;
}

/** `8 Mbit/s` or `1.5 Mbit/s`, at most one decimal. */
export function formatMbps(bps: number) {
  return `${Math.round((bps / 1_000_000) * 10) / 10} Mbit/s`;
}

/**
 * The option name matching a playing frame size: the smallest rung or
 * original box containing it, else its height as `1080p`. Null without a
 * frame yet.
 */
export function playingName(
  size: { width: number; height: number } | null,
  quality: Quality | undefined,
): string | null {
  if (size === null) return null;
  const boxes = [
    ...(quality?.original ? [quality.original] : []),
    ...(quality?.rungs ?? []),
  ];
  const box = boxes
    .filter((entry) => entry.width >= size.width && entry.height >= size.height)
    .toSorted((a, b) => a.width * a.height - b.width * b.height)[0];
  return box?.name ?? `${size.height}p`;
}

/** The Quality row's value: `Auto · 1080p`, `Original`, or the rung that's playing, falling back to the pick before a frame loads. */
export function qualityValue(
  state: {
    quality: string;
    videoSize: { width: number; height: number } | null;
  },
  quality: Quality | undefined,
): string {
  const name = playingName(state.videoSize, quality);
  if (state.quality === "original") return "Original";
  if (state.quality === "auto")
    return name === null ? "Auto" : `Auto · ${name}`;
  return name ?? state.quality;
}

/** One Quality submenu option; `versionId` names the Version to open for version-sourced rungs. */
export type QualityEntry = {
  value: string;
  label: string;
  detail?: string;
  disabled?: boolean;
  versionId?: string;
};

/** The Quality submenu's options: Auto, Original when it plays, and the plan's rungs. */
export function qualityEntries(
  quality: Quality | undefined,
  versions: readonly { id: string; label: string }[],
): QualityEntry[] {
  const entries: QualityEntry[] = [{ value: "auto", label: "Auto" }];
  if (quality?.original) {
    entries.push({
      value: "original",
      label: "Original",
      detail: `${quality.original.name} · ${formatMbps(quality.original.bitrate)}`,
    });
  }
  for (const rung of quality?.rungs ?? []) {
    const detail =
      rung.source === "stored"
        ? `Stored · ${formatMbps(rung.bitrate)}`
        : rung.source === "transcode"
          ? `Transcode · ${formatMbps(rung.bitrate)}`
          : versions.find((version) => version.id === rung.versionId)?.label;
    entries.push({
      value: rung.name,
      label: rung.name,
      ...(detail === undefined ? {} : { detail }),
      disabled: !rung.available,
      ...(rung.versionId === null ? {} : { versionId: rung.versionId }),
    });
  }
  return entries;
}
