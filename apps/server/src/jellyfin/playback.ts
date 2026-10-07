import type { createHlsHandler } from "../api/hls.ts";
import { listVersionViews } from "../api/views.ts";
import { AuthError } from "../auth/errors.ts";
import { verifyPlaybackToken } from "../auth/playback-tokens.ts";
import { authenticate } from "../auth/sessions.ts";
import { locateVersionFile, serveVersionFile } from "../playback/direct.ts";
import { planPlayback, toSubtitleStream } from "../playback/planning.ts";
import { parseHlsName } from "../playback/playlists.ts";
import { readWebvtt } from "../transcoder/subtitles.ts";
import { json, noTimeouts, type RequestContext, type Route } from "./http.ts";
import { mediaSource, type PlannedSource } from "./media.ts";
import { readDeviceProfile } from "./profile.ts";
import { parseGuid, readBody, requiredGuid, toGuid } from "./request.ts";

type HlsHandler = ReturnType<typeof createHlsHandler>;

// Android TV's DeviceProfile runs past the 16 KiB every other body gets.
const maxPlaybackInfoBytes = 262_144;

// A segment wait can outlive Bun's ten second idle timeout.
const segmentWaitSeconds = 30;

/**
 * Jellyfin clients follow TranscodingUrl verbatim and never refresh its token,
 * so the token outlives a long film. It still dies with its session or with
 * the device's sign-in, since every request re-checks both.
 */
export const jellyfinTokenLifetimeSeconds = 24 * 60 * 60;

/**
 * Resolves who asks for a media URL. Players often cannot send headers, so
 * besides the MediaBrowser header this takes the client's own token as
 * `ApiKey` or `api_key`, or the playback token Thalia wrote into the URL
 * beside its PlaySessionId.
 */
async function mediaUserId(
  { db, client, query, url }: RequestContext,
  itemId: string,
) {
  const token = client.token ?? query.get("apiKey") ?? query.get("api_key");
  if (token !== undefined) return (await authenticate(db, token)).user.id;
  const sessionId = parseGuid(query.get("playSessionId") ?? "");
  const playback = url.searchParams.get("token");
  if (sessionId === undefined || playback === null)
    throw new AuthError("UNAUTHENTICATED");
  const claims = await verifyPlaybackToken(db, playback, { sessionId, itemId });
  return claims.userId;
}

/** The Version a media URL names: its source id, or the Item's first Version for the Item's own id. */
async function versionOf(
  context: RequestContext,
  userId: string,
  itemId: string,
  source: string | undefined,
) {
  const versions = await listVersionViews(context.db, userId, itemId);
  const sourceId = source === undefined ? itemId : requiredGuid(source);
  const version =
    sourceId === itemId
      ? versions[0]
      : versions.find((candidate) => candidate.id === sourceId);
  if (version === undefined) throw new AuthError("NOT_FOUND");
  return version;
}

async function directStream(context: RequestContext, itemId: string) {
  const userId = await mediaUserId(context, itemId);
  const version = await versionOf(
    context,
    userId,
    itemId,
    context.query.get("mediaSourceId"),
  );
  return serveVersionFile(context.db, userId, itemId, version.id);
}

/** Maps a Jellyfin HLS path onto the session's HLS route, passing the query on. */
async function sessionHls(
  hls: HlsHandler,
  context: RequestContext,
  itemId: string,
  variant: string | undefined,
  name: string,
) {
  const file = name.toLowerCase() === "main.m3u8" ? "media.m3u8" : name;
  if (parseHlsName(file) === null) throw new AuthError("NOT_FOUND");
  const sessionId = requiredGuid(context.query.get("playSessionId"));
  context.server.timeout(context.request, segmentWaitSeconds);
  const folder = variant === undefined ? "hls" : `hls/${requiredGuid(variant)}`;
  const response = await hls(
    new Request(
      new URL(
        `/api/playback/${sessionId}/${itemId}/${folder}/${file}${context.url.search}`,
        context.request.url,
      ),
      { signal: context.request.signal },
    ),
    noTimeouts,
  );
  if (response === undefined) throw new AuthError("NOT_FOUND");
  return response;
}

async function subtitle(context: RequestContext) {
  const { db, params, request } = context;
  const itemId = requiredGuid(params.id);
  const index = Number(params.index);
  const userId = await mediaUserId(context, itemId);
  const version = await versionOf(context, userId, itemId, params.source);
  // ffmpeg numbers subtitle Streams among themselves; Jellyfin by File index.
  const subtitles = version.streams.filter(
    (stream) => stream.kind === "subtitle",
  );
  const ordinal = subtitles.findIndex((stream) => stream.index === index);
  const stream = subtitles[ordinal];
  if (stream === undefined || toSubtitleStream(stream).kind !== "text")
    throw new AuthError("NOT_FOUND");
  const { path } = await locateVersionFile(db, userId, itemId, version.id);
  if (path === undefined) throw new AuthError("NOT_FOUND");
  return new Response(await readWebvtt(path, ordinal, request.signal), {
    headers: {
      "content-type": "text/vtt; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * PlaybackInfo, the direct stream, the HLS routes and the subtitle route.
 * Media routes are anonymous to the route table because players fetch them
 * without headers; each checks its own credential.
 */
export function playbackRoutes(hls: HlsHandler): Route[] {
  return [
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
        // Jellyfin numbers Streams across the File, as Thalia does. A
        // negative audio index asks for the default; -1 turns subtitles off.
        const audioIndex =
          body.number("AudioStreamIndex") ?? query.integer("AudioStreamIndex");
        const subtitleIndex =
          body.number("SubtitleStreamIndex") ??
          query.integer("SubtitleStreamIndex");
        const subtitleStreamIndex =
          subtitleIndex === undefined
            ? undefined
            : subtitleIndex < 0
              ? null
              : subtitleIndex;
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
              ...(audioIndex === undefined || audioIndex < 0
                ? {}
                : { audioStreamIndex: audioIndex }),
              ...(subtitleStreamIndex === undefined
                ? {}
                : { subtitleStreamIndex }),
            },
            { request, peerAddress },
          );
          sessionId = plan.sessionId;
          const token =
            plan.url === null
              ? null
              : new URL(plan.url, request.url).searchParams.get("token");
          // The URLs keep the selection, as Jellyfin's own do.
          const selection = {
            ...(plan.audioStreamIndex === null
              ? {}
              : { AudioStreamIndex: String(plan.audioStreamIndex) }),
            ...(subtitleStreamIndex === undefined
              ? {}
              : { SubtitleStreamIndex: String(subtitleStreamIndex ?? -1) }),
          };
          planned = {
            method: plan.method,
            query:
              token === null
                ? null
                : new URLSearchParams({
                    PlaySessionId: toGuid(plan.sessionId),
                    MediaSourceId: toGuid(version.id),
                    ...selection,
                    token,
                  }),
            audioStreamIndex: plan.audioStreamIndex,
            subtitleStreamIndex,
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
          PlaySessionId:
            sessionId === undefined ? undefined : toGuid(sessionId),
        });
      },
    },
    {
      method: "GET",
      path: "/Videos/{id}/{name}",
      anonymous: true,
      handle: (context) => {
        const itemId = requiredGuid(context.params.id);
        const name = context.params.name ?? "";
        // `stream`, or `stream.mkv` as jellyfin-web and Kodi spell it.
        return /^stream(\.[a-z0-9]+)?$/i.test(name)
          ? directStream(context, itemId)
          : sessionHls(hls, context, itemId, undefined, name);
      },
    },
    {
      method: "GET",
      path: "/Videos/{id}/{variant}/{name}",
      anonymous: true,
      handle: (context) =>
        sessionHls(
          hls,
          context,
          requiredGuid(context.params.id),
          context.params.variant,
          context.params.name ?? "",
        ),
    },
    {
      method: "GET",
      path: "/Videos/{id}/{source}/Subtitles/{index}/Stream.vtt",
      anonymous: true,
      handle: subtitle,
    },
  ];
}
