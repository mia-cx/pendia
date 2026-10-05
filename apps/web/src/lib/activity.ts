import type { PendiaClient } from "./api.ts";

/** A live or queued playback session as the dashboard lists it. */
export type ActivitySession = Awaited<
  ReturnType<PendiaClient["playback"]["sessions"]>
>[number];

/** Formats seconds as m:ss under an hour and h:mm:ss from an hour, flooring; negative or non-finite reads 0:00. */
export function clock(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours === 0
    ? `${minutes}:${String(rest).padStart(2, "0")}`
    : `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function playsSource(rungs: readonly string[]) {
  return rungs.length === 1 && rungs[0] === "source";
}

/** The Version label; for a non-transcode session also its stored rungs and "On" its transcoder. */
export function deliveryLine(
  session: Pick<ActivitySession, "playMethod" | "rungs" | "transcoder"> & {
    version: { label: string };
  },
): string {
  return [
    session.version.label,
    ...(session.playMethod !== "transcode" && !playsSource(session.rungs)
      ? session.rungs
      : []),
    session.playMethod !== "transcode" && session.transcoder !== null
      ? `On ${session.transcoder}`
      : null,
  ]
    .filter((part) => part !== null && part !== "")
    .join(" · ");
}

/** What each transcode reason reads as. */
export const reasonLabels: Record<ActivitySession["reasons"][number], string> =
  {
    video: "Video converted",
    audio: "Audio converted",
    subtitles: "Subtitles burned in",
    hdr: "HDR mapped to SDR",
  };

/** Under a transcode: what it writes, on which node, then each part it converts. */
export function transcodeLine(
  session: Pick<ActivitySession, "rungs" | "transcoder" | "reasons">,
): string {
  const where = session.transcoder;
  return [
    !playsSource(session.rungs)
      ? `To ${session.rungs.join(", ")}${where === null ? "" : ` on ${where}`}`
      : where === null
        ? null
        : `On ${where}`,
    ...session.reasons.map((reason) => reasonLabels[reason]),
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** The app and device a session plays on. */
export function clientLabel(session: {
  clientName: string | null;
  deviceName: string | null;
}): string {
  if (session.clientName === null) return "Unknown app";
  if (session.deviceName === null) return session.clientName;
  return `${session.clientName} on ${session.deviceName}`;
}
