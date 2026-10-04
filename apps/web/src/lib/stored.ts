import type { PendiaClient } from "./api.ts";
import { fromMbps, toMbps } from "./bitrate.ts";

/** A library's stored-version policy as the API reads it; null stores nothing. */
export type StoredPolicy = Awaited<
  ReturnType<PendiaClient["libraries"]["storedVersions"]>
>["policy"];

/** One rung of a policy. */
export type Rung = NonNullable<StoredPolicy>["rungs"][number];

/** The rung that remuxes the source without re-encoding. */
export const sourceRung = "source";

/** A rung as people read it, such as `720p · 3 Mbit/s`, or the source remux. */
export function rungLabel(rung: Rung): string {
  if (!("height" in rung)) return "Source, remuxed";
  return `${rung.name} · ${toMbps(rung.bitrate)} Mbit/s`;
}

/** The editor's form state: text fields stay strings until saved. */
export type PolicyDraft = {
  keepSource: boolean;
  rungs: { name: string; height: string; bitrateMbps: string }[];
  minHeight: string;
  codecs: string;
  hdr: boolean;
};

/** Fills the editor from a saved policy. */
export function toDraft(policy: StoredPolicy): PolicyDraft {
  const encoded = (policy?.rungs ?? []).flatMap((rung) =>
    "height" in rung
      ? [
          {
            name: rung.name,
            height: String(rung.height),
            bitrateMbps: toMbps(rung.bitrate),
          },
        ]
      : [],
  );
  return {
    keepSource: policy?.rungs.some((rung) => !("height" in rung)) ?? false,
    rungs: encoded,
    minHeight: policy?.when?.minHeight?.toString() ?? "",
    codecs: policy?.when?.codecs?.join(", ") ?? "",
    hdr: policy?.when?.hdr === true,
  };
}

/** The policy a draft saves; null when it names no rung. A blank rung name becomes its height, such as `720p`. */
export function fromDraft(draft: PolicyDraft): StoredPolicy {
  const rungs: Rung[] = [
    ...(draft.keepSource ? [{ name: sourceRung } as const] : []),
    ...draft.rungs.map((rung) => ({
      name: rung.name.trim() || `${rung.height.trim()}p`,
      height: Number(rung.height),
      // The form's own constraints keep these fields numeric; the server checks ranges.
      bitrate: fromMbps(rung.bitrateMbps) ?? Number.NaN,
    })),
  ];
  if (rungs.length === 0) return null;
  const codecs = draft.codecs
    .split(",")
    .map((codec) => codec.trim().toLowerCase())
    .filter((codec) => codec !== "");
  const when = {
    ...(draft.minHeight.trim() === ""
      ? {}
      : { minHeight: Number(draft.minHeight) }),
    ...(codecs.length === 0 ? {} : { codecs }),
    ...(draft.hdr ? { hdr: true as const } : {}),
  };
  return Object.keys(when).length === 0 ? { rungs } : { rungs, when };
}

/** The rung names a saved policy has and the next one drops; their stored Versions get deleted. */
export function droppedRungs(
  saved: StoredPolicy,
  next: StoredPolicy,
): string[] {
  const kept = new Set(next?.rungs.map((rung) => rung.name));
  return (saved?.rungs ?? [])
    .map((rung) => rung.name)
    .filter((name) => !kept.has(name));
}
