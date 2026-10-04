import { listVersionViews } from "../api/views.ts";
import { AuthError } from "../auth/errors.ts";
import { planPlayback } from "../playback/planning.ts";
import { json, type Route } from "./http.ts";
import { mediaSource, type PlannedSource } from "./media.ts";
import { readDeviceProfile } from "./profile.ts";
import { parseGuid, readBody, requiredGuid, toGuid } from "./request.ts";

// Android TV's DeviceProfile runs past the 16 KiB every other body gets.
const maxPlaybackInfoBytes = 262_144;

/**
 * Jellyfin clients follow TranscodingUrl verbatim and never refresh its token,
 * so the token outlives a long film. It still dies with its session or with
 * the device's sign-in, since every request re-checks both.
 */
export const jellyfinTokenLifetimeSeconds = 24 * 60 * 60;

/** PlaybackInfo: plans one Version for the client's DeviceProfile. */
export const playbackRoutes: Route[] = [
  {
    method: "POST",
    path: "/Items/{id}/PlaybackInfo",
    handle: async ({ db, request, query, params, caller, peerAddress }) => {
      const itemId = requiredGuid(params.id);
      const body = await readBody(request, maxPlaybackInfoBytes);
      const versions = await listVersionViews(db, caller.user.id, itemId);
      // A Jellyfin item's first source shares the item's id.
      const requested =
        body.optionalString("MediaSourceId") ?? query.get("mediaSourceId");
      const sourceId =
        requested === undefined ? undefined : parseGuid(requested);
      const version =
        sourceId === undefined || sourceId === itemId
          ? versions[0]
          : versions.find((candidate) => candidate.id === sourceId);
      if (version === undefined) throw new AuthError("NOT_FOUND");
      const profile = readDeviceProfile(
        body.value("DeviceProfile") ?? {},
        body.number("MaxStreamingBitrate") ??
          query.count("maxStreamingBitrate"),
      );
      let planned: PlannedSource | null = null;
      let sessionId: string | undefined;
      try {
        const plan = await planPlayback(
          db,
          caller,
          {
            itemId,
            versionId: version.id,
            profile,
            tokenLifetimeSeconds: jellyfinTokenLifetimeSeconds,
          },
          { request, peerAddress },
        );
        sessionId = plan.sessionId;
        const token =
          plan.url === null
            ? null
            : new URL(plan.url, request.url).searchParams.get("token");
        planned = {
          method: plan.method,
          query:
            token === null
              ? null
              : new URLSearchParams({
                  PlaySessionId: toGuid(plan.sessionId),
                  MediaSourceId: toGuid(version.id),
                  token,
                }),
        };
      } catch (error) {
        // No path plays for this profile. The source still answers, with
        // every flag off; Findroid plays the file regardless.
        if (
          !(error instanceof AuthError) ||
          (error.code !== "INVALID_INPUT" && error.code !== "CONFLICT")
        )
          throw error;
      }
      return json({
        MediaSources: [mediaSource(itemId, version, planned)],
        PlaySessionId: sessionId === undefined ? undefined : toGuid(sessionId),
      });
    },
  },
];
